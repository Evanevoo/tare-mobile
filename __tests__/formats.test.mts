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
import { formatNudge, formatExample, matchesFormat } from '../src/formats.ts';

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

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) process.exit(1);
