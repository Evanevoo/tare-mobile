import assert from 'node:assert/strict';
import test from 'node:test';
import { locateWarning, hasLocalReturn } from '../src/interlock.ts';

/**
 * The three-way interlock, pinned. The case that matters most is the one
 * the old single-field test got wrong: a customer link that is STALE —
 * rental already closed — must not warn, because a warning that fires on
 * the routine case trains the yard to tap through the real one.
 */

test('no customer on the record — never warns', () => {
  assert.equal(locateWarning(undefined, false), false);
  assert.equal(locateWarning(null, false), false);
  assert.equal(locateWarning({ c: null, or: 1 }, false), false);
  assert.equal(locateWarning({ or: 1 }, false), false);
});

test('customer AND open rental — warns', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 1 }, false), true);
});

test('THE FIX: customer but the rental is already closed — silent', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 0 }, false), false);
});

test('a RETURN already on this phone silences it — the outbox outruns the server', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 1 }, true), false);
});

test('an old server that never sent `or` — warn like before, the safe direction', () => {
  assert.equal(locateWarning({ c: 'WELD01' }, false), true);
});

test('hasLocalReturn: only a RETURN for THAT barcode, any state including SENT', () => {
  const scans = [
    { barcode: 'A1', mode: 'SHIP' },
    { barcode: 'A2', mode: 'RETURN' },
  ];
  assert.equal(hasLocalReturn(scans, 'A1'), false, 'a SHIP is not a return');
  assert.equal(hasLocalReturn(scans, 'A2'), true);
  assert.equal(hasLocalReturn(scans, 'A3'), false);
  assert.equal(hasLocalReturn([], 'A2'), false);
});
