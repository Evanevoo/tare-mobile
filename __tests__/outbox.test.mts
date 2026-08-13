/**
 * node --experimental-strip-types __tests__/outbox.test.mts
 *
 * The offline queue. The decisive property: a shift uploaded twice posts once.
 */
import {
  reduce, empty, pending, queued, counts, toWire, retagBlockedBy,
  type QueuedScan, type Outbox,
} from '../src/outbox.ts';
import { ulid, ulidTime } from '../src/ulid.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const scan = (barcode: string, mode: 'SHIP' | 'RETURN', order = 'INV-9001'): QueuedScan => ({
  clientId: ulid(), orderNumber: order, barcode, mode, customerListId: 'BOR-001',
  scannedAt: new Date(1754000000000).toISOString(), lat: null, lng: null,
  accuracyM: null, state: 'QUEUED',
});
const run = (acts: Parameters<typeof reduce>[1][], init: Outbox = empty) =>
  acts.reduce(reduce, init);

section('ULID — the device names its own scans');
{
  const ids = Array.from({ length: 500 }, () => ulid(1754000000000));
  ok('500 ids in one millisecond are all distinct', new Set(ids).size === 500);
  ok('and stay monotonic', ids.every((id, i) => i === 0 || id > ids[i - 1]));
  ok('the timestamp round-trips', ulidTime(ulid(1754000000000)) === 1754000000000);
  ok('length is always 26', ids.every((i) => i.length === 26));
}

section('Enqueue');
{
  const s = run([{ type: 'ENQUEUE', scan: scan('PW-K-041827', 'SHIP') }]);
  ok('a scan lands in the queue', s.scans.length === 1);
  ok('and starts QUEUED', s.scans[0].state === 'QUEUED');

  const twice = reduce(s, { type: 'ENQUEUE', scan: scan('PW-K-041827', 'SHIP') });
  ok('scanning the same bottle twice the same way is one unit, not two',
    twice.scans.length === 1, String(twice.scans.length));

  const flipped = reduce(s, { type: 'ENQUEUE', scan: scan('PW-K-041827', 'RETURN') });
  ok('the opposite direction corrects the scan instead of stacking it',
    flipped.scans.length === 1 && flipped.scans[0].mode === 'RETURN');
  ok('and keeps the original clientId, so the server sees one record',
    flipped.scans[0].clientId === s.scans[0].clientId);

  const two = reduce(s, { type: 'ENQUEUE', scan: scan('PW-K-041903', 'SHIP') });
  ok('a different bottle is a separate row', two.scans.length === 2);
}

section('A SENT row is history, not a live match — the SHIP·RETURN·RETURN bug');
{
  // A bottle that already synced once this job (the driver pressed Sync
  // mid-batch), then gets corrected. `.find` used to return this SENT row
  // ahead of anything queued after it, because it is earlier in the array —
  // so every later scan of the same bottle compared itself against stale
  // history instead of the live QUEUED row.
  const sent = (o: Outbox) => {
    const ids = o.scans.map((x) => x.clientId);
    return reduce(reduce(o, { type: 'BEGIN_UPLOAD', clientIds: ids }),
      { type: 'UPLOAD_OK', clientIds: ids });
  };

  let s = sent(run([{ type: 'ENQUEUE', scan: scan('B5', 'SHIP') }]));
  ok('the SHIP already went up', s.scans.length === 1 && s.scans[0].state === 'SENT');

  s = reduce(s, { type: 'ENQUEUE', scan: scan('B5', 'RETURN') });
  ok('a RETURN on the same bottle after a SENT SHIP is a fresh row, not a rewrite of history',
    s.scans.length === 2, String(s.scans.length));
  ok('the new row is QUEUED', s.scans[1].state === 'QUEUED');

  s = reduce(s, { type: 'ENQUEUE', scan: scan('B5', 'RETURN') });
  ok('scanning it again the same direction stays one row — the bug appended a second',
    s.scans.length === 2, String(s.scans.length));
  ok('and the SENT row from before is untouched',
    s.scans.find((x) => x.state === 'SENT')?.mode === 'SHIP');
}

section('Upload lifecycle');
{
  const base = run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP') },
    { type: 'ENQUEUE', scan: scan('B2', 'SHIP') },
  ]);
  const ids = base.scans.map((s) => s.clientId);

  const flying = reduce(base, { type: 'BEGIN_UPLOAD', clientIds: ids });
  ok('upload marks scans UPLOADING', flying.scans.every((s) => s.state === 'UPLOADING'));
  ok('nothing is QUEUED mid-flight', queued(flying).length === 0);

  const dropped = reduce(flying, { type: 'UPLOAD_FAILED', clientIds: ids });
  ok('a dropped connection rolls every scan back to QUEUED',
    dropped.scans.every((s) => s.state === 'QUEUED'));
  ok('and loses nothing', dropped.scans.length === 2);

  const sent = reduce(flying, { type: 'UPLOAD_OK', clientIds: ids });
  ok('a good upload marks them SENT', sent.scans.every((s) => s.state === 'SENT'));
  ok('and pending drops to zero', pending(sent).length === 0);

  const cleared = reduce(sent, { type: 'CLEAR_SENT' });
  ok('clearing removes only settled rows', cleared.scans.length === 0);
}

section('Edit before it leaves the device');
{
  const s = run([{ type: 'ENQUEUE', scan: scan('B7', 'SHIP') }]);
  const toggled = reduce(s, { type: 'TOGGLE', orderNumber: 'INV-9001', barcode: 'B7', mode: 'RETURN' });
  ok('a queued scan can be flipped', toggled.scans[0].mode === 'RETURN');

  const removed = reduce(s, { type: 'REMOVE', clientId: s.scans[0].clientId });
  ok('and removed', removed.scans.length === 0);

  const flying = reduce(s, { type: 'BEGIN_UPLOAD', clientIds: [s.scans[0].clientId] });
  const cantRemove = reduce(flying, { type: 'REMOVE', clientId: s.scans[0].clientId });
  ok('but an in-flight scan cannot be removed underneath the upload',
    cantRemove.scans.length === 1);
  const cantToggle = reduce(flying, { type: 'TOGGLE', orderNumber: 'INV-9001', barcode: 'B7', mode: 'RETURN' });
  ok('nor edited', cantToggle.scans[0].mode === 'SHIP');
}

section('THE DECISIVE ONE — a 400-scan shift uploaded twice posts once');
{
  let s: Outbox = empty;
  for (let i = 0; i < 400; i++) {
    s = reduce(s, { type: 'ENQUEUE', scan: scan(`PW-K-${String(i).padStart(6, '0')}`, 'SHIP') });
  }
  ok('400 scans queued offline', s.scans.length === 400);

  const ids = s.scans.map((x) => x.clientId);

  // First drain: the server accepts everything.
  const server = new Map<string, number>();
  const post = (rows: ReturnType<typeof toWire>[]) => {
    let accepted = 0;
    for (const r of rows) {
      const key = `${r.orderNumber}|${r.barcode}|${r.mode}`;   // the server's unique constraint
      if (server.has(key)) continue;                            // ← idempotency
      server.set(key, 1); accepted++;
    }
    return accepted;
  };

  s = reduce(s, { type: 'BEGIN_UPLOAD', clientIds: ids });
  const first = post(s.scans.map(toWire));
  ok('the first upload posts all 400', first === 400, String(first));

  // The response never arrives — truck went under a bridge after the write.
  s = reduce(s, { type: 'UPLOAD_FAILED', clientIds: ids });
  ok('the handset believes they are unsent and re-queues them', queued(s).length === 400);

  // Second drain: same rows, same keys.
  s = reduce(s, { type: 'BEGIN_UPLOAD', clientIds: ids });
  const second = post(s.scans.map(toWire));
  ok('the replay posts ZERO — no double-billing', second === 0, String(second));
  ok('and the ledger still holds exactly 400 rows', server.size === 400, String(server.size));

  s = reduce(s, { type: 'UPLOAD_OK', clientIds: ids });
  ok('the queue drains clean', pending(s).length === 0);
}

section('Counting for the UI');
{
  const s = run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP') },
    { type: 'ENQUEUE', scan: scan('B2', 'SHIP') },
    { type: 'ENQUEUE', scan: scan('B3', 'RETURN') },
    { type: 'ENQUEUE', scan: scan('B4', 'SHIP', 'INV-9002') },
  ]);
  const c = counts(s, 'INV-9001');
  ok('per-order ship count', c.ship === 2, String(c.ship));
  ok('per-order return count', c.ret === 1, String(c.ret));
  ok('another order is excluded', c.total === 3, String(c.total));
  ok('the global count sees both orders', counts(s).total === 4);
}

section('The wire shape matches the API contract');
{
  const w = toWire(scan('B1', 'SHIP'));
  const keys = Object.keys(w).sort().join(',');
  ok('exactly the fields POST /api/scans validates',
    keys === 'accuracyM,barcode,customerListId,lat,lng,mode,orderNumber,scannedAt', keys);
  ok('clientId is NOT sent — the server dedupes on the natural key',
    !('clientId' in w));
}

section('RETAG — fixing a whole order that has not gone up yet');
{
  const base = run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'WRONG-1') },
    { type: 'ENQUEUE', scan: scan('B2', 'SHIP', 'WRONG-1') },
    { type: 'ENQUEUE', scan: scan('B3', 'SHIP', 'OTHER-9') },
  ]);

  const moved = reduce(base, { type: 'RETAG', orderNumber: 'WRONG-1', toOrderNumber: 'RIGHT-2' });
  ok('every scan on the order moves, not just the first',
    moved.scans.filter((s) => s.orderNumber === 'RIGHT-2').length === 2);
  ok('and an unrelated order is left alone',
    moved.scans.find((s) => s.barcode === 'B3')?.orderNumber === 'OTHER-9');

  const recust = reduce(base, { type: 'RETAG', orderNumber: 'WRONG-1', toCustomerListId: 'ACME-7' });
  ok('the customer can be corrected the same way',
    recust.scans.filter((s) => s.customerListId === 'ACME-7').length === 2);
  ok('and correcting the customer does not touch the order number',
    recust.scans.every((s) => s.orderNumber !== 'RIGHT-2'));

  // The guard that matters: the server dedupes on (org, order, barcode, mode),
  // so moving a barcode onto an order that already has it would silently lose
  // one of the two at upload. Refused here, where it can still be explained.
  const wouldCollide = run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'WRONG-1') },
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'RIGHT-2') },
  ]);
  const refused = reduce(wouldCollide, {
    type: 'RETAG', orderNumber: 'WRONG-1', toOrderNumber: 'RIGHT-2',
  });
  ok('a move that would duplicate a barcode on the target order is refused whole',
    refused.scans.filter((s) => s.orderNumber === 'WRONG-1').length === 1);

  // Once a scan is the server's, the phone must not quietly rewrite it.
  const sent = run([
    { type: 'ENQUEUE', scan: scan('B9', 'SHIP', 'SENT-1') },
    { type: 'BEGIN_UPLOAD', clientIds: [] },
  ]);
  const sentIds = sent.scans.map((s) => s.clientId);
  const afterSent = reduce(
    reduce(sent, { type: 'BEGIN_UPLOAD', clientIds: sentIds }),
    { type: 'UPLOAD_OK', clientIds: sentIds },
  );
  const tried = reduce(afterSent, { type: 'RETAG', orderNumber: 'SENT-1', toOrderNumber: 'NOPE-3' });
  ok('a SENT scan is never retagged locally — that is the server’s to change',
    tried.scans[0].orderNumber === 'SENT-1');

  ok('a retag with nothing to change is a no-op',
    reduce(base, { type: 'RETAG', orderNumber: 'WRONG-1' }) === base);
}

section('retagBlockedBy — asked BEFORE dispatching, never inferred after');
{
  const clean = run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'WRONG-1') },
    { type: 'ENQUEUE', scan: scan('B2', 'SHIP', 'WRONG-1') },
  ]);
  ok('a clear move reports no blocker',
    retagBlockedBy(clean, 'WRONG-1', 'RIGHT-2') === null);

  const blocked = run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'WRONG-1') },
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'RIGHT-2') },
  ]);
  ok('a blocked move names the barcode in the way',
    retagBlockedBy(blocked, 'WRONG-1', 'RIGHT-2') === 'B1',
    String(retagBlockedBy(blocked, 'WRONG-1', 'RIGHT-2')));

  // The bug this replaced: the screen dispatched and then checked whether any
  // scan carried the target order. In the refusal case one always does — the
  // colliding row — so the check said "moved" and the driver got a success
  // haptic while nothing moved. The predicate must agree with the reducer.
  const after = reduce(blocked, { type: 'RETAG', orderNumber: 'WRONG-1', toOrderNumber: 'RIGHT-2' });
  ok('and the reducer agrees — the refusal really did leave everything put',
    after.scans.filter((s) => s.orderNumber === 'WRONG-1').length === 1);
  ok('the old inference would have said "moved" here, which is why it is gone',
    after.scans.some((s) => s.orderNumber === 'RIGHT-2'));

  ok('moving to the same order is not a blocker, it is a no-op',
    retagBlockedBy(clean, 'WRONG-1', 'WRONG-1') === null);
  ok('an empty target is not a blocker either', retagBlockedBy(clean, 'WRONG-1', '  ') === null);
}

section('APPLY_SERVER_EDIT — the phone follows the ledger for SENT rows');
{
  const sent = (o: Outbox) => {
    const ids = o.scans.map((s) => s.clientId);
    return reduce(reduce(o, { type: 'BEGIN_UPLOAD', clientIds: ids }),
      { type: 'UPLOAD_OK', clientIds: ids });
  };
  const base = sent(run([
    { type: 'ENQUEUE', scan: scan('B1', 'SHIP', 'SO-1') },
    { type: 'ENQUEUE', scan: scan('B2', 'SHIP', 'SO-1') },
  ]));

  const flipped = reduce(base, {
    type: 'APPLY_SERVER_EDIT', orderNumber: 'SO-1', barcode: 'B1', mode: 'RETURN',
  });
  ok('a server-side direction change lands on the local copy',
    flipped.scans.find((s) => s.barcode === 'B1')?.mode === 'RETURN');
  ok('and leaves the other bottle alone',
    flipped.scans.find((s) => s.barcode === 'B2')?.mode === 'SHIP');

  const dropped = reduce(base, {
    type: 'APPLY_SERVER_EDIT', orderNumber: 'SO-1', barcode: 'B1', drop: true,
  });
  ok('a withdrawal removes the local copy — the record lives on the server',
    dropped.scans.length === 1 && dropped.scans[0].barcode === 'B2');

  const moved = reduce(base, {
    type: 'APPLY_SERVER_EDIT', orderNumber: 'SO-1', toOrderNumber: 'SO-2',
  });
  ok('a whole-order move takes every sent row with it',
    moved.scans.every((s) => s.orderNumber === 'SO-2'));

  // A QUEUED row has not been seen by the server, so a server edit cannot be
  // about it. Applying one anyway would double-apply a change at upload.
  const mixed = run([
    { type: 'ENQUEUE', scan: scan('B9', 'SHIP', 'SO-1') },
  ]);
  const withSent = { scans: [...base.scans, ...mixed.scans] };
  const partial = reduce(withSent, {
    type: 'APPLY_SERVER_EDIT', orderNumber: 'SO-1', toOrderNumber: 'SO-2',
  });
  ok('a QUEUED row is never touched by a server edit',
    partial.scans.find((s) => s.barcode === 'B9')?.orderNumber === 'SO-1');
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exit(1);
