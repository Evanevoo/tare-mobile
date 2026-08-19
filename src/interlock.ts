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

/** Should Locate warn that adding this bottle ends a rental? */
export function locateWarning(
  asset: LocateAssetView | null | undefined,
  localReturn: boolean,
): boolean {
  if (!asset?.c) return false;      // nobody's account, nothing to end
  if (asset.or === 0) return false; // the rental is already closed — the stale-c case
  if (localReturn) return false;    // this phone brought it back; server just hasn't caught up
  return true;                      // or === 1, or an old server: say it
}
