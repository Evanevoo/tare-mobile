/**
 * node --experimental-strip-types __tests__/cache-owner.test.mts
 *
 * ONE COMPANY'S SCANS ON ANOTHER COMPANY'S SCREEN.
 *
 * Reported 28 Sep 2026: signed in to a demo company on a phone that had been
 * signed in to a real one that morning, History drew the real company's orders
 * for about a second and then replaced them with the demo's. The server had
 * leaked nothing. The phone had: History puts the last page it downloaded on
 * screen before it asks the network, that page was on disk from the previous
 * login, and signing out had cleared four caches and not that one.
 *
 * Two promises are pinned here. A cached download is only ever shown to the
 * login that downloaded it. And no cache can be added to the app without
 * somebody deciding which kind it is — the last test reads the source, because
 * the bug was a list somebody forgot to extend.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_CACHES, DEVICE_CACHES, OWNER_KEY, ownerVerdict, ownedBy,
} from '../src/cache-owner.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

section('whose phone is it now');

ok('the same login keeps what it downloaded',
  ownerVerdict('driver@yard.ca', 'driver@yard.ca') === 'keep');
ok('case and stray spaces are not a different person',
  ownerVerdict(' Driver@Yard.ca ', 'driver@yard.ca') === 'keep');
ok('a different login wipes it',
  ownerVerdict('office@realco.ca', 'demo@scanified.com') === 'wipe');
ok('no stamp yet (written by an older build) keeps — once',
  ownerVerdict(null, 'driver@yard.ca') === 'keep');
/* Offline with a session too old to read: nothing new can be fetched, so
   throwing away the fleet would leave a driver in a yard with an empty app. */
ok('nobody identifiable keeps: there is nothing to replace it with',
  ownerVerdict('driver@yard.ca', null) === 'keep');

section('a cached page is shown only to the login that downloaded it');

const page = { orders: [{ orderNumber: 'S1' }], owner: 'office@realco.ca' };
ok('the owner sees it', ownedBy(page, 'office@realco.ca') === page);
ok('the owner sees it however the address was typed', ownedBy(page, 'Office@RealCo.ca ') === page);
ok('anybody else sees nothing', ownedBy(page, 'demo@scanified.com') === null);
ok('a page with no owner on it is nobody\'s, so it is not shown',
  ownedBy({ orders: [{ orderNumber: 'S1' }] }, 'demo@scanified.com') === null);
ok('with nobody signed in it is not shown', ownedBy(page, null) === null);
ok('nothing cached is nothing', ownedBy(null, 'demo@scanified.com') === null);

section('every cache is on one list or the other');

ok('the two History pages are account caches',
  ACCOUNT_CACHES.includes('history' as never) && ACCOUNT_CACHES.includes('fill-history' as never));
ok('so are the fleet, the job in hand and the Locate draft',
  (['bootstrap', 'lastSync', 'delivery', 'locateDraft'] as const)
    .every((k) => ACCOUNT_CACHES.includes(k as never)));
ok('the stamp itself is not wiped with them', !ACCOUNT_CACHES.includes(OWNER_KEY as never));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}

/* Every key handed to cacheGet or cacheSet, as a literal or as a constant
   defined in the same file. The type argument can span lines, hence [\s\S]. */
const CALL = /cache(?:Get|Set)\s*(?:<[\s\S]*?>)?\s*\(\s*(?:(['"`])([\w-]+)\1|([A-Z][A-Z0-9_]*))/g;
const known = new Set<string>([...ACCOUNT_CACHES, ...DEVICE_CACHES, OWNER_KEY]);
const used = new Map<string, string>();
const unresolved: string[] = [];

for (const file of [...walk('app'), ...walk('src')]) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL)) {
    if (m[2]) { used.set(m[2], file); continue; }
    // The stamp's own key is imported rather than defined where it is used.
    if (m[3] === 'OWNER_KEY') { used.set(OWNER_KEY, file); continue; }
    const def = new RegExp(`const\\s+${m[3]}\\s*=\\s*(['"\`])([\\w-]+)\\1`).exec(src);
    if (def) used.set(def[2], file); else unresolved.push(`${m[3]} in ${file}`);
  }
}

ok('the scan found the caches it should', used.has('history') && used.has('locateDraft'),
  [...used.keys()].join(', '));
ok('every key could be read off the source', unresolved.length === 0, unresolved.join('; '));
const strays = [...used].filter(([k]) => !known.has(k));
ok(
  strays.length === 0
    ? 'no cache exists that sign-out does not know about'
    : `not on either list in src/cache-owner.ts: ${strays.map(([k, f]) => `${k} (${f})`).join(', ')}`,
  strays.length === 0,
);

section('and the three places that must use the list, do');

/* The store and the screen import native modules, so they cannot be run under
   plain node. Their source can be read, which is enough to notice the list
   being bypassed — a hand-written set of four keys is how this began. */
const store = readFileSync(join('src', 'store.ts'), 'utf8');
const handOver = store.slice(store.indexOf('async handOver('), store.indexOf('async refresh('));
const hydrate = store.slice(store.indexOf('async hydrate('), store.indexOf('async handOver('));
ok('signing out clears every account cache, from the list',
  /ACCOUNT_CACHES\.map\(/.test(handOver));
ok('and no longer names them one at a time',
  !/cacheSet\('(bootstrap|lastSync|delivery)', null\)/.test(handOver));
ok('starting up asks whose caches these are before reading any',
  hydrate.indexOf('ownerVerdict(') > -1
    && hydrate.indexOf('ownerVerdict(') < hydrate.indexOf("cacheGet<Bootstrap>('bootstrap')"));
ok('and stamps them for whoever is signed in', /cacheSet\(OWNER_KEY,/.test(hydrate));

const screen = readFileSync(join('app', 'history.tsx'), 'utf8');
const reads = [...screen.matchAll(/cacheGet<\w+>\('(history|fill-history)'\)/g)].length;
const guarded = [...screen.matchAll(/ownedBy\(\s*await cacheGet<\w+>\('(history|fill-history)'\)/g)].length;
ok('History reads both of its caches', reads === 2, `found ${reads}`);
ok('and shows neither to anybody but the login that downloaded it', guarded === 2, `guarded ${guarded}`);
ok('and writes the owner into both',
  [...screen.matchAll(/owner: email/g)].length === 2);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
