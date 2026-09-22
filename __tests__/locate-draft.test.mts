import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateDraftAction } from '../src/locate-draft.ts';

const now = 1_000_000;

test('a previously staged full bottle never auto-populates a new Locate session', () => {
  assert.equal(
    locateDraftAction({ location: 'Rack A', custom: false, state: 'full', codes: ['MARK-1'], at: now }, now),
    'ask',
  );
});

test('an empty draft is discarded instead of restoring a fill choice', () => {
  assert.equal(
    locateDraftAction({ location: 'Rack A', custom: false, state: 'full', codes: [], at: now }, now),
    'discard',
  );
});

test('an old Locate draft is discarded', () => {
  assert.equal(
    locateDraftAction({ location: 'Rack A', custom: false, state: 'full', codes: ['MARK-1'], at: now - 1 }, now, 1),
    'discard',
  );
});
