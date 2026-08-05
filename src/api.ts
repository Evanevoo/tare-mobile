import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import type { QueuedScan } from './outbox';
import { toWire } from './outbox';

/**
 * One base URL, set at build time per EAS profile. Nothing else in the app
 * knows where the server is.
 */
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra as any)?.apiUrl ??
  'http://localhost:3000';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface Bootstrap {
  org: { name: string; assetLabel: string; assetPlural: string };
  user: { name: string; email: string; role: string };
  customers: { customerListId: string; name: string; city: string | null }[];
  assets: Record<string, string>;   // barcode → product code
  outCount: number;
  syncedAt: string;
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const res = await fetch(`${API_URL}/api/mobile/bootstrap`, {
    headers: { ...(await authHeader()) },
  });
  if (!res.ok) throw new Error(`Bootstrap failed (${res.status})`);
  return res.json();
}

export interface SyncResult {
  accepted: number;
  replayed: number;
  unresolved: string[];
}

/**
 * Drain the outbox. Safe to call twice with the same rows — the server is
 * idempotent on (org, orderNumber, barcode, mode), which is the guarantee the
 * whole offline design rests on.
 */
export async function postScans(scans: QueuedScan[]): Promise<SyncResult> {
  const res = await fetch(`${API_URL}/api/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ scans: scans.map(toWire) }),
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (!res.ok) throw new Error(`Sync failed (${res.status})`);
  return res.json();
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export const signOut = () => supabase.auth.signOut();
