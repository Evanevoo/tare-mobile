import * as SQLite from 'expo-sqlite';
import type { QueuedScan, Outbox } from './outbox';

/**
 * Persistence for the outbox. Deliberately thin: the state machine lives in
 * outbox.ts, this only makes it survive the app being killed mid-shift —
 * which happens, because phones get dropped and batteries die.
 */
let db: SQLite.SQLiteDatabase | null = null;

export async function open() {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('tare.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
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
  return db;
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

export async function loadOutbox(): Promise<Outbox> {
  const d = await open();
  const rows = await d.getAllAsync<any>('SELECT * FROM outbox ORDER BY client_id ASC');
  return { scans: rows.map(fromRow) };
}

/** Mirror the whole reduced state. Small N (a shift is hundreds, not millions). */
export async function saveOutbox(o: Outbox) {
  const d = await open();
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
}

export async function cacheSet(key: string, value: unknown) {
  const d = await open();
  await d.runAsync(
    'INSERT INTO cache (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    [key, JSON.stringify(value)],
  );
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const d = await open();
  const row = await d.getFirstAsync<any>('SELECT v FROM cache WHERE k = ?', [key]);
  if (!row) return null;
  try { return JSON.parse(row.v) as T; } catch { return null; }
}
