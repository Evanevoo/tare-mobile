/**
 * node --experimental-strip-types __tests__/when.test.mts
 *
 * THE TEST THAT SHOULD HAVE EXISTED BEFORE THE BUG DID.
 *
 * A scan taken at 2:38pm in Saskatoon displayed as 8:38, on every screen, for
 * as long as there have been screens — because the code read the time by
 * slicing characters out of a UTC ISO string. tsc cannot see that. A unit test
 * can, and this is it.
 *
 * Run with TZ pinned so the assertions mean something on any machine:
 *   TZ=America/Regina node --experimental-strip-types __tests__/when.test.mts
 * Regina is UTC−6 all year (Saskatchewan does not observe daylight saving),
 * which is the fleet's own zone and the one the bug was found in.
 */
import { localTime, localDay, dayLabel, whenLabel } from '../src/when.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const offsetHours = -new Date('2026-08-09T20:38:00Z').getTimezoneOffset() / 60;

section(`Local time, not UTC  (TZ=${TZ}, offset ${offsetHours}h)`);
{
  // The exact scan from the bug report: 20:38 UTC is 14:38 in Saskatchewan.
  const iso = '2026-08-09T20:38:00.000Z';
  const d = new Date(iso);
  const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  ok('the time is the local wall clock, whatever zone this runs in',
    localTime(iso) === expected, `${localTime(iso)} != ${expected}`);

  ok('and it is NOT the raw UTC slice unless the machine really is on UTC',
    offsetHours === 0 ? localTime(iso) === '20:38' : localTime(iso) !== '20:38',
    localTime(iso));

  if (offsetHours === -6) {
    ok('in the fleet’s own zone, 20:38Z reads 14:38 — the reported case',
      localTime(iso) === '14:38', localTime(iso));
  }
}

section('The date rolls at local midnight, not UTC midnight');
{
  // 03:00 UTC on the 10th is still the evening of the 9th anywhere west of
  // UTC. This is what made "today's scans" drop the end of a delivery run.
  const lateEvening = '2026-08-10T03:00:00.000Z';
  const d = new Date(lateEvening);
  const expected =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  ok('localDay agrees with the platform’s own local getters',
    localDay(lateEvening) === expected, `${localDay(lateEvening)} != ${expected}`);

  if (offsetHours < 0) {
    ok('west of UTC, an evening scan is still the same local day, not tomorrow',
      localDay(lateEvening) === '2026-08-09', localDay(lateEvening));
    ok('and that differs from the UTC slice, which is the bug',
      localDay(lateEvening) !== lateEvening.slice(0, 10));
  }

  ok('localDay accepts a Date as well as a string',
    localDay(new Date(lateEvening)) === localDay(lateEvening));
}

section('dayLabel takes an instant, so a caller cannot pre-slice it wrong');
{
  const now = new Date();
  ok('an instant from a moment ago is Today', dayLabel(now.toISOString()) === 'Today');
  ok('one day back is Yesterday',
    dayLabel(new Date(now.getTime() - 864e5).toISOString()) === 'Yesterday');

  const old = dayLabel('2026-03-04T18:00:00.000Z');
  ok('anything older is a short date, not Today', old !== 'Today' && old !== 'Yesterday', old);
  ok('and it is not an ISO fragment', !old.includes('-'), old);
}

section('Bad input degrades to nothing, never to "Invalid Date"');
{
  ok('a junk timestamp yields an empty time', localTime('not a date') === '');
  ok('a junk timestamp yields an empty day', localDay('not a date') === '');
  ok('an empty string is empty, not NaN', localTime('') === '');
  ok('whenLabel of junk is empty rather than "Invalid Date NaN:NaN"',
    whenLabel('not a date').trim() === '', JSON.stringify(whenLabel('not a date')));
}

section('whenLabel is the pair every screen actually shows');
{
  const iso = new Date().toISOString();
  ok('label is the day and the local time together',
    whenLabel(iso) === `${dayLabel(iso)} ${localTime(iso)}`);
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exit(1);
