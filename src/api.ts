import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import type { QueuedScan } from './outbox';
import { toWire } from './outbox';
import type { BatchItem, BulkCreateResult } from './batch';
import type { HistoryPage } from './history';
import type { PendingShipRec } from './pending-ship';

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

/**
 * Who is signed into this phone, known without the server.
 *
 * "Signed in as" used to read the bootstrap payload, so the moment the handset
 * could not reach the console — a dead tunnel, a yard with no bars, a first run
 * before the download finishes — the one line on the screen whose entire job is
 * to say who you are went blank. The session itself is on the device; asking it
 * costs nothing and cannot fail offline.
 *
 * Name and role still come from the bootstrap when it is there, because
 * Supabase only knows the address that signed in.
 */
export async function sessionIdentity(): Promise<{ email: string } | null> {
  const { data } = await supabase.auth.getSession();
  const email = data.session?.user?.email;
  return email ? { email } : null;
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
  /**
   * Scanned out and not yet approved — the thing is still in house, on
   * purpose, and this is the reason. Null on almost every asset, which is why
   * it costs the download nothing. Optional so a v4 cache still type-checks
   * on the way to being discarded.
   */
  ps?: PendingShipRec | null;
  /** Who it last came back FROM, by name. Null when it never has. */
  lc?: string | null;
  /** The day it came back, YYYY-MM-DD. */
  rt?: string | null;
  /** Gas type, category, group, description — the columns 017 restored. */
  gt?: string | null;
  cat?: string | null;
  grp?: string | null;
  ds?: string | null;
  /**
   * The supplier label (assets.owner): "WeldCor", "Linde". Deliberately NOT
   * `own`, which is the customer-owned BILLING flag — one is a catalogue
   * label, the other stops rental accruing.
   */
  sup?: string | null;
  /**
   * 1 = an open rental exists on this asset right now. The third leg of the
   * Locate interlock: a stale `c` alone must not warn — see interlock.ts.
   */
  or?: 0 | 1;
}

/** One catalogue row: pick the code, the other four fill in together. */
export interface TypeRec {
  code: string;
  gasType: string | null;
  category: string | null;
  groupName: string | null;
  description: string | null;
}

export interface CustomerRec {
  id: string;
  customerListId: string;
  name: string;
  /** The code printed on their card, as printed — asterisks included. */
  bc: string | null;
  city: string | null;
  region: string | null;
  address: string | null;
  postal: string | null;
  contact: string | null;
  phone: string | null;
  email: string | null;
  held: number;
  /** The one holding account for walk-ins with no account number yet. Never bills. */
  tmp?: number;
}

/** One product code and how many of them the fleet has. */
export interface ProductRec {
  code: string;
  n: number;
}

// 4: customers carry `bc`, the code printed on their card. A v3 cache has no
// barcode on any customer, so a card scanned at the counter would find nothing
// and look identical to an unknown customer. The bump discards that cache.
//
// 5: assets carry `ps`, `lc` and `rt` — scanned out and awaiting approval, and
// who it last came back from. Additive, so a v4 cache would not crash; it
// would just go on drawing a bottle that left this morning exactly like one
// that never moved, which is the whole defect. Being quietly wrong for one
// more sync is worse than a refetch on the wifi they leave from.
//
// 7: assets carry `gt/cat/grp/ds/sup` (the descriptive columns migration 017
// restored), `or` (an open rental exists — the Locate interlock's third
// leg), plus the `types` catalogue and `limits.maxAssets`. 6 and 7 were cut
// server-side in the same release and no handset ever saw a 6, so the app
// goes straight to 7. A v5 cache has none of it: Add would offer no picks,
// Locate would warn off one stale field, and the quota warning would never
// fire — refetch instead.
export const BOOTSTRAP_VERSION = 7;

export interface Bootstrap {
  /** Shape version. A cache without this is from an older app and is discarded. */
  v?: number;
  org: { name: string; assetLabel: string; assetPlural: string };
  user: { name: string; email: string; role: string };
  customers: CustomerRec[];
  assets: Record<string, AssetRec>;
  locations: string[];
  /**
   * What this org's numbers look like, set in Settings. Empty means "no rule",
   * which must read as "anything is allowed" and never as "everything is wrong".
   * The server has always sent these; the handset just never typed them.
   */
  formats?: { barcode?: string; customerNumber?: string; orderNumber?: string };
  /** Commonest first. Drives the product picker when adding something new. */
  products: ProductRec[];
  /** The attribute catalogue — one pick fills four fields. Empty until writes teach it. */
  types?: TypeRec[];
  /** The cylinder quota, for warning BEFORE the server refuses. Null = unlimited. */
  limits?: { maxAssets: number | null };
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

/** The most orders one page may ask for, and what it asks for by default. */
export const HISTORY_PAGE = 50;
export const HISTORY_MAX = 100;

/**
 * The company's orders, newest first.
 *
 * History used to be assembled from the outbox, which meant it showed one
 * handset's own work and nothing else — reinstall the app and the screen came
 * back empty, which the owner read, reasonably, as scans disappearing. This is
 * the other half: what the company has, paged.
 *
 * A FAILURE HERE IS NOT AN EMERGENCY. The caller falls back to the last page
 * it cached and says so, because a driver in a yard with no bars is the normal
 * case for this screen rather than the exception. So the messages below are
 * sentences and not codes — nothing renders them today, but the day something
 * does, it must not be showing somebody a 503.
 */
export async function fetchHistory(
  opts: { limit?: number; before?: string | null } = {},
): Promise<HistoryPage> {
  const limit = Math.min(HISTORY_MAX, Math.max(1, Math.trunc(opts.limit ?? HISTORY_PAGE)));
  const q = new URLSearchParams({ limit: String(limit) });
  if (opts.before) q.set('before', opts.before);

  const res = await fetch(`${API_URL}/api/mobile/history?${q.toString()}`, {
    headers: { ...(await authHeader()) },
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (!res.ok) throw new Error('The server could not be reached.');
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
export class SyncRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SyncRefused';
  }
}

export async function postScans(scans: QueuedScan[]): Promise<SyncResult> {
  const res = await fetch(`${API_URL}/api/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ scans: scans.map(toWire) }),
  });

  /**
   * A REFUSAL IS NOT BAD RECEPTION.
   *
   * Every non-OK status came back as `Sync failed (402)`, `sync` caught it and
   * set `online: false`, and Home rendered "Offline — nothing is lost". So a
   * driver whose company had gone read-only for non-payment, or whose session
   * had expired, spent the day walking to higher ground and pressing Sync
   * against a server that was never going to accept it. The one thing the app
   * knew — WHY it was refused — was the thing it threw away.
   *
   * These are separated because the driver's next action is different for
   * each: 402 means phone the office, 401 means sign in again, 5xx and a dead
   * socket mean try later. The queue is safe in all four cases and every
   * message says so, because that is the fear the screen has to answer.
   */
  if (res.status === 402) {
    throw new SyncRefused(402,
      'This account is read-only, so the office has to sort out billing before scans can upload. '
      + 'Nothing is lost — your scans stay on this phone.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new SyncRefused(res.status,
      'Your session has expired. Sign in again to upload — your scans stay on this phone.');
  }
  if (!res.ok) {
    throw new SyncRefused(res.status,
      `The server refused the upload (${res.status}). Your scans stay on this phone; try again shortly.`);
  }
  return res.json();
}

export interface FillResult {
  updated: number;
  /** Rentals that were open on these assets and have now been ended. */
  closed: number;
  /** Who those closed rentals belonged to — one entry per closed rental. */
  closedCustomers: { barcode: string; customerName: string }[];
  unknown: string[];
  /**
   * One line per barcode sent — what actually happened to each. Legacy
   * reported per-bottle failures; aggregates alone meant one refused bottle
   * hid inside "updated 19". Optional: an older server omits it and the
   * screen falls back to the aggregates.
   */
  results?: { barcode: string; ok: boolean; reason?: string }[];
}

/** One Locate save, as the server remembers it (fill_records, 018). */
export interface FillHistoryEntry {
  id: string;
  barcode: string;
  location: string;
  state: 'full' | 'empty';
  previousState: 'full' | 'empty' | null;
  previousLocation: string | null;
  filledBy: string | null;
  filledAt: string;
}

export interface FillHistoryPage {
  entries: FillHistoryEntry[];
  /** Cursor for the next page; null when this is the end. */
  before: string | null;
}

/**
 * What this yard put where — the durable record POST /fill now writes.
 * Same fallback contract as fetchHistory: a failure is not an emergency,
 * the caller shows its cache and says so.
 */
export async function fetchFillHistory(
  opts: { limit?: number; before?: string | null } = {},
): Promise<FillHistoryPage> {
  const q = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, opts.limit ?? 50))) });
  if (opts.before) q.set('before', opts.before);
  const res = await fetch(`${API_URL}/api/mobile/fill-history?${q.toString()}`, {
    headers: { ...(await authHeader()) },
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (!res.ok) throw new Error('The server could not be reached.');
  return res.json();
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

/**
 * Change a scan the phone has already uploaded.
 *
 * The outbox can fix anything still on the device without a network — that is
 * local state and `outbox.ts` owns it. Once a scan syncs, the ledger owns it,
 * and this is the only way back in. Needs signal, needs a reason, and needs
 * the manager role; every one of those is enforced by the server, not here.
 *
 * Identified by (order, barcode, direction) rather than a server id, because
 * that triple is the server's own unique key and the phone already knows it —
 * no extra round trip to learn an id it would then have to keep in sync.
 */
export async function editSentScan(body: {
  action: 'mode' | 'void' | 'restore' | 'order' | 'customer';
  orderNumber: string;
  barcode?: string;
  mode?: 'SHIP' | 'RETURN';
  value?: string;
  reason: string;
}): Promise<{ ok: true; message: string }> {
  const res = await fetch(`${API_URL}/api/mobile/scan-edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (!res.ok) throw new Error(json?.error ?? `Could not save (${res.status})`);
  return json;
}

export interface RemoteOrderScan {
  barcode: string;
  mode: 'SHIP' | 'RETURN';
  scannedAt: string;
  scannedBy: string | null;
}

export interface RemoteOrder {
  orderNumber: string;
  customerListId: string | null;
  scans: RemoteOrderScan[];
}

/**
 * One order's scans, read from the server instead of this phone's outbox.
 *
 * The order editor is built from the outbox first because a scan still
 * queued is local state this phone owns outright — nobody else has seen it.
 * But most orders in History were never scanned on this phone at all, so the
 * editor had nothing to fall back to except "scanned on another handset" and
 * a pointer to the console. This is that fallback: the ledger, not the
 * device, decides what is on an order — the same shift api/mobile/history
 * already made for the list. Editing what comes back still goes through
 * editSentScan below, which the server gates on the manager role regardless
 * of which phone is asking.
 */
export async function fetchOrderDetail(orderNumber: string): Promise<RemoteOrder> {
  const res = await fetch(`${API_URL}/api/mobile/order/${encodeURIComponent(orderNumber)}`, {
    headers: { ...(await authHeader()) },
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (!res.ok) throw new Error('The server could not be reached.');
  return res.json();
}

/** The editable half of an asset. Everything here is what the thing IS. */
export interface AssetDraft {
  productCode: string;
  serialNumber?: string | null;
  status?: 'available' | 'rented' | 'maintenance' | 'lost' | 'retired';
  isFull?: boolean;
  location?: string | null;
  customerOwned?: boolean;
  lastRequalOn?: string | null;
  nextRequalOn?: string | null;
  /** The 017 columns. Usually filled together from one `types` pick. */
  gasType?: string | null;
  category?: string | null;
  groupName?: string | null;
  description?: string | null;
  /** Supplier label — NOT the customer-owned billing switch. */
  owner?: string | null;
}

/**
 * An error that carries the server's structured answer.
 *
 * Adding something that already exists and editing something that still has an
 * open rental are both refusals the UI has a real response to — open the
 * existing record, or ask before ending somebody's billing. Flattening them
 * into a message string would throw that away.
 */
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function send(path: string, method: 'POST' | 'PATCH', body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(json?.error ?? `Could not save (${res.status})`, res.status, json);
  }
  return json;
}

/**
 * Add something to the fleet.
 *
 * Needs signal. A new barcode invented offline could be invented twice on two
 * phones, and the loser would silently lose their work at sync — better to say
 * so now than to lie about having saved it.
 */
export function createAsset(barcode: string, draft: AssetDraft) {
  return send('/api/mobile/assets', 'POST', { barcode, ...draft }) as Promise<{
    asset: AssetRec & { id: string; barcode: string };
  }>;
}

/**
 * What a whole pallet has in common. Everything that differs bottle to bottle
 * — the barcode, the serial — is in the items; everything else is asked once.
 */
export interface BulkAssetCreate {
  productCode: string;
  location?: string | null;
  isFull: boolean;
  nextRequalOn?: string | null;
  status?: 'available';
  /** Pallet-level, like productCode: forty bottles from one supplier. */
  gasType?: string | null;
  category?: string | null;
  groupName?: string | null;
  description?: string | null;
  owner?: string | null;
}

/**
 * Add a pallet of them in one go.
 *
 * Needs signal, for the same reason `createAsset` does and more so: forty
 * barcodes invented offline are forty chances for two phones in the same yard
 * to invent the same one.
 *
 * A PARTIAL SUCCESS COMES BACK 200 AND IS NOT A FAILURE. Half a pallet booked
 * in yesterday means half the barcodes come back in `skipped` with the rest
 * created, and the screen reports that honestly rather than throwing the whole
 * save away — see app/asset/batch.tsx. The only refusals that arrive as thrown
 * ApiErrors are the ones that stopped the request cold, of which 402 is the
 * one worth naming: the organisation is read-only, nothing was created, and
 * the batch is still sitting on the phone.
 */
export function createAssets(items: BatchItem[], details: BulkAssetCreate) {
  return send('/api/mobile/assets/bulk', 'POST', { items, ...details }) as
    Promise<BulkCreateResult>;
}

/**
 * Correct the record on something.
 *
 * `confirmCloseRentals` is the second half of a two-step: the first call comes
 * back 409 with how many rentals are open, the driver is told what ending them
 * means, and only then does the same call go again with the flag set.
 */
export function updateAsset(
  barcode: string,
  draft: Partial<AssetDraft> & { confirmCloseRentals?: boolean; newBarcode?: string },
) {
  return send(`/api/mobile/assets/${encodeURIComponent(barcode)}`, 'PATCH', draft) as Promise<{
    asset: any; closed: number; changed: string[];
  }>;
}

/**
 * One asset, from the ledger instead of this phone's cache.
 *
 * The lookup path for a record the last bootstrap has never heard of — a
 * bottle added from another handset an hour ago, or one whose barcode was
 * just corrected. "Not on this phone" used to be a dead end; this is the
 * door out of it. Needs signal, and says so plainly when there is none.
 */
export async function getAsset(barcode: string): Promise<{
  asset: (AssetRec & { barcode: string }) | null;
}> {
  const res = await fetch(`${API_URL}/api/mobile/assets/${encodeURIComponent(barcode)}`, {
    headers: { ...(await authHeader()) },
  });
  if (res.status === 401) throw new Error('Your session expired. Sign in again.');
  if (res.status === 404) return { asset: null };
  if (!res.ok) throw new Error('The server could not be reached.');
  return res.json();
}

/**
 * The same correction, applied to a stack at once.
 *
 * Narrower on purpose — see api/mobile/assets/bulk on the server for why
 * status, isFull and custody are not here. Only what is genuinely the same
 * across a whole pallet: what kind, where, who owns them.
 */
export interface BulkAssetPatch {
  productCode?: string;
  location?: string | null;
  customerOwned?: boolean;
  gasType?: string | null;
  category?: string | null;
  groupName?: string | null;
  description?: string | null;
  owner?: string | null;
}
export function bulkUpdateAssets(barcodes: string[], patch: BulkAssetPatch) {
  return send('/api/mobile/assets/bulk', 'PATCH', { barcodes, ...patch }) as Promise<{
    matched: number; updated: number; missing: string[];
  }>;
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/**
 * Send a recovery link — straight back into this app, not a browser.
 *
 * The web app's /reset-password still exists and still works for anyone who
 * opens the email somewhere else, but it never actually solved the problem
 * for the case that matters here: a driver on the same phone Scanified is
 * installed on. Routing through a browser logged THAT session in — a
 * different, separate session from the one this app's own Supabase client
 * keeps in this phone's storage. Setting a new password in the browser never
 * touched the app at all; the driver still had to come back and type the new
 * password in by hand.
 *
 * Pointing the link at the app's own scheme instead means the OS opens
 * Scanified directly with the one-time code, app/reset-password.tsx exchanges
 * it for a session in the app's own client, and saving the new password there
 * IS signing in — no separate trip back to the login screen.
 *
 * The trade: this only opens on the phone Scanified is already installed on.
 * Opened somewhere else — a desktop, a phone without the app — the link
 * simply does not open anything. Accepted for the same reason the password
 * itself is never remembered: this app assumes the device asking is the
 * device that needs it.
 */
export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: Linking.createURL('/reset-password'),
  });
  if (error) throw new Error(error.message);
}

export const signOut = () => supabase.auth.signOut();
