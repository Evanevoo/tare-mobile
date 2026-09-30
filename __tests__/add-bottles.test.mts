import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * WHAT THE 15 SEP STORE BUILD HAD, KEPT THIS TIME.
 *
 * Builds 233/234 were cut from a branch that never reached master, and the
 * over-the-air updates published from master afterwards quietly took three of
 * its changes back off drivers' phones. They were restored on 30 Sep; these
 * make sure the next update from master cannot drop them again.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const batch = read('../app/asset/batch.tsx');
const scan = read('../app/scan.tsx');

test('Add opens the several-at-once screen, details first', () => {
  for (const f of ['../app/(tabs)/index.tsx', '../app/(tabs)/more.tsx']) {
    assert.doesNotMatch(read(f), /router\.push\('\/asset\/new'/, f);
  }
  const details = batch.indexOf('label="What kind"');
  const loop = batch.indexOf('{/* ── then the bottles: scan, serial, add, again ── */}');
  assert.ok(details > 0 && loop > details, 'the details come before the scan loop');
});

test('one product pick fills the rest', () => {
  const pick = batch.slice(batch.indexOf('function pickProduct('));
  for (const set of ['setGas(', 'setCategory(', 'setGroup(', 'setDesc(']) assert.ok(pick.indexOf(set) > 0, set);
});

test('the bottle description is shown at the pick, while scanning and over the list', () => {
  assert.match(batch, /const describe = desc\.trim\(\) \|\| \[category, gas\]/);
  assert.ok((batch.match(/\{describe/g) ?? []).length >= 3, 'three places show it');
  assert.match(batch, /No description on file for this product/);
});

test('Done sits on the right of the scan header, after the count', () => {
  const header = scan.slice(scan.indexOf("<View style={{ flexDirection: 'row', alignItems: 'center' }}>"));
  const count = header.indexOf('accessibilityLabel={`Review this order.');
  const done = header.indexOf('onPress={() => finish()}');
  assert.ok(count > 0 && done > count, 'Done comes after the review pill');
});

test('no other company is named in the supplier hint', () => {
  assert.doesNotMatch(batch, /WeldCor/);
});
