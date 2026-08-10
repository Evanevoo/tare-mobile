/**
 * node --experimental-strip-types __tests__/batch.test.mts
 *
 * A PALLET, BEFORE ANY OF IT EXISTS.
 *
 * Everything the batch screen actually decides is in src/batch.ts, and the
 * reason is this file: a driver receiving forty cylinders cannot be asked to
 * find out on the fortieth that the twelfth went in twice. The rules that stop
 * that are worth running on every commit, and none of them need a camera, a
 * phone or a yard.
 *
 * The bias throughout is the opposite of the reticle's. There, refusing was the
 * dangerous act; here it is accepting — a duplicate that gets through becomes a
 * second record of one physical bottle, which is an invoice somebody has to
 * unpick. So these are mostly tests that the refusals fire, and that each one
 * comes back with something to say rather than silently dropping the scan.
 */
import {
  MAX_BATCH, normalizeCode, whyRefused, addRow, editRow, removeRow,
  whyNotReady, toItems, applyResult, describeResult,
  type BatchRow, type BulkCreateResult,
} from '../src/batch.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** The downloaded fleet. A Set is all `Fleet` asks for, which is the point of it. */
const fleet = (...on: string[]) => new Set(on);

/** A batch built the way the screen builds one: scan, serial, confirm, repeat. */
function batch(...pairs: [string, string][]): BatchRow[] {
  let rows: BatchRow[] = [];
  pairs.forEach(([barcode, serial], i) => {
    const r = addRow(rows, { id: `id${i + 1}`, barcode, serial }, null);
    rows = r.rows;
  });
  return rows;
}

section('ONE CYLINDER GOES IN');
{
  const r = addRow([], { id: 'a', barcode: 'cyl-001', serial: ' sn900 ' }, fleet());
  ok('it lands', !!r.row && r.refused === null);
  ok('the barcode is normalised, so a typed space cannot make a second row',
    r.row?.barcode === 'CYL-001', String(r.row?.barcode));
  ok('and so is the serial, because it is typed by a thumb in gloves',
    r.row?.serial === 'SN900', String(r.row?.serial));
  ok('the list it was given is untouched', r.rows.length === 1);
  ok('no serial is a real answer, not a blank to be chased',
    addRow([], { id: 'a', barcode: 'CYL-002' }, null).row?.serial === '');
}

section('THE SAME BOTTLE TWICE — the mistake made forty in');
{
  const rows = batch(['CYL-001', 'SN1'], ['CYL-002', 'SN2'], ['CYL-003', 'SN3']);
  const again = addRow(rows, { id: 'x', barcode: 'CYL-002', serial: 'SN9' }, null);
  ok('it is refused', again.refused?.reason === 'in-batch');
  ok('the list did not change', again.rows.length === 3 && again.row === null);
  ok('and it says which one it already is, because that is the useful half',
    again.refused?.at === 2 && again.refused!.says.includes('number 2'),
    again.refused?.says);
  ok('a stray space does not sneak the same barcode past the check',
    addRow(rows, { id: 'x', barcode: ' cyl-002 ' }, null).refused?.reason === 'in-batch');
}

section('ONE THAT IS ALREADY ON THE FLEET');
{
  const rows = batch(['CYL-001', 'SN1']);
  const r = addRow(rows, { id: 'x', barcode: 'CYL-900' }, fleet('CYL-900'));
  ok('refused against the phone’s own downloaded copy', r.refused?.reason === 'on-fleet');
  ok('it names the barcode, because the driver is holding that one',
    r.refused!.says.startsWith('CYL-900'), r.refused?.says);
  ok('nothing was added', r.rows.length === 1);
  ok('an unknown barcode with a stocked fleet still goes in',
    addRow(rows, { id: 'x', barcode: 'CYL-901' }, fleet('CYL-900')).refused === null);
}

section('THE READS THAT ARE NOT CYLINDERS');
{
  ok('an empty read is refused rather than added as a blank row',
    addRow([], { id: 'x', barcode: '   ' }, null).refused?.reason === 'blank');
  const full = Array.from({ length: MAX_BATCH }, (_, i): BatchRow =>
    ({ id: `id${i}`, barcode: `CYL-${i}`, serial: '' }));
  ok(`${MAX_BATCH} is the ceiling, and it is said at the scan, not at the save`,
    addRow(full, { id: 'x', barcode: 'CYL-NEW' }, null).refused?.reason === 'full');
}

section('FIXING ONE AT CYLINDER TWELVE — without starting again');
{
  const rows = batch(['CYL-001', 'SN1'], ['CYL-002', 'SNZ'], ['CYL-003', 'SN3']);
  const fixed = editRow(rows, 'id2', { serial: 'sn2' }, null);
  ok('the serial changes', fixed.rows[1].serial === 'SN2', fixed.rows[1].serial);
  ok('and nothing else about that row does',
    fixed.rows[1].barcode === 'CYL-002' && fixed.rows[1].id === 'id2');
  ok('the other rows keep their place, because their numbers are on screen',
    fixed.rows[0].barcode === 'CYL-001' && fixed.rows[2].barcode === 'CYL-003');
  ok('a row may keep its own barcode — it is not its own duplicate',
    editRow(rows, 'id2', { barcode: 'CYL-002', serial: 'SN2' }, null).refused === null);
  ok('retyping one onto a barcode already in the batch is refused',
    editRow(rows, 'id2', { barcode: 'CYL-003' }, null).refused?.reason === 'in-batch');
  ok('and onto one already on the fleet',
    editRow(rows, 'id2', { barcode: 'CYL-900' }, fleet('CYL-900')).refused?.reason === 'on-fleet');
  ok('clearing a barcode entirely is refused, not saved as a nameless row',
    editRow(rows, 'id2', { barcode: '' }, null).refused?.reason === 'blank');
  ok('editing a row that is no longer there is a no-op, never a throw',
    editRow(rows, 'gone', { serial: 'X' }, null).rows === rows);
}

section('TAKING ONE BACK OUT');
{
  const rows = batch(['CYL-001', 'SN1'], ['CYL-002', 'SN2'], ['CYL-003', 'SN3']);
  const less = removeRow(rows, 'id2');
  ok('it goes', less.length === 2 && !less.some((r) => r.barcode === 'CYL-002'));
  ok('the rest keep their order', less[0].barcode === 'CYL-001' && less[1].barcode === 'CYL-003');
  ok('and its barcode is free again — the wrong bottle, then the right one',
    addRow(less, { id: 'x', barcode: 'CYL-002' }, null).refused === null);
  ok('removing an id that is not there changes nothing', removeRow(rows, 'gone').length === 3);
}

section('WHEN THE BATCH MAY BE SAVED — and what it says when it may not');
{
  const rows = batch(['CYL-001', 'SN1']);
  const good = { productCode: '20LB', isFull: true, dateOk: true };
  ok('nothing scanned yet', whyNotReady([], good) === 'Scan one to start.');
  ok('no product code', !!whyNotReady(rows, { ...good, productCode: '  ' }));
  ok('full or empty unanswered — never assumed',
    !!whyNotReady(rows, { ...good, isFull: null }));
  ok('a date that is not a real day',
    !!whyNotReady(rows, { ...good, dateOk: false }));
  ok('a row with no serial does not hold the batch up',
    whyNotReady(batch(['CYL-001', '']), good) === null);
  ok('and with all of it answered, it saves', whyNotReady(rows, good) === null);
}

section('WHAT GOES UP THE WIRE');
{
  const items = toItems(batch(['CYL-001', 'SN1'], ['CYL-002', '']));
  ok('one item per row, in scan order',
    items.length === 2 && items[0].barcode === 'CYL-001' && items[1].barcode === 'CYL-002');
  ok('a serial that was typed', items[0].serialNumber === 'SN1');
  ok('and one that was not goes as null, not as an empty string',
    items[1].serialNumber === null);
}

section('PARTIAL SUCCESS IS NORMAL — what is left in hand afterwards');
{
  const rows = batch(['CYL-001', 'SN1'], ['CYL-002', 'SN2'], ['CYL-003', 'SN3']);
  const result: BulkCreateResult = {
    created: 1,
    createdBarcodes: ['CYL-001'],
    skipped: [{ barcode: 'CYL-002', reason: 'exists' }],
    invalid: [{ barcode: 'CYL-003', reason: 'no such product code' }],
  };
  const left = applyResult(rows, result);
  ok('what was created leaves the screen', !left.some((r) => r.barcode === 'CYL-001'));
  ok('what was refused stays in hand, so Save can go again without re-scanning',
    left.length === 2 && left[0].barcode === 'CYL-002' && left[1].barcode === 'CYL-003');
  ok('an all-created save empties the batch',
    applyResult(rows, {
      created: 3, createdBarcodes: ['CYL-001', 'CYL-002', 'CYL-003'], skipped: [], invalid: [],
    }).length === 0);
}

section('SAYING IT PLAINLY');
{
  const say = (r: Partial<BulkCreateResult>) => describeResult(
    { created: 0, createdBarcodes: [], skipped: [], invalid: [], ...r },
    'cylinder', 'cylinders',
  );
  ok('the ordinary case', say({ created: 38 }) === '38 cylinders added.', say({ created: 38 }));
  ok('one of them', say({ created: 1 }) === '1 cylinder added.', say({ created: 1 }));
  ok('some already there, counted separately from the ones that failed',
    say({ created: 36, skipped: [{ barcode: 'A', reason: 'exists' }] })
      === '36 cylinders added. 1 was already on the fleet.',
    say({ created: 36, skipped: [{ barcode: 'A', reason: 'exists' }] }));
  ok('nothing at all is said as nothing, not as zero',
    say({ invalid: [{ barcode: 'A', reason: 'bad' }, { barcode: 'B', reason: 'bad' }] })
      === 'Nothing new went on the fleet. 2 could not be added.',
    say({ invalid: [{ barcode: 'A', reason: 'bad' }, { barcode: 'B', reason: 'bad' }] }));
  ok('and the word error never appears in any of it',
    !say({ created: 2, skipped: [{ barcode: 'A', reason: 'exists' }] }).toLowerCase().includes('error'));
}

section('NORMALISING, ON ITS OWN');
{
  ok('case', normalizeCode('cyl-1') === 'CYL-1');
  ok('every kind of whitespace, not just the ends', normalizeCode(' cy l\t1 ') === 'CYL1');
  ok('an empty read stays empty', normalizeCode('   ') === '');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
