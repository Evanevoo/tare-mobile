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
  type Outbox, type QueuedScan,
} from '../src/outbox.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

let n = 0;
const scan = (owner?: { id: string; name: string }): QueuedScan => ({
  clientId: `c${++n}`, orderNumber: 'S100', barcode: `B${n}`, mode: 'SHIP',
  customerListId: 'L1', scannedAt: '2026-09-30T12:00:00Z',
  lat: null, lng: null, accuracyM: null, state: 'QUEUED',
  ...(owner ? { ownerId: owner.id, ownerName: owner.name } : {}),
});
const ids = (xs: QueuedScan[]) => xs.map((s) => s.clientId).sort().join(',');

const mike = { id: 'u-mike', name: 'mike.t' };
const jace = { id: 'u-jace', name: 'Jace' };

section('only the scanner uploads a stamped scan');
{
  const m1 = scan(mike), m2 = scan(mike), j1 = scan(jace), old = scan();
  const o: Outbox = { scans: [m1, m2, j1, old] };

  ok('Jace signed in sends his own and the unstamped one, not Mike\'s',
    ids(sendable(o, jace.id)) === ids([j1, old]), ids(sendable(o, jace.id)));
  ok('Mike signed back in sends his own',
    ids(sendable(o, mike.id)) === ids([m1, m2, old]));
  ok('nobody identifiable sends only what predates the stamp',
    ids(sendable(o, null)) === ids([old]));
  ok('an old queue with no stamps uploads exactly as before',
    ids(sendable({ scans: [old] }, 'anyone')) === ids([old]));
}

section('held scans wait, counted and named, and are never lost');
{
  const m1 = scan(mike), m2 = scan(mike), j1 = scan(jace);
  let o: Outbox = reduce(empty, { type: 'ENQUEUE', scan: m1 });
  o = reduce(o, { type: 'ENQUEUE', scan: m2 });
  o = reduce(o, { type: 'ENQUEUE', scan: j1 });

  // Jace's sync: the whole round trip, as store.sync runs it.
  const go = sendable(o, jace.id).map((s) => s.clientId);
  o = reduce(o, { type: 'BEGIN_UPLOAD', clientIds: go });
  o = reduce(o, { type: 'UPLOAD_OK', clientIds: go });

  ok('Jace\'s scan went up', o.scans.find((s) => s.clientId === j1.clientId)?.state === 'SENT');
  ok('Mike\'s are still queued on the phone',
    o.scans.filter((s) => s.ownerId === mike.id && s.state === 'QUEUED').length === 2);
  ok('Jace has nothing of his own left to send', unsentMine(o, jace.id).length === 0);

  const w = waitingForOthers(o, jace.id);
  ok('one person is waited for, with a count', w.length === 1 && w[0].name === 'mike.t' && w[0].count === 2,
    JSON.stringify(w));
  ok('said in plain words',
    waitingLine(w[0]) === '2 scans saved by mike.t are waiting for them to sign in.', waitingLine(w[0]));
  ok('and in the singular', waitingLine({ name: 'Jace', count: 1 })
    === '1 scan saved by Jace is waiting for them to sign in.');
  ok('Mike, signed in, is waiting for nobody', waitingForOthers(o, mike.id).length === 0);
  ok('and Mike\'s two are his to send', unsentMine(o, mike.id).length === 2);
}

section('the stamp stays on the phone');
{
  const w = toWire(scan(mike)) as Record<string, unknown>;
  ok('toWire does not send ownerId or ownerName', !('ownerId' in w) && !('ownerName' in w));
}

section('and the store is wired to it');
/* store.ts imports native modules, so it cannot run under plain node; its
   source is enough to notice the filter or the stamp being taken back out. */
{
  const store = readFileSync(join('src', 'store.ts'), 'utf8');
  const addScan = store.slice(store.indexOf('addScan(barcode, geo)'), store.indexOf('startDelivery(customerListId'));
  const sync = store.slice(store.indexOf('async sync()'));
  const handOver = store.slice(store.indexOf('async handOver('), store.indexOf('async refresh('));
  ok('every new scan is stamped with the signed-in user', /ownerId: userId/.test(addScan));
  ok('sync sends only what this login may send', /sendable\(get\(\)\.outbox, me\)/.test(sync)
    && !/= queued\(outbox\)/.test(sync));
  ok('and asks who is signed in at the moment it sends', /sessionIdentity\(\)/.test(sync));
  ok('a sign-out keeps other drivers\' unsent scans', /heldForOther\(s, me\)/.test(handOver)
    && /saveOutbox\(kept\)/.test(handOver) && !/saveOutbox\(empty\)/.test(handOver));
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
