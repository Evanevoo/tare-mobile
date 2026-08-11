/**
 * node --experimental-strip-types __tests__/pending-ship.test.mts
 *
 * THE TEST FOR THE TWO WORDS THAT WERE NOT ENOUGH.
 *
 * IN HOUSE on a bottle scanned onto a truck at 06:40, and IN HOUSE on one that
 * has sat on the rack since March, were the same chip in the same grey. The
 * server is right not to move custody on a scan; the handset was wrong to say
 * nothing about it. Everything below is what the screens now say instead, and
 * the cases are the ways it could still be wrong: a bottle out at a customer,
 * one back from somewhere with no memory of it, an order scanned against an
 * account that has no name.
 */
import {
  custodyChips, listChips, custodyLine, custodyCaption, wasAt, wasAtDetail,
  pendingHeadline, pendingNote,
  type CustodyFacts, type PendingShipRec,
} from '../src/pending-ship.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const ps = (o: Partial<PendingShipRec> = {}): PendingShipRec => ({
  o: '78089', n: 'POW City Mechanical Partnership',
  at: '2026-08-11T13:40:00.000Z', doc: 0, ...o,
});
const asset = (o: Partial<CustodyFacts> = {}): CustodyFacts =>
  ({ c: null, f: 0, ...o });
const labels = (a: CustodyFacts) => custodyChips(a).map((x) => x.label).join(' ');
const tones = (a: CustodyFacts) => custodyChips(a).map((x) => x.tone).join(' ');

// ── the chips ───────────────────────────────────────────────────────────────
section('The chips across the top of the asset screen');
{
  ok('a bottle nobody has touched reads empty and in house',
     labels(asset()) === 'EMPTY IN HOUSE', labels(asset()));
  ok('a full one says so', labels(asset({ f: 1 })) === 'FULL IN HOUSE');

  const out = asset({ c: '80000005', f: 1 });
  ok('out at a customer, custody is the only thing said',
     labels(out) === 'OUT', labels(out));
  // Fill state is a shelf state. On something earning right now it reads as a
  // fault even though the data is correct, so it is not drawn at all.
  ok('and no fill claim is made about something on a customer’s site',
     !labels(out).includes('FULL') && !labels(out).includes('EMPTY'));

  const pend = asset({ ps: ps() });
  ok('scanned out but not approved, IN HOUSE stays and SCANNED OUT joins it',
     labels(pend) === 'EMPTY IN HOUSE SCANNED OUT', labels(pend));
  ok('and it comes last — the surprising fact is that it IS in house',
     custodyChips(pend)[2].label === 'SCANNED OUT');
  ok('it carries its own tone rather than borrowing the out-at-a-customer one',
     custodyChips(pend)[2].tone === 'pending');
  ok('the tones are meanings, never hex',
     tones(pend) === 'empty quiet pending', tones(pend));

  ok('a customer holding it beats a stale pending record',
     labels(asset({ c: '80000005', ps: ps() })) === 'OUT');
}

section('A list row says less, but never less than the pending state');
{
  const row = (a: CustodyFacts) => listChips(a).map((x) => x.label).join(' ');

  // The caption beside a search result already says "in house" in words.
  ok('IN HOUSE is left to the caption', row(asset()) === 'EMPTY', row(asset()));
  ok('a full one still says full', row(asset({ f: 1 })) === 'FULL');
  ok('out at a customer is unchanged', row(asset({ c: '80000005' })) === 'OUT');

  // The one thing a list row could not say before. Dropping it here would
  // leave the pending state visible only to somebody who already opened the
  // asset — and he opens it because he is already confused.
  ok('SCANNED OUT survives the trim',
     row(asset({ ps: ps() })) === 'EMPTY SCANNED OUT', row(asset({ ps: ps() })));
  ok('and keeps its own tone',
     listChips(asset({ ps: ps() })).map((x) => x.tone).join(' ') === 'empty pending');

  ok('nothing quiet ever reaches a row',
     listChips(asset({ ps: ps() })).every((c) => c.tone !== 'quiet'));
}

// ── the detail line ─────────────────────────────────────────────────────────
section('"Empty · in house · was at X" — the owner’s own sentence');
{
  const back = asset({ lc: 'Howlett Construction', rt: '2026-08-04' });
  ok('the whole line', custodyLine(back) === 'Empty · in house · was at Howlett Construction',
     custodyLine(back));
  ok('a full one reads full', custodyLine({ ...back, f: 1 }) ===
     'Full · in house · was at Howlett Construction');
  ok('one that has never been anywhere just says in house',
     custodyLine(asset()) === 'Empty · in house', custodyLine(asset()));
  ok('out at a customer answers the question actually being asked',
     custodyLine(asset({ c: '80000005' })) === 'Out at 80000005');

  ok('the detail form adds the day it came back',
     wasAtDetail(back) === 'was at Howlett Construction · back 2026-08-04',
     wasAtDetail(back));
  ok('no date still names the customer',
     wasAtDetail({ ...back, rt: null }) === 'was at Howlett Construction');
  ok('an empty name is no clause rather than a dangling separator',
     wasAt(asset({ lc: '   ' })) === '');
}

// ── the list caption ────────────────────────────────────────────────────────
section('The caption on a search row, where there is room for six words');
{
  ok('a plain in-house one says so',
     custodyCaption(asset()) === 'in house');
  ok('a returned one says where it came back from',
     custodyCaption(asset({ lc: 'FALCON TRANSPORT' })) === 'in house · was at FALCON TRANSPORT');
  ok('one out at a customer says who has it',
     custodyCaption(asset({ c: '80000005' })) === 'out at 80000005');

  const pend = custodyCaption(asset({ ps: ps() }));
  ok('a pending one still says in house first',
     pend.startsWith('in house · '), pend);
  ok('and names who it was scanned to, and on what order',
     pend === 'in house · scanned to POW City Mechanical Partnership on 78089', pend);
  ok('an unnamed account does not become "scanned to null"',
     custodyCaption(asset({ ps: ps({ n: '' }) })) === 'in house · scanned to a customer on 78089',
     custodyCaption(asset({ ps: ps({ n: '' }) })));
  // The row must not go on saying "was at" about a bottle that has since been
  // scanned back out — where it is GOING is the newer, more useful fact.
  ok('a pending one drops the older "was at" clause',
     !custodyCaption(asset({ ps: ps(), lc: 'FALCON TRANSPORT' })).includes('was at'));
}

// ── the sentences ───────────────────────────────────────────────────────────
section('What the banner says');
{
  ok('the headline is the sentence the owner asked for',
     pendingHeadline(ps()) ===
     'Scanned to POW City Mechanical Partnership on order 78089, awaiting approval',
     pendingHeadline(ps()));
  ok('with no account it still reads as English',
     pendingHeadline(ps({ n: '' })) === 'Scanned out on order 78089, awaiting approval',
     pendingHeadline(ps({ n: '' })));

  // Verbatim from the console's scan detail screen. If somebody reworded one
  // of the two, this fails and they have to reword both.
  ok('no document yet reuses the console’s own words',
     pendingNote(ps(), 'Cylinder').startsWith(
       'No invoice with order number 78089 has been imported. That is not an error — the scan is held until the document arrives'),
     pendingNote(ps(), 'Cylinder'));
  ok('and it names the thing in the tenant’s own word',
     pendingNote(ps(), 'Cylinder').includes('this cylinder stays in house'));
  ok('with no label it still says something true',
     pendingNote(ps()).includes('this asset stays in house'), pendingNote(ps()));

  const queued = ps({ doc: 1 });
  ok('an imported document waiting on a person is a different sentence',
     pendingNote(queued).includes('waiting to be approved'), pendingNote(queued));
  ok('and it does not claim the document is missing',
     !pendingNote(queued).includes('has been imported. That is not an error'));
  ok('both say why it is still in house',
     pendingNote(ps()).includes('in house') && pendingNote(queued).includes('in house'));
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
if (failed > 0) process.exit(1);
