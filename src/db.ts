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

/**
 * Where the outbox is actually being kept, right now.
 *
 *   'sqlite'    the normal path
 *   'fallback'  SQLite is broken but AsyncStorage is holding the shift
 *   'none'      nothing on this phone works; scans are in memory only
 *
 * This exists because `dbUnavailable` stopped being the right question the
 * moment a fallback existed. It says "SQLite failed", which is true on Evan's
 * handset and no longer means the scans are at risk. Warning a driver that
 * nothing is being saved while it IS being saved trains them to ignore the one
 * banner that matters — so the banner is now driven by this, and only 'none'
 * is worth interrupting anybody about.
 */
export let storageMode: 'sqlite' | 'fallback' | 'none' = 'none';

export async function open(): Promise<SQLite.SQLiteDatabase | null> {
  if (db) return db;
  if (tried && dbUnavailable) return null;   // failed once; do not thrash
  tried = true;

  try {
    db = await SQLite.openDatabaseAsync('tare.db');
    await init(db);
    dbUnavailable = null;
    storageMode = 'sqlite';
    return db;
  } catch (e: any) {
    db = null;
    dbUnavailable = String(e?.message ?? e);
    // Not fatal on its own - the AsyncStorage fallback below usually holds the
    // shift - but it is the first half of the story and worth knowing which
    // handsets it happens on.
    shout('sqlite-open', e);
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

/**
 * ═══ THE FALLBACK THAT SHOULD HAVE BEEN HERE FROM THE START ═══
 *
 * "Not saving to this phone — upload before you stop" was on Evan's screen on
 * 19 Aug, in red, while he was scanning a real delivery. SQLite had failed to
 * open on that handset, and the app did exactly what it was written to do:
 * degraded to online-only, told him the truth, and kept going.
 *
 * The trouble is what "online-only" costs. Every scan lived in a JavaScript
 * variable and nowhere else, so the instant the app was force-closed — which
 * is what the grey-screen bug was making him do — the entire shift was gone.
 * Two deliveries were lost that way, POW City and Flatstone, and neither ever
 * reached the server. The warning was accurate and it was not enough.
 *
 * AsyncStorage is a COMPLETELY SEPARATE native module from expo-sqlite, and it
 * is demonstrably working on that exact phone: the app lock and the push token
 * are stored in it and have never failed. So when SQLite is unavailable there
 * is still a disk to write to; the app simply was not using it.
 *
 * An outbox is a few hundred rows of small JSON. Rewriting the whole blob on
 * every scan is O(n) where SQLite would be O(1), and at this size that is
 * microseconds — a completely acceptable price for a shift surviving a crash.
 * This is a worse database and an enormously better outcome.
 */
const AS_OUTBOX = 'outbox.fallback.v1';
const AS_CACHE_PREFIX = 'cache.fallback.v1.';

/**
 * A STORAGE FAILURE HAS TO REACH SOMEBODY WHO CAN READ IT.
 *
 * Every failure path in this file logged to `console.warn`, which on a release
 * build on a driver's phone goes precisely nowhere. So "Not saving to this
 * phone" could appear in a yard with no way to find out which of the two
 * storage layers had gone, or why — and the only remaining move was guessing,
 * which is how the update-check bug ate most of 20 Aug before Sentry was asked.
 *
 * Reported once per kind per launch: a save runs on every scan, and a driver
 * sweeping a rack must not turn one broken phone into a thousand events.
 */
const shouted = new Set<string>();
function shout(kind: string, e: unknown, extra: Record<string, unknown> = {}) {
  console.warn(`[tare] ${kind}:`, e);
  if (shouted.has(kind)) return;
  shouted.add(kind);
  try {
    // Required lazily so this module never depends on Sentry being up, and
    // never throws from a catch block.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/react-native');
    Sentry.captureException(e instanceof Error ? e : new Error(`${kind}: ${String(e)}`), {
      tags: { kind: 'storage-failed', storage: kind, storageMode },
      extra: { ...extra, storageMode, sqliteError: dbUnavailable },
    });
  } catch { /* nothing left to try */ }
}

async function asyncStorage() {
  // Guarded like every other native touch in this app: if even AsyncStorage
  // is missing there is nothing left to do but stay in memory, and saying so
  // is better than throwing on the scan path.
  try {
    return (await import('@react-native-async-storage/async-storage')).default;
  } catch (e) {
    // This is the branch that decides between "SQLite broke but the shift is
    // safe" and "nothing on this phone is holding anything". It was silent.
    shout('async-storage-import', e);
    return null;
  }
}

export async function loadOutbox(): Promise<Outbox> {
  const d = await open();

  if (!d) {
    // No SQLite. Try the fallback before concluding there is nothing.
    try {
      const AS = await asyncStorage();
      if (AS) {
        // Reaching AsyncStorage at all is what decides the mode. A first run
        // has nothing stored yet, and that must still count as "there is a
        // disk here" or the banner fires on a phone that is about to save
        // perfectly well.
        storageMode = 'fallback';
        const raw = await AS.getItem(AS_OUTBOX);
        if (raw) {
          const parsed = JSON.parse(raw) as Outbox;
          if (parsed && Array.isArray(parsed.scans)) return parsed;
        }
      }
    } catch (e) {
      console.warn('[tare] fallback loadOutbox failed:', e);
    }
    return { scans: [] };
  }

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

  if (!d) {
    // The whole point of the fallback: this now returns TRUE on a phone with
    // no working SQLite, because the scans really are on disk. Before, it
    // returned false and the shift lived in RAM until something killed it.
    try {
      const AS = await asyncStorage();
      if (!AS) { storageMode = 'none'; return false; }
      await AS.setItem(AS_OUTBOX, JSON.stringify(o));
      storageMode = 'fallback';
      return true;
    } catch (e) {
      // BOTH layers are gone. This is the only state the red banner is for,
      // and until now it was the least explained thing in the app.
      shout('fallback-save', e, { scans: o.scans.length });
      storageMode = 'none';
      return false;
    }
  }

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

  // The cache holds the job in flight — customer, order number, mode — so
  // without this a driver on a no-SQLite phone who restarts mid-delivery comes
  // back to a blank Delivery screen and has to set the order up again from
  // memory. Same fallback, same reason.
  if (!d) {
    try {
      const AS = await asyncStorage();
      if (AS) await AS.setItem(AS_CACHE_PREFIX + key, JSON.stringify(value));
    } catch { /* memory only, as before */ }
    return;
  }

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

  if (!d) {
    try {
      const AS = await asyncStorage();
      if (!AS) return null;
      const raw = await AS.getItem(AS_CACHE_PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  try {
    const row = await d.getFirstAsync<any>('SELECT v FROM cache WHERE k = ?', [key]);
    if (!row) return null;
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}
