/**
 * node --experimental-strip-types __tests__/route-param.test.mts
 *
 * THE % CRASH, PINNED (SCANIFIED-MOBILE-7).
 *
 * The production failure: every push encodes its dynamic segment once with
 * encodeURIComponent, expo-router decodes the segment once on the way in, and
 * the screen then decoded it AGAIN. A value carrying a literal '%' — this
 * fleet's Code 39 customer cards genuinely start with one — made that second
 * decode read '%80' as a percent-escape, find invalid UTF-8, and throw
 * `URIError: Malformed decodeURI input` during first render, before any error
 * boundary. Fatal, and repeatable on every tap of the same History row.
 *
 * These tests walk the same pipeline the app does:
 *
 *   param = decodeURIComponent(encodeURIComponent(value))
 *   (the router decodes the pushed segment exactly once — the production
 *   crash itself is the proof, see src/route-param.ts)
 *
 * decodeParam must then return that param untouched, for every value, and
 * must never throw. The straight second `decodeURIComponent` is asserted to
 * throw on the crash corpus so this file fails loudly if the fixture ever
 * stops representing the bug — and asserted to silently CORRUPT `ABC%123`
 * (a well-formed escape), which is the case that rules out any guarded
 * try/decode version of the fix, not just the bare one.
 */
import { decodeParam } from '../src/route-param.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** What the modern router hands the screen after an encoded push. */
const modernRouter = (pushed: string) => decodeURIComponent(pushed);

/** The full modern pipeline: push → router decode → screen normalize. */
const roundTrip = (value: string) => decodeParam(modernRouter(encodeURIComponent(value)));

const never = (fn: () => unknown) => {
  try { fn(); return true; } catch { return false; }
};

/**
 * The crash corpus. Every value that reached production or plausibly could:
 * the exact card from the Sentry event, bare and embedded malformed escapes,
 * spaces, '+', '#', '/', '?', and non-ASCII — the characters URL layers
 * historically mangle.
 */
const CORPUS = [
  '%800006D2-1614971550A',   // the Sentry event's own shape (Code 39 card)
  '%800006D2-1614971550',
  'ABC%123',
  'ABC%80',
  'ABC%',
  '%',
  '100% COMPLETE',
  'plain-order-123',
  'S50200',
  'ORDER 42',                // space
  'A+B',                     // '+' must stay '+', not become a space
  'PO#77-3',                 // '#'
  'INV/2026/08',             // '/'
  'WHY?7',                   // '?'
  'BÖTTLE-Ø9',               // non-ASCII survives the round trip
];

section('The exact production failure: a second decode on these values throws');
{
  // If none of these throws under a bare double-decode, the fixture no longer
  // reproduces the bug and this file must be revisited, not trusted.
  const throwers = ['%800006D2-1614971550A', 'ABC%80', 'ABC%', '%', '100% COMPLETE'];
  for (const v of throwers) {
    ok(`double decodeURIComponent throws on ${JSON.stringify(v)}`,
      !never(() => decodeURIComponent(modernRouter(encodeURIComponent(v)))));
  }
  // And the quieter failure a guarded decode cannot survive: a WELL-FORMED
  // escape inside a literal value decodes without throwing — into the wrong
  // string. This is why decodeParam transforms nothing.
  ok('a guarded second decode silently corrupts "ABC%123"',
    decodeURIComponent(modernRouter(encodeURIComponent('ABC%123'))) !== 'ABC%123');
}

section('Order route pipeline: push → router decode → decodeParam');
for (const v of CORPUS) {
  ok(`${JSON.stringify(v)} survives without throwing and unchanged`,
    never(() => roundTrip(v)) && roundTrip(v) === v);
}

section('Asset route pipeline: same walk plus the screen’s uppercase');
for (const v of CORPUS) {
  ok(`${JSON.stringify(v)} → ${JSON.stringify(v.toUpperCase())}`,
    never(() => roundTrip(v).toUpperCase()) && roundTrip(v).toUpperCase() === v.toUpperCase());
}

section('Every percent shape stays literal data — malformed AND well-formed');
{
  // History rows written before the fix can hold a raw '%…' order number.
  // Opening one hands decodeParam what the router decoded; it must come back
  // byte-identical. 'ABC%123' is the load-bearing case: its escape is VALID,
  // so only a transform-nothing implementation keeps it intact.
  for (const v of ['%800006D2-1614971550A', 'ABC%123', 'ABC%80', 'ABC%', '100% COMPLETE', '%25']) {
    ok(`${JSON.stringify(v)} passes through untouched`, decodeParam(v) === v);
  }
}

section('Edges');
{
  ok('undefined → empty string', decodeParam(undefined) === '');
  ok('array param uses its first element', decodeParam(['S50200', 'X']) === 'S50200');
  ok('empty array → empty string', decodeParam([]) === '');
  ok('never throws, whatever arrives', never(() => decodeParam('%%%\uD800%ZZ')));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
