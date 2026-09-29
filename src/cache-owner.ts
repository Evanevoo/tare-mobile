/**
 * WHOSE DOWNLOAD IS THIS?
 *
 * The cache table is one flat list of keys, and nothing in it says who put a
 * value there. That was harmless while a phone belonged to one login for life.
 * It is not once a handset is signed out of one company and into another: on
 * 28 Sep 2026 History drew one company's orders under another company's login,
 * because it shows the last page it downloaded before asking the network, and
 * sign-out had cleared four caches without knowing there were six.
 *
 * So the list lives here, in one place, and two rules hang off it.
 *
 *   1. The phone remembers which login its caches belong to (OWNER_KEY). When
 *      a different login arrives, everything on ACCOUNT_CACHES goes before
 *      anything is read. That covers the ways a login can change without
 *      passing through Sign out: a password reset, a session the server ended.
 *
 *   2. A page that is drawn before the network answers carries its owner
 *      inside it, and is not drawn for anybody else. That is `ownedBy`, and it
 *      holds even if rule 1 never got to run.
 *
 * The outbox is deliberately not on this list. Scans that have not uploaded
 * are somebody's work, and what happens to them on a hand-over is decided in
 * store.handOver, which refuses rather than destroys.
 *
 * Pure, and imports nothing: __tests__/cache-owner.test.mts runs it under
 * plain node, and reads the source to check that no cache is missing from
 * both lists.
 */

/** Downloaded for, or typed by, one login. Wiped when the login changes. */
export const ACCOUNT_CACHES = [
  'bootstrap',
  'lastSync',
  'delivery',
  'history',
  'fill-history',
  'locateDraft',
] as const;

/** Belongs to the handset whoever holds it. Survives a change of login. */
export const DEVICE_CACHES: readonly string[] = [];

/** Where the phone keeps the address its account caches belong to. */
export const OWNER_KEY = 'owner';

const norm = (s: string | null | undefined) => s?.trim().toLowerCase() || null;

/**
 * Keep what is on disk, or wipe it, given who it was stamped for and who is
 * signed in now.
 *
 * Wipes on exactly one condition: both are known and they differ. No stamp
 * means an older build wrote the cache, and no identity means the phone is
 * offline with a session it cannot read — in both cases there is nothing to
 * compare, and wiping would cost a driver the fleet with no way to fetch it
 * again. `ownedBy` covers the pages where being wrong would show.
 */
export function ownerVerdict(
  stamp: string | null | undefined, me: string | null | undefined,
): 'keep' | 'wipe' {
  const theirs = norm(stamp);
  const mine = norm(me);
  if (!theirs || !mine) return 'keep';
  return theirs === mine ? 'keep' : 'wipe';
}

/**
 * The cached value if this login downloaded it, otherwise nothing.
 *
 * Stricter than `ownerVerdict` on purpose. A page with no owner on it, or a
 * screen with nobody signed in, shows nothing: the cost is a spinner for the
 * length of one request, and the alternative is another company's customers.
 */
export function ownedBy<T extends { owner?: string | null }>(
  cached: T | null | undefined, me: string | null | undefined,
): T | null {
  const mine = norm(me);
  if (!cached || !mine) return null;
  return norm(cached.owner) === mine ? cached : null;
}
