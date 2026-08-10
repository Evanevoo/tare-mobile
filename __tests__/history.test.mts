/**
 * node --experimental-strip-types __tests__/history.test.mts
 *
 * THE ORDER THAT DISAPPEARED, AND THE ONE THAT APPEARED TWICE.
 *
 * History is the company's list now, not this handset's, and the join between
 * the two is src/history.ts. The owner's complaint was the first of those
 * failures — a screen built out of the outbox showed nothing at all on a fresh
 * install, which from a yard is indistinguishable from a shift going missing.
 * The second is the one this change could introduce: the same order drawn once
 * by the server and once by the phone, or a load of three bottles counted as
 * six because both sides counted the same scans.
 *
 * So the bias here is arithmetic and identity. Every test below is either "is
 * this one row or two" or "how many went out", because those are the two
 * questions a driver reads this screen to answer, and both of them are wrong
 * in a way nobody notices until an invoice is disputed.
 */
import {
  orderKey, mergeHistory, appendPage, offlineNotice,
  type ServerOrder, type LocalScan,
} from '../src/history.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** One order as the server counts it. Everything not stated is nothing. */
const srv = (o: Partial<ServerOrder> & { orderNumber: string }): ServerOrder => ({
  customerListId: 'C1', customerName: 'Acme Welding',
  ship: 0, ret: 0, voided: 0, lastScanAt: '2026-08-10T12:00:00.000Z', scannedBy: [],
  ...o,
});

/** One row of this phone's outbox. */
const local = (
  orderNumber: string, mode: 'SHIP' | 'RETURN',
  state: LocalScan['state'], scannedAt: string, customerListId = 'C1',
): LocalScan => ({ orderNumber, mode, state, scannedAt, customerListId });

const names = new Map([['C1', 'Acme Welding'], ['C2', 'Redwater Fab']]);

section('THE COMPANY’S LIST, WHICH IS THE WHOLE POINT');
{
  const rows = mergeHistory(
    [
      srv({ orderNumber: 'SO-1001', ship: 6, ret: 2, lastScanAt: '2026-08-10T09:00:00.000Z' }),
      srv({ orderNumber: 'SO-1002', ship: 3, lastScanAt: '2026-08-10T15:00:00.000Z' }),
    ],
    [],
  );
  ok('an empty outbox does not empty the screen — that was the bug', rows.length === 2);
  ok('newest first, because the order somebody is asking about is the last one finished',
    rows[0].orderNumber === 'SO-1002');
  ok('the server’s counts are the counts', rows[1].ship === 6 && rows[1].ret === 2);
  ok('nothing is marked as this phone’s', rows.every((r) => !r.onlyOnPhone && r.pending === 0));
  ok('and no orders at all is an empty list, not a throw', mergeHistory([], []).length === 0);
}

section('SCANNED IN A YARD WITH NO BARS — it shows up now, marked');
{
  const rows = mergeHistory(
    [srv({ orderNumber: 'SO-1001', ship: 1, lastScanAt: '2026-08-10T09:00:00.000Z' })],
    [
      local('SO-2000', 'SHIP', 'QUEUED', '2026-08-10T16:00:00.000Z', 'C2'),
      local('SO-2000', 'SHIP', 'QUEUED', '2026-08-10T16:01:00.000Z', 'C2'),
      local('SO-2000', 'RETURN', 'UPLOADING', '2026-08-10T16:02:00.000Z', 'C2'),
    ],
    { names, me: 'Dave' },
  );
  ok('the order the server has never heard of is on the screen', rows.length === 2);
  ok('at the top, because it is the newest thing that happened',
    rows[0].orderNumber === 'SO-2000');
  ok('flagged as nowhere but here', rows[0].onlyOnPhone === true);
  ok('with every one of them counted as still to go up', rows[0].pending === 3);
  ok('and counted the way the driver counts them', rows[0].ship === 2 && rows[0].ret === 1);
  ok('the customer is named from the downloaded list, not left as an account number',
    rows[0].customerName === 'Redwater Fab', rows[0].customerName);
  ok('an UPLOADING row is still not uploaded — a rollback is one dropped connection away',
    rows[0].pending === 3);
  ok('whoever is holding the phone is who scanned it',
    rows[0].scannedBy.join(',') === 'Dave');
  ok('the last scan is the newest of them', rows[0].lastScanAt === '2026-08-10T16:02:00.000Z');
}

section('COUNTING A LOAD ONCE — the mistake that ends up on an invoice');
{
  const rows = mergeHistory(
    [srv({ orderNumber: 'SO-1001', ship: 3, ret: 1, lastScanAt: '2026-08-10T09:00:00.000Z' })],
    [
      // The three the server already counted, plus one that has not gone up.
      local('SO-1001', 'SHIP', 'SENT', '2026-08-10T08:58:00.000Z'),
      local('SO-1001', 'SHIP', 'SENT', '2026-08-10T08:59:00.000Z'),
      local('SO-1001', 'SHIP', 'SENT', '2026-08-10T09:00:00.000Z'),
      local('SO-1001', 'RETURN', 'SENT', '2026-08-10T09:00:00.000Z'),
      local('SO-1001', 'SHIP', 'QUEUED', '2026-08-10T11:30:00.000Z'),
    ],
    { names },
  );
  ok('one order, one row', rows.length === 1);
  ok('a scan the server already has is not counted a second time',
    rows[0].ship === 4, `ship=${rows[0].ship}`);
  ok('nor on the way back', rows[0].ret === 1, `ret=${rows[0].ret}`);
  ok('only what has not gone up is pending', rows[0].pending === 1);
  ok('and it is not "only on this phone" — the server has most of it',
    rows[0].onlyOnPhone === false);
  ok('the newer local scan moves the order’s clock forward',
    rows[0].lastScanAt === '2026-08-10T11:30:00.000Z');
}

section('ONE ORDER, TWO SPELLINGS — still one row');
{
  const rows = mergeHistory(
    [srv({ orderNumber: 'so-1001', ship: 2, lastScanAt: '2026-08-10T09:00:00.000Z' })],
    [local(' SO-1001 ', 'SHIP', 'QUEUED', '2026-08-10T10:00:00.000Z')],
    { names },
  );
  ok('case and a stray space do not make a second delivery', rows.length === 1);
  ok('the counts land on the one row', rows[0].ship === 3 && rows[0].pending === 1);
  ok('the server’s spelling is the one on screen, because that is what the office sees',
    rows[0].orderNumber === 'so-1001');
  ok('orderKey on its own', orderKey(' so-1001 ') === 'SO-1001');
}

section('WHAT IS SENT BUT NOT ON THE PAGE — an order older than what came down');
{
  const rows = mergeHistory(
    [],
    [
      local('SO-0900', 'SHIP', 'SENT', '2026-07-01T09:00:00.000Z'),
      local('SO-0900', 'RETURN', 'SENT', '2026-07-01T09:01:00.000Z'),
    ],
    { names },
  );
  ok('it is still a row, not a gap', rows.length === 1);
  ok('and its scans are counted, because nothing else on this screen is counting them',
    rows[0].ship === 1 && rows[0].ret === 1);
  ok('with nothing waiting to upload', rows[0].pending === 0);
  ok('flagged as unseen by the server rather than as unsent, which would be a lie',
    rows[0].onlyOnPhone === true);
}

section('WHO ELSE TOUCHED IT, AND WHO IT WAS FOR');
{
  const rows = mergeHistory(
    [srv({ orderNumber: 'SO-1001', customerName: 'Acme Welding', scannedBy: ['Dave', 'Priya'] })],
    [],
    { names },
  );
  ok('the server says who scanned it — the half one handset could never know',
    rows[0].scannedBy.join(', ') === 'Dave, Priya');
  ok('withdrawn scans are carried through rather than quietly dropped',
    mergeHistory([srv({ orderNumber: 'SO-1', voided: 2 })], [])[0].voided === 2);

  const unknown = mergeHistory(
    [], [local('SO-3000', 'SHIP', 'QUEUED', '2026-08-10T10:00:00.000Z', 'C9')], { names },
  );
  ok('a customer nobody has downloaded falls back to the account number, never to blank',
    unknown[0].customerName === 'C9');
  ok('and a scan with no customer at all does not crash the row',
    mergeHistory([], [local('SO-4000', 'SHIP', 'QUEUED', '2026-08-10T10:00:00.000Z', '')])
      [0].customerName === '');
}

section('PAGING — the same order must not arrive twice');
{
  const first = [
    srv({ orderNumber: 'SO-1002', lastScanAt: '2026-08-10T15:00:00.000Z' }),
    srv({ orderNumber: 'SO-1001', lastScanAt: '2026-08-10T09:00:00.000Z' }),
  ];
  const second = [
    // Scanned again while the driver was scrolling, so it straddles the boundary.
    srv({ orderNumber: 'SO-1001', lastScanAt: '2026-08-10T09:00:00.000Z' }),
    srv({ orderNumber: 'SO-1000', lastScanAt: '2026-08-09T16:00:00.000Z' }),
  ];
  const both = appendPage(first, second);
  ok('the repeat is dropped, not appended five rows below itself', both.length === 3);
  ok('the older page goes on the end, in order',
    both.map((o) => o.orderNumber).join(',') === 'SO-1002,SO-1001,SO-1000');
  ok('the page already in hand is untouched', first.length === 2);
  ok('a page of nothing changes nothing', appendPage(first, []).length === 2);
  ok('and the merge would not have doubled it either',
    mergeHistory([...first, ...second], []).length === 3);
}

section('THE ORDER OF THE LIST');
{
  const rows = mergeHistory(
    [
      srv({ orderNumber: 'SO-B', lastScanAt: '2026-08-09T10:00:00.000Z' }),
      srv({ orderNumber: 'SO-A', lastScanAt: '2026-08-09T10:00:00.000Z' }),
      srv({ orderNumber: 'SO-C', lastScanAt: '2026-08-10T10:00:00.000Z' }),
    ],
    [local('SO-D', 'SHIP', 'QUEUED', '2026-08-11T10:00:00.000Z')],
  );
  ok('newest first', rows.map((r) => r.orderNumber).join(',') === 'SO-D,SO-C,SO-A,SO-B');
  ok('two orders finished at the same moment do not swap places between renders',
    rows[2].orderNumber === 'SO-A' && rows[3].orderNumber === 'SO-B');
}

section('SAYING IT PLAINLY WHEN THERE IS NO SIGNAL');
{
  const at = '2026-08-10T14:38:00.000Z';
  const said = offlineNotice(at);
  ok('it says the list is what came down, and when',
    said.includes('downloaded') && said.includes('Pull down'), said);
  ok('it warns that anything scanned since is missing from it',
    said.includes('is not in it'), said);
  ok('never a status code', !/\b[1-5]\d\d\b/.test(said) && !said.toLowerCase().includes('error'),
    said);
  const never = offlineNotice(null);
  ok('and when nothing was ever downloaded it says that instead of showing a date',
    never.includes('nothing downloaded') && !never.includes('downloaded Today'), never);
  ok('still no code in it',
    !/\b[1-5]\d\d\b/.test(never) && !never.toLowerCase().includes('error'), never);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
