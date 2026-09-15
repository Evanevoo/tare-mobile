import { matchesFormat } from './formats.ts';

type Formats = { barcode?: string; customerNumber?: string; orderNumber?: string } | null | undefined;

/**
 * WHAT DELIVERY'S CUSTOMER FIELD IS WILLING TO READ.
 *
 * 15 Sep 2026: "the scanner isn't scanning customer barcode, but order number
 * scans fine." Since ff2c291 the customer scan was gated on the ASSET barcode
 * rule (WeldCor: `#########`), so every customer card was dropped silently
 * before it was ever matched. Swapping in the customer-number rule is not
 * enough either: WeldCor's cards are Code 39, stored as
 * `*%800006A4-1610474335A*`, and the camera reads the `%` that the rule
 * `********-***********` does not have.
 *
 * The field genuinely takes a card or a cylinder, so the camera may pass:
 *   - anything the bootstrap already recognises (`known`), however it prints;
 *   - otherwise, a code that fits the asset or customer-number rule once the
 *     Code 39 start/stop asterisks and `%` prefix are taken off.
 * A decode that is neither is still refused, which is what ff2c291 was for.
 */
export function acceptCustomerFieldScan(code: string, formats: Formats, known: boolean): boolean {
  if (known) return true;
  const bare = code.trim().replace(/^\*?%?/, '').replace(/\*$/, '');
  const rule = [formats?.barcode, formats?.customerNumber].filter(Boolean).join(',');
  return matchesFormat(bare, rule);
}
