/**
 * node --experimental-strip-types __tests__/scan-owner.test.mts
 *
 * SCANS GO UP UNDER THE NAME OF WHOEVER SCANNED THEM.
 *
 * A driver's login expired with scans still queued, somebody else signed in
 * on the same phone, and the next sync posted the queue with the new token.
 * The server credits every row to the token's owner, so the ledger said the
 * second person scanned bottles they never touched. Pinned here: a stamped
 * row only ever uploads under its own scanner, is never dropped for anyone
 * else, and rows from before the stamp existed upload as they always did.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  reduce, empty, sendable, unsentMine, waitingForOthers, waitingLine, toWire,
  ownerStamp, heldForOther, sendAs, OwnerChanged,
  type Outbox, type QueuedScan, type TokenSession,
} from '../src/outbox.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

let n = 0;
const scan = (owner?: { id?: string; email?: string; name: string }): QueuedScan => ({
  clientId: `c${++n}`, orderNumber: 'S100', barcode: `B${n}`, mode: 'SHIP',
  customerListId: 'L1', scannedAt: '2026-09-30T12:00:00Z',
  lat: null, lng: null, accuracyM: null, state: 'QUEUED',
  ...(owner ? ownerStamp(owner, owner.name) : {}),
});
const ids = (xs: QueuedScan[]) => xs.map((s) => s.clientId).sort().join(',');

const mike = { id: 'u-mike', email: 'mike.t@crew.scanified.com', name: 'mike.t' };
const jace = { id: 'u-jace', email: 'jace@weldcor.ca', name: 'Jace' };

section('only the scanner uploads a stamped scan');
{
  const m1 = scan(mike), m2 = scan(mike), j1 = scan(jace), old = scan();
  const o: Outbox = { scans: [m1, m2, j1, old] };

  ok("Jace signed in sends his own and the unstamped one, not Mike's",
    ids(sendable(o, jace)) === ids([j1, old]), ids(sendable(o, jace)));
  ok('Mike signed back in sends his own', ids(sendable(o, mike)) === ids([m1, m2, old]));
  ok('nobody identifiable sends only what predates the stamp', ids(sendable(o, null)) === ids([old]));
  ok('an old queue with no stamps uploads exactly as before',
    ids(sendable({ scans: [old] }, { id: 'anyone' })) === ids([old]));
}

section('held scans wait, counted and named, and are never lost');
{
  const m1 = scan(mike), m2 = scan(mike), j1 = scan(jace);
  let o: Outbox = reduce(empty, { type: 'ENQUEUE', scan: m1 });
  o = reduce(o, { type: 'ENQUEUE', scan: m2 });
  o = reduce(o, { type: 'ENQUEUE', scan: j1 });

  // Jace's sync: the whole round trip, as store.sync runs it.
  const go = sendable(o, jace).map((s) => s.clientId);
  o = reduce(o, { type: 'BEGIN_UPLOAD', clientIds: go });
  o = reduce(o, { type: 'UPLOAD_OK', clientIds: go });

  ok("Jace's scan went up", o.scans.find((s) => s.clientId === j1.clientId)?.state === 'SENT');
  ok("Mike's are still queued on the phone",
    o.scans.filter((s) => s.ownerId === mike.id && s.state === 'QUEUED').length === 2);
  ok('Jace has nothing of his own left to send', unsentMine(o, jace).length === 0);

  const w = waitingForOthers(o, jace);
  ok('one person is waited for, with a count', w.length === 1 && w[0].name === 'mike.t' && w[0].count === 2,
    JSON.stringify(w));
  ok('said in plain words',
    waitingLine(w[0]) === '2 scans saved by mike.t are waiting for them to sign in.', waitingLine(w[0]));
  ok('and in the singular', waitingLine({ name: 'Jace', count: 1 })
    === '1 scan saved by Jace is waiting for them to sign in.');
  ok('Mike, signed in, is waiting for nobody', waitingForOthers(o, mike).length === 0);
  ok("and Mike's two are his to send", unsentMine(o, mike).length === 2);
}

section('the stamp stays on the phone');
{
  const w = toWire(scan(mike)) as Record<string, unknown>;
  ok('toWire does not send the owner', !('ownerId' in w) && !('ownerEmail' in w) && !('ownerName' in w));
}

section('offline, the address alone is enough to stamp and to match');
{
  const st = ownerStamp({ email: ' Mike.T@Crew.Scanified.com ' }, 'mike.t');
  ok('stamped with the lower-cased address and no id',
    st.ownerEmail === 'mike.t@crew.scanified.com' && !('ownerId' in st), JSON.stringify(st));
  ok('nobody known means no stamp at all',
    Object.keys(ownerStamp(null)).length === 0 && Object.keys(ownerStamp({ id: null, email: '' })).length === 0);

  const m = scan({ email: 'mike.t@crew.scanified.com', name: 'mike.t' });
  ok('Mike, known only by address in any case, may send it',
    !heldForOther(m, { email: 'MIKE.T@crew.scanified.com' }));
  ok('Mike, back online with his id as well, may send it', !heldForOther(m, mike));
  ok('Jace may not', heldForOther(m, jace));
  ok('nor may a login nobody can identify', heldForOther(m, null));
  ok('an id-only stamp is held from a login known only by address',
    heldForOther(scan({ id: 'u-mike', name: 'mike.t' }), { email: mike.email }));
  const both = scan(mike);
  ok('ids decide when both sides have one',
    heldForOther(both, { id: 'u-other', email: mike.email }) && !heldForOther(both, { id: 'u-mike', email: 'x@y' }));
  const o: Outbox = { scans: [m] };
  ok("and it waits for Mike by name on Jace's phone",
    waitingForOthers(o, jace)[0]?.name === 'mike.t' && sendable(o, jace).length === 0);
}

section('the token that goes up is the one that was checked');
{
  const token = (who: typeof mike): TokenSession => ({ token: `t-${who.id}`, id: who.id, email: who.email });
  let sent: (string | null)[] = [];
  const send = async (t: string | null) => { sent.push(t); return 'ok'; };
  const m1 = scan(mike), old = scan();

  let r: unknown = await sendAs([m1, old], async () => token(mike), send);
  ok("Mike's rows go up with Mike's token", r === 'ok' && sent.join() === 't-u-mike');

  // Mike was checked when the sync started; Jace signed in before this chunk.
  sent = [];
  r = await sendAs([m1, old], async () => token(jace), send).catch((e) => e);
  ok('a different login aborts the chunk', r instanceof OwnerChanged);
  ok('and nothing is sent', sent.length === 0);

  sent = [];
  r = await sendAs([m1], async () => null, send).catch((e) => e);
  ok('no session at all sends nothing stamped', r instanceof OwnerChanged && sent.length === 0);

  sent = [];
  r = await sendAs([old], async () => token(jace), send);
  ok('unstamped rows still ride with whoever is signed in', r === 'ok' && sent.join() === 't-u-jace');

  // What sync does with the abort: the chunk goes back in line, untouched.
  let o: Outbox = { scans: [m1] };
  o = reduce(o, { type: 'BEGIN_UPLOAD', clientIds: [m1.clientId] });
  o = reduce(o, { type: 'UPLOAD_FAILED', clientIds: [m1.clientId] });
  ok('the aborted chunk is QUEUED again, for its owner only', o.scans[0].state === 'QUEUED'
    && sendable(o, mike).length === 1 && sendable(o, jace).length === 0);
}

section('and the store and the upload are wired to it');
/* store.ts and api.ts import native modules, so they cannot run under plain
   node; their source is enough to notice the stamp or a check being removed. */
{
  const store = readFileSync(join('src', 'store.ts'), 'utf8');
  const addScan = store.slice(store.indexOf('addScan(barcode, geo)'), store.indexOf('startDelivery(customerListId'));
  const sync = store.slice(store.indexOf('async sync()'));
  const handOver = store.slice(store.indexOf('async handOver('), store.indexOf('async refresh('));
  ok('every new scan is stamped with whatever is known of the signed-in user',
    /ownerStamp\(\{ id: userId, email \}/.test(addScan));
  ok('sync sends only what this login may send', /sendable\(get\(\)\.outbox, me\)/.test(sync)
    && !/= queued\(outbox\)/.test(sync));
  ok('and asks who is signed in at the moment it sends', /sessionIdentity\(\)/.test(sync));
  ok('an abort mid-sync stops the sync', /e instanceof OwnerChanged/.test(sync));
  ok("a sign-out keeps other drivers' unsent scans", /heldForOther\(s, me\)/.test(handOver)
    && /saveOutbox\(kept\)/.test(handOver) && !/saveOutbox\(empty\)/.test(handOver));

  const api = readFileSync(join('src', 'api.ts'), 'utf8');
  const post = api.slice(api.indexOf('export async function postScans('), api.indexOf('A REFUSAL IS NOT BAD RECEPTION'));
  ok('postScans sends through the check, with the token it checked',
    /await sendAs\(scans,/.test(post) && !/authHeader\(\)/.test(post));
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
