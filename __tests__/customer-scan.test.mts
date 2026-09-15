import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptCustomerFieldScan } from '../src/customer-scan.ts';

// WeldCor's live rules, 15 Sep 2026.
const formats = { barcode: '#########', customerNumber: '********-***********', orderNumber: '#####, #####A, A#####' };

test('THE BUG: a known customer card is accepted even though it fits no rule as read', () => {
  assert.equal(acceptCustomerFieldScan('%800006A4-1610474335A', formats, true), true);
});

test('an unknown card is accepted once the Code 39 wrapper is taken off', () => {
  assert.equal(acceptCustomerFieldScan('%80000D77-1767805019A', formats, false), true);
  assert.equal(acceptCustomerFieldScan('*%80000D77-1767805019A*', formats, false), true);
  assert.equal(acceptCustomerFieldScan('80000D77-1767805019A', formats, false), true);
});

test('a cylinder can still be scanned from the customer field', () => {
  assert.equal(acceptCustomerFieldScan('608503046', formats, false), true);
});

test('a junk decode that is nobody and fits no rule is still refused', () => {
  assert.equal(acceptCustomerFieldScan('4LB', formats, false), false);
  assert.equal(acceptCustomerFieldScan('12345', formats, false), false);
});

test('an org with no rules written down accepts everything', () => {
  assert.equal(acceptCustomerFieldScan('anything', {}, false), true);
});
