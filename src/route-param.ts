/**
 * A ROUTE PARAM THAT CONTAINS A LITERAL '%' USED TO CRASH THE APP.
 *
 * Sentry SCANIFIED-MOBILE-7 (fatal, production, iOS): `URIError: Malformed
 * decodeURI input`, thrown during the very first render of OrderEdit. The
 * chain that gets there:
 *
 *   1. Every push to a dynamic route here encodes correctly —
 *      `router.push('/order/' + encodeURIComponent(orderNumber))`.
 *   2. expo-router DECODES the segment itself before `useLocalSearchParams`
 *      returns it. The param arrives already plain. The production crash is
 *      itself the proof: the screen received the literal `%800006D2-…`, which
 *      only exists post-decode.
 *   3. The screen then called `decodeURIComponent` on it AGAIN — harmless on
 *      values with no '%', which is why it survived in the field for months.
 *
 * Then a scan against a customer card landed a value like
 * `%800006D2-1614971550A` (Code 39 cards on this fleet genuinely start with
 * '%'; it is printer decoration, see scan-match.ts) in an order number. The
 * second decode saw `%80`, read it as a percent-escape, found it is not valid
 * UTF-8, and threw — fatally, in render, before any error boundary. From the
 * driver's side: tap that order in History (or scan your way to it) and the
 * app dies, every time, forever, because the order is still there on every
 * relaunch. "It doesn't scan" is what that looks like in a yard.
 *
 * WHY THIS DOES NOT DECODE AT ALL — NOT EVEN A GUARDED try/decode.
 *
 * The first version of this fix kept a `try { decodeURIComponent } catch`
 * on the theory that a malformed escape would fall through to the raw
 * string. The regression suite killed that theory the day it was written:
 * `ABC%123` contains a WELL-FORMED escape (`%12` is a valid hex pair), so
 * the guarded decode does not throw — it silently turns a literal order
 * number into `ABC\x123`. No check can tell "a '%' the router left literal"
 * apart from "a '%25' some other router failed to decode": the two are the
 * same bytes. What settles it is evidence, not preference: the router this
 * app ships decodes exactly once (see 2 above), so the only correct number
 * of decodes on the screen side is ZERO. A param is taken as the router
 * hands it over — normalized to one plain string, never transformed.
 */
export function decodeParam(raw: string | string[] | undefined): string {
  return String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '');
}
