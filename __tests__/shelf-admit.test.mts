import assert from 'node:assert/strict';
import test from 'node:test';
import { admit } from '../src/shelf-admit.ts';

/**
 * The locate screen's duplicate guard.
 *
 * The case that matters is the fourth one. Everything else here is the
 * behaviour that already worked and must keep working, because the fix
 * touches the path all of them run through.
 */

const NONE = new Set<string>();

test('a barcode nobody has seen counts', () => {
  assert.equal(admit('A1', [], NONE, NONE), 'add');
});

test('a barcode already on the shelf is a duplicate', () => {
  assert.equal(admit('A1', ['A1'], NONE, NONE), 'duplicate');
});

test('a barcode with a dialog open about it is neither — the camera is just still looking', () => {
  assert.equal(admit('A1', [], NONE, new Set(['A1'])), 'deciding');
});

/* ── the bug ──────────────────────────────────────────────────────────────
   The driver taps "Shelve it anyway". That handler deletes the barcode from
   `deciding` and calls setCodes in the same breath — but `codes` does not
   contain it until the next render. A camera frame landing in that window
   used to see an empty `deciding` and a stale `codes`, pass both guards, and
   add the bottle a second time. */
test('a barcode accepted from a dialog is held before codes catches up', () => {
  const justAdded = new Set(['A1']);
  assert.equal(admit('A1', [], justAdded, NONE), 'duplicate',
    'the frame arriving between the tap and the re-render must not add it again');
});

test('and once the render lands, codes alone is enough', () => {
  // The screen empties justAdded whenever codes changes, so this is the state
  // one render later.
  assert.equal(admit('A1', ['A1'], NONE, NONE), 'duplicate');
});

/* ── the things the fix must not break ────────────────────────────────── */

test('a bottle taken off the shelf can be scanned again', () => {
  // Removing a chip changes `codes`, which clears justAdded.
  assert.equal(admit('A1', ['B2'], NONE, NONE), 'add');
});

test('after a save the shelf is empty and everything is scannable again', () => {
  assert.equal(admit('A1', [], NONE, NONE), 'add');
});

test('a restored draft is already on the shelf', () => {
  assert.equal(admit('A1', ['A1', 'B2'], NONE, NONE), 'duplicate');
});

test('two different bottles never block each other', () => {
  const justAdded = new Set(['A1']);
  assert.equal(admit('B2', ['C3'], justAdded, new Set(['D4'])), 'add');
});
