import assert from 'node:assert/strict';
import test from 'node:test';
import { locateWarning, hasLocalReturn } from '../src/interlock.ts';

/**
 * The three-way interlock, pinned. The case that matters most is the one
 * the old single-field test got wrong: a customer link that is STALE —
 * rental already closed — must not warn, because a warning that fires on
 * the routine case trains the yard to tap through the real one.
 */

/* These pinned a boolean. `locateWarning` became three-way when
   'return-pending' was split out of the loud case -- a driver who HAD scanned
   twelve returns was being told all twelve were still out -- and the test was
   never moved with it, so this file has been failing since. The cases below
   are the same cases; only the vocabulary changed, except where noted. */

test('no customer on the record — never warns', () => {
  assert.equal(locateWarning(undefined, false), 'none');
  assert.equal(locateWarning(null, false), 'none');
  assert.equal(locateWarning({ c: null, or: 1 }, false), 'none');
  assert.equal(locateWarning({ or: 1 }, false), 'none');
});

test('customer AND open rental AND no return anywhere — the loud one', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 1 }, false), 'not-returned');
});

test('THE FIX: customer but the rental is already closed — silent', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 0 }, false), 'none');
});

/* THIS CASE CHANGED MEANING, not just spelling. It used to return false --
   silence. It now returns 'return-pending', which the screen shows as a one
   line note rather than a dialog: the driver did the right thing and the
   office is behind, which is worth saying and not worth stopping for. */
test('a RETURN already on this phone downgrades it to a note, not silence', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 1 }, true), 'return-pending');
});

/* The branch the long comment in interlock.ts is about, and the one case in
   that file with no test: `rp` is the SERVER reporting a return on an
   unverified order, so it survives the outbox emptying after upload. */
test('a RETURN the server knows about does too, after the outbox has emptied', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 1, rp: 1 }, false), 'return-pending');
});

test('an old server that never sent `rp` falls through to the loud case', () => {
  assert.equal(locateWarning({ c: 'WELD01', or: 1 }, false), 'not-returned');
});

test('an old server that never sent `or` — warn like before, the safe direction', () => {
  assert.equal(locateWarning({ c: 'WELD01' }, false), 'not-returned');
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
