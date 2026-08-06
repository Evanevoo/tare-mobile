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

/** One asset, as it arrives. Keys are short because there are forty thousand. */
export interface AssetRec {
  p: string | null;        // product code
  sn: string | null;       // serial number
  s: string;               // status
  f: 0 | 1;                // is full
  l: string | null;        // location
  c: string | null;        // customer account number, null = in-house
  own: 0 | 1;              // customer-owned
  rq: string | null;       // next requalification, YYYY-MM-DD
  lq: string | null;       // last requalification
}

export interface CustomerRec {
  id: string;
  customerListId: string;
  name: string;
  city: string | null;
  region: string | null;
  address: string | null;
  postal: string | null;
  contact: string | null;
  phone: string | null;
  email: string | null;
  held: number;
}

export const BOOTSTRAP_VERSION = 2;

export interface Bootstrap {
  /** Shape version. A cache without this is from an older app and is discarded. */
  v?: number;
  org: { name: string; assetLabel: string; assetPlural: string };
  user: { name: string; email: string; role: string };
  customers: CustomerRec[];
  assets: Record<string, AssetRec>;
  locations: string[];
  stats: {
    total: number; out: number; inHouse: number; full: number; customers: number;
  };
  outCount: number;
  syncedAt: string;
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const res = await fetch(`${API_URL}/api/mobile/bootstrap`, {
    headers: { ...(await authHeader()) },
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
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

export interface FillResult {
  updated: number;
  /** Rentals that were open on these assets and have now been ended. */
  closed: number;
  unknown: string[];
}

/**
 * Locate: put a batch of assets at a location and mark them full or empty.
 *
 * Unlike a delivery this needs signal, because it settles rentals rather than
 * recording evidence — and a rental closed optimistically on a phone that
 * never reconnects is a customer billed for nothing.
 */
export async function postFill(
  location: string, state: 'full' | 'empty', barcodes: string[],
): Promise<FillResult> {
  const res = await fetch(`${API_URL}/api/mobile/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ location, state, barcodes }),
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error ?? `Could not save (${res.status})`);
  }
  return res.json();
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export const signOut = () => supabase.auth.signOut();
