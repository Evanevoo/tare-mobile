import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEditToRemote } from '../src/remote-edit.ts';

/**
 * The order editor's server snapshot, kept in step with edits made against
 * the server. The first test is the reported bug; the rest are the other
 * three actions, which had the same staleness and nobody had seen yet.
 */

const order = (...scans: { barcode: string; mode: 'SHIP' | 'RETURN' }[]) => ({
  orderNumber: 'INV-8974',
  customerListId: 'WELD01',
  scans,
});

/* ── the bug ──────────────────────────────────────────────────────────────
   Flip a sent bottle from out to back. The outbox row becomes RETURN. The
   snapshot still said SHIP, the merge dedupes on barcode AND mode, so the
   server row stopped being suppressed and the bottle rendered in both
   lists — "on server" on both copies, because both were. */
test('flipping a sent bottle moves it in the snapshot instead of leaving a twin', () => {
  const before = order({ barcode: '685955754', mode: 'SHIP' });
  const after = applyEditToRemote(before, {
    action: 'mode', barcode: '685955754', mode: 'SHIP', value: 'RETURN',
  });
  assert.deepEqual(after?.scans, [{ barcode: '685955754', mode: 'RETURN' }]);
  assert.equal(after?.scans.length, 1, 'one bottle, one row — not one per list');
});

test('other bottles on the order are untouched', () => {
  const before = order(
    { barcode: 'A1', mode: 'SHIP' },
    { barcode: '685955754', mode: 'SHIP' },
    { barcode: 'B2', mode: 'RETURN' },
  );
  const after = applyEditToRemote(before, {
    action: 'mode', barcode: '685955754', mode: 'SHIP', value: 'RETURN',
  });
  assert.deepEqual(after?.scans, [
    { barcode: 'A1', mode: 'SHIP' },
    { barcode: '685955754', mode: 'RETURN' },
    { barcode: 'B2', mode: 'RETURN' },
  ]);
});

/* AssetScan is unique on (org, order, barcode, mode), so a bottle genuinely
   can go out and come back on one visit. Flipping onto a direction that is
   already there must not mint a second copy of a pair the server keeps
   unique. */
test('flipping onto a direction the bottle already has drops the old row', () => {
  const before = order(
    { barcode: 'A1', mode: 'SHIP' },
    { barcode: 'A1', mode: 'RETURN' },
  );
  const after = applyEditToRemote(before, {
    action: 'mode', barcode: 'A1', mode: 'SHIP', value: 'RETURN',
  });
  assert.deepEqual(after?.scans, [{ barcode: 'A1', mode: 'RETURN' }]);
});

test('a withdrawn row leaves the snapshot', () => {
  const before = order({ barcode: 'A1', mode: 'SHIP' }, { barcode: 'B2', mode: 'SHIP' });
  const after = applyEditToRemote(before, { action: 'void', barcode: 'A1', mode: 'SHIP' });
  assert.deepEqual(after?.scans, [{ barcode: 'B2', mode: 'SHIP' }]);
});

test('a void with no mode named takes both directions for that barcode', () => {
  const before = order({ barcode: 'A1', mode: 'SHIP' }, { barcode: 'A1', mode: 'RETURN' });
  const after = applyEditToRemote(before, { action: 'void', barcode: 'A1' });
  assert.deepEqual(after?.scans, []);
});

test('a scan moved to another order is no longer on this one', () => {
  const before = order({ barcode: 'A1', mode: 'SHIP' }, { barcode: 'B2', mode: 'SHIP' });
  const after = applyEditToRemote(before, { action: 'order', barcode: 'A1', value: 'INV-9000' });
  assert.deepEqual(after?.scans, [{ barcode: 'B2', mode: 'SHIP' }]);
});

test('a customer change rewrites the account, not the scans', () => {
  const before = order({ barcode: 'A1', mode: 'SHIP' });
  const after = applyEditToRemote(before, { action: 'customer', value: 'LUNA02' });
  assert.equal(after?.customerListId, 'LUNA02');
  assert.deepEqual(after?.scans, [{ barcode: 'A1', mode: 'SHIP' }]);
});

/* ── nothing to do ───────────────────────────────────────────────────── */

test('no snapshot yet — nothing to keep in step', () => {
  assert.equal(applyEditToRemote(null, { action: 'mode', barcode: 'A1', mode: 'SHIP', value: 'RETURN' }), null);
});

test('an action this does not model leaves the snapshot alone', () => {
  const before = order({ barcode: 'A1', mode: 'SHIP' });
  assert.deepEqual(applyEditToRemote(before, { action: 'something-new' })?.scans,
    [{ barcode: 'A1', mode: 'SHIP' }]);
});

test('a malformed mode edit is ignored rather than half-applied', () => {
  const before = order({ barcode: 'A1', mode: 'SHIP' });
  // No `value` — the caller did not say what to change it to.
  assert.deepEqual(applyEditToRemote(before, { action: 'mode', barcode: 'A1', mode: 'SHIP' })?.scans,
    [{ barcode: 'A1', mode: 'SHIP' }]);
});
