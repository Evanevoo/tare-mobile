import * as SQLite from 'expo-sqlite';
import type { QueuedScan, Outbox } from './outbox';

/**
 * Persistence for the outbox. Deliberately thin: the state machine lives in
 * outbox.ts, this only makes it survive the app being killed mid-shift —
 * which happens, because phones get dropped and batteries die.
 */
let db: SQLite.SQLiteDatabase | null = null;

/**
 * WHEN SQLITE ITSELF FAILS.
 *
 * On some Android builds `NativeDatabase.prepareAsync` rejects with a bare
 * java.lang.NullPointerException — the native handle comes back null and every
 * later call throws. Nothing in JS causes it and nothing in JS can repair it.
 *
 * What must not happen is what was happening: an unhandled rejection at
 * startup, a full-screen red error, and a driver who cannot sign in. The local
 * database is a durability optimisation — it lets a shift survive the app being
 * killed — and losing it should cost exactly that, not the whole app.
 *
 * So a failure here is recorded once and then the module degrades to
 * online-only: scans still post, they just are not held on disk if the phone
 * dies mid-shift. `dbUnavailable` is exported so a screen can tell the driver
 * the truth rather than pretending everything is normal.
 */
export let dbUnavailable: string | null = null;
let tried = false;

export async function open(): Promise<SQLite.SQLiteDatabase | null> {
  if (db) return db;
  if (tried && dbUnavailable) return null;   // failed once; do not thrash
  tried = true;

  try {
    db = await SQLite.openDatabaseAsync('tare.db');
    await init(db);
    dbUnavailable = null;
    return db;
  } catch (e: any) {
    db = null;
    dbUnavailable = String(e?.message ?? e);
    console.warn('[tare] local database unavailable, running online-only:', dbUnavailable);
    return null;
  }
}

async function init(d: SQLite.SQLiteDatabase) {
  // WAL is set on its own. It is a PRAGMA that RETURNS a row, and batching a
  // result-producing statement with DDL in one execAsync is the shape most
  // likely to trip the native layer — cheap to separate, and it removes one
  // suspect from a crash that cannot be reproduced off-device.
  try { await d.execAsync('PRAGMA journal_mode = WAL'); } catch { /* not fatal */ }

  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS outbox (
      client_id        TEXT PRIMARY KEY NOT NULL,
      order_number     TEXT NOT NULL,
      barcode          TEXT NOT NULL,
      mode             TEXT NOT NULL,
      customer_list_id TEXT NOT NULL,
      scanned_at       TEXT NOT NULL,
      lat              REAL,
      lng              REAL,
      accuracy_m       INTEGER,
      state            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_state_idx ON outbox (state);
    CREATE INDEX IF NOT EXISTS outbox_order_idx ON outbox (order_number);

    CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
  `);
}

const toRow = (s: QueuedScan) => [
  s.clientId, s.orderNumber, s.barcode, s.mode, s.customerListId,
  s.scannedAt, s.lat, s.lng, s.accuracyM, s.state,
];

const fromRow = (r: any): QueuedScan => ({
  clientId: r.client_id, orderNumber: r.order_number, barcode: r.barcode,
  mode: r.mode, customerListId: r.customer_list_id, scannedAt: r.scanned_at,
  lat: r.lat, lng: r.lng, accuracyM: r.accuracy_m, state: r.state,
});

/* Every entry point below tolerates the database being gone. Each one answers
   "what is the honest answer when there is no disk?" rather than throwing:
   an empty outbox, a silently dropped write, a cache miss. The caller's code
   path is identical to a cold install, which is a state the app already
   handles correctly. */

export async function loadOutbox(): Promise<Outbox> {
  const d = await open();
  if (!d) return { scans: [] };
  try {
    const rows = await d.getAllAsync<any>('SELECT * FROM outbox ORDER BY client_id ASC');
    return { scans: rows.map(fromRow) };
  } catch (e) {
    console.warn('[tare] loadOutbox failed, treating as empty:', e);
    return { scans: [] };
  }
}

/** Mirror the whole reduced state. Small N (a shift is hundreds, not millions).
 *  Returns false when it could not be persisted, so a caller that cares can
 *  say so — silence here is what turns a dead battery into a lost shift. */
export async function saveOutbox(o: Outbox): Promise<boolean> {
  const d = await open();
  if (!d) return false;
  try {
    await d.withTransactionAsync(async () => {
      await d.runAsync('DELETE FROM outbox');
      for (const s of o.scans) {
        await d.runAsync(
          `INSERT INTO outbox
             (client_id, order_number, barcode, mode, customer_list_id,
              scanned_at, lat, lng, accuracy_m, state)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          toRow(s) as any,
        );
      }
    });
    return true;
  } catch (e) {
    console.warn('[tare] saveOutbox failed; scans are in memory only:', e);
    return false;
  }
}

export async function cacheSet(key: string, value: unknown) {
  const d = await open();
  if (!d) return;
  try {
    await d.runAsync(
      'INSERT INTO cache (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      [key, JSON.stringify(value)],
    );
  } catch (e) {
    console.warn('[tare] cacheSet failed:', e);
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const d = await open();
  if (!d) return null;
  try {
    const row = await d.getFirstAsync<any>('SELECT v FROM cache WHERE k = ?', [key]);
    if (!row) return null;
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}
