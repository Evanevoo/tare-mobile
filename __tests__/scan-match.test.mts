/**
 * node --experimental-strip-types __tests__/scan-match.test.mts
 *
 * WHAT A SCANNED LABEL TURNS OUT TO BE.
 *
 * The values in here are not invented. They are the row that broke: Davis
 * Machine Company's card, as the printer produced it, as the decoder read it,
 * and as the ERP stores it. Three different strings for one customer, which is
 * exactly the situation `key()` exists to survive.
 */
import { classify, key, explainMiss } from '../src/scan-match.ts';
import type { AssetRec, Bootstrap, CustomerRec } from '../src/api.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** A customer row, with only the fields this decision reads spelled out. */
const cust = (customerListId: string, name: string, bc: string | null): CustomerRec => ({
  id: `uuid-${customerListId}`, customerListId, name, bc,
  city: null, region: null, address: null, postal: null,
  contact: null, phone: null, email: null, held: 0,
});

const asset: AssetRec = {
  p: 'PROPANE-20', sn: null, s: 'available', f: 1, l: null, c: null,
  own: 0, rq: null, lq: null,
};

const boot = (
  customers: CustomerRec[], assets: Record<string, AssetRec> = {},
): Bootstrap => ({
  v: 4,
  org: { name: 'WeldCor', assetLabel: 'cylinder', assetPlural: 'cylinders' },
  user: { name: 'Driver', email: 'd@example.com', role: 'driver' },
  customers, assets, locations: [], products: [],
  stats: { total: 0, out: 0, inHouse: 0, full: 0, customers: customers.length },
  outCount: 0, syncedAt: '2026-08-09T00:00:00.000Z',
});

/* The row that broke, in all three of its real spellings. */
const LIST_ID = '800006D2-1614971550A';
const STORED = '*%800006D2-1614971550A*';   // as printed on the card
const SCANNED = '%800006D2-1614971550A';    // as the decoder reads it
const NAME = 'Davis Machine Company (1960)LTD';

const davis = cust(LIST_ID, NAME, STORED);

section('key() — what survives is the payload');
{
  ok('the printed card and the account number reduce to the same thing',
    key(STORED) === key(LIST_ID), `${key(STORED)} vs ${key(LIST_ID)}`);
  ok('and so does what the decoder actually returns',
    key(SCANNED) === '800006D21614971550A', key(SCANNED));
  ok('case does not matter', key('ab-12') === key('AB12'));
  ok('a code of pure punctuation reduces to nothing', key('***') === '');
}

section('Davis Machine Company — the scan that found nobody');
{
  const t = classify(SCANNED, boot([davis]));
  ok('the card, read without its asterisks, finds the customer',
    t?.kind === 'customer', JSON.stringify(t));
  ok('and identifies them by ACCOUNT NUMBER, which is what gets billed',
    t?.kind === 'customer' && t.id === LIST_ID, JSON.stringify(t));
  ok('and carries the name for the screen',
    t?.kind === 'customer' && t.name === NAME);
}

section('The same scan against every shape the phone might be holding');
{
  const withAsterisks = classify(STORED, boot([davis]));
  ok('asterisks included — an exact, byte-identical read still matches',
    withAsterisks?.kind === 'customer' && withAsterisks.id === LIST_ID,
    JSON.stringify(withAsterisks));

  // The import never mapped the customer-barcode column, so bc is null on the
  // phone. The account number has to carry the scan on its own.
  const noCard = classify(SCANNED, boot([cust(LIST_ID, NAME, null)]));
  ok('bc is null — it falls back to the account number and still matches',
    noCard?.kind === 'customer' && noCard.id === LIST_ID, JSON.stringify(noCard));

  const lower = classify(SCANNED.toLowerCase(), boot([davis]));
  ok('a lowercase read matches too',
    lower?.kind === 'customer' && lower.id === LIST_ID, JSON.stringify(lower));

  const spaced = classify(`  ${SCANNED}  `, boot([davis]));
  ok('surrounding whitespace is not a miss',
    spaced?.kind === 'customer' && spaced.id === LIST_ID, JSON.stringify(spaced));
}

section('Order of precedence');
{
  const b = boot([davis], { [SCANNED]: asset });
  const t = classify(SCANNED, b);
  ok('a barcode the fleet knows wins over a customer code that reduces the same',
    t?.kind === 'asset', JSON.stringify(t));

  // The card is what the counter scans, so it is checked before the account
  // number — a tenant may print something that is not simply their number.
  const other = cust('AB123', 'Whoever Ltd', null);
  const carded = cust('ZZ999', 'Card Holder Ltd', '*AB-123*');
  const t2 = classify('AB123', boot([other, carded]));
  ok('the printed card beats a different customer whose account number collides',
    t2?.kind === 'customer' && t2.id === 'ZZ999', JSON.stringify(t2));
}

section('Nothing matched');
{
  const t = classify('INV-9001', boot([davis]));
  ok('a genuinely unknown code is just text', t?.kind === 'text', JSON.stringify(t));
  ok('and comes back uppercased, ready for the order-number field',
    t?.kind === 'text' && t.code === 'INV-9001');
  ok('an empty read is nothing at all', classify('   ', boot([davis])) === null);
  ok('a code of pure punctuation is text, not a customer',
    classify('***', boot([davis]))?.kind === 'text');
  ok('with no bootstrap at all, everything is text',
    classify(SCANNED, null)?.kind === 'text');
}

section('AMBIGUITY MUST NEVER BE GUESSED — the wrong customer is worse than no customer');
{
  // Two real customers whose codes differ only in punctuation. Reducing both
  // collapses them onto one key, and there is no honest way to choose.
  const twoCards = boot([
    cust('C-1', 'Acme Welding', '*AB-123*'),
    cust('C-2', 'Acme Welding Supply', '*AB123*'),
  ]);
  const t = classify('AB123', twoCards);
  ok('two cards reducing to one key identify NOBODY', t?.kind === 'text',
    JSON.stringify(t));

  const twoAccounts = boot([
    cust('AB-123', 'Acme Welding', null),
    cust('AB123', 'Acme Welding Supply', null),
  ]);
  const t2 = classify('AB123', twoAccounts);
  ok('two account numbers reducing to one key identify NOBODY too',
    t2?.kind === 'text', JSON.stringify(t2));

  // An exact, byte-identical read is not ambiguous — the tenant stored that
  // precise string against exactly one customer.
  const t3 = classify('*AB-123*', twoCards);
  ok('but a byte-identical read still resolves, because it is not ambiguous',
    t3?.kind === 'customer' && t3.id === 'C-1', JSON.stringify(t3));
}

section('A MISS SAYS WHY — the thing whose absence made this expensive');
{
  const stale = boot([cust(LIST_ID, NAME, null), cust('C-9', 'Someone Else', null)]);
  const m = explainMiss('XYZ-1', stale);
  ok('a list with no card codes on it says exactly that',
    m.includes('None of the 2 customers') && m.includes('card code'), m);
  ok('and names the code that was read', m.includes('XYZ-1'), m);

  const healthy = explainMiss('XYZ-1', boot([davis]));
  ok('a healthy list says the code simply is not known',
    healthy.includes('no customer or cylinder matches on this phone'), healthy);
  ok('and shows what the phone is holding, so a report is actionable',
    healthy.includes('1 customers, 1 with a card code'), healthy);

  const ambiguous = explainMiss('AB123', boot([
    cust('C-1', 'Acme Welding', '*AB-123*'),
    cust('C-2', 'Acme Welding Supply', '*AB123*'),
  ]));
  ok('a refusal reads as a refusal, not as an unknown code',
    ambiguous.includes('matches 2 customers'), ambiguous);

  ok('an empty phone says to download the list',
    explainMiss('AB123', boot([])).includes('no customers are on this phone'));
  ok('and no bootstrap at all says so too',
    explainMiss('AB123', null).includes('nothing is downloaded'));
}

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) process.exit(1);
