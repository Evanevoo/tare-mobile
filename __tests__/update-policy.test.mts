/**
 * node --experimental-strip-types __tests__/update-policy.test.mts
 *
 * The update prompt is the one feature in this app that can interrupt a driver
 * who did not ask to be interrupted, and the one that can restart the process
 * out from under a queue of scans. Both of those live behind the predicates in
 * update-policy.ts, so both are tested here.
 *
 * expo-updates itself is not tested and cannot be — it needs a native runtime.
 * That is exactly why the decisions were pulled out of it.
 */
import {
  shouldCheck, bannerVisible, bannerRoute, restartHint, statusLine,
  CHECK_INTERVAL_MS, RETRY_INTERVAL_MS, type Phase,
} from '../src/update-policy.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const NOW = 1_760_000_000_000;
const base = {
  enabled: true, online: true, phase: 'idle' as Phase,
  lastCheckAt: null as number | null, now: NOW,
};

section('Asking the server');
{
  ok('a fresh launch asks straight away', shouldCheck(base));

  ok('a development build never asks — checkForUpdateAsync would throw',
    !shouldCheck({ ...base, enabled: false }));

  ok('no signal, no request', !shouldCheck({ ...base, online: false }));

  ok('not while a check is already running',
    !shouldCheck({ ...base, phase: 'checking', lastCheckAt: NOW - 864e5 }));

  ok('not while a bundle is downloading',
    !shouldCheck({ ...base, phase: 'downloading', lastCheckAt: NOW - 864e5 }));

  ok('not when one is already downloaded and waiting',
    !shouldCheck({ ...base, phase: 'ready', lastCheckAt: NOW - 864e5 }));

  ok('an error does not stop the next check, it only delays it',
    shouldCheck({ ...base, phase: 'error', lastFailed: true, lastCheckAt: NOW - RETRY_INTERVAL_MS }));
}

section('The interval');
{
  ok('one minute after a check is too soon',
    !shouldCheck({ ...base, lastCheckAt: NOW - 60_000 }));

  ok('a second under the interval is still too soon',
    !shouldCheck({ ...base, lastCheckAt: NOW - CHECK_INTERVAL_MS + 1000 }));

  ok('exactly the interval is due',
    shouldCheck({ ...base, lastCheckAt: NOW - CHECK_INTERVAL_MS }));

  ok('after a failure the normal interval is NOT enough',
    !shouldCheck({ ...base, phase: 'error', lastFailed: true, lastCheckAt: NOW - CHECK_INTERVAL_MS }),
    'a dead spot must not be retried every fifteen minutes');

  ok('a caller can shorten the interval for its own reasons',
    shouldCheck({ ...base, lastCheckAt: NOW - 5_000, intervalMs: 1_000 }));
}

section('A clock that moves backwards does not freeze the checks');
{
  // The handset picks up network time, or a driver corrects a wrong date, and
  // lastCheckAt is suddenly in the future. Naive arithmetic makes that "not
  // due" until real time catches up — which on a year-sized jump is never.
  ok('a timestamp from the future is treated as due, not as not-yet',
    shouldCheck({ ...base, lastCheckAt: NOW + 365 * 864e5 }));
}

section('When the banner is allowed on screen');
{
  const ready = { phase: 'ready' as Phase, readyId: 'abc', dismissedId: null, segment: '(tabs)' };

  ok('a downloaded update on a tab shows', bannerVisible(ready));

  ok('nothing to show while idle',
    !bannerVisible({ ...ready, phase: 'idle' }));
  ok('nothing to show while still downloading',
    !bannerVisible({ ...ready, phase: 'downloading' }));
  ok('a failed check is not a banner — it belongs in Settings',
    !bannerVisible({ ...ready, phase: 'error' }));

  ok('NEVER over the scan screen',
    !bannerVisible({ ...ready, segment: 'scan' }),
    'a driver mid-load must not be able to hit Restart by accident');
  ok('not on login either',
    !bannerVisible({ ...ready, segment: 'login' }));
  ok('not on a pushed screen, which has no tab bar to sit above',
    !bannerVisible({ ...ready, segment: 'settings' }));
  ok('not before the router has resolved a segment',
    !bannerVisible({ ...ready, segment: undefined }));

  ok('bannerRoute is the tabs and only the tabs',
    bannerRoute('(tabs)') && !bannerRoute('scan') && !bannerRoute(null));
}

section('Dismissal is per-update, not forever');
{
  ok('the one that was waved away stays away',
    !bannerVisible({ phase: 'ready', readyId: 'abc', dismissedId: 'abc', segment: '(tabs)' }));

  ok('but the NEXT update still gets to speak',
    bannerVisible({ phase: 'ready', readyId: 'def', dismissedId: 'abc', segment: '(tabs)' }),
    'dismissing once must not silence every future fix');

  ok('an update with no id cannot be permanently dismissed',
    bannerVisible({ phase: 'ready', readyId: null, dismissedId: null, segment: '(tabs)' }),
    'erring toward showing the prompt beats hiding a fix');
}

section('What the driver is told');
{
  ok('with an empty queue, the reassurance is unconditional',
    restartHint(0).includes('Nothing on this phone is lost'));

  ok('with scans waiting, the count is named',
    restartHint(3).includes('3 unsent scans'), restartHint(3));

  ok('one scan reads as one scan, not "1 scans"',
    restartHint(1).includes('1 unsent scan ') && !restartHint(1).includes('scans'),
    restartHint(1));

  ok('a negative count cannot happen but does not produce nonsense',
    restartHint(-1) === restartHint(0));
}

section('The Settings line');
{
  ok('idle is the quiet answer', statusLine('idle', { enabled: true }) === 'Up to date');
  ok('ready says what to do next',
    statusLine('ready', { enabled: true }).includes('restart'));
  ok('an error shows the real message, not a generic one',
    statusLine('error', { enabled: true, error: 'Network request failed' })
      === 'Network request failed');
  ok('an error with no message still says something',
    statusLine('error', { enabled: true, error: null }).length > 0);
  ok('a dev build says so rather than claiming to be up to date',
    statusLine('idle', { enabled: false }) === 'Updates are off in this build');
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exit(1);
