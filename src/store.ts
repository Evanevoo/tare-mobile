import { create } from 'zustand';
import { reduce, empty, pending, queued, type Action, type Outbox, type Mode, type QueuedScan }
  from './outbox';
import { ulid } from './ulid';
import { loadOutbox, saveOutbox, cacheGet, cacheSet, dbUnavailable as dbFlag, storageMode } from './db';
import {
  fetchBootstrap, postScans, sessionIdentity, SyncRefused, BOOTSTRAP_VERSION, MAX_SYNC_BATCH,
  fetchOrderTarget, type Bootstrap,
} from './api';
import type { TargetLine } from './target-progress.ts';
import { registerPush, deregisterPush } from './notifications';
import { matchesFormat } from './formats';

interface State {
  ready: boolean;
  outbox: Outbox;
  boot: Bootstrap | null;
  /**
   * The signed-in address, read off the device's own session rather than the
   * download. Survives a dead server; `boot` does not.
   */
  email: string | null;
  online: boolean;
  syncing: boolean;
  lastError: string | null;
  lastSync: string | null;
  /**
   * THE LOCAL DATABASE, WHEN IT IS GONE.
   *
   * `db.ts` exports this the moment SQLite fails to open, but nothing ever
   * read it — the flag existed, degraded the app to online-only exactly as
   * designed, and told nobody. A driver whose phone hit this kept scanning
   * against a screen that looked completely normal, every scan sitting in
   * memory only, and found out at the end of the shift when the app closed
   * and the whole thing evaporated with no error anywhere. A message here is
   * the only thing that turns "silently gone" into "seen and worked around."
   */
  dbUnavailable: string | null;

  // the delivery in progress
  customerListId: string | null;
  customerName: string | null;
  orderNumber: string | null;
  mode: Mode;
  /**
   * The server answered and said no. 402 = the account is read-only, 401/403 =
   * the session is gone. Distinct from `online`, because "no signal" and "the
   * server refuses you" need opposite advice and used to render identically.
   */
  blocked: number | null;
  /** Barcodes the last sync uploaded that match no asset on the fleet. */
  unresolved: string[];
  /**
   * What the current order's Sales Order says should ship — "3 Argon, 2
   * Oxygen" — for the live checklist. Null means "nothing to show": no
   * Sales Order for this order yet, a walk-in, or simply not fetched yet.
   * Never blocks anything; see fetchTarget and api.ts's fetchOrderTarget.
   */
  orderTarget: TargetLine[] | null;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  dispatch: (a: Action) => void;
  addScan: (barcode: string, geo?: { lat: number; lng: number; accuracyM: number | null }) =>
    { kind: 'added' | 'duplicate' | 'unknown'; offFormat: boolean };
  startDelivery: (customerListId: string, customerName: string, orderNumber: string) => void;
  /**
   * Fire-and-forget: ask the server what this order's Sales Order says
   * should ship. Never awaited by a caller that needs to keep moving — see
   * the doc comment on api.ts's fetchOrderTarget for why a failure here is
   * silent rather than surfaced.
   */
  fetchTarget: (orderNumber: string) => void;
  endDelivery: () => void;
  setMode: (m: Mode) => void;
  sync: () => Promise<void>;
  /**
   * Wipe this phone for the next driver. Refuses, and changes nothing, while
   * scans are still unsent — see the implementation. `force` overrides, and is
   * only ever passed by a person who has been shown the count.
   */
  handOver: (opts?: { force?: boolean }) => Promise<{ handed: boolean; unsent: number }>;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  outbox: empty,
  boot: null,
  email: null,
  online: true,
  syncing: false,
  lastError: null,
  lastSync: null,
  dbUnavailable: null,
  customerListId: null,
  customerName: null,
  orderNumber: null,
  mode: 'SHIP',
  blocked: null,
  unresolved: [],
  orderTarget: null,

  async hydrate() {
    const [loaded, cached, lastSync, job, who] = await Promise.all([
      loadOutbox(),
      cacheGet<Bootstrap>('bootstrap'),
      cacheGet<string>('lastSync'),
      cacheGet<{
        customerListId: string; customerName: string; orderNumber: string; mode: Mode;
      }>('delivery'),
      sessionIdentity().catch(() => null),
    ]);

    // A cache written by an older build has a different shape: `assets` used to
    // be barcode -> string and is now barcode -> object. Reading `.p` off a
    // string does not throw where it happens; it yields undefined, and the
    // crash surfaces three screens later — the worst kind of bug to debug from
    // a yard. So the payload carries a version, and anything that does not
    // match is discarded and refetched rather than trusted.
    const boot = cached && cached.v === BOOTSTRAP_VERSION ? cached : null;

    /**
     * ANYTHING STILL "UPLOADING" ON DISK IS A CORPSE. RESURRECT IT.
     *
     * This app is starting, so no upload can be in flight — any row left in
     * UPLOADING is from a process that died between BEGIN_UPLOAD and either
     * answer. Nothing else in the app will ever touch those rows again:
     * sync() sends `queued()`, which is QUEUED only, and the one transition
     * out of UPLOADING lives in a catch block that a killed process never
     * runs. Cost of leaving them: a whole delivery silently stranded on the
     * phone for ever (Flatstone, 19 Aug). Cost of re-sending one the server
     * already has: nothing, because the ingest dedupes and replays zero.
     *
     * Persisted immediately rather than left to the fire-and-forget write in
     * dispatch(), because the entire point is surviving the next crash.
     */
    const recovered = reduce(loaded, { type: 'RECOVER_INFLIGHT' });
    const outbox = recovered;
    const strandedCount = loaded.scans.filter((s) => s.state === 'UPLOADING').length;
    if (strandedCount) {
      await saveOutbox(recovered).catch(() => {});
    }

    // Restore the job in flight, if there was one. A driver who force-quit at
    // bottle thirty comes back to bottle thirty.
    /*
      A RESTORED JOB WITH NOTHING LEFT IN IT IS A GHOST.

      `endDelivery()` clears the job and writes `cacheSet('delivery', null)` —
      but that write is fire-and-forget and its failure is swallowed, which is
      right (a driver must not be blocked by a disk write) and leaves one hole:
      if it does not land, hydrate faithfully restores the finished job on the
      NEXT launch. And the one after. Dismissing it only clears memory, so it
      returns every single time the app opens.

      Reported 2 Sep 2026 — S50404, "still open, 0 scanned", after the order
      had been scanned and submitted twice over. All six scans were on the
      server; only the pointer was stuck.

      So the outbox decides, not the cache. A job whose scans have all
      uploaded has nothing left to resume: the card would offer to continue
      work that is already done. A job with anything still queued is restored
      exactly as before — that is the force-quit-at-bottle-thirty case this
      cache exists for, and it is untouched.

      Self-healing rather than a stricter write: the write can always fail, on
      any phone, and this makes that harmless instead of permanent.
    */
    const jobHasWork = job?.orderNumber
      ? outbox.scans.some((sc) => sc.orderNumber === job.orderNumber)
      : false;
    const liveJob = jobHasWork ? job : null;
    if (job && !jobHasWork) {
      // Try once more to clear it, so the next launch does not repeat this.
      cacheSet('delivery', null).catch(() => {});
    }

    set({
      outbox, boot, lastSync, ready: true,
      email: who?.email ?? null,
      // Set by loadOutbox()'s own call to open() above, so it is current by
      // the time this reads it — an ES module `let` export is a live binding,
      // not a snapshot taken at import time.
      // Not `dbFlag`. That says "SQLite failed", which is true on some phones
      // and no longer means the scans are at risk — the AsyncStorage fallback
      // in db.ts holds them. Warning a driver that nothing is being saved
      // while it IS being saved is how a banner stops being believed.
      dbUnavailable: storageMode === 'none' ? (dbFlag ?? 'Could not save to this phone.') : null,
      customerListId: liveJob?.customerListId ?? null,
      customerName: liveJob?.customerName ?? null,
      orderNumber: liveJob?.orderNumber ?? null,
      mode: liveJob?.mode ?? 'SHIP',
    });
    get().refresh().catch(() => {});
    // A relaunch mid-job restores the order but not its target — the
    // checklist would otherwise sit empty until the driver went back to
    // Delivery and started again. Same fire-and-forget contract as
    // startDelivery's own call below.
    if (liveJob?.orderNumber) get().fetchTarget(liveJob.orderNumber);
  },

  /**
   * SIGNING OUT HANDS THE PHONE TO SOMEBODY ELSE.
   *
   * `signOut()` cleared the Supabase session and nothing else. The outbox is
   * on disk and the delivery job is in the cache, so both survived — and
   * `hydrate()` faithfully restored them for whoever signed in next. The next
   * driver started their shift already holding the previous driver's queue and
   * their half-finished job, and the moment they synced, those scans posted
   * under the new driver's token: the wrong name on the evidence, on the
   * packet, and on the "Recorded by" line of a document sent to a customer.
   *
   * The confirmation dialog has always said unsent scans "will be lost". That
   * was the honest intent and it simply was not implemented; this makes the
   * warning true rather than quietly doing something worse than it promises.
   *
   * Order matters. Local state is cleared BEFORE the session drops, so a
   * failure to reach Supabase cannot leave one driver's work sitting under
   * another driver's login.
   */
  async handOver(opts) {
    /**
     * A HAND-OVER MAY NEVER DESTROY WORK. THIS GUARD IS THE WHOLE POINT.
     *
     * This function used to clear the outbox unconditionally, and the idle
     * timer in src/guard.tsx calls it after sixty minutes with no touch. So:
     * a driver scans forty bottles in a dead zone, presses Submit, the upload
     * fails, the rows go back to QUEUED, the phone sits in the cradle for a
     * long drive with nobody touching the screen — and at the hour mark the
     * app deleted all forty from memory AND from disk, with no upload attempt
     * and no warning anyone was awake to read.
     *
     * That is the exact loss the entire offline design exists to prevent, and
     * it is the one RECOVER_INFLIGHT cannot undo, because recovery reads the
     * database and this had already emptied it.
     *
     * So: try to send first, and if anything is still unsent, REFUSE. The
     * caller decides what to do with a refusal — the idle timer blocks the
     * phone instead of signing out, which keeps the security promise (nobody
     * else can use it) without paying for it in somebody's shift.
     *
     * `force` exists for the deliberate Settings sign-out, where a person has
     * been shown the count and has chosen. Nothing calls it automatically.
     */
    try {
      await get().sync();
    } catch {
      // Offline. The count below decides; a failed send is not a reason to
      // discard, it is the reason the guard exists.
    }
    const unsent = pending(get().outbox).length;
    if (unsent && !opts?.force) return { handed: false, unsent };

    // The push token first, while the session still exists to authorize the
    // request — after signOut nothing can. Never blocks the hand-over; a
    // dead zone just leaves a token the send-side prunes on first bounce.
    await deregisterPush();
    set({
      outbox: empty,
      boot: null,
      email: null,
      lastError: null,
      lastSync: null,
      customerListId: null,
      customerName: null,
      orderNumber: null,
      mode: 'SHIP',
      blocked: null,
      unresolved: [],
      orderTarget: null,
    });
    await Promise.all([
      saveOutbox(empty).catch(() => {}),
      cacheSet('delivery', null).catch(() => {}),
      cacheSet('bootstrap', null).catch(() => {}),
      cacheSet('lastSync', null).catch(() => {}),
    ]);
    return { handed: true, unsent: 0 };
  },

  async refresh() {
    try {
      const boot = await fetchBootstrap();
      await cacheSet('bootstrap', boot);
      set({ boot, online: true, lastError: null });
      // A successful signed-in bootstrap is the moment this phone provably
      // belongs to somebody — register it for pushes. Fire-and-forget and
      // internally guarded (see src/notifications.ts): on builds without
      // the native module, or with no Firebase config, it is a no-op.
      registerPush();
    } catch (e: any) {
      set({ online: false, lastError: e?.message ?? 'Offline' });
    }
  },

  dispatch(action) {
    const outbox = reduce(get().outbox, action);
    set({ outbox });
    // Fire and forget for the happy path — in-memory state is already
    // correct and a driver must never wait on a disk write between two
    // scans. But a `false` here means this scan is NOT on disk, and that used
    // to vanish into an ignored promise. Surfacing it is what lets the screen
    // say so instead of the shift finding out when the app closes.
    saveOutbox(outbox).then((ok) => {
      // `ok` is now true when the AsyncStorage fallback took the write, so a
      // phone with broken SQLite stops shouting about it. Only a genuine
      // nowhere-to-write is worth a banner. See storageMode in db.ts.
      if (!ok) set({ dbUnavailable: 'Could not save to this phone.' });
      else if (get().dbUnavailable) set({ dbUnavailable: null });
    }).catch(() => {});
  },

  /**
   * The scan loop. Returns what happened so the screen can pick the right
   * haptic — a driver with gloves on judges the app by whether the buzz
   * matches what they saw.
   */
  addScan(barcode, geo) {
    const { orderNumber, customerListId, mode, outbox, boot } = get();
    if (!orderNumber || !customerListId) return { kind: 'unknown', offFormat: false };

    // Only a row still pending can be "already scanned this trip" — a SENT
    // row is history from an earlier sync in this same job and must not
    // silently swallow a legitimate new scan of the same bottle. Mirrors the
    // fix in outbox.ts's ENQUEUE reducer; see the comment there for the
    // SHIP-then-RETURN-then-RETURN case this was dropping.
    const existing = outbox.scans.find(
      (s) => s.orderNumber === orderNumber && s.barcode === barcode && s.state !== 'SENT');
    if (existing && existing.mode === mode) return { kind: 'duplicate', offFormat: false };

    // Unknown barcodes are still accepted — never rejected in the field.
    const unknown = !!boot && !(barcode in boot.assets);
    // See the long comment in scan.tsx's take() for why BOTH conditions
    // matter: a code the fleet already knows is right by definition, so this
    // only fires for a code that is both new to the fleet AND does not look
    // like one of ours. Computed here (not just in scan.tsx) so the flag can
    // live on the row itself and still read correctly from History days
    // later, instead of only flashing at the moment of the scan.
    const offFormat = unknown && !matchesFormat(barcode, boot?.formats?.barcode);

    const scan: QueuedScan = {
      clientId: ulid(),
      orderNumber, barcode, mode, customerListId,
      scannedAt: new Date().toISOString(),
      lat: geo?.lat ?? null, lng: geo?.lng ?? null, accuracyM: geo?.accuracyM ?? null,
      state: 'QUEUED',
      offFormat,
    };
    get().dispatch({ type: 'ENQUEUE', scan });

    return { kind: unknown ? 'unknown' : 'added', offFormat };
  },

  /**
   * THE JOB SURVIVES THE APP DYING.
   *
   * Scans were always safe — every dispatch writes the outbox to SQLite, so a
   * force-quit mid-load loses nothing that was scanned. But the *job* around
   * them lived only in memory: customer, order number and direction. Relaunch
   * and they came back null, `scan.tsx` bounced the driver to Home, and forty
   * scans sat in the outbox belonging to an order the app could no longer show
   * them. They would still upload on the next sync, so nothing was lost — but
   * a driver who cannot see the job assumes it is gone and scans the load
   * again, and a double-scanned load is a real problem even when the server
   * dedupes it.
   *
   * So the job is written down too. Same cache the bootstrap uses, one small
   * object, rewritten only when a delivery starts, ends, or changes direction
   * — three times a job, not once a scan.
   */
  startDelivery(customerListId, customerName, orderNumber) {
    // orderTarget cleared immediately, not left over from whatever order
    // came before — showing yesterday's checklist against today's order for
    // the few hundred milliseconds before the fetch below lands would be a
    // real, if brief, wrong answer.
    set({ customerListId, customerName, orderNumber, mode: 'SHIP', orderTarget: null });
    cacheSet('delivery', { customerListId, customerName, orderNumber, mode: 'SHIP' })
      .catch(() => {});
    get().fetchTarget(orderNumber);
  },
  /**
   * See the doc comment on api.ts's fetchOrderTarget: this never throws
   * outward, never sets `lastError`, and is never awaited by a caller that
   * needs to keep moving. An order with no Sales Order behind it yet — most
   * of them, until rung two of the QuickBooks work lands — simply keeps
   * orderTarget null, and the screen falls back to exactly what it shows
   * today.
   */
  fetchTarget(orderNumber) {
    fetchOrderTarget(orderNumber)
      .then((t) => {
        // The driver may have already moved to a different order (or ended
        // the delivery) by the time a slow response lands — a stale target
        // for the wrong order would be worse than none.
        if (get().orderNumber !== orderNumber) return;
        set({ orderTarget: t.lines.map((l) => ({ productCode: l.productCode, quantity: l.quantity })) });
      })
      .catch(() => {});
  },
  endDelivery() {
    set({ customerListId: null, customerName: null, orderNumber: null, orderTarget: null });
    cacheSet('delivery', null).catch(() => {});
  },
  setMode(mode) {
    set({ mode });
    const { customerListId, customerName, orderNumber } = get();
    if (!orderNumber) return;
    cacheSet('delivery', { customerListId, customerName, orderNumber, mode }).catch(() => {});
  },

  /**
   * Drain the outbox to the server, one chunk of at most `MAX_SYNC_BATCH` at
   * a time.
   *
   * A SHIFT'S QUEUE USED TO BE SENT AS ONE REQUEST, WHATEVER ITS SIZE.
   *
   * The server has always capped a batch at 2,000 scans (`Batch` in
   * api/scans/route.ts) and `postScans` has always sent exactly what it was
   * handed — it does not chunk. A driver who went a whole shift with no
   * signal, or whose queue survived several missed syncs, could carry more
   * than 2,000 scans by the time a bar of signal finally showed up. That one
   * oversized request came back a permanent 400 — not a retryable "offline",
   * a batch the server will never accept — and every scan in it sat on the
   * phone forever, because nothing here ever split it smaller and tried
   * again. Chunking here, on the one caller that can ever exceed the cap, is
   * what keeps a big queue draining instead of wedging solid.
   *
   * Each chunk is BEGIN_UPLOAD → post → UPLOAD_OK/UPLOAD_FAILED on its own,
   * so a failure partway through leaves the earlier chunks correctly SENT
   * and only the chunk in flight (plus whatever never got a turn) back in
   * QUEUED for the next sync — nothing already accepted is re-sent, nothing
   * still queued is lost.
   */
  async sync() {
    const { outbox, syncing } = get();
    if (syncing) return;
    const toSend = queued(outbox);
    if (!toSend.length) return;

    set({ syncing: true, lastError: null });

    const allUnresolved: string[] = [];
    let anyUploaded = false;

    const persistProgress = async () => {
      const now = new Date().toISOString();
      await cacheSet('lastSync', now).catch(() => {});
      set({ lastSync: now });
    };

    for (let i = 0; i < toSend.length; i += MAX_SYNC_BATCH) {
      const chunk = toSend.slice(i, i + MAX_SYNC_BATCH);
      const ids = chunk.map((s) => s.clientId);
      get().dispatch({ type: 'BEGIN_UPLOAD', clientIds: ids });

      try {
        /**
         * THE SERVER'S ANSWER WAS THROWN AWAY.
         *
         * `await postScans(toSend)` discarded a `SyncResult` that carries
         * `unresolved` — the barcodes the server accepted but could not match
         * to any asset. Every row was then marked SENT regardless, so a
         * bottle scanned against a barcode nobody owns vanished from the
         * phone looking exactly like a successful delivery. The driver had
         * the only remaining evidence and no reason to think anything was
         * wrong.
         *
         * The rows still go to SENT — they ARE on the server, and pretending
         * otherwise would make the next sync post them twice — but the count
         * comes back to the driver so the unknown barcode gets dealt with
         * while the truck is still at the customer.
         */
        const result = await postScans(chunk);
        get().dispatch({ type: 'UPLOAD_OK', clientIds: ids });
        anyUploaded = true;
        if (result.unresolved?.length) allUnresolved.push(...result.unresolved);
      } catch (e: any) {
        // Nothing is lost. This chunk goes back in line and the next sync
        // retries it (and anything after it that never got a turn); if the
        // server did receive it, the replay posts zero.
        get().dispatch({ type: 'UPLOAD_FAILED', clientIds: ids });

        /*
          A REFUSAL IS NOT OFFLINE. Setting `online: false` on every failure is
          what turned a billing lockout and an expired session into "Offline —
          nothing is lost", which is the one message that tells the driver to
          keep trying. `SyncRefused` means the server answered; the connection
          is fine and pressing Sync again will not help.
        */
        const refused = e instanceof SyncRefused;
        set({
          online: refused ? true : false,
          blocked: refused ? e.status : null,
          lastError: e?.message ?? 'Sync failed',
          syncing: false,
        });
        // Earlier chunks in THIS call did upload — record that before
        // stopping, so a partial drain still moves lastSync forward.
        if (anyUploaded) await persistProgress();
        return;
      }
    }

    await persistProgress();
    set({
      syncing: false,
      online: true,
      blocked: null,
      lastError: allUnresolved.length
        ? `${allUnresolved.length} barcode${allUnresolved.length === 1 ? '' : 's'} uploaded but `
          + `${allUnresolved.length === 1 ? 'is' : 'are'} not on the fleet: `
          + `${allUnresolved.slice(0, 3).join(', ')}`
          + `${allUnresolved.length > 3 ? '…' : ''}. The office has to add or correct `
          + `${allUnresolved.length === 1 ? 'it' : 'them'}.`
        : null,
      unresolved: allUnresolved,
    });
    get().refresh().catch(() => {});
  },
}));

export const usePendingCount = () => useStore((s) => pending(s.outbox).length);
