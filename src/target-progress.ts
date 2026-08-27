/**
 * Sales Order target vs what's actually been scanned, per product — the
 * live "Argon 2/3 · Oxygen 1/2" checklist. Pure and dependency-free, like
 * outbox.ts, so it runs under plain node in tests the same way.
 *
 * SHIP only, matching the target itself: a Sales Order has no return side
 * (see the server's lib/quickbooks.ts, normaliseSalesOrderTargets), and
 * Evan's own framing for this feature excluded returns because there is no
 * equivalent target quantity for them. A RETURN scan never counts toward a
 * row here — it still counts in the header pill's plain ship/return total,
 * which reads the outbox directly and does not go through this module.
 *
 * Advisory only, same as every other check in this app: this produces
 * numbers to show, never a verdict that blocks anything. Submit stays
 * reachable whatever these rows say.
 */
import type { Outbox } from './outbox.ts';
import { forOrder } from './outbox.ts';

export interface TargetLine {
  productCode: string;
  quantity: number;
}

export interface ChecklistRow {
  productCode: string;
  target: number;
  scanned: number;
}

/**
 * Product code comes from the bootstrap's asset catalogue, not the scan
 * itself — a QueuedScan only ever carries a barcode (see outbox.ts). An
 * unrecognised barcode (not on this phone's asset list, scanned before the
 * bootstrap refreshed, or added off-format) cannot be attributed to a
 * product and simply does not count toward any row here — it is not
 * dropped anywhere else, only left out of this one derived view.
 *
 * `target` rows set the order of what's shown; a SHIP scan of a product
 * code with NO target line is real progress the driver made and is worth
 * seeing, so it is appended as its own row (target: 0) rather than
 * silently folded away — "this wasn't on the order" is exactly the kind of
 * thing this checklist exists to surface.
 */
export function checklist(
  outbox: Outbox,
  orderNumber: string,
  productOf: (barcode: string) => string | null | undefined,
  target: TargetLine[],
): ChecklistRow[] {
  const scannedByProduct = new Map<string, number>();
  for (const s of forOrder(outbox, orderNumber)) {
    if (s.mode !== 'SHIP') continue;
    const p = productOf(s.barcode);
    if (!p) continue;
    scannedByProduct.set(p, (scannedByProduct.get(p) ?? 0) + 1);
  }

  const rows = target.map((t) => ({
    productCode: t.productCode,
    target: t.quantity,
    scanned: scannedByProduct.get(t.productCode) ?? 0,
  }));

  const onTarget = new Set(target.map((t) => t.productCode));
  for (const [productCode, scanned] of scannedByProduct) {
    if (!onTarget.has(productCode)) rows.push({ productCode, target: 0, scanned });
  }

  return rows;
}

/** True once every target line has at least as many SHIP scans as it asks for. */
export const isComplete = (rows: ChecklistRow[]): boolean =>
  rows.length > 0 && rows.every((r) => r.scanned >= r.target);
