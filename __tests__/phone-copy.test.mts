/**
 * node --experimental-strip-types __tests__/phone-copy.test.mts
 *
 * NOTHING A DRIVER READS NAMES ANOTHER COMPANY, OR SAYS WHAT IS NOT TRUE.
 *
 * The app was built inside one company, and three screens still gave that
 * company's name as the example of a supplier. The next company to install
 * it reads a competitor's name in a hint under a text box. A fourth screen
 * said "No password is ever stored on this phone", which was true until the
 * sign-in screen learned to save one.
 *
 * None of those is something a type checker or a scan test can see. Each is
 * a sentence. So the sentences are checked: every screen is read with its
 * comments removed, and what is left — code, and the text it draws — must not
 * contain them. Comments are exempt on purpose; they are where this codebase
 * records why, usually by naming the day it broke and for whom.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function rendered(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Not after a colon, so the `//` in a URL is not read as a comment.
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}

const BANNED: [RegExp, string][] = [
  [/weldcor/i, 'names another company'],
  [/davis machine/i, 'names a customer of another company'],
  [/PW-K-\d+/, "shows another company's barcode as the example"],
  [/no password is ever stored/i, 'says no password is stored, which stopped being true'],
  [/newscanified\.netlify\.app/i, 'shows the old address of the site'],
];

section('phone copy: what the screens say');

const files = [...walk('app'), ...walk('src')];
ok('there are screens to check', files.length > 40, `found ${files.length}`);

for (const [pattern, why] of BANNED) {
  const hits = files.filter((f) => pattern.test(rendered(f)));
  ok(`nothing on the phone ${why}`, hits.length === 0, `${pattern} in: ${hits.join(', ')}`);
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
