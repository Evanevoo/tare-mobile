import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { holdNotice, holdFor } from '../src/hold.ts';

/**
 * A QuickBooks hold on a customer is said to the driver, in the office's own
 * words, and never stops them scanning. Absent / blank means not on hold —
 * which is also what every bootstrap looks like before the server sends it.
 */

test('no hold, no notice', () => {
  assert.equal(holdNotice(undefined), null);
  assert.equal(holdNotice(null), null);
  assert.equal(holdNotice(''), null);
  assert.equal(holdNotice('   '), null);
  assert.equal(holdNotice(42 as unknown as string), null);
});

test('the notice quotes the label as QuickBooks has it', () => {
  const n = holdNotice('  Hard Hold ');
  assert.ok(n);
  assert.equal(n.label, 'Hard Hold');
  assert.equal(n.text, 'On hold in QuickBooks: Hard Hold. Check with the office before delivering.');
});

test('hard holds and do-not-sell read red; softer holds amber', () => {
  assert.equal(holdNotice('Hard Hold')?.severe, true);
  assert.equal(holdNotice('DO NOT SELL')?.severe, true);
  assert.equal(holdNotice('Do-Not-Sell')?.severe, true);
  assert.equal(holdNotice('Soft Hold')?.severe, false);
  assert.equal(holdNotice('Hold')?.severe, false);
});

test('looked up by account number from the customer list', () => {
  const customers = [
    { customerListId: 'A1', hold: 'Soft Hold' },
    { customerListId: 'B2' },
    { customerListId: 'C3', hold: '' },
  ];
  assert.equal(holdFor(customers, 'A1')?.label, 'Soft Hold');
  assert.equal(holdFor(customers, 'B2'), null);
  assert.equal(holdFor(customers, 'C3'), null);
  assert.equal(holdFor(customers, 'ZZ'), null);
  assert.equal(holdFor(customers, null), null);
  assert.equal(holdFor(undefined, 'A1'), null);
});

test('the warning is shown on the picker and the scan screen, and never gates', () => {
  const delivery = readFileSync(new URL('../app/(tabs)/delivery.tsx', import.meta.url), 'utf8');
  const scan = readFileSync(new URL('../app/scan.tsx', import.meta.url), 'utf8');
  assert.match(delivery, /holdFor\(boot\?\.customers, picked\.id\)/);
  assert.match(scan, /holdFor\(boot\?\.customers, customerListId\)/);
  // Start scanning stays enabled for a customer on hold.
  const canStart = delivery.match(/const canStart = ([^;]+);/)?.[1] ?? '';
  assert.ok(canStart, 'canStart not found');
  assert.doesNotMatch(canStart, /hold/i);
});
