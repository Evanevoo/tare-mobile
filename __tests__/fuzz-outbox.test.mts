/**
 * node --experimental-strip-types __tests__/fuzz-outbox.test.mts
 *
 * Seeded property fuzzing of the outbox state machine (src/outbox.ts).
 *
 * Two kinds of run:
 *   - STORE-SHAPED: action sequences the app can actually produce — scans via
 *     the addScan rule, flips and removals of QUEUED rows, retags, a sync that
 *     sends only `sendable` rows and answers with UPLOAD_OK / UPLOAD_FAILED
 *     (with driver actions interleaved while it is in flight), crashes
 *     (RECOVER_INFLIGHT), server edits of SENT rows, sign-in changes.
 *   - ARBITRARY: any action with any ids, including ids that do not exist and
 *     answers for batches that were never begun, to check the reducer alone.
 *
 * After every step the transition is checked against what the reducer is
 * allowed to do: no row lost except by REMOVE (QUEUED), CLEAR_SENT (SENT) or a
 * server drop (SENT); no row in two states; nothing ever leaves SENT; no row
 * created except by ENQUEUE; rows that are not QUEUED never edited by the
 * phone; owner rules hold for every login.
 *
 * Duplicate ROWS for one bottle — the same (order, barcode, mode) twice — are
 * reachable in two ways, both by design: a queued correction undone (K1, via
 * ENQUEUE or TOGGLE), and a server edit landing a SENT row beside a QUEUED
 * copy the server has not seen. Both rows upload, the server keeps one, and
 * every screen counts through distinctScans, which the derived-view check
 * below holds to. A server edit that makes a second SENT copy — the ledger
 * keeps one, so the phone would be telling a different story — is K2, fixed
 * 1 Oct 2026, and fails here. So does any other way of producing a duplicate.
 */
import {
  reduce, empty, latestScan, retagBlockedBy, pending, queued, inFlight,
  ownerStamp, heldForOther, sendable, unsentMine, waitingForOthers, sendAs, OwnerChanged,
  counts, toWire, scanKey, distinctScans,
  type QueuedScan, type Outbox, type Action, type Mode, type Me,
} from '../src/outbox.ts';
import { prng, seedFromEnv, harness, iters, messyString, show, type Rng } from './fuzz-kit.mts';

const SEED = seedFromEnv(0x5ca11ed);
const h = harness('fuzz-outbox.test.mts', SEED);
const r = prng(SEED);

/* ------------------------------------------------------------ the world */

// Small pools so collisions (same bottle, same order) happen constantly.
const ORDERS = ['INV-1', 'INV-2', 'INV-3', 'S100'];
const BARCODES = ['B1', 'B2', 'B3', 'B4', 'B5'];
const CUSTOMERS = ['CUST-A', 'CUST-B'];

// People. A and B are different people: different ids AND different addresses.
// A2 is A again under a new id (removed and re-added) with the address in
// another case; A3 is A known only by id (offline, no address readable).
type Person = { tag: string; me: Me; person: 'A' | 'B' | 'C' | 'nobody' };
const PEOPLE: Person[] = [
  { tag: 'A', me: { id: 'u-a', email: 'mike.t@crew.scanified.com' }, person: 'A' },
  { tag: 'A2', me: { id: 'u-a-new', email: '  MIKE.T@Crew.Scanified.com ' }, person: 'A' },
  { tag: 'A3', me: { id: 'u-a', email: null }, person: 'A' },
  { tag: 'B', me: { id: 'u-b', email: 'jane@example.com' }, person: 'B' },
  { tag: 'B-email-only', me: { id: null, email: 'Jane@Example.com' }, person: 'B' },
  { tag: 'C', me: { id: 'u-c', email: 'carl@example.com' }, person: 'C' },
  { tag: 'nobody', me: null, person: 'nobody' },
];
const personOf = new Map<string, Person['person']>(); // owner id/email → person
for (const p of PEOPLE) {
  if (p.me?.id) personOf.set(`id:${p.me.id}`, p.person);
  if (p.me?.email) personOf.set(`em:${p.me.email.trim().toLowerCase()}`, p.person);
}
/** Independent oracle: which person a stamped row belongs to, or 'legacy'. */
const rowPerson = (s: QueuedScan) => {
  if (!s.ownerId && !s.ownerEmail) return 'legacy';
  return (s.ownerId && personOf.get(`id:${s.ownerId}`))
    || (s.ownerEmail && personOf.get(`em:${s.ownerEmail.trim().toLowerCase()}`))
    || 'stranger';
};

let nextId = 0;
const freshId = () => `c${String(nextId++).padStart(7, '0')}`;
const flip = (m: Mode): Mode => (m === 'SHIP' ? 'RETURN' : 'SHIP');

function makeScan(rr: Rng, who: Person | null, over: Partial<QueuedScan> = {}): QueuedScan {
  return {
    clientId: freshId(),
    orderNumber: rr.pick(ORDERS),
    barcode: rr.pick(BARCODES),
    mode: rr.bool() ? 'SHIP' : 'RETURN',
    customerListId: rr.pick(CUSTOMERS),
    scannedAt: new Date(1_790_000_000_000 + rr.int(1e8)).toISOString(),
    lat: null, lng: null, accuracyM: null,
    state: 'QUEUED',
    ...(who ? ownerStamp(who.me, who.tag) : {}),
    ...over,
  };
}

/* ------------------------------------------------------------ invariants */

const FIELDS = ['orderNumber', 'barcode', 'mode', 'customerListId'] as const;
const sameFields = (a: QueuedScan, b: QueuedScan) => FIELDS.every((f) => a[f] === b[f]);

/** Rows beyond the first for each (order, barcode, mode). Zero means "counted once". */
function excess(o: Outbox): number {
  const seen = new Map<string, number>();
  for (const s of o.scans) {
    const k = `${s.orderNumber}\u0000${s.barcode}\u0000${s.mode}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let n = 0;
  for (const c of seen.values()) n += c - 1;
  return n;
}

/** Rows beyond the first for each key among SENT rows only: what the ledger would disagree with. */
const excessSent = (o: Outbox) => excess({ scans: o.scans.filter((s) => s.state === 'SENT') });

/**
 * When a server edit may take a row off the phone. A drop takes the SENT rows
 * it names (one direction when it names one — K3). A flip or move takes a SENT
 * row only when the row it would become is already SENT there, as the server
 * does (K2): never a row it was not about, and never because of a queued copy.
 */
function serverEditMayDrop(pre: Outbox, a: Extract<Action, { type: 'APPLY_SERVER_EDIT' }>, p: QueuedScan): boolean {
  if (p.state !== 'SENT' || p.orderNumber !== a.orderNumber || (a.barcode && p.barcode !== a.barcode)) return false;
  if (a.drop) {
    const which = a.from ?? a.mode;
    return !which || p.mode === which;
  }
  const from = a.mode ? (a.from ?? flip(a.mode)) : a.from;
  if (from && p.mode !== from) return false;
  const on = a.toOrderNumber || p.orderNumber, m = a.mode || p.mode;
  if (on === p.orderNumber && m === p.mode) return false;
  return pre.scans.some((q) => q !== p && q.state === 'SENT' && q.orderNumber === on && q.barcode === p.barcode && q.mode === m);
}

/**
 * Everything the reducer is allowed to do in one step. Returns why it broke
 * the rules, or null. `strict` adds the rules that only hold for sequences the
 * app can produce (UPLOAD_OK only ever answers rows that are UPLOADING).
 */
function checkStep(pre: Outbox, a: Action, post: Outbox, strict: boolean): string | null {
  const preById = new Map(pre.scans.map((s) => [s.clientId, s]));
  const postById = new Map(post.scans.map((s) => [s.clientId, s]));
  if (postById.size !== post.scans.length) return 'two rows share a clientId (one scan in two states)';

  for (const s of post.scans) {
    if (!['QUEUED', 'UPLOADING', 'SENT'].includes(s.state)) return `bad state ${s.state}`;
    if (s.mode !== 'SHIP' && s.mode !== 'RETURN') return `bad mode ${s.mode}`;
  }

  for (const [id] of postById) {
    if (preById.has(id)) continue;
    if (!(a.type === 'ENQUEUE' && a.scan.clientId === id)) return `row ${id} appeared from ${a.type}`;
  }

  for (const [id, p] of preById) {
    if (postById.has(id)) continue;
    const allowed =
      (a.type === 'REMOVE' && a.clientId === id && p.state === 'QUEUED')
      || (a.type === 'CLEAR_SENT' && p.state === 'SENT')
      || (a.type === 'APPLY_SERVER_EDIT' && serverEditMayDrop(pre, a, p));
    if (!allowed) return `row ${id} (${p.state}) LOST by ${a.type}`;
  }

  const ids = 'clientIds' in a ? new Set(a.clientIds) : new Set<string>();
  for (const [id, p] of preById) {
    const q = postById.get(id);
    if (!q) continue;
    if (p.state !== q.state) {
      const ok =
        (p.state === 'QUEUED' && q.state === 'UPLOADING' && a.type === 'BEGIN_UPLOAD' && ids.has(id))
        || (p.state === 'UPLOADING' && q.state === 'QUEUED'
          && ((a.type === 'UPLOAD_FAILED' && ids.has(id)) || a.type === 'RECOVER_INFLIGHT'))
        || (q.state === 'SENT' && p.state !== 'SENT' && a.type === 'UPLOAD_OK' && ids.has(id)
          && (!strict || p.state === 'UPLOADING'));
      if (!ok) return `row ${id} moved ${p.state} -> ${q.state} on ${a.type}`;
    }
    if (!sameFields(p, q)) {
      // Phone-side edits touch QUEUED rows only; server edits touch SENT only.
      const phoneEdit = ['ENQUEUE', 'TOGGLE', 'RETAG'].includes(a.type);
      if (phoneEdit && p.state !== 'QUEUED') return `${p.state} row ${id} edited by ${a.type}`;
      if (a.type === 'APPLY_SERVER_EDIT' && p.state !== 'SENT') return `${p.state} row ${id} edited by a server edit`;
      if (!phoneEdit && a.type !== 'APPLY_SERVER_EDIT') return `row ${id} fields changed by ${a.type}`;
    }
  }

  // Survivors keep their relative order (History and latestScan depend on it).
  const order = post.scans.filter((s) => preById.has(s.clientId)).map((s) => s.clientId);
  const was = pre.scans.filter((s) => postById.has(s.clientId)).map((s) => s.clientId);
  if (order.join() !== was.join()) return `row order changed by ${a.type}`;

  if (a.type === 'ENQUEUE') {
    const { orderNumber: on, barcode: bc, mode } = a.scan;
    const before = latestScan(pre.scans, on, bc);
    if (before && before.mode === mode && post !== pre) return 'a repeat of the latest scan changed the outbox';
    const after = latestScan(post.scans, on, bc);
    if (!after || after.mode !== mode) return `after ENQUEUE ${mode}, the bottle's latest scan reads ${after?.mode}`;
  }

  // Derived views agree with the rows.
  const c = counts(post);
  // Screens count each bottle once per direction per order, however many rows.
  const bottles = new Set(post.scans.map(scanKey));
  if (c.total !== bottles.size || c.ship + c.ret !== c.total) return 'counts() is not one per (order, barcode, mode)';
  if (c.pending !== pending(post).length) return 'counts().pending is not unsent ROWS';
  const d = distinctScans(post.scans);
  if (d.length !== bottles.size
    || d.some((s) => post.scans.slice(post.scans.indexOf(s) + 1).some((x) => scanKey(x) === scanKey(s))))
    return 'distinctScans did not keep the latest row of each key';
  if (pending(post).length + post.scans.filter((s) => s.state === 'SENT').length !== post.scans.length)
    return 'pending() is not "everything but SENT"';
  if (queued(post).length + inFlight(post).length !== pending(post).length) return 'queued+inFlight != pending';
  return null;
}

/** Owner rules, checked for every login against the oracle above. */
function checkOwners(o: Outbox): string | null {
  for (const p of PEOPLE) {
    const send = sendable(o, p.me);
    const sendIds = new Set(send.map((s) => s.clientId));
    for (const s of send) {
      if (s.state !== 'QUEUED') return `sendable(${p.tag}) offered a ${s.state} row`;
      const owner = rowPerson(s);
      if (owner !== 'legacy' && owner !== p.person)
        return `sendable(${p.tag}) offered ${owner}'s row ${show({ id: s.ownerId, em: s.ownerEmail })}`;
    }
    for (const s of queued(o)) {
      if (rowPerson(s) === 'legacy' && !sendIds.has(s.clientId)) return `legacy row held from ${p.tag}`;
    }
    // A login with a known id or address gets its own QUEUED rows, whichever half it knows.
    if (p.person !== 'nobody') {
      for (const s of queued(o)) {
        const own = rowPerson(s) === p.person;
        const matchable = (s.ownerId && s.ownerId === p.me?.id)
          || (s.ownerEmail && p.me?.email && s.ownerEmail.trim().toLowerCase() === p.me.email.trim().toLowerCase());
        if (own && matchable && !sendIds.has(s.clientId)) return `${p.tag}'s own row held from them`;
      }
    } else if (send.some((s) => rowPerson(s) !== 'legacy')) {
      return 'with nobody signed in, a stamped row was sendable';
    }
    // Every pending row is either this login's to answer for or waiting for someone else.
    const mine = unsentMine(o, p.me).length;
    const waiting = waitingForOthers(o, p.me).reduce((n, w) => n + w.count, 0);
    if (mine + waiting !== pending(o).length) return `unsentMine+waitingForOthers != pending for ${p.tag}`;
  }
  return null;
}

/* ------------------------------------------------------------ store-shaped runs */

const tally = { K1_enqueue: 0, K1_toggle: 0, besideQueued: 0, collided: 0, steps: 0, sent: 0, recovered: 0 };

function storeShaped(rr: Rng, steps: number): string | null {
  let o: Outbox = empty;
  let who: Person = rr.pick(PEOPLE);
  let flight: string[] | null = null; // ids of the chunk in flight, if any

  const apply = (a: Action): string | null => {
    const pre = o;
    const post = reduce(pre, a);
    tally.steps++;
    const why = checkStep(pre, a, post, true);
    if (why) return `${why}\n      action: ${show(a)}\n      before: ${show(pre.scans.map(brief), 600)}`;
    if (a.type === 'APPLY_SERVER_EDIT' && excessSent(post) > excessSent(pre))
      return `K2: a server edit made a second SENT copy of one (order, barcode, mode): ${show(a)}
      before: ${show(pre.scans.map(brief), 600)}`;
    if (a.type === 'APPLY_SERVER_EDIT' && !a.drop && post.scans.length < pre.scans.length) tally.collided++;
    const grew = excess(post) - excess(pre);
    if (grew > 0) {
      if (a.type === 'ENQUEUE') tally.K1_enqueue++;
      else if (a.type === 'TOGGLE') tally.K1_toggle++;
      else if (a.type === 'APPLY_SERVER_EDIT' && (a.mode || a.toOrderNumber)) tally.besideQueued++;
      else return `a duplicate (order, barcode, mode) was created by ${a.type}: ${show(a)}\n      before: ${show(pre.scans.map(brief), 600)}`;
    }
    o = post;
    return null;
  };

  for (let i = 0; i < steps; i++) {
    const roll = rr.int(100);
    let why: string | null = null;

    if (roll < 40) {
      // A scan, through the same rule store.addScan applies before dispatching.
      const scan = makeScan(rr, rr.bool(0.1) ? null : who);
      const existing = latestScan(o.scans, scan.orderNumber, scan.barcode);
      if (existing && existing.mode === scan.mode) continue; // "duplicate" buzz, nothing dispatched
      why = apply({ type: 'ENQUEUE', scan });
    } else if (roll < 48) {
      const q = queued(o);
      if (!q.length) continue;
      const s = rr.pick(q);
      why = apply({ type: 'TOGGLE', orderNumber: s.orderNumber, barcode: s.barcode, mode: flip(s.mode) });
    } else if (roll < 52) {
      const q = queued(o);
      if (!q.length) continue;
      why = apply({ type: 'REMOVE', clientId: rr.pick(q).clientId });
    } else if (roll < 57) {
      const from = rr.pick(ORDERS);
      const to = rr.bool(0.8) ? rr.pick(ORDERS) : undefined;
      const blocked = to ? retagBlockedBy(o, from, to) : null;
      const before = o;
      why = apply({ type: 'RETAG', orderNumber: from, toOrderNumber: to, toCustomerListId: rr.bool(0.4) ? rr.pick(CUSTOMERS) : undefined });
      if (!why && blocked && o !== before) why = `retagBlockedBy said ${blocked} but RETAG went ahead`;
    } else if (roll < 70) {
      // Sync: start a chunk, or answer the one in flight.
      if (!flight) {
        const ids = sendable(o, who.me).map((s) => s.clientId).slice(0, rr.range(1, 8));
        if (!ids.length) continue;
        flight = ids;
        why = apply({ type: 'BEGIN_UPLOAD', clientIds: ids });
      } else {
        const okUp = rr.bool(0.7);
        why = apply({ type: okUp ? 'UPLOAD_OK' : 'UPLOAD_FAILED', clientIds: flight });
        if (okUp) tally.sent += flight.length;
        flight = null;
      }
    } else if (roll < 73) {
      // The app died. Whatever was in flight never gets an answer.
      flight = null;
      tally.recovered++;
      why = apply({ type: 'RECOVER_INFLIGHT' });
    } else if (roll < 80) {
      const sent = o.scans.filter((s) => s.state === 'SENT');
      if (!sent.length) continue;
      const s = rr.pick(sent);
      const kind = rr.int(4);
      // Shaped exactly as app/order/[orderNumber].tsx serverEditToLocal and scan.tsx build them.
      const a: Action = kind === 0
        ? { type: 'APPLY_SERVER_EDIT', orderNumber: s.orderNumber, barcode: s.barcode, from: s.mode, mode: flip(s.mode) }
        : kind === 1
          ? { type: 'APPLY_SERVER_EDIT', orderNumber: s.orderNumber, barcode: s.barcode, from: s.mode, drop: true }
          : kind === 2
            ? { type: 'APPLY_SERVER_EDIT', orderNumber: s.orderNumber, toOrderNumber: rr.pick(ORDERS) }
            : { type: 'APPLY_SERVER_EDIT', orderNumber: s.orderNumber, toCustomerListId: rr.pick(CUSTOMERS) };
      why = apply(a);
    } else if (roll < 84) {
      why = apply({ type: 'CLEAR_SENT' });
    } else if (roll < 90) {
      who = rr.pick(PEOPLE); // somebody else signs in on this phone
    } else {
      // Owner rules, any time.
      why = checkOwners(o);
    }
    if (why) return why;
  }
  return checkOwners(o);
}

const brief = (s: QueuedScan) =>
  `${s.clientId.slice(-3)}:${s.orderNumber}/${s.barcode}/${s.mode[0]}/${s.state[0]}${s.ownerId || s.ownerEmail ? `@${s.ownerName ?? '?'}` : ''}`;

/* ------------------------------------------------------------ arbitrary runs */

function arbitraryAction(rr: Rng, o: Outbox): Action {
  const someId = () => (o.scans.length && rr.bool(0.8) ? rr.pick(o.scans).clientId : rr.bool() ? freshId() : messyString(rr, 4));
  const ids = () => Array.from({ length: rr.range(0, 5) }, someId);
  const order = () => (rr.bool(0.85) ? rr.pick(ORDERS) : rr.pick(['', ' ', ' INV-1 ', 'inv-1', messyString(rr, 6)]));
  const mode = (): Mode => (rr.bool() ? 'SHIP' : 'RETURN');
  switch (rr.int(11)) {
    case 0: case 1: case 2: return { type: 'ENQUEUE', scan: makeScan(rr, rr.bool(0.3) ? null : rr.pick(PEOPLE), { orderNumber: order() }) };
    case 3: return { type: 'TOGGLE', orderNumber: order(), barcode: rr.pick(BARCODES), mode: mode() };
    case 4: return { type: 'REMOVE', clientId: someId() };
    case 5: return {
      type: 'RETAG', orderNumber: order(),
      toOrderNumber: rr.bool(0.8) ? order() : undefined,
      toCustomerListId: rr.bool(0.4) ? rr.pick([...CUSTOMERS, ' ', '']) : undefined,
    };
    case 6: return {
      type: 'APPLY_SERVER_EDIT', orderNumber: order(),
      barcode: rr.bool(0.7) ? rr.pick(BARCODES) : undefined,
      from: rr.bool(0.4) ? mode() : undefined,
      mode: rr.bool(0.4) ? mode() : undefined,
      drop: rr.bool(0.2),
      toOrderNumber: rr.bool(0.2) ? order() : undefined,
      toCustomerListId: rr.bool(0.2) ? rr.pick(CUSTOMERS) : undefined,
    };
    case 7: return { type: 'BEGIN_UPLOAD', clientIds: ids() };
    case 8: return { type: rr.bool() ? 'UPLOAD_OK' : 'UPLOAD_FAILED', clientIds: ids() };
    case 9: return { type: 'RECOVER_INFLIGHT' };
    default: return { type: 'CLEAR_SENT' };
  }
}

function arbitrary(rr: Rng, steps: number): string | null {
  let o: Outbox = empty;
  for (let i = 0; i < steps; i++) {
    const a = arbitraryAction(rr, o);
    const post = reduce(o, a);
    const why = checkStep(o, a, post, false);
    if (why) return `${why}\n      action: ${show(a)}\n      before: ${show(o.scans.map(brief), 600)}`;

    // RETAG and its ask-first companion never disagree.
    if (a.type === 'RETAG' && a.toOrderNumber !== undefined && !a.toCustomerListId) {
      const blocked = retagBlockedBy(o, a.orderNumber, a.toOrderNumber);
      if (blocked !== null && post !== o) return `retagBlockedBy=${blocked} but RETAG changed the outbox: ${show(a)}`;
      const to = a.toOrderNumber.trim();
      if (blocked === null && to && to !== a.orderNumber) {
        const stuck = post.scans.find((s) => s.state === 'QUEUED' && s.orderNumber === a.orderNumber);
        if (stuck) return `retagBlockedBy said go but a QUEUED row stayed on ${a.orderNumber}: ${show(a)}`;
      }
    }
    // An unknown action type is a no-op, not a crash.
    if (reduce(post, { type: 'NOPE' } as unknown as Action) !== post) return 'unknown action changed state';
    o = post;
  }
  // toWire never carries the local-only fields.
  for (const s of o.scans) {
    const w = toWire(s) as Record<string, unknown>;
    if ('ownerId' in w || 'ownerEmail' in w || 'offFormat' in w || 'state' in w || 'clientId' in w)
      return `toWire leaked a local field: ${show(w)}`;
  }
  return checkOwners(o);
}

/* ------------------------------------------------------------ run */

h.section('Store-shaped sequences');
h.prop('no scan lost, none in two states, SENT is final, owners respected', iters(5000), () => storeShaped(r, r.range(10, 120)));
console.log(`    ${tally.steps} reducer steps, ${tally.sent} rows sent, ${tally.recovered} crash recoveries`);
console.log(`    K1 duplicate rows (correction undone; by design, counted once on screen): `
  + `${tally.K1_enqueue} via ENQUEUE, ${tally.K1_toggle} via TOGGLE`);
console.log(`    server edits that landed on a row already SENT there and dropped instead (K2's rule): ${tally.collided}`);
console.log(`    server edits that landed beside a QUEUED copy (by design, counted once on screen): ${tally.besideQueued}`);

h.section('Arbitrary action sequences');
h.prop('reducer keeps its rules for any input', iters(5000), () => arbitrary(r, r.range(5, 80)));

h.section('Owner stamp and heldForOther, random identities');
{
  const ident = (rr: Rng): Me => {
    const k = rr.int(10);
    if (k === 0) return null;
    if (k === 1) return undefined;
    const id = rr.pick([null, undefined, '', 'u-a', 'u-b', messyString(rr, 5)]);
    const email = rr.pick([null, undefined, '', ' ', 'a@x.com', ' A@X.COM ', 'b@x.com', messyString(rr, 6)]);
    return { id, email };
  };
  const norm = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '') || null;
  h.prop('a row stamped by X is sendable to Y only when Y shares X\'s id or (case-blind) address', iters(20000), () => {
    const x = ident(r), y = ident(r);
    const stamp = ownerStamp(x, r.bool() ? 'Name' : null);
    const s = { ...makeScan(r, null), ...stamp };
    const held = heldForOther(s, y);
    const stamped = !!(stamp.ownerId || stamp.ownerEmail);
    const sameId = !!stamp.ownerId && !!y?.id && stamp.ownerId === y.id;
    const sameEmail = !!stamp.ownerEmail && !!norm(y?.email) && norm(stamp.ownerEmail) === norm(y?.email);
    const expectHeld = stamped && !sameId && !sameEmail;
    if (held !== expectHeld) return `x=${show(x)} y=${show(y)} stamp=${show(stamp)} held=${held}`;
    // The stamp is what the phone knew: never invented, address always normalised.
    if (stamp.ownerEmail && stamp.ownerEmail !== norm(x?.email)) return `stamp email not normalised: ${show(stamp)}`;
    if (!x?.id && stamp.ownerId) return 'stamp invented an id';
    // Stamped by X, always sendable back to X.
    if (stamped && heldForOther(s, x)) return `x's own row held from x: ${show(x)}`;
    return null;
  });
}

h.section('sendAs: the token and the check are one read');
{
  let n = 0, bad: string | null = null;
  const runs = iters(3000);
  const rowsFor = () => Array.from({ length: r.range(0, 4) }, () => makeScan(r, r.bool(0.25) ? null : r.pick(PEOPLE)));
  const sessionFor = () => {
    const p = r.pick(PEOPLE);
    if (r.bool(0.15)) return null;
    return { token: r.bool(0.85) ? `tok-${p.tag}` : r.pick([null, '']), id: p.me?.id ?? null, email: p.me?.email ?? null };
  };
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < runs; i++) {
    const rows = rowsFor();
    const session = sessionFor();
    const calls: (string | null)[] = [];
    jobs.push(sendAs(rows, async () => session, async (tok) => { calls.push(tok); return tok; })
      .then(
        (tok) => {
          n++;
          if (calls.length !== 1) bad ??= `send called ${calls.length} times`;
          if (tok && rows.some((s) => heldForOther(s, session))) bad ??= `sent another login's row under ${tok}`;
          if (!session?.token && tok !== null) bad ??= 'no live session but a token went up';
        },
        (e) => {
          n++;
          if (!(e instanceof OwnerChanged)) bad ??= `unexpected rejection ${e}`;
          else if (calls.length) bad ??= 'OwnerChanged after send was already called';
          else if (!rows.some((s) => heldForOther(s, session))) bad ??= 'OwnerChanged with every row sendable';
        }));
  }
  await Promise.all(jobs);
  h.ok(`sendAs never sends a row under a token that may not carry it  (${n})`, !bad && n === runs, bad ?? '');
}

h.done();
