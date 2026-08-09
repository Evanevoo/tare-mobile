/**
 * node --experimental-strip-types __tests__/ocr.test.mts
 *
 * WHAT THE CAMERA READ, AND WHAT WE ARE ALLOWED TO BELIEVE.
 *
 * "Read text" photographs a label whose bars are destroyed and lets ML Kit
 * read the number printed underneath. That number arrives as a smear of
 * whatever else was on the label — a company name, a tare weight, a serial
 * number, a date — and none of it is trusted. `candidatesFrom` casts a wide
 * net on purpose; `matchKnown` is the wall. Everything below is a test of the
 * wall, because the failure it prevents is a confidently-wrong number landing
 * on a scan that settles a rental and bills a customer.
 */
import { candidatesFrom, matchKnown } from '../src/ocr.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* A cylinder label, as ML Kit hands back the lines it found on it. */
const LABEL = [
  'ACME WELDING SUPPLY',
  'Cylinder  PROPANE-20',
  'S/N  CYL-000481',
  'Tare 14.2 kg',
];

section('candidatesFrom() — a whole label, broken into things that could be a code');
{
  const c = candidatesFrom(LABEL);
  ok('the number under the barcode survives', c.includes('CYL-000481'), c.join(','));
  ok('and so does the product code, hyphen and all', c.includes('PROPANE-20'), c.join(','));
  ok('order follows the label, top line first', c[0] === 'ACME', c.join(','));
  ok('the serial number comes after the product code, as printed',
    c.indexOf('PROPANE-20') < c.indexOf('CYL-000481'), c.join(','));

  // Nothing here decides WHICH token is the code — that is matchKnown's job,
  // and it does it by lookup rather than by cleverness.
  ok('words are candidates too, because guessing which one is "the code" is the danger',
    c.includes('WELDING'), c.join(','));
}

section('Punctuation is a separator; case is not information');
{
  ok('a trailing full stop is not part of the code',
    candidatesFrom(['cyl-000481.']).join(',') === 'CYL-000481');
  ok('brackets and hashes split cleanly',
    candidatesFrom(['Receipt #(SO-10482)']).join(',') === 'RECEIPT,SO-10482',
    candidatesFrom(['Receipt #(SO-10482)']).join(','));
  ok('lowercase comes back uppercased, because the whole app compares uppercased',
    candidatesFrom(['cyl-000481']).join(',') === 'CYL-000481');

  // The asterisks a Code 39 card prints are stored ON the customer row (see
  // scan-match.ts), so stripping them here would hand the matcher a string
  // the org never stored.
  ok('asterisks survive — a printed card genuinely contains them',
    candidatesFrom(['*AB-123*']).join(',') === '*AB-123*',
    candidatesFrom(['*AB-123*']).join(','));
}

section('Too short and too long are both noise, not identifiers');
{
  const c = candidatesFrom(LABEL);
  ok('"kg" is not a code', !c.includes('KG'), c.join(','));
  ok('and neither is the "S" of "S/N"', !c.includes('S'), c.join(','));
  ok('nor the digits of a tare weight', !c.includes('14') && !c.includes('2'), c.join(','));

  ok('three characters is the floor, and it is kept',
    candidatesFrom(['ABC']).join(',') === 'ABC');
  ok('two is below it', candidatesFrom(['AB']).length === 0);
  ok('forty characters is the ceiling, and it is kept',
    candidatesFrom(['A'.repeat(40)]).length === 1);
  ok('forty-one is a line the recogniser failed to break, not an identifier',
    candidatesFrom(['A'.repeat(41)]).length === 0);
}

section('The same token twice is one candidate');
{
  const c = candidatesFrom(['CYL-1234  CYL-1234', 'cyl-1234']);
  ok('deduped across the line and across the label', c.length === 1, c.join(','));
  ok('and it is the first spelling that is kept', c[0] === 'CYL-1234', c.join(','));
}

section('matchKnown() — THE WALL. Nothing on file, nothing accepted.');
{
  const fleet = new Set(['CYL-000481', 'CYL-000482', 'PROPANE-20']);

  ok('a code the org has never heard of is refused, not returned as a maybe',
    matchKnown(['INV-9001', 'DELIVERY'], fleet) === null);

  // This is the whole safety property in one line: OCR read something, it was
  // well-formed, it looked exactly like a barcode, and it is still discarded.
  ok('a perfectly plausible but unknown number is still refused',
    matchKnown(['CYL-000999'], fleet) === null);

  ok('a known candidate comes back', matchKnown(['CYL-000481'], fleet) === 'CYL-000481');

  const c = candidatesFrom(LABEL);
  ok('several candidates match — the first one on the label wins',
    matchKnown(c, fleet) === 'PROPANE-20', matchKnown(c, fleet) ?? 'null');
  ok('and it really is a choice between two, not the only match',
    c.filter((t) => fleet.has(t)).length === 2, c.filter((t) => fleet.has(t)).join(','));

  // key() uppercases as it reduces, so the set no longer has to be uppercased
  // to work. The scanner uppercases it anyway, because everything else in the
  // app does and a set that only works by accident is a trap for the next
  // person.
  ok('a set entry stored in lowercase still matches, and comes back as stored',
    matchKnown(['CYL-000481'], new Set(['cyl-000481'])) === 'cyl-000481');

  // A phone that has never synced holds nothing to check a read against, so
  // there is no honest way to tell a correct read from an invented one.
  ok('an empty known set accepts NOTHING, which is the right answer for a phone that never synced',
    matchKnown(c, new Set()) === null);
  ok('no candidates at all is also null, not a throw',
    matchKnown([], fleet) === null);
}

section('End to end — the label a driver actually photographed');
{
  const known = new Set(['CYL-000481']);
  ok('the printed number is found and confirmed against the fleet',
    matchKnown(candidatesFrom(LABEL), known) === 'CYL-000481');
  ok('the same label against a fleet that does not own it reads as nothing at all',
    matchKnown(candidatesFrom(LABEL), new Set(['CYL-777777'])) === null);
}

/**
 * The row that broke, again — the same three spellings scan-match.test.mts is
 * built on, now arriving through a camera instead of a decoder. This is the
 * case an exact string compare silently could not serve: OCR slices the card
 * at the `%` it cannot keep, so what comes back is byte-identical to neither
 * the stored card code nor the account number.
 */
const LIST_ID = '800006D2-1614971550A';
const STORED = '*%800006D2-1614971550A*';   // as printed on the card
const CARD_LINES = ['Davis Machine Company', '*%800006D2-1614971550A*'];

section('The %-prefixed customer card — what OCR actually hands back');
{
  const c = candidatesFrom(CARD_LINES);
  ok('the % is a separator, so the token is NOT the stored string',
    c.includes('800006D2-1614971550A*') && !c.includes(STORED), c.join(','));
  ok('and the hyphen did not tear the code in half',
    c.includes('800006D2-1614971550A*'), c.join(','));

  const onCard = matchKnown(c, new Set([STORED]));
  ok('reduced on both sides, the sliced token still finds the card', onCard === STORED,
    onCard ?? 'null');
  ok('and what comes back is the STORED spelling, which classify() can resolve',
    onCard === '*%800006D2-1614971550A*');

  // The scanner adds the account number only when it is genuinely a second
  // code — a card that is just the account number wrapped reduces to the same
  // key, and feeding both in would look like two customers colliding.
  const onAccount = matchKnown(c, new Set([LIST_ID]));
  ok('a phone whose import never mapped the card column matches on the account number',
    onAccount === LIST_ID, onAccount ?? 'null');

  ok('an exact, undecorated read of the account number matches it too',
    matchKnown(['800006D2-1614971550A'], new Set([LIST_ID])) === LIST_ID);
}

section('REDUCTION MUST NOT MAKE DIFFERENT CODES ONE CODE');
{
  ok('one digit apart is still two different cylinders',
    matchKnown(['CYL-000482'], new Set(['CYL-000481'])) === null);
  ok('and one digit apart deep inside a long account number is too',
    matchKnown(['800006D2-1614971551A'], new Set([LIST_ID])) === null);
  ok('a shared prefix is not a match',
    matchKnown(['CYL-0004'], new Set(['CYL-000481'])) === null);
  ok('nor is a longer code that contains a known one',
    matchKnown(['CYL-0004810'], new Set(['CYL-000481'])) === null);
  ok('stripping punctuation does not strip letters — ABC123 is not ABC124',
    matchKnown(['ABC123'], new Set(['ABC124'])) === null);
  ok('a candidate of pure punctuation reduces to nothing and matches nothing',
    matchKnown(['***'], new Set(['CYL-000481'])) === null);

  // What reduction DOES collapse, deliberately: decoration only.
  ok('but the same payload in different printer decoration is one code',
    matchKnown(['*CYL-000481*'], new Set(['CYL 000481'])) === 'CYL 000481');
}

section('AMBIGUITY IS REFUSED HERE TOO — classify() refuses it for the same reason');
{
  // Two genuinely different customers whose cards differ only in punctuation.
  const twoCards = new Set(['*AB-123*', '*AB123*']);
  ok('a reduced key shared by two stored codes resolves to NOBODY',
    matchKnown(['AB123'], twoCards) === null);
  ok('and the refusal holds however the token was decorated',
    matchKnown(['*AB-123'], twoCards) === null);

  // Exact first, exactly as classify() does it: that precise string is stored
  // against one entry, so there is nothing ambiguous about it.
  ok('a byte-identical read still resolves, because it is not ambiguous',
    matchKnown(['*AB-123*'], twoCards) === '*AB-123*');

  // The ambiguous key is refused; a different, unambiguous candidate later on
  // the label is still free to match.
  ok('a refusal on one candidate does not poison the rest of the label',
    matchKnown(['AB123', 'CYL-000481'], new Set([...twoCards, 'CYL-000481'])) === 'CYL-000481');
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) process.exit(1);
