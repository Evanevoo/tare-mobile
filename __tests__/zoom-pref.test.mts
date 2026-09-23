import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZoom, nextZoom, zoomLabel, ZOOM_STEPS } from '../src/zoom-pref.ts';

test('a remembered zoom comes back as the same step', () => {
  for (const z of ZOOM_STEPS) assert.equal(parseZoom(String(z)), z);
});

test('nothing stored, or anything odd, starts at 1x - never a crash, never a stuck zoom', () => {
  for (const raw of [null, undefined, '', 'abc', '0.5', '-1', 'NaN', '1']) assert.equal(parseZoom(raw as never), 0, String(raw));
});

test('the button cycles 1x -> 1.5x -> 2x -> 1x, and an unknown value restarts the cycle', () => {
  assert.equal(nextZoom(0), 0.15);
  assert.equal(nextZoom(0.15), 0.3);
  assert.equal(nextZoom(0.3), 0);
  assert.equal(nextZoom(0.9), 0);
});

test('labels match the button', () => {
  assert.equal(zoomLabel(0), '1\u00d7');
  assert.equal(zoomLabel(0.15), '1.5\u00d7');
  assert.equal(zoomLabel(0.3), '2\u00d7');
});
