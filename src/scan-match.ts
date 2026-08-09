import type { Bootstrap } from './api';

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

export function classify(raw: string, boot: Bootstrap | null): ScanTarget | null {
  const up = raw.trim().toUpperCase();
  if (!up) return null;

  if (boot?.assets?.[up]) return { kind: 'asset', barcode: up };

  const customers = boot?.customers ?? [];
  const k = key(up);
  if (!k) return { kind: 'text', code: up };

  // Exact first: if a tenant's stored code is byte-identical to what came off
  // the scanner, nothing further needs deciding.
  let hit = customers.find((c) => c.bc && c.bc.toUpperCase() === up);

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
    const byCard = customers.filter((c) => c.bc && key(c.bc) === k);
    if (byCard.length === 1) hit = byCard[0];
    else if (byCard.length === 0) {
      const byAccount = customers.filter((c) => key(c.customerListId) === k);
      if (byAccount.length === 1) hit = byAccount[0];
    }
  }

  if (hit) return { kind: 'customer', id: hit.customerListId, name: hit.name };

  return { kind: 'text', code: up };
}
