import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, empty, queued, pending, type Outbox, type QueuedScan } from '../src/outbox.ts';

/**
 * THE LOST FLATSTONE DELIVERY.
 *
 * Reported twice on 19 Aug 2026: scanned a delivery, pressed Done then Submit,
 * the screen went grey and froze, the app was force-closed, and the scans were
 * gone. Nothing for that customer ever reached the ledger.
 *
 * Two independent bugs composed into it. The freeze was a Modal left visible
 * while its screen navigated away (fixed in app/scan.tsx). The DATA LOSS is
 * this one: BEGIN_UPLOAD moves rows to UPLOADING and persists that, and the
 * only transition back out lives in sync()'s catch block - which a killed
 * process never runs. sync() then only ever sends QUEUED rows, so a row
 * stranded in UPLOADING is invisible to every retry for the life of the phone.
 */

const scan = (clientId: string, state: QueuedScan['state']): QueuedScan => ({
  clientId,
  orderNumber: 'FLATSTONE-1',
  barcode: `BC-${clientId}`,
  mode: 'SHIP',
  customerListId: '80000B8D-1734709364A',
  scannedAt: '2026-08-19T18:00:00.000Z',
  lat: null, lng: null, accuracyM: null,
  state,
});

const box = (...scans: QueuedScan[]): Outbox => ({ scans });

test('THE BUG: rows stranded in UPLOADING are invisible to sync', () => {
  const stranded = box(scan('a', 'UPLOADING'), scan('b', 'UPLOADING'));
  // This is what the phone woke up to. They count as pending...
  assert.equal(pending(stranded).length, 2);
  // ...but sync() would send none of them. Forever.
  assert.equal(queued(stranded).length, 0);
});

test('THE FIX: recovery puts every in-flight row back in the queue', () => {
  const stranded = box(scan('a', 'UPLOADING'), scan('b', 'UPLOADING'));
  const out = reduce(stranded, { type: 'RECOVER_INFLIGHT' });
  assert.equal(queued(out).length, 2);
  assert.equal(out.scans.every((s) => s.state === 'QUEUED'), true);
});

test('SENT rows are history and must not be resurrected', () => {
  const mixed = box(scan('a', 'SENT'), scan('b', 'UPLOADING'), scan('c', 'QUEUED'));
  const out = reduce(mixed, { type: 'RECOVER_INFLIGHT' });
  assert.equal(out.scans.find((s) => s.clientId === 'a')!.state, 'SENT');
  assert.equal(out.scans.find((s) => s.clientId === 'b')!.state, 'QUEUED');
  assert.equal(out.scans.find((s) => s.clientId === 'c')!.state, 'QUEUED');
  assert.equal(queued(out).length, 2);
});

test('nothing in flight is a no-op, and never loses a row', () => {
  const clean = box(scan('a', 'SENT'), scan('b', 'QUEUED'));
  const out = reduce(clean, { type: 'RECOVER_INFLIGHT' });
  assert.deepEqual(out.scans, clean.scans);
});

test('an empty outbox survives recovery', () => {
  assert.deepEqual(reduce(empty, { type: 'RECOVER_INFLIGHT' }), { scans: [] });
});

test('recovery preserves every field of the scan, not just its state', () => {
  const one = scan('a', 'UPLOADING');
  const out = reduce(box(one), { type: 'RECOVER_INFLIGHT' });
  assert.deepEqual(out.scans[0], { ...one, state: 'QUEUED' });
});

test('recovery is idempotent - a second start changes nothing more', () => {
  const once = reduce(box(scan('a', 'UPLOADING')), { type: 'RECOVER_INFLIGHT' });
  const twice = reduce(once, { type: 'RECOVER_INFLIGHT' });
  assert.deepEqual(twice, once);
});

test('a recovered row can then be uploaded normally', () => {
  const recovered = reduce(box(scan('a', 'UPLOADING')), { type: 'RECOVER_INFLIGHT' });
  const sending = reduce(recovered, { type: 'BEGIN_UPLOAD', clientIds: ['a'] });
  assert.equal(sending.scans[0].state, 'UPLOADING');
  const done = reduce(sending, { type: 'UPLOAD_OK', clientIds: ['a'] });
  assert.equal(done.scans[0].state, 'SENT');
});
