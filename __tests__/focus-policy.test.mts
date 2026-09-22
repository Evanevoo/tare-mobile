import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusPulseDelays } from '../src/focus-policy.ts';

test('a steady scan does not deliberately restart autofocus', () => {
  assert.deepEqual(focusPulseDelays(true), []);
});

test('a sweep scan retains its staged autofocus recovery pulses', () => {
  assert.deepEqual(focusPulseDelays(false), [600, 2000, 3100]);
});
