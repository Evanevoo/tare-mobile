import { create } from 'zustand';
import { reduce, empty, pending, queued, type Action, type Outbox, type Mode, type QueuedScan }
  from './outbox';
import { ulid } from './ulid';
import { loadOutbox, saveOutbox, cacheGet, cacheSet } from './db';
import { fetchBootstrap, postScans, sessionIdentity, SyncRefused, BOOTSTRAP_VERSION, type Bootstrap }
  from './api';

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

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  dispatch: (a: Action) => void;
  addScan: (barcode: string, geo?: { lat: number; lng: number; accuracyM: number | null }) => 'added' | 'duplicate' | 'unknown';
  startDelivery: (customerListId: string, customerName: string, orderNumber: string) => void;
  endDelivery: () => void;
  setMode: (m: Mode) => void;
  sync: () => Promise<void>;
  handOver: () => Promise<void>;
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
  customerListId: null,
  customerName: null,
  orderNumber: null,
  mode: 'SHIP',
  blocked: null,
  unresolved: [],

  async hydrate() {
    const [outbox, cached, lastSync, job, who] = await Promise.all([
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

    // Restore the job in flight, if there was one. A driver who force-quit at
    // bottle thirty comes back to bottle thirty.
    set({
      outbox, boot, lastSync, ready: true,
      email: who?.email ?? null,
      customerListId: job?.customerListId ?? null,
      customerName: job?.customerName ?? null,
      orderNumber: job?.orderNumber ?? null,
      mode: job?.mode ?? 'SHIP',
    });
    get().refresh().catch(() => {});
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
  async handOver() {
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
    });
    await Promise.all([
      saveOutbox(empty).catch(() => {}),
      cacheSet('delivery', null).catch(() => {}),
      cacheSet('bootstrap', null).catch(() => {}),
      cacheSet('lastSync', null).catch(() => {}),
    ]);
  },

  async refresh() {
    try {
      const boot = await fetchBootstrap();
      await cacheSet('bootstrap', boot);
      set({ boot, online: true, lastError: null });
    } catch (e: any) {
      set({ online: false, lastError: e?.message ?? 'Offline' });
    }
  },

  dispatch(action) {
    const outbox = reduce(get().outbox, action);
    set({ outbox });
    saveOutbox(outbox).catch(() => {});   // fire and forget; state is already correct
  },

  /**
   * The scan loop. Returns what happened so the screen can pick the right
   * haptic — a driver with gloves on judges the app by whether the buzz
   * matches what they saw.
   */
  addScan(barcode, geo) {
    const { orderNumber, customerListId, mode, outbox, boot } = get();
    if (!orderNumber || !customerListId) return 'unknown';

    const existing = outbox.scans.find(
      (s) => s.orderNumber === orderNumber && s.barcode === barcode);
    if (existing && existing.mode === mode) return 'duplicate';

    const scan: QueuedScan = {
      clientId: ulid(),
      orderNumber, barcode, mode, customerListId,
      scannedAt: new Date().toISOString(),
      lat: geo?.lat ?? null, lng: geo?.lng ?? null, accuracyM: geo?.accuracyM ?? null,
      state: 'QUEUED',
    };
    get().dispatch({ type: 'ENQUEUE', scan });

    // Unknown barcodes are still accepted — never rejected in the field.
    return boot && !(barcode in boot.assets) ? 'unknown' : 'added';
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
    set({ customerListId, customerName, orderNumber, mode: 'SHIP' });
    cacheSet('delivery', { customerListId, customerName, orderNumber, mode: 'SHIP' })
      .catch(() => {});
  },
  endDelivery() {
    set({ customerListId: null, customerName: null, orderNumber: null });
    cacheSet('delivery', null).catch(() => {});
  },
  setMode(mode) {
    set({ mode });
    const { customerListId, customerName, orderNumber } = get();
    if (!orderNumber) return;
    cacheSet('delivery', { customerListId, customerName, orderNumber, mode }).catch(() => {});
  },

  async sync() {
    const { outbox, syncing } = get();
    if (syncing) return;
    const toSend = queued(outbox);
    if (!toSend.length) return;

    const ids = toSend.map((s) => s.clientId);
    set({ syncing: true, lastError: null });
    get().dispatch({ type: 'BEGIN_UPLOAD', clientIds: ids });

    try {
      /**
       * THE SERVER'S ANSWER WAS THROWN AWAY.
       *
       * `await postScans(toSend)` discarded a `SyncResult` that carries
       * `unresolved` — the barcodes the server accepted but could not match to
       * any asset. Every row was then marked SENT regardless, so a bottle
       * scanned against a barcode nobody owns vanished from the phone looking
       * exactly like a successful delivery. The driver had the only remaining
       * evidence and no reason to think anything was wrong.
       *
       * The rows still go to SENT — they ARE on the server, and pretending
       * otherwise would make the next sync post them twice — but the count
       * comes back to the driver so the unknown barcode gets dealt with while
       * the truck is still at the customer.
       */
      const result = await postScans(toSend);
      get().dispatch({ type: 'UPLOAD_OK', clientIds: ids });
      const now = new Date().toISOString();
      await cacheSet('lastSync', now);
      set({
        online: true,
        lastSync: now,
        lastError: result.unresolved?.length
          ? `${result.unresolved.length} barcode${result.unresolved.length === 1 ? '' : 's'} uploaded but `
            + `${result.unresolved.length === 1 ? 'is' : 'are'} not on the fleet: `
            + `${result.unresolved.slice(0, 3).join(', ')}`
            + `${result.unresolved.length > 3 ? '…' : ''}. The office has to add or correct `
            + `${result.unresolved.length === 1 ? 'it' : 'them'}.`
          : null,
        unresolved: result.unresolved ?? [],
      });
      get().refresh().catch(() => {});
    } catch (e: any) {
      // Nothing is lost. The rows go back in line and the next sync retries;
      // if the server did receive them, the replay posts zero.
      get().dispatch({ type: 'UPLOAD_FAILED', clientIds: ids });

      /*
        A REFUSAL IS NOT OFFLINE. Setting `online: false` on every failure is
        what turned a billing lockout and an expired session into "Offline —
        nothing is lost", which is the one message that tells the driver to
        keep trying. `SyncRefused` means the server answered; the connection is
        fine and pressing Sync again will not help.
      */
      const refused = e instanceof SyncRefused;
      set({
        online: refused ? true : false,
        blocked: refused ? e.status : null,
        lastError: e?.message ?? 'Sync failed',
      });
    } finally {
      set({ syncing: false });
    }
  },
}));

export const usePendingCount = () => useStore((s) => pending(s.outbox).length);
