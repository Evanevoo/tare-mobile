/**
 * A ROUTE PARAM THAT CONTAINS A LITERAL '%' USED TO CRASH THE APP.
 *
 * Sentry SCANIFIED-MOBILE-7 (fatal, production, iOS): `URIError: Malformed
 * decodeURI input`, thrown during the very first render of OrderEdit. The
 * chain that gets there:
 *
 *   1. Every push to a dynamic route here encodes correctly —
 *      `router.push('/order/' + encodeURIComponent(orderNumber))`.
 *   2. expo-router DECODES the segment itself before handing it to
 *      `useLocalSearchParams`. The param arrives already plain.
 *   3. The screen then called `decodeURIComponent` on it AGAIN — harmless
 *      on values with no '%', which is why it survived in the field for
 *      months.
 *
 * Then a scan against a customer card landed a value like
 * `%800006D2-1614971550A` (Code 39 cards on this fleet genuinely start
 * with '%'; it is printer decoration, see scan-match.ts) in an order
 * number. The second decode saw `%80`, read it as a percent-escape,
 * found it is not valid UTF-8, and threw — fatally, in render, before
 * any error boundary. From the driver's side: tap that order in History
 * (or scan your way to it) and the app dies, every time, forever,
 * because the order is still there on every relaunch. "It doesn't scan"
 * is what that looks like in a yard.
 *
 * The decode is kept (one older expo-router lineage did NOT pre-decode,
 * and a doubly-encoded param would otherwise display as `%2580…`), but a
 * failed decode now means "this was already plain text — a literal '%'
 * is data, not an escape", which is always the right reading of a value
 * that does not parse as percent-encoding.
 */
export function decodeParam(raw: string | string[] | undefined): string {
  const s = String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
