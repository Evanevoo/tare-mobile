import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatForScanIntent } from '../src/scan-format.ts';

const formats = { barcode: '#########', customerNumber: 'C#####', orderNumber: 'O#####' };

test('customer scanning uses the configured customer-number format, not the asset barcode format', () => {
  assert.equal(formatForScanIntent('customer', formats), 'C#####');
});

test('order and asset scanning use their own configured formats', () => {
  assert.equal(formatForScanIntent('order', formats), 'O#####');
  assert.equal(formatForScanIntent('asset', formats), '#########');
});
