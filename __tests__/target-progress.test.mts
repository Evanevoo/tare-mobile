/**
 * node --experimental-strip-types __tests__/target-progress.test.mts
 *
 * The live checklist: what a Sales Order says should ship, against what has
 * actually been scanned SHIP on this order so far.
 */
import { reduce, empty, type QueuedScan, type Outbox } from '../src/outbox.ts';
import { checklist, isComplete } from '../src/target-progress.ts';
import { ulid } from '../src/ulid.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const scan = (barcode: string, mode: 'SHIP' | 'RETURN', order = '77777'): QueuedScan => ({
  clientId: ulid(), orderNumber: order, barcode, mode, customerListId: 'BOR-001',
  scannedAt: new Date(1754000000000).toISOString(), lat: null, lng: null,
  accuracyM: null, state: 'QUEUED',
});
const run = (acts: Parameters<typeof reduce>[1][], init: Outbox = empty) =>
  acts.reduce(reduce, init);

// A tiny stand-in for boot.assets — barcode -> product code.
const PRODUCTS: Record<string, string> = {
  'ARGON-001': 'ARGON', 'ARGON-002': 'ARGON', 'ARGON-003': 'ARGON', 'ARGON-004': 'ARGON',
  'OXY-001': 'OXYGEN', 'OXY-002': 'OXYGEN',
};
const productOf = (barcode: string) => PRODUCTS[barcode] ?? null;

section('This order has 3 Argon and 2 Oxygen');
{
  const target = [{ productCode: 'ARGON', quantity: 3 }, { productCode: 'OXYGEN', quantity: 2 }];

  const nothingScanned = checklist(empty, '77777', productOf, target);
  ok('before any scan, the target still shows with zero progress',
    nothingScanned.length === 2
      && nothingScanned.every((r) => r.scanned === 0),
    JSON.stringify(nothingScanned));
  ok('not complete yet', isComplete(nothingScanned) === false);

  const partial = run([
    { type: 'ENQUEUE', scan: scan('ARGON-001', 'SHIP') },
    { type: 'ENQUEUE', scan: scan('ARGON-002', 'SHIP') },
    { type: 'ENQUEUE', scan: scan('OXY-001', 'SHIP') },
  ]);
  const rows = checklist(partial, '77777', productOf, target);
  const argon = rows.find((r) => r.productCode === 'ARGON');
  const oxygen = rows.find((r) => r.productCode === 'OXYGEN');
  ok('2 of 3 Argon scanned', argon?.scanned === 2 && argon?.target === 3);
  ok('1 of 2 Oxygen scanned', oxygen?.scanned === 1 && oxygen?.target === 2);
  ok('not complete with one Argon still short', isComplete(rows) === false);

  const full = run([
    { type: 'ENQUEUE', scan: scan('ARGON-003', 'SHIP') },
    { type: 'ENQUEUE', scan: scan('OXY-002', 'SHIP') },
  ], partial);
  const doneRows = checklist(full, '77777', productOf, target);
  ok('3/3 Argon, 2/2 Oxygen', isComplete(doneRows) === true, JSON.stringify(doneRows));
}

section('RETURN scans never count toward a target — this feature has no return side');
{
  const target = [{ productCode: 'ARGON', quantity: 1 }];
  const withReturn = run([
    { type: 'ENQUEUE', scan: scan('ARGON-004', 'RETURN') },
  ]);
  const rows = checklist(withReturn, '77777', productOf, target);
  ok('a return scan of the same product does not advance the target',
    rows.find((r) => r.productCode === 'ARGON')?.scanned === 0);
}

section('A scan of something not on the order is shown, not hidden');
{
  const target = [{ productCode: 'ARGON', quantity: 1 }];
  const extra = run([
    { type: 'ENQUEUE', scan: scan('OXY-001', 'SHIP') },
  ]);
  const rows = checklist(extra, '77777', productOf, target);
  const oxygen = rows.find((r) => r.productCode === 'OXYGEN');
  ok('an off-order product still gets its own row', oxygen !== undefined);
  ok('with target 0, so it reads as extra rather than expected', oxygen?.target === 0);
  ok('and its scan is counted', oxygen?.scanned === 1);
}

section('An unrecognised barcode cannot be attributed to a product');
{
  const target = [{ productCode: 'ARGON', quantity: 1 }];
  const unknownProduct = (_: string) => null;
  const s = run([{ type: 'ENQUEUE', scan: scan('ARGON-001', 'SHIP') }]);
  const rows = checklist(s, '77777', unknownProduct, target);
  ok('no row is fabricated from a scan the bootstrap cannot place',
    rows.length === 1 && rows[0].scanned === 0, JSON.stringify(rows));
}

section('Only this order\'s own scans count');
{
  const target = [{ productCode: 'ARGON', quantity: 1 }];
  const otherOrder = run([{ type: 'ENQUEUE', scan: scan('ARGON-001', 'SHIP', '99999') }]);
  const rows = checklist(otherOrder, '77777', productOf, target);
  ok('a scan on a different order does not leak into this checklist',
    rows.find((r) => r.productCode === 'ARGON')?.scanned === 0);
}

section('No target at all');
{
  ok('an empty target produces an empty checklist and is not "complete"',
    checklist(empty, '77777', productOf, []).length === 0
      && isComplete(checklist(empty, '77777', productOf, [])) === false);
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) process.exit(1);
