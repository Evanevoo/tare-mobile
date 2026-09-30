/**
 * The offline outbox — one queue, one state machine.
 *
 * Scanified had four overlapping queues and a comment file about sync bugs.
 * This is the whole thing: scans go in, they come out exactly once, and a
 * dropped upload rolls back rather than vanishing.
 *
 * Kept pure and dependency-free so it runs under plain node in tests. The
 * SQLite layer in db.ts is a persistence shim around this, nothing more.
 */

export type Mode = 'SHIP' | 'RETURN';
export type ScanState = 'QUEUED' | 'UPLOADING' | 'SENT';

export interface QueuedScan {
  clientId: string;        // ULID, minted on the device
  orderNumber: string;
  barcode: string;
  mode: Mode;
  customerListId: string;
  scannedAt: string;       // ISO
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  state: ScanState;
  /**
   * True when this scan was accepted despite not matching the org's
   * configured barcode format — see the "off-format" comment in scan.tsx's
   * take(). Purely a local UI flag: the row is still a normal scan in every
   * other way (uploads, dedupes, counts the same), this only controls
   * whether the review list and History keep showing a warning tag on it.
   * Not sent to the server — see toWire below, which deliberately omits it.
   */
  offFormat?: boolean;
  /**
   * Who scanned it: the Supabase user id and lower-cased address signed in at
   * the moment of the scan (either may be missing offline, never both once
   * anyone is known), and how to name them on screen. The server credits a
   * scan to whoever's token uploads it, so a row may only go up under this
   * login — see `sendable`. Absent on rows queued by builds before 30 Sep,
   * which upload as they always did. Local only, like offFormat; toWire omits
   * all three.
   */
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
}

/** Who is signed in, as far as the phone can tell. Either half may be unknown. */
export type Me = { id?: string | null; email?: string | null } | null | undefined;

export interface Outbox {
  scans: QueuedScan[];
}

export type Action =
  | { type: 'ENQUEUE'; scan: QueuedScan }
  | { type: 'TOGGLE'; orderNumber: string; barcode: string; mode: Mode }
  | { type: 'REMOVE'; clientId: string }
  /**
   * Retag a whole order that has not gone up yet.
   *
   * The mistake this exists for is the common one and the expensive one: the
   * driver picks the wrong customer or fat-fingers the order number, then
   * scans forty bottles against it. Fixing that a bottle at a time is not
   * fixing it. QUEUED rows only — once a row is UPLOADING or SENT it is the
   * server's to change (api/mobile/scan-edit), and quietly rewriting a row
   * that is mid-flight would put the phone and the ledger into two different
   * stories about the same scan.
   */
  | { type: 'RETAG'; orderNumber: string; toOrderNumber?: string; toCustomerListId?: string }
  /**
   * The server changed a scan this phone had already sent — bring the local
   * copy into line.
   *
   * The phone is not the source of truth for a SENT scan; the ledger is. But
   * the phone is the SCREEN, and History is built entirely from this outbox.
   * Without this the driver flips a sent bottle, sees "Saved", and the row
   * still reads the old way — for ever, because the outbox is persisted to
   * SQLite and nothing ever reconciles SENT rows against the server.
   *
   * `drop` is for a withdrawal: the server keeps the row as evidence, but on
   * the phone it should stop counting, and the phone has no concept of a
   * withdrawn scan to render. Deleting the local copy is the honest local
   * equivalent — the record still exists where records are kept.
   *
   * SENT rows only. Anything still QUEUED is the phone's own and is edited
   * through the actions above; applying a server edit to it would double-apply
   * a change the server has not seen.
   */
  | {
      type: 'APPLY_SERVER_EDIT';
      orderNumber: string;
      barcode?: string;
      mode?: Mode;
      drop?: boolean;
      toOrderNumber?: string;
      toCustomerListId?: string;
    }
  | { type: 'BEGIN_UPLOAD'; clientIds: string[] }
  | { type: 'UPLOAD_OK'; clientIds: string[] }
  | { type: 'UPLOAD_FAILED'; clientIds: string[] }
  /** Crash recovery at hydrate: strand nothing in UPLOADING. See the reducer. */
  | { type: 'RECOVER_INFLIGHT' }
  | { type: 'CLEAR_SENT' };

export const empty: Outbox = { scans: [] };

/** A scan is identified by what the server dedupes on, not by its clientId. */
const sameScan = (a: QueuedScan, orderNumber: string, barcode: string) =>
  a.orderNumber === orderNumber && a.barcode === barcode;

/**
 * The most recent scan of this bottle on this order, whatever its state.
 *
 * Rows are appended in scan order and a correction replaces its row in place,
 * so the last match is the bottle's current direction on this order. That is
 * the one thing a new scan has to be compared with: same direction means the
 * driver scanned it again, not a second unit — whether the first scan is still
 * waiting or went up seconds ago (30 Sep: "I was able to scan the same bottle
 * twice"; scans upload almost at once, so the first one was nearly always
 * SENT and was never compared). Shared by ENQUEUE and store.addScan so the
 * buzz and the queue can never disagree again.
 */
export function latestScan(scans: QueuedScan[], orderNumber: string, barcode: string): QueuedScan | undefined {
  for (let i = scans.length - 1; i >= 0; i--) {
    if (sameScan(scans[i], orderNumber, barcode)) return scans[i];
  }
  return undefined;
}

export function reduce(state: Outbox, action: Action): Outbox {
  switch (action.type) {
    case 'ENQUEUE': {
      const { scan } = action;
      /**
       * A SENT ROW IS HISTORY, NOT THE CURRENT PENDING STATE.
       *
       * This used to match ANY row with the same (order, barcode), including
       * one already SENT from an earlier sync in the same job. `.find` returns
       * the first match in array order, and a SENT row is always the older
       * one — so once a bottle had synced, every later scan of it kept
       * comparing itself against that stale SENT row instead of the fresh
       * QUEUED one sitting after it: SHIP (synced) → RETURN (correctly
       * replaces in place) → RETURN again both landed here, both found the old
       * SENT SHIP row, both saw a different mode, and both pushed a NEW
       * QUEUED RETURN row rather than recognising the first RETURN was
       * already queued. Two identical rows for one bottle, silently.
       *
       * Only a QUEUED or UPLOADING row can be "already pending" or "still
       * ours to correct" — a SENT row is the server's now. Excluded here the
       * same way APPLY_SERVER_EDIT excludes anything NOT SENT; this is the
       * mirror case.
       */
      /*
        30 Sep, the other half: excluding SENT rows went too far. A bottle
        whose scan had already uploaded (seconds, usually) could be scanned
        the same way again and land as a second row. The comparison is now
        against the LATEST row for this bottle on this order, in any state:
        that is SHIP·RETURN·RETURN's live RETURN, and it is also the SENT SHIP
        a repeat SHIP must match. The replace below still only rewrites a row
        that is QUEUED, never the server's history.
      */
      const existing = latestScan(state.scans, scan.orderNumber, scan.barcode);

      // Same direction as its latest scan — a double beep, not a second unit.
      if (existing && existing.mode === scan.mode) return state;

      // Same bottle, opposite direction: the driver corrected themselves.
      // Replace rather than stack, but only while it is still ours to change.
      if (existing && existing.state === 'QUEUED') {
        return {
          scans: state.scans.map((s) =>
            s.clientId === existing.clientId ? { ...scan, clientId: existing.clientId } : s),
        };
      }

      return { scans: [...state.scans, scan] };
    }

    case 'TOGGLE': {
      const hit = state.scans.find(
        (s) => sameScan(s, action.orderNumber, action.barcode) && s.state === 'QUEUED');
      if (!hit) return state;
      return {
        scans: state.scans.map((s) =>
          s.clientId === hit.clientId ? { ...s, mode: action.mode } : s),
      };
    }

    case 'REMOVE':
      return {
        scans: state.scans.filter(
          (s) => !(s.clientId === action.clientId && s.state === 'QUEUED')),
      };

    case 'RETAG': {
      const to = action.toOrderNumber?.trim();
      const cust = action.toCustomerListId?.trim();
      if (!to && !cust) return state;

      // Moving onto an order this phone ALREADY has rows for would let the
      // same (order, barcode, mode) exist twice in one outbox — which the
      // server would dedupe on upload, silently dropping one of them. Refused
      // here instead, where it can still be explained.
      if (to && to !== action.orderNumber) {
        const moving = state.scans.filter(
          (s) => s.orderNumber === action.orderNumber && s.state === 'QUEUED');
        const collides = moving.some((m) =>
          state.scans.some((s) => s.orderNumber === to && s.barcode === m.barcode));
        if (collides) return state;
      }

      return {
        scans: state.scans.map((s) =>
          s.orderNumber === action.orderNumber && s.state === 'QUEUED'
            ? {
                ...s,
                ...(to ? { orderNumber: to } : {}),
                ...(cust ? { customerListId: cust } : {}),
              }
            : s),
      };
    }

    case 'APPLY_SERVER_EDIT': {
      const { orderNumber, barcode, mode, drop, toOrderNumber, toCustomerListId } = action;
      const isTarget = (s: QueuedScan) =>
        s.state === 'SENT' && s.orderNumber === orderNumber &&
        (barcode ? s.barcode === barcode : true);

      if (drop) return { scans: state.scans.filter((s) => !isTarget(s)) };

      return {
        scans: state.scans.map((s) => (isTarget(s)
          ? {
              ...s,
              ...(mode ? { mode } : {}),
              ...(toOrderNumber ? { orderNumber: toOrderNumber } : {}),
              ...(toCustomerListId ? { customerListId: toCustomerListId } : {}),
            }
          : s)),
      };
    }

    case 'BEGIN_UPLOAD': {
      const ids = new Set(action.clientIds);
      return {
        scans: state.scans.map((s) =>
          ids.has(s.clientId) && s.state === 'QUEUED' ? { ...s, state: 'UPLOADING' } : s),
      };
    }

    case 'UPLOAD_OK': {
      const ids = new Set(action.clientIds);
      return {
        scans: state.scans.map((s) =>
          ids.has(s.clientId) ? { ...s, state: 'SENT' } : s),
      };
    }

    // The truck drove under a bridge. Nothing is lost — it goes back in line.
    case 'UPLOAD_FAILED': {
      const ids = new Set(action.clientIds);
      return {
        scans: state.scans.map((s) =>
          ids.has(s.clientId) && s.state === 'UPLOADING' ? { ...s, state: 'QUEUED' } : s),
      };
    }

    /**
     * THE APP DIED MID-UPLOAD. PUT THE ROWS BACK IN LINE.
     *
     * Found 19 Aug 2026, from a real lost delivery: scanned for Flatstone
     * Construction, pressed Done then Submit, the screen went grey and froze,
     * the app was force-closed, and the scans were gone. Nothing reached the
     * server — no Flatstone scan exists in the ledger.
     *
     * Here is the whole mechanism. `BEGIN_UPLOAD` moves rows to UPLOADING and
     * that state is persisted to SQLite immediately, as it must be. The ONLY
     * thing that ever moves a row back out of UPLOADING is `UPLOAD_FAILED`,
     * which runs in sync()'s catch block. A catch block requires the process
     * to still be alive. A crash, a force-quit, an OS kill under memory
     * pressure — none of them run it.
     *
     * And sync() only ever sends `queued(outbox)`, which is `state ===
     * 'QUEUED'` exactly. So a row stranded in UPLOADING is never retried by
     * anything, ever. It sits on the phone, counts as pending, and will not
     * move for the rest of the device's life. The driver did everything right
     * and the shift is gone.
     *
     * The recovery is the one fact that makes this safe: if this app is
     * hydrating, it has just started, so by definition no upload is in
     * flight. Any UPLOADING row is therefore a corpse from a previous
     * process and belongs back in the queue.
     *
     * Re-sending something the server may already have is deliberately the
     * safe direction, not a risk taken: /api/scans createMany uses
     * skipDuplicates and returns a `replayed` count, so a row that did land
     * before the crash posts zero the second time. Duplicate delivery is
     * free; a lost delivery is a phone call from a yard.
     */
    case 'RECOVER_INFLIGHT':
      return {
        scans: state.scans.map((s) =>
          s.state === 'UPLOADING' ? { ...s, state: 'QUEUED' } : s),
      };

    case 'CLEAR_SENT':
      return { scans: state.scans.filter((s) => s.state !== 'SENT') };

    default:
      return state;
  }
}

/**
 * Would a retag actually land? Asked BEFORE dispatching, never inferred after.
 *
 * The screen used to dispatch RETAG and then guess whether it had worked by
 * checking whether any scan now carried the target order number. That check
 * can never be false: RETAG only refuses when a scan on the target order
 * shares a barcode, so in exactly the refusal case a matching row is present
 * and the guess reported success. The driver got a success haptic and a
 * navigation to the target order while forty bottles quietly stayed on the
 * wrong one.
 *
 * A reducer that silently declines needs a companion the caller can ask first.
 * This is it, and it is the same predicate the reducer uses, so the rule lives
 * in one place rather than being restated — wrongly — at the call site.
 */
export function retagBlockedBy(
  o: Outbox, orderNumber: string, toOrderNumber: string,
): string | null {
  const to = toOrderNumber.trim();
  if (!to || to === orderNumber) return null;
  const moving = o.scans.filter((s) => s.orderNumber === orderNumber && s.state === 'QUEUED');
  for (const m of moving) {
    if (o.scans.some((s) => s.orderNumber === to && s.barcode === m.barcode)) return m.barcode;
  }
  return null;
}

export const pending = (o: Outbox) => o.scans.filter((s) => s.state !== 'SENT');
export const queued = (o: Outbox) => o.scans.filter((s) => s.state === 'QUEUED');
export const inFlight = (o: Outbox) => o.scans.filter((s) => s.state === 'UPLOADING');

/**
 * SCANS GO UP UNDER THE NAME OF WHOEVER SCANNED THEM.
 *
 * A login that expired mid-shift left its queue on disk, the next person
 * signed in, and the next sync posted that queue with their token — so the
 * ledger credited every bottle to someone who never touched it. A stamped row
 * now waits for its own scanner: it is never sent under another login and
 * never discarded, and it goes up the next time they sign in on this phone.
 *
 * `me` unknown (no session readable) holds back every stamped row, since
 * nothing proves the token is theirs. Unstamped rows predate the stamp and
 * upload exactly as before, so an update strands nothing already queued.
 */
const norm = (e: string | null | undefined) => e?.trim().toLowerCase() || null;

/** The owner fields a scan taken now should carry, or none if nobody is known. */
export function ownerStamp(me: Me, name?: string | null): Pick<QueuedScan, 'ownerId' | 'ownerEmail' | 'ownerName'> {
  const id = me?.id || undefined;
  const email = norm(me?.email) ?? undefined;
  if (!id && !email) return {};
  return {
    ...(id ? { ownerId: id } : {}),
    ...(email ? { ownerEmail: email } : {}),
    ...(name ? { ownerName: name } : {}),
  };
}

/**
 * Matched by user id when both sides have one, otherwise by address; a stamp
 * the signed-in login cannot be compared with is held, not guessed at.
 */
export function heldForOther(s: QueuedScan, me: Me): boolean {
  if (!s.ownerId && !s.ownerEmail) return false;
  if (s.ownerId && me?.id) return s.ownerId !== me.id;
  const mine = norm(me?.email);
  if (s.ownerEmail && mine) return norm(s.ownerEmail) !== mine;
  return true;
}

/** What this login may upload now. */
export const sendable = (o: Outbox, me: Me) =>
  queued(o).filter((s) => !heldForOther(s, me));

/** Unsent work this login answers for — what a sign-out has to account for. */
export const unsentMine = (o: Outbox, me: Me) =>
  pending(o).filter((s) => !heldForOther(s, me));

/** Unsent scans waiting for somebody else to sign in, per person. */
export function waitingForOthers(o: Outbox, me: Me) {
  const by = new Map<string, { name: string; count: number }>();
  for (const s of pending(o)) {
    if (!heldForOther(s, me)) continue;
    const key = s.ownerEmail || s.ownerId!;
    const w = by.get(key) ?? { name: s.ownerName || s.ownerEmail || 'another driver', count: 0 };
    w.count++;
    by.set(key, w);
  }
  return [...by.values()];
}

/**
 * THE CHECK AND THE TOKEN ARE THE SAME READ.
 *
 * sync() chooses rows for whoever was signed in when it started, but the
 * token is fetched again for each POST. A sign-in in between — above all
 * between two chunks — would send the first person's rows under the second
 * person's token. So the session that supplies the token is the session the
 * rows are checked against, in one read, immediately before the send. Any row
 * that login may not carry and nothing is sent: `OwnerChanged` puts the chunk
 * back in line (UPLOAD_FAILED) and the next sync chooses again. Unstamped rows
 * ride with any token, as they always have.
 */
export class OwnerChanged extends Error {
  constructor() {
    super('Someone else signed in while scans were sending. They are still on this phone.');
    this.name = 'OwnerChanged';
  }
}

export type TokenSession = { token: string | null; id: string | null; email: string | null } | null;

export async function sendAs<T>(
  scans: QueuedScan[],
  readSession: () => Promise<TokenSession>,
  send: (token: string | null) => Promise<T>,
): Promise<T> {
  const session = await readSession();
  if (scans.some((s) => heldForOther(s, session))) throw new OwnerChanged();
  return send(session?.token ?? null);
}

/** "3 scans saved by mike.t are waiting for them to sign in." */
export const waitingLine = (w: { name: string; count: number }) =>
  `${w.count} scan${w.count === 1 ? '' : 's'} saved by ${w.name} `
  + `${w.count === 1 ? 'is' : 'are'} waiting for them to sign in.`;

export function forOrder(o: Outbox, orderNumber: string) {
  return o.scans.filter((s) => s.orderNumber === orderNumber);
}

export function counts(o: Outbox, orderNumber?: string) {
  const rows = orderNumber ? forOrder(o, orderNumber) : o.scans;
  return {
    ship: rows.filter((s) => s.mode === 'SHIP').length,
    ret: rows.filter((s) => s.mode === 'RETURN').length,
    pending: rows.filter((s) => s.state !== 'SENT').length,
    total: rows.length,
  };
}

/** The wire shape POST /api/scans expects. */
export const toWire = (s: QueuedScan) => ({
  orderNumber: s.orderNumber,
  barcode: s.barcode,
  mode: s.mode,
  customerListId: s.customerListId,
  scannedAt: s.scannedAt,
  lat: s.lat,
  lng: s.lng,
  accuracyM: s.accuracyM,
});
