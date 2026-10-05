import type { Bootstrap, CustomerRec } from './api';

/**
 * WHAT A SCANNED CODE TURNED OUT TO BE.
 *
 * Two screens point a camera at a label without knowing in advance what kind of
 * label it is — Delivery setup and the search bar on Home — and both have to
 * answer the same question in the same order. That order is the whole point of
 * this file, and it is not alphabetical:
 *
 *   1. an asset the fleet already knows about
 *   2. a code matching a customer
 *   3. anything else: it is just a string
 *
 * Asset first, because a mis-scanned cylinder landing silently in an
 * order-number field is precisely the error that makes an invoice
 * unexplainable three weeks later.
 *
 * SEPARATE FROM THE HOOK ON PURPOSE. This decides which customer gets billed
 * for a cylinder, and it used to live in a file that imports expo-router and
 * zustand — so it could not be run outside a phone, and it was never tested.
 * Nothing here touches React. It is a pure function of (code, bootstrap), which
 * means the table of real-world label formats below it can actually be run.
 */
export type ScanTarget =
  | { kind: 'asset'; barcode: string }
  | { kind: 'customer'; id: string; name: string }
  | { kind: 'text'; code: string };

/**
 * Reduce a code to the characters that carry its meaning.
 *
 * EVERY TENANT PRINTS THESE DIFFERENTLY, and that is why this is a blunt strip
 * rather than a format. WeldCor's receipts carry Code 39 wrapped in asterisks
 * with a `%` prefix — `*%80000D74-1767719329A*` — and the first version of this
 * hard-coded exactly that. The next distributor uses Code 128, or a `C-`
 * prefix, or an internal customer number with no relation to the ERP key.
 * Encoding one company's printer into the scan path means scanning silently
 * stops working for everyone else, and that failure is indistinguishable from
 * an unknown customer.
 *
 * So no format is assumed. Both sides of the comparison — what was scanned and
 * what was stored — go through the same reduction, so whatever the printer
 * added cancels out without anyone having to describe it: start and stop
 * characters, prefixes, hyphens, spaces, punctuation. What survives is the
 * alphanumeric payload, and two labels for the same customer agree on that
 * however they were produced.
 */
export const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The customers a scan can be matched against, and nothing that is not one.
 *
 * K5, 1 Oct 2026: a bootstrap from an older server or cache with `customers`
 * not a list, a hole in the list, or a record whose account number is null
 * threw out of classify and took Delivery, Home search and the scan screen
 * down with it. A record with no account number cannot be billed, so it is
 * not a match for anything; it is skipped rather than allowed to stop the
 * rest of the list from matching. `bc` is read through `card` for the same
 * reason: absent is the honest reading of a code that is not a string.
 */
function customerList(boot: Bootstrap | null): CustomerRec[] {
  const list: unknown = boot?.customers;
  if (!Array.isArray(list)) return [];
  return list.filter((c): c is CustomerRec => !!c && typeof c === 'object' && typeof c.customerListId === 'string');
}
const card = (c: CustomerRec) => (typeof c.bc === 'string' ? c.bc : '');

export function classify(raw: string, boot: Bootstrap | null): ScanTarget | null {
  const up = raw.trim().toUpperCase();
  if (!up) return null;

  if (boot?.assets?.[up]) return { kind: 'asset', barcode: up };

  const customers = customerList(boot);
  const k = key(up);
  if (!k) return { kind: 'text', code: up };

  // Exact first: if a tenant's stored code is byte-identical to what came off
  // the scanner, nothing further needs deciding.
  let hit = customers.find((c) => card(c) && card(c).toUpperCase() === up);

  /**
   * Then reduced, and ONLY IF IT IS UNAMBIGUOUS.
   *
   * Discarding punctuation is what makes this work across printers, but it also
   * means `AB-123` and `AB123` collapse to one key. If two customers collide
   * there, the honest answer is that this scan identifies nobody — sending a
   * driver to whichever row sorted first is how cylinders end up on the wrong
   * account, and the driver would have no way to know.
   *
   * The card is checked before the account number because the card is what the
   * counter actually scans, and a tenant may print something that is not simply
   * their account number wrapped.
   */
  if (!hit) {
    const byCard = customers.filter((c) => card(c) && key(card(c)) === k);
    if (byCard.length === 1) hit = byCard[0];
    else if (byCard.length === 0) {
      const byAccount = customers.filter((c) => key(c.customerListId) === k);
      if (byAccount.length === 1) hit = byAccount[0];
    }
  }

  if (hit) return { kind: 'customer', id: hit.customerListId, name: hit.name };

  return { kind: 'text', code: up };
}

/**
 * WHY A SCAN FOUND NOBODY — in words, on the phone, in production.
 *
 * This function exists because the bug it was written for cost days. A card
 * was scanned, nothing was found, and the screen said the same thing it says
 * for an order number: nothing at all. "No match" and "this phone is holding a
 * customer list downloaded before card codes existed" and "that code describes
 * two customers so I refused to choose" are three completely different
 * situations with three completely different fixes, and they were rendered
 * identically — so the only way to tell them apart was to attach a debugger to
 * a handset in a yard.
 *
 * So a miss now says which one it was. Not a log line, which nobody in a truck
 * can read: the sentence the driver is already looking at. It costs one line of
 * text and it turns "scanning is broken" into a report somebody can act on.
 *
 * Pure, like everything else here — it is a function of the same two arguments
 * `classify` gets, so the table of cases can be run off a phone.
 */
export function explainMiss(raw: string, boot: Bootstrap | null): string {
  const up = raw.trim().toUpperCase();
  const thing = boot?.org?.assetLabel ?? 'asset';

  if (!boot) {
    return `Read ${up} — nothing is downloaded to this phone yet. ` +
      `It downloads by itself when the phone has signal, so check the connection.`;
  }

  const customers = customerList(boot);
  if (!customers.length) {
    return `Read ${up} — no customers are on this phone. ` +
      `The list downloads by itself when the phone has signal, so check the connection.`;
  }

  // Refused rather than missed: the code describes more than one customer, and
  // picking one of them is how a cylinder lands on the wrong account.
  const k = key(up);
  const collisions = k
    ? customers.filter((c) => (card(c) && key(card(c)) === k) || key(c.customerListId) === k)
    : [];
  if (collisions.length > 1) {
    return `Read ${up} — that code matches ${collisions.length} customers ` +
      `(${collisions.slice(0, 2).map((c) => c.name).join(', ')}…), so none was chosen. ` +
      `Pick the customer from the list.`;
  }

  // The symptom that started this: a customer list downloaded before customer
  // barcodes shipped, or an import that never mapped the barcode column. Name
  // search still works, so nothing else on the phone looks wrong.
  const withCard = customers.filter((c) => card(c)).length;
  if (!withCard) {
    return `Read ${up} — no customer or ${thing} matches. None of the ` +
      `${customers.length} customers on this phone carry a card code, so this ` +
      `list is out of date or was imported without one. It updates by itself when the ` +
      `phone has signal, so check the connection.`;
  }

  return `Read ${up} — no customer or ${thing} matches on this phone ` +
    `(${customers.length} customers, ${withCard} with a card code).`;
}
