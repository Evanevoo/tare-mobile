/**
 * The Locate interlock — when does putting a bottle on a shelf deserve a
 * warning that it ends somebody's rental?
 *
 * The old test was one field: `known.c`, the customer link from the last
 * bootstrap. That field is a denormalised snapshot, and it goes stale the
 * moment the console closes a rental by hand or another handset returns the
 * bottle — which means the warning fired on EXACTLY the case legacy learned
 * to suppress: a bottle whose paperwork was already settled, being put away
 * by the person who just carried it in. A warning that cries wolf on the
 * routine case trains the yard to tap through the real one.
 *
 * Three legs now, all required:
 *   1. the record names a customer          (`c`)
 *   2. an open rental actually exists NOW   (`or`, endedAt IS NULL, v7)
 *   3. nothing on this phone already returned it (the outbox knows before
 *      the server does)
 *
 * `or` missing entirely means an older server that has not learned the flag
 * — there the warning stays on `c` alone, because "warn like before" is the
 * safe direction to be wrong in. `or === 0` is an explicit answer and
 * silences it.
 *
 * Pure and tested under node — see __tests__/interlock.test.mts.
 */

export interface LocateAssetView {
  /** Customer account number, from the bootstrap. Null/absent = in-house. */
  c?: string | null;
  /** 1 = open rental exists now; 0 = explicitly none; absent = old server. */
  or?: 0 | 1;
  /**
   * 1 = the server already has a RETURN scan for this bottle on an order that
   * has not been verified yet. Named `rp` — return pending — because `rt` is
   * already the returned-on DATE in the asset payload.
   *
   * Absent = old server, which is why the check below compares against 1
   * rather than testing truthiness.
   */
  rp?: 0 | 1;
}

export interface ReturnLike {
  barcode: string;
  mode: string;
}

/**
 * A RETURN for this barcode anywhere in the outbox — queued, held, or SENT.
 * SENT counts on purpose: the bootstrap in hand may predate the upload, so
 * the phone's own record is the freshest fact available.
 */
export function hasLocalReturn(scans: readonly ReturnLike[], barcode: string): boolean {
  return scans.some((s) => s.mode === 'RETURN' && s.barcode === barcode);
}

/**
 * Why Locate should warn before ending a rental — or that it should not.
 *
 *   'none'            nothing to say.
 *   'not-returned'    the bottle is on a customer's account and NOBODY has
 *                     scanned it back. This is the one that matters: the
 *                     customer is still being charged for a cylinder that is
 *                     in your hand, and shelving it here would close the
 *                     rental as a side effect of housekeeping instead of
 *                     through the delivery it belongs to.
 *   'return-pending'  a return IS on record, the paperwork just has not caught
 *                     up — no invoice yet, or the order is still in approvals.
 *                     Worth saying, not worth alarming about.
 */
export type LocateWarning = 'none' | 'not-returned' | 'return-pending';

export function locateWarning(
  asset: LocateAssetView | null | undefined,
  localReturn: boolean,
): LocateWarning {
  if (!asset?.c) return 'none';      // nobody's account, nothing to end
  if (asset.or === 0) return 'none'; // the rental is already closed — the stale-c case
  // This phone brought it back and the upload has not landed yet.
  if (localReturn) return 'return-pending';
  /*
    THE TWO CASES READ IDENTICALLY BEFORE AND NEEDED DIFFERENT ANSWERS.

    `localReturn` only knows what is still in THIS phone's outbox — correct
    while the scan is queued, useless once it uploads, because the outbox
    empties and the app forgets. So a driver who scanned twelve returns on
    S50467 at 16:10 was told all twelve were "still out at a customer" when he
    went to shelve them an hour later.

    The rentals genuinely were open: no invoice had been written, so the order
    could not be verified. The warning was not wrong, it was just unable to
    distinguish "you never scanned this back" from "you did, and the office is
    behind" — and those want opposite reactions from a driver. The first means
    stop and go scan it properly. The second means carry on.

    `rp` is the server reporting a live RETURN scan on an unverified order, so
    it covers any phone at any time rather than only this session. Old servers
    do not send it, and undefined !== 1, so they fall through to the loud case
    — which is the safe direction to be wrong in.
  */
  if (asset.rp === 1) return 'return-pending';
  return 'not-returned';
}
