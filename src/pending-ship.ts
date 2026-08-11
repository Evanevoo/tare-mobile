/**
 * WHAT A CYLINDER IN HOUSE IS ACTUALLY SAYING.
 *
 * A SHIP scan does not move custody. The server is explicit about why — a ship
 * is a claim until a document is imported and approved, and letting a phone in
 * a yard assign a customer would make the handset the source of truth for
 * billing. So an asset scanned onto a truck at 06:40 is genuinely, correctly
 * in house, and nothing here changes that.
 *
 * The bug was that the screen said nothing else. IN HOUSE on a bottle that
 * left this morning and IN HOUSE on one that has not moved since March were
 * the same two words in the same grey, on the detail screen and in every
 * search result. The owner's report was exactly that: "the ship bottles must
 * say in-house as we havent approved it yet. maybe we can add a note saying
 * scanned to x? the returns they must be empty in-house (was at x)".
 *
 * Both halves live here, in one place, worded once. The console says the same
 * sentences from its own copy of this decision (src/lib/pending-ship.ts) — two
 * screens explaining the same hold in two different sets of words is how one
 * of them becomes the one people believe.
 *
 * Pure: no react-native import, no store import, so
 * `node --experimental-strip-types` tests it without a simulator.
 */

/**
 * The `ps` field on an asset in the bootstrap payload, present only on the
 * handful of things actually waiting on a document.
 *
 * `doc` separates the two holds because they need different things doing to
 * them: 0 means no document with that order number has reached the office at
 * all, 1 means one has and is sitting in the approvals queue waiting for a
 * person. A driver told the wrong one of those chases the wrong department.
 */
export interface PendingShipRec {
  /** Order number the scan was taken against. */
  o: string;
  /** The customer's name, or their account number, or '' when neither. */
  n: string;
  /** ISO instant of the scan. */
  at: string;
  doc: 0 | 1;
}

/** Everything about an asset that decides what its custody line says. */
export interface CustodyFacts {
  /** The holder's account number. Null means in house. */
  c: string | null;
  /** Full, as the payload sends it. */
  f: 0 | 1;
  /** Scanned out and not yet approved. */
  ps?: PendingShipRec | null;
  /** The name of whoever it last came back from. */
  lc?: string | null;
  /** The day it came back, YYYY-MM-DD. */
  rt?: string | null;
}

/**
 * A chip's meaning, not its colour.
 *
 * The screen maps these onto the palette, because the same three colours have
 * to mean the same three things on every screen — green full, red empty, blue
 * out, and now amber for "we said it went, nobody has signed for it". Handing
 * a hex code out of a pure module is how a state ends up drawn one colour here
 * and another one screen away, which this app has already been through once.
 */
export type Tone = 'full' | 'empty' | 'out' | 'pending' | 'quiet';

export interface Chip {
  label: string;
  tone: Tone;
}

/**
 * The chips across the top of the asset screen, left to right.
 *
 * Fill state only appears in house. Out at a customer it does not apply: the
 * bottle is rented, and how much is left in it is their business — showing
 * EMPTY on something earning right now reads as a fault even though the data
 * is correct.
 *
 * SCANNED OUT sits AFTER in house, never instead of it. The thing is in house;
 * that is the true and slightly surprising fact, and burying it would trade
 * one wrong screen for another.
 */
export function custodyChips(a: CustodyFacts): Chip[] {
  if (a.c) return [{ label: 'OUT', tone: 'out' }];

  const chips: Chip[] = [
    { label: a.f ? 'FULL' : 'EMPTY', tone: a.f ? 'full' : 'empty' },
    { label: 'IN HOUSE', tone: 'quiet' },
  ];
  if (a.ps) chips.push({ label: 'SCANNED OUT', tone: 'pending' });
  return chips;
}

/**
 * The chips a LIST row gets: the same decision, minus the quiet one.
 *
 * A search result has a caption under the barcode that already says "in house"
 * in words, and a chip repeating the sentence beside it is noise on a screen
 * somebody is scrolling past. SCANNED OUT is NOT dropped — it is the one thing
 * these rows could not say before, and dropping it here would leave the
 * pending state visible only if a driver opened the asset, which is the screen
 * he opens because he is already confused.
 *
 * A function rather than a filter written at each call site, so a third list
 * cannot quietly decide something different.
 */
export function listChips(a: CustodyFacts): Chip[] {
  return custodyChips(a).filter((c) => c.tone !== 'quiet');
}

/** "was at Howlett Construction", or '' when it has never come back from anywhere. */
export function wasAt(a: CustodyFacts): string {
  const name = (a.lc ?? '').trim();
  return name ? `was at ${name}` : '';
}

/** "was at Howlett Construction · back 2026-08-04". */
export function wasAtDetail(a: CustodyFacts): string {
  const was = wasAt(a);
  if (!was) return '';
  const day = (a.rt ?? '').trim();
  return day ? `${was} · back ${day}` : was;
}

/**
 * "Empty · in house · was at Howlett Construction" — the owner's own sentence,
 * for the detail screen.
 *
 * Out at a customer this is not the question being asked, so it answers the
 * one that is.
 */
export function custodyLine(a: CustodyFacts): string {
  if (a.c) return `Out at ${a.c}`;

  const parts = [a.f ? 'Full' : 'Empty', 'in house'];
  const was = wasAt(a);
  if (was) parts.push(was);
  return parts.join(' · ');
}

/**
 * The same thing for a list row, where the barcode and the product code are
 * already on the line and there is room for about six more words.
 *
 * Lower case and no fill state: the row draws FULL/EMPTY as a chip already,
 * and repeating it in the caption is noise on a screen somebody is scrolling.
 */
export function custodyCaption(a: CustodyFacts): string {
  if (a.c) return `out at ${a.c}`;
  if (a.ps) return `in house · scanned to ${a.ps.n || 'a customer'} on ${a.ps.o}`;
  const was = wasAt(a);
  return was ? `in house · ${was}` : 'in house';
}

/** "Scanned to POW City Mechanical Partnership on order 78089, awaiting approval" */
export function pendingHeadline(ps: PendingShipRec): string {
  const who = (ps.n ?? '').trim();
  return `Scanned ${who ? `to ${who}` : 'out'} on order ${ps.o}, awaiting approval`;
}

/**
 * Why it still says in house.
 *
 * The no-document sentence is the console's own words, verbatim from the scan
 * detail screen, which has been telling the office this for as long as the
 * approvals queue has existed. A driver and a dispatcher looking at the same
 * held scan should read the same explanation.
 */
export function pendingNote(ps: PendingShipRec, singular = 'asset'): string {
  const thing = (singular ?? '').trim().toLowerCase() || 'asset';
  return ps.doc
    ? `Order ${ps.o} has been imported and is waiting to be approved. Custody moves when somebody approves it, not when a driver scans it, so this ${thing} is still in house.`
    : `No invoice with order number ${ps.o} has been imported. That is not an error — the scan is held until the document arrives, and this ${thing} stays in house until the document is approved.`;
}
