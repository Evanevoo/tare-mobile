/**
 * node --experimental-strip-types __tests__/double-count.test.mts
 *
 * ONE BOTTLE, ONE DIRECTION, ONE ORDER COUNTS ONCE ON SCREEN. (K1, fuzz, 1 Oct 2026)
 *
 * Ship B9 (it uploads in seconds), scan it as a return by mistake, correct back
 * to ship: the outbox holds SHIP/SENT and SHIP/QUEUED. Both still upload — the
 * server keeps one, its unique key is (org, order, barcode, mode) — but the Ship
 * pill, the Sales Order checklist ("Argon 2/2" for one bottle), Home's "scanned
 * today", the order screen and History all counted two. They now count through
 * outbox.ts distinctScans; the rows, and what uploads, are unchanged. Counts
 * that protect data (unsent rows for sign-out and hand-over) still count rows.
 */
import { readFileSync } from 'node:fs';
import {
  reduce, empty, counts, queued, pending, unsentMine, distinctScans, sendable,
  type QueuedScan, type Outbox, type Action,
} from '../src/outbox.ts';
import { checklist } from '../src/target-progress.ts';
import { mergeHistory } from '../src/history.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

let n = 0;
const scan = (mode: 'SHIP' | 'RETURN', barcode = 'B9', order = 'INV-1'): QueuedScan => ({
  clientId: `id-${n++}`, orderNumber: order, barcode, mode, customerListId: 'CUST',
  scannedAt: `2026-10-01T15:00:${String(n).padStart(2, '0')}.000Z`, lat: null, lng: null, accuracyM: null, state: 'QUEUED',
});
const run = (acts: Action[], init: Outbox = empty) => acts.reduce(reduce, init);
const sendAll = (o: Outbox) => {
  const ids = o.scans.filter((s) => s.state === 'QUEUED').map((s) => s.clientId);
  return run([{ type: 'BEGIN_UPLOAD', clientIds: ids }, { type: 'UPLOAD_OK', clientIds: ids }], o);
};
const rowsOf = (o: Outbox) => o.scans.map((s) => `${s.mode}/${s.state}`).join(',');
const argon = (o: Outbox) => checklist(o, 'INV-1', () => 'ARGON', [{ productCode: 'ARGON', quantity: 2 }])[0];

section('After the first SHIP was sent');
{
  const shipped = sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]));
  const back = run([{ type: 'ENQUEUE', scan: scan('RETURN') }, { type: 'ENQUEUE', scan: scan('SHIP') }], shipped);
  ok('the outbox still holds both rows (nothing about the upload changed)', rowsOf(back) === 'SHIP/SENT,SHIP/QUEUED', rowsOf(back));
  ok('and the queued one still goes up', queued(back).length === 1 && sendable(back, null).length === 1);
  const c = counts(back, 'INV-1');
  ok('the Ship pill counts one bottle', c.ship === 1 && c.ret === 0 && c.total === 1, JSON.stringify(c));
  ok('the checklist reads 1/2, not 2/2', argon(back).scanned === 1, `scanned=${argon(back).scanned}`);
  ok('counts().pending is still unsent ROWS', c.pending === 1);
}

section('Via TOGGLE in the review list');
{
  const shipped = sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]));
  const wrong = run([{ type: 'ENQUEUE', scan: scan('RETURN') }], shipped);
  const toggled = run([{ type: 'TOGGLE', orderNumber: 'INV-1', barcode: 'B9', mode: 'SHIP' }], wrong);
  ok('both rows remain', rowsOf(toggled) === 'SHIP/SENT,SHIP/QUEUED', rowsOf(toggled));
  ok('one ship counted', counts(toggled, 'INV-1').ship === 1, String(counts(toggled, 'INV-1').ship));
  ok('checklist 1', argon(toggled).scanned === 1);
}

section('While the first SHIP is still uploading');
{
  const first = run([{ type: 'ENQUEUE', scan: scan('SHIP') }]);
  const flying = run([{ type: 'BEGIN_UPLOAD', clientIds: [first.scans[0].clientId] }], first);
  const again = run([{ type: 'ENQUEUE', scan: scan('RETURN') }, { type: 'ENQUEUE', scan: scan('SHIP') }], flying);
  ok('two unsent SHIP rows, both still to upload', rowsOf(again) === 'SHIP/UPLOADING,SHIP/QUEUED', rowsOf(again));
  ok('one ship counted', counts(again, 'INV-1').ship === 1 && counts(again, 'INV-1').total === 1);
  ok('checklist 1', argon(again).scanned === 1);
  // Data-protecting counts are rows: sign-out and hand-over must see both.
  ok('pending() and unsentMine() still count both rows', pending(again).length === 2 && unsentMine(again, null).length === 2);
  ok('counts().pending likewise', counts(again, 'INV-1').pending === 2);
}

section('What still counts as two');
{
  const o = sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP', 'B1') }, { type: 'ENQUEUE', scan: scan('SHIP', 'B2') }]));
  const out = run([{ type: 'ENQUEUE', scan: scan('RETURN', 'B1') }], o);
  const c = counts(out, 'INV-1');
  ok('two bottles are two ships', c.ship === 2, String(c.ship));
  ok('a bottle that went out and came back counts once each way', c.ret === 1 && c.total === 3, JSON.stringify(c));
  const other = run([{ type: 'ENQUEUE', scan: scan('SHIP', 'B1', 'INV-2') }], out);
  ok('the same bottle on another order is its own', counts(other).total === 4, String(counts(other).total));
  ok('distinctScans keeps the latest row of a key', distinctScans([
    { orderNumber: 'O', barcode: 'B', mode: 'SHIP' as const, tag: 'old' },
    { orderNumber: 'O', barcode: 'B', mode: 'SHIP' as const, tag: 'new' },
  ]).map((x) => x.tag).join() === 'new');
}

section('History');
{
  const shipped = sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]));
  const back = run([{ type: 'ENQUEUE', scan: scan('RETURN') }, { type: 'ENQUEUE', scan: scan('SHIP') }], shipped);
  const server = [{ orderNumber: 'INV-1', customerListId: 'CUST', customerName: 'Acme', ship: 1, ret: 0, voided: 0, lastScanAt: '2026-10-01T15:00:00.000Z', scannedBy: [] }];
  const [row] = mergeHistory(server, back.scans);
  ok('a server order does not add an unsent copy of a bottle this phone already sent', row.ship === 1, `ship=${row.ship}`);
  ok('but still shows it as not uploaded', row.pending === 1, `pending=${row.pending}`);

  const first = run([{ type: 'ENQUEUE', scan: scan('SHIP', 'B9', 'NEW-1') }]);
  const flying = run([{ type: 'BEGIN_UPLOAD', clientIds: [first.scans[0].clientId] }], first);
  const again = run([{ type: 'ENQUEUE', scan: scan('RETURN', 'B9', 'NEW-1') }, { type: 'ENQUEUE', scan: scan('SHIP', 'B9', 'NEW-1') }], flying);
  const [phoneOnly] = mergeHistory([], again.scans);
  ok('an order only on this phone counts the bottle once', phoneOnly.ship === 1 && phoneOnly.ret === 0, `ship=${phoneOnly.ship}`);
  ok('with both rows still pending', phoneOnly.pending === 2, `pending=${phoneOnly.pending}`);
}

section('The screens count through distinctScans');
{
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  ok('scan screen review list', /distinctScans\(forOrder\(outbox, orderNumber\)\)/.test(read('../app/scan.tsx')));
  ok('Home "scanned today"', /const mine = distinctScans\(/.test(read('../app/(tabs)/index.tsx')));
  ok('order screen header and lists', /const bottles = distinctScans\(effectiveRows\)/.test(read('../app/order/[orderNumber].tsx')));
  ok('checklist', /distinctScans\(forOrder\(outbox, orderNumber\)\)/.test(read('../src/target-progress.ts')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
