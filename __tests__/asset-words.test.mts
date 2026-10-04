/**
 * node --experimental-strip-types __tests__/asset-words.test.mts
 *
 * THE BOXES THAT DESCRIBE AN ASSET USE THE COMPANY'S OWN WORDS.
 *
 * Every asset screen asked for a "Gas type", whatever the company tracked. The
 * words now follow `org.assetType` from the bootstrap. These pin three things:
 * a cylinder company — and any phone that was never told a type — reads
 * exactly what it read before; every other kind has its own words; and the
 * five screens take them from the table and no longer spell them out.
 */
import { readFileSync } from 'node:fs';
import { assetWords, wordFor, leaveAloneHint, kindHint, describedField } from '../src/asset-words.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

section('a cylinder company reads what it always read');
const cyl = assetWords('cylinder');
ok('Add and Edit: Gas type', cyl.contents?.label === 'Gas type' && cyl.contents.hint === 'What is in it.'
  && cyl.contents.placeholder === 'Gas type — Oxygen, Acetylene…');
ok('Add and Edit: Category', cyl.category.label === 'Category' && cyl.category.hint === 'Industrial, medical, beverage.'
  && cyl.category.placeholder === 'Category — Industrial, Medical…');
ok('Add and Edit: Group', cyl.group.label === 'Group' && cyl.group.hint === 'How it is grouped on reports.'
  && cyl.group.placeholder === 'Group — High-Pressure, Cryo…');
ok('bulk edit hints', leaveAloneHint(cyl.contents!) === "Leave blank to leave each one's gas type alone."
  && leaveAloneHint(cyl.category) === "Leave blank to leave each one's category alone."
  && leaveAloneHint(cyl.group) === "Leave blank to leave each one's group alone.");
ok('the batch screen hint', kindHint(cyl) === 'Pick one. Gas type, category, group and description fill in from it.');
ok('the change summary words', describedField('gasType', cyl) === 'gas type'
  && describedField('category', cyl) === 'category' && describedField('groupName', cyl) === 'group');

section('a phone that was never told a type is a cylinder phone');
ok('no type at all (older server, older download)', assetWords(undefined) === cyl);
ok('null', assetWords(null) === cyl);
ok('a type this build has not heard of', assetWords('hovercraft') === cyl);

section('every other kind has its own words');
const KINDS = ['keg', 'tote', 'pallet', 'tool', 'equipment', 'container'];
const CARRIES = new Set(['cylinder', 'keg', 'tote']);
for (const k of KINDS) {
  const w = assetWords(k);
  ok(`${k}: is not the cylinder table`, w !== cyl);
  ok(`${k}: category and group are fully worded`,
    [w.category, w.group].every((f) => !!f.label && !!f.hint && !!f.placeholder));
  ok(`${k}: ${CARRIES.has(k) ? 'asks what it contains' : 'has no contents box, because it carries nothing'}`,
    CARRIES.has(k) ? !!w.contents?.label && !!w.contents.hint && !!w.contents.placeholder : w.contents === null);
  ok(`${k}: nothing in it mentions gas`, !/gas|oxygen|acetylene/i.test(JSON.stringify(w)));
}
ok('a keg is contents, size and brand',
  [assetWords('keg').contents?.label, assetWords('keg').category.label, assetWords('keg').group.label].join() === 'Contents,Size,Brand');
ok('a tool is category and make', assetWords('tool').category.label === 'Category' && assetWords('tool').group.label === 'Make');
ok('the batch hint leaves contents out for a tool',
  kindHint(assetWords('tool')) === 'Pick one. Category, make and description fill in from it.');
ok('and names it for a keg', kindHint(assetWords('keg')) === 'Pick one. Contents, size, brand and description fill in from it.');
ok('a changed field is named in the company\'s words', describedField('groupName', assetWords('keg')) === 'brand'
  && describedField('category', assetWords('container')) === 'size');
ok('a contents change on a kind with no contents box still has a name',
  describedField('gasType', assetWords('tool')) === 'gas type');
ok('other fields are left to the screen', describedField('location', cyl) === null);
ok('wordFor lower-cases the label', wordFor(assetWords('equipment').group) === 'manufacturer');

section('the screens take their words from the table');
const rendered = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SCREENS = ['app/asset/new.tsx', 'app/asset/bulk-edit.tsx', 'app/asset/edit/[barcode].tsx',
  'app/asset/[barcode].tsx', 'app/asset/batch.tsx'];
for (const p of SCREENS) {
  const src = rendered(p);
  ok(`${p} does not spell out "Gas type"`, !/Gas type|gas type/.test(src));
  ok(`${p} reads the company's type from the bootstrap`, /assetWords\(boot\?\.org\?\.assetType\)/.test(src));
}
for (const p of ['app/asset/new.tsx', 'app/asset/bulk-edit.tsx', 'app/asset/edit/[barcode].tsx']) {
  ok(`${p} drops the contents box when there is nothing to contain`, /\{W\.contents \? \(/.test(rendered(p)));
}
ok('the bootstrap type allows a server that does not send a type',
  /assetType\?: string;/.test(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
