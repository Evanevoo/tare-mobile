/**
 * node --experimental-strip-types __tests__/formats.test.mts
 *
 * THE ORG'S NUMBER RULES, ON THE HANDSET.
 *
 * Advisory, never a gate — so the property under test is as much about when
 * this stays QUIET as about when it speaks. A warning that is wrong while
 * somebody is still typing is the fastest way to teach them to stop reading
 * warnings.
 */
import { formatNudge, formatExample, matchesFormat, barcodeRefusal } from '../src/formats.ts';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** WeldCor's real rule: 5 digits, 5 digits + letter, or letter + 5 digits. */
const ORDER = '#####, #####A, A#####';

section('matchesFormat — the org rule as it is actually saved');
{
  ok('five digits pass', matchesFormat('12345', ORDER));
  ok('five digits and a letter pass', matchesFormat('12345A', ORDER));
  ok('a letter and five digits pass', matchesFormat('A12345', ORDER));
  ok('lowercase passes — the field uppercases anyway', matchesFormat('a12345', ORDER));
  ok('an invoice-style number does NOT', !matchesFormat('INV-9001', ORDER));
  ok('six digits do NOT', !matchesFormat('123456', ORDER));
  ok('an empty rule accepts anything', matchesFormat('INV-9001', ''));
  ok('so does a missing one', matchesFormat('INV-9001', undefined));
}

section('formatExample — one example beats restating the rule');
{
  ok('the first alternative becomes a concrete number',
    formatExample(ORDER) === '12345', formatExample(ORDER));
  ok('no rule, no example', formatExample('') === '');
}

section('formatNudge — when it speaks');
{
  const n = (v: string, ...p: (string | null | undefined)[]) =>
    formatNudge(v, p.length ? p[0] : ORDER, 'order numbers');

  ok('a wrong number of full length is called out', n('INV-9001') !== null, String(n('INV-9001')));
  ok('and the message carries a real example',
    (n('INV-9001') ?? '').includes('12345'), String(n('INV-9001')));
  ok('a right number says nothing', n('12345') === null);
  ok('an empty field says nothing', n('') === null);
  ok('whitespace only says nothing', n('   ') === null);
  ok('no rule saved means never a warning', n('INV-9001', '') === null);
  ok('and a missing rule too', n('INV-9001', undefined) === null);
}

section('THE QUIET GATE — nothing is said while somebody is still typing');
{
  const n = (v: string) => formatNudge(v, ORDER, 'order numbers');

  // Shortest alternative is 5 characters, so 1..4 are "not finished yet",
  // not "wrong".
  ok('one character is silent', n('1') === null);
  ok('four characters are silent', n('1234') === null);
  ok('the fifth character is the first moment wrong is distinguishable',
    n('1234-') !== null, String(n('1234-')));
  ok('a value at the shortest length that fits stays silent', n('12345') === null);
  ok('a longer value that fits stays silent', n('12345A') === null);
  ok('a longer value that does not fit speaks', n('12345AB') !== null);
}

section('The gate must not be defeated by a long rule');
{
  // A nine-digit barcode rule: nothing is said until the ninth character.
  const b = (v: string) => formatNudge(v, '#########', 'barcodes');
  ok('eight characters into a nine-digit rule is silent', b('12345678') === null);
  ok('eight WRONG characters are still silent — it could still become right',
    b('ABCDEFGH') === null);
  ok('nine wrong characters speak', b('ABCDEFGHI') !== null, String(b('ABCDEFGHI')));
  ok('nine right characters stay silent', b('123456789') === null);
}

section('barcodeRefusal — a typed barcode follows the rule too (30 Sep)');
{
  // From the field: "the app will scan anything even if the format isn't the
  // same". "A" and "QQ" were typed onto real orders on 24–30 Sep.
  const r = (v: string, known = false) => barcodeRefusal(v, '#########', known);
  ok('"A" is refused', r('A') !== null);
  ok('"QQ" is refused', r('QQ') !== null);
  ok('eight digits are refused', r('12345678') !== null);
  ok('nine digits pass', r('123456789') === null);
  ok('a bottle already in the fleet passes whatever it looks like', r('A', true) === null);
  ok('the reason gives an example and where to change the rule',
    /123456789/.test(r('A') ?? '') && /format on the website/.test(r('A') ?? ''));
  ok('no rule set refuses nothing', barcodeRefusal('A', '', false) === null);
  ok('several shapes: any one passes', barcodeRefusal('AB1234', '#########, AA####', false) === null);

  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const scan = read('../app/scan.tsx');
  ok('the scan screen checks a typed code before taking it',
    /function submitManual\(\)[\s\S]*?barcodeRefusal\(code, boot\?\.formats\?\.barcode, !!boot\?\.assets\?\.\[code\]\)[\s\S]*?take\(code\)/.test(scan));
  ok('and both ways of submitting go through that check',
    /onSubmitEditing=\{submitManual\}/.test(scan) && /onPress=\{submitManual\}/.test(scan)
    && !/take\(manualCode\)/.test(scan));
  const batch = read('../app/asset/batch.tsx');
  ok('Add bottles refuses before the code becomes the bottle being added',
    batch.indexOf('barcodeRefusal(normalizeCode(raw)') > 0
    && batch.indexOf('barcodeRefusal(normalizeCode(raw)') < batch.indexOf("setPending({ barcode: normalizeCode(raw), serial: '' })"));
  const single = read('../app/asset/new.tsx');
  ok('the single Add screen will not save one', /const ready = [^;]*!barcodeProblem/.test(single));
  ok('no screen still says it will go in anyway',
    !/Check the label — it will still/.test(batch + single));
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) process.exit(1);
