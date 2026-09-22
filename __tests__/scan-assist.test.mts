import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanAssist } from '../src/scan-assist.ts';

test('a normal camera session gives the driver a calm aiming instruction', () => {
  assert.deepEqual(scanAssist(false, false), {
    tone: 'ready',
    title: 'Aim at the barcode',
    detail: 'We’ll confirm it before adding.',
  });
});

test('a struggling camera offers the light recovery action before a failed scan', () => {
  assert.deepEqual(scanAssist(true, false), {
    tone: 'warning',
    title: 'Low light? Turn on flash',
    detail: 'Or use Read from photo.',
  });
});

test('a struggling camera with flash on points to the remaining photo fallback', () => {
  assert.deepEqual(scanAssist(true, true), {
    tone: 'ready',
    title: 'Still struggling?',
    detail: 'Use Read from photo.',
  });
});
