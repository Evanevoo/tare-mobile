/**
 * History, joined: what the COMPANY scanned, plus what this phone has not
 * managed to upload yet.
 *
 * The owner reported that history was disappearing. Nothing was ever lost —
 * every scan is on the server and none of them are voided. The screen was
 * simply built out of the outbox, and its own doc comment said as much:
 * "History is what THIS PHONE did". So a reinstall, a second handset, or a new
 * build opened on an empty list, and from a yard that is indistinguishable
 * from a shift that went missing.
 *
 * The list comes down from the server now, and this file is the join. It is
 * the only part of that change with any real thinking in it, and every mistake
 * worth making lives here: counting a scan twice because the server already
 * has it, drawing one order as two rows because the two sides spell its number
 * differently, or losing the order that exists nowhere but this phone because
 * the server has never heard of it.
 *
 * Pure, and it imports nothing that has ever seen a handset —
 * __tests__/history.test.mts runs the whole join under plain node.
 */
import { whenLabel } from './when.ts';

/** One order as the server counts it. The wire shape of GET /api/mobile/history. */
export interface ServerOrder {
  orderNumber: string;
  customerListId: string;
  customerName: string;
  ship: number;
  ret: number;
  /** Withdrawn scans. They stay on the record and stop counting — see scan-edit. */
  voided: number;
  lastScanAt: string;
  /** Everybody who touched it, which is the half of this a single phone cannot know. */
  scannedBy: string[];
}

/** A page of them, newest first. `nextBefore` is null at the end of the road. */
export interface HistoryPage {
  orders: ServerOrder[];
  nextBefore: string | null;
}

/**
 * The page as it is kept on disk, with the moment it arrived.
 *
 * The timestamp is the whole point of caching it: a list with no date on it
 * invites somebody to believe it is current, and the yard with no bars is the
 * normal case here rather than the edge one.
 */
export interface CachedHistory extends HistoryPage {
  fetchedAt: string;
}

/**
 * As much of an outbox row as the join needs.
 *
 * Structural rather than an import of QueuedScan, for the reason `Fleet` in
 * src/batch.ts is structural: a test can state one in four lines, and this
 * file stays something you can read without opening another.
 */
export interface LocalScan {
  orderNumber: string;
  customerListId: string;
  mode: 'SHIP' | 'RETURN';
  scannedAt: string;
  state: 'QUEUED' | 'UPLOADING' | 'SENT';
}

/** One row on the screen, whichever side it came from — or both. */
export interface HistoryRow {
  orderNumber: string;
  customerListId: string;
  /** The best name anybody knows for them; falls back to the account number. */
  customerName: string;
  ship: number;
  ret: number;
  voided: number;
  /** Scans of this order still sitting on this handset. */
  pending: number;
  /** The server has never heard of this order. Almost always: no signal yet. */
  onlyOnPhone: boolean;
  lastScanAt: string;
  scannedBy: string[];
}

/**
 * The form two order numbers are compared in.
 *
 * The retag box uppercases what a driver types and the scanner uppercases what
 * it reads, but the server holds whatever reached it first — so the same order
 * can arrive from the two sides differing by a case or a trailing space. That
 * is one order, and one order has to draw as one row. Drawing it as two is the
 * exact failure this screen was rebuilt to stop.
 */
export const orderKey = (n: string) => n.trim().toUpperCase();

/**
 * Server orders and this phone's outbox, as one list, newest first.
 *
 * THE COUNTING RULE, WHICH IS THE WHOLE OF IT. A scan the server already knows
 * about is already in its `ship`/`ret`, so adding the phone's copy on top
 * would show six out on a load of three. Only the rows this phone has NOT
 * uploaded are added.
 *
 * The exception is an order the server did not send at all — no signal since
 * it was scanned, or it is older than the page in hand. Nothing is counting it
 * anywhere else, so there every local row counts, sent or not. It corrects
 * itself the moment that order arrives from the server.
 */
export function mergeHistory(
  server: readonly ServerOrder[],
  scans: readonly LocalScan[],
  opts: { names?: ReadonlyMap<string, string>; me?: string | null } = {},
): HistoryRow[] {
  const rows = new Map<string, HistoryRow>();

  for (const o of server) {
    const key = orderKey(o.orderNumber);
    // Pages are asked for newest first, so where one repeats across a page
    // boundary the copy already in hand is the fresher of the two.
    if (rows.has(key)) continue;
    rows.set(key, {
      orderNumber: o.orderNumber,
      customerListId: o.customerListId,
      customerName: o.customerName || opts.names?.get(o.customerListId) || o.customerListId || '',
      ship: o.ship,
      ret: o.ret,
      voided: o.voided,
      pending: 0,
      onlyOnPhone: false,
      lastScanAt: o.lastScanAt,
      scannedBy: o.scannedBy ?? [],
    });
  }

  for (const s of scans) {
    const key = orderKey(s.orderNumber);
    const row = rows.get(key);
    const unsent = s.state !== 'SENT';

    if (!row) {
      rows.set(key, {
        orderNumber: s.orderNumber,
        customerListId: s.customerListId,
        customerName: opts.names?.get(s.customerListId) || s.customerListId || '',
        ship: s.mode === 'SHIP' ? 1 : 0,
        ret: s.mode === 'RETURN' ? 1 : 0,
        voided: 0,
        pending: unsent ? 1 : 0,
        onlyOnPhone: true,
        lastScanAt: s.scannedAt,
        // Nobody else can have touched an order nobody else has seen.
        scannedBy: opts.me ? [opts.me] : [],
      });
      continue;
    }

    if (row.onlyOnPhone || unsent) {
      if (s.mode === 'SHIP') row.ship++; else row.ret++;
    }
    if (unsent) row.pending++;
    // The server's own last scan is usually the later one; it is not while a
    // driver is standing in a yard adding to an order that synced this morning.
    if (s.scannedAt > row.lastScanAt) row.lastScanAt = s.scannedAt;
  }

  return [...rows.values()].sort(
    (a, b) => b.lastScanAt.localeCompare(a.lastScanAt)
      || orderKey(a.orderNumber).localeCompare(orderKey(b.orderNumber)),
  );
}

/**
 * The next page, onto the end of what is already on screen.
 *
 * `before` is a timestamp, so an order scanned while the driver was scrolling
 * can legitimately come back on both sides of a page boundary. Appending it
 * blind would put the same order on the screen twice, five rows apart, which
 * reads as a duplicated delivery rather than as a paging artefact.
 */
export function appendPage(
  have: readonly ServerOrder[], next: readonly ServerOrder[],
): ServerOrder[] {
  const seen = new Set(have.map((o) => orderKey(o.orderNumber)));
  const out = have.slice();
  for (const o of next) {
    const key = orderKey(o.orderNumber);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

/**
 * What the screen says when the download did not happen.
 *
 * Said as what it is, with the time on it, and never as a code. A driver who
 * is told "500" learns nothing they can act on; a driver who is told this list
 * came down at 06:12 knows exactly how much to trust it and that pulling down
 * is worth a try. The yard with no bars is the ordinary case here, so this is
 * ordinary copy rather than an error.
 */
export function offlineNotice(fetchedAt: string | null): string {
  if (!fetchedAt) {
    return 'No signal, and nothing downloaded to this phone yet. What is below is only what '
      + 'this handset has scanned itself. Pull down to try again.';
  }
  return `No signal. This is what the phone downloaded ${whenLabel(fetchedAt)} — anything `
    + 'scanned since, on any handset, is not in it. Pull down to try again.';
}
