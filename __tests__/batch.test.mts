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
  MAX_BATCH, normalizeCode, serialKey, whyRefused, whySerialRefused,
  addRow, editRow, removeRow,
  whyNotReady, toItems, applyResult, describeResult,
  type BatchRow, type BulkCreateResult, type Fleet,
} from '../src/batch.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** The downloaded fleet. A Set is all `Fleet` asks for, which is the point of it. */
const fleet = (...on: string[]) => new Set(on);

/**
 * The same, plus the serials. Keyed the way the server keys them, so a test
 * that writes a serial in lower case is testing the comparison and not the
 * fixture.
 */
const fleetWith = (serials: Record<string, string>, ...on: string[]): Fleet => ({
  has: (bc) => on.includes(bc),
  serialHeldBy: (sn) => {
    const key = serialKey(sn);
    if (!key) return null;
    for (const [barcode, serial] of Object.entries(serials)) {
      if (serialKey(serial) === key) return barcode;
    }
    return null;
  },
});

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

section('THE SAME SERIAL TWICE — "SAME AS BARCODES", in the owner’s words');
{
  const rows = batch(['CYL-001', 'SN1'], ['CYL-002', 'SN2'], ['CYL-003', 'SN3']);
  const again = addRow(rows, { id: 'x', barcode: 'CYL-004', serial: 'SN2' }, null);
  ok('it is refused', again.refused?.reason === 'serial-in-batch');
  ok('the list did not change', again.rows.length === 3 && again.row === null);
  ok('and it names which one already has it — the number AND the barcode',
    again.refused!.says.includes('number 2') && again.refused!.says.includes('CYL-002'),
    again.refused?.says);
  ok('heldBy is the cylinder wearing it, not the one in hand',
    again.refused?.heldBy === 'CYL-002' && again.refused?.barcode === 'CYL-004');
  ok('case is not a difference — the server compares upper(btrim(…)) and so must this',
    addRow(rows, { id: 'x', barcode: 'CYL-004', serial: 'sn2' }, null).refused?.reason
      === 'serial-in-batch');
  ok('nor is whitespace round it',
    addRow(rows, { id: 'x', barcode: 'CYL-004', serial: '  SN2  ' }, null).refused?.reason
      === 'serial-in-batch');
  ok('a serial nobody else has goes in',
    addRow(rows, { id: 'x', barcode: 'CYL-004', serial: 'SN4' }, null).refused === null);
}

section('NO SERIAL IS NOT A COLLISION — most collars have nothing stamped on them');
{
  const rows = batch(['CYL-001', ''], ['CYL-002', '']);
  ok('two blanks live together', rows.length === 2);
  ok('and a third joins them',
    addRow(rows, { id: 'x', barcode: 'CYL-003' }, null).refused === null);
  ok('whitespace is a blank, not a serial called space',
    addRow(rows, { id: 'x', barcode: 'CYL-004', serial: '   ' }, null).refused === null);
  ok('a blank never collides with the fleet either',
    addRow(rows, { id: 'x', barcode: 'CYL-005', serial: '' },
      fleetWith({ 'CYL-900': '' })).refused === null);
  ok('serialKey says so on its own',
    serialKey('') === null && serialKey('  ') === null && serialKey(null) === null);
  ok('and it is the server’s own normal form', serialKey(' sn7 ') === 'SN7');
}

section('A SERIAL ALREADY ON THE FLEET — caught here, not at the save');
{
  const rows = batch(['CYL-001', 'SN1']);
  const on = fleetWith({ 'CYL-900': 'SN900' }, 'CYL-900');
  const r = addRow(rows, { id: 'x', barcode: 'CYL-002', serial: 'sn900' }, on);
  ok('refused against the phone’s own downloaded copy', r.refused?.reason === 'serial-on-fleet');
  ok('it names the cylinder already wearing it, because that is the one to go and look at',
    r.refused?.heldBy === 'CYL-900' && r.refused!.says.includes('CYL-900'), r.refused?.says);
  ok('and it says the rule in the words the owner used',
    r.refused!.says.includes('unique, the same as barcodes'), r.refused?.says);
  ok('nothing was added', r.rows.length === 1);
  ok('an untaken serial still goes in',
    addRow(rows, { id: 'x', barcode: 'CYL-002', serial: 'SN901' }, on).refused === null);
  ok('a fleet that cannot answer the serial question is not treated as an empty one — '
    + 'a plain Set is still a legal Fleet',
    addRow(rows, { id: 'x', barcode: 'CYL-002', serial: 'SN900' }, fleet('CYL-900')).refused
      === null);
  ok('the barcode is refused before the serial, so one sentence names one problem',
    addRow(rows, { id: 'x', barcode: 'CYL-900', serial: 'SN900' }, on).refused?.reason
      === 'on-fleet');
}

section('THE SERIAL RULE ON ITS OWN');
{
  const rows = batch(['CYL-001', 'SN1'], ['CYL-002', 'SN2']);
  ok('a clash in the batch',
    whySerialRefused({ barcode: 'CYL-009', serial: 'SN1' }, rows, null)?.at === 1);
  ok('a blank asks nothing of the fleet',
    whySerialRefused({ barcode: 'CYL-009', serial: '' }, rows,
      fleetWith({ 'CYL-900': 'SN900' })) === null);
  ok('a row does not collide with itself',
    whySerialRefused({ barcode: 'CYL-001', serial: 'SN1' }, rows, null, 'id1') === null);
  ok('but it still collides with the others',
    whySerialRefused({ barcode: 'CYL-001', serial: 'SN2' }, rows, null, 'id1')?.reason
      === 'serial-in-batch');
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
  ok('retyping a serial onto one already in the batch is refused',
    editRow(rows, 'id2', { serial: 'SN3' }, null).refused?.reason === 'serial-in-batch');
  ok('and onto one already stamped on the fleet',
    editRow(rows, 'id2', { serial: 'SN900' }, fleetWith({ 'CYL-900': 'SN900' })).refused?.reason
      === 'serial-on-fleet');
  ok('a row may keep its own serial — it is not its own duplicate',
    editRow(rows, 'id2', { serial: 'SNZ' }, null).refused === null);
  ok('nor when it is retyped in another case, which is the same serial',
    editRow(rows, 'id2', { serial: 'snz' }, null).refused === null);
  ok('nor with a stray space, which is how a thumb in gloves types it',
    editRow(rows, 'id2', { serial: ' SNZ ' }, null).refused === null);
  ok('correcting only the barcode leaves the serial where it was, unrefused',
    editRow(rows, 'id2', { barcode: 'CYL-012' }, null).rows[1].serial === 'SNZ');
  ok('and a serial can be cleared, because having none is a real answer',
    editRow(rows, 'id2', { serial: '' }, null).rows[1].serial === ''
      && editRow(rows, 'id2', { serial: '' }, null).refused === null);
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
