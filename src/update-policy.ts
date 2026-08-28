/**
 * WHEN TO LOOK FOR A NEW BUILD, AND WHEN TO SAY SO.
 *
 * `fallbackToCacheTimeout: 0` means the app never waits at launch: it starts
 * from whatever JavaScript is already on the phone and picks up a newer bundle
 * only on the launch AFTER the one that downloaded it. That is the right
 * trade for a driver standing in a yard — nobody should watch a spinner
 * because the office published a fix — but it has a tail nobody thinks about:
 * a phone that is never force-quit never gets to that "next launch". Handsets
 * live in cradles and stay open for days, so a fix shipped Monday can still be
 * missing on Thursday with everything reporting healthy.
 *
 * So the app asks, and when the answer is yes it tells the driver and lets
 * them choose the moment. The rules for asking and telling live here, apart
 * from expo-updates, because they are the part that can be wrong in a way a
 * type checker cannot see — and the part worth a test.
 */

export type Phase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

/**
 * A quarter of an hour between checks.
 *
 * The check is one small HTTPS round trip to Expo's manifest endpoint, so the
 * cost is data, not battery. Fifteen minutes means a fix published at the
 * start of a route reaches the truck during the route rather than the next
 * morning, and still amounts to a handful of requests across a shift.
 */
export const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * An hour after a check that threw.
 *
 * The common cause of a failed check is the yard's dead spot, and retrying a
 * dead spot every fifteen minutes is how a background task turns into a
 * battery complaint. Backing off also keeps the log readable: one failure an
 * hour is a signal, four an hour is noise.
 */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Should the app ask the server right now?
 *
 * Every reason to say no is listed rather than folded into one condition, so
 * that a future reason can be added without re-deriving the others.
 */
export function shouldCheck(o: {
  /** expo-updates is compiled in and pointed at a channel. False in dev. */
  enabled: boolean;
  online: boolean;
  phase: Phase;
  lastCheckAt: number | null;
  /** The previous check threw, so back off further. */
  lastFailed?: boolean;
  now: number;
  intervalMs?: number;
}): boolean {
  // A development build has no update channel. Asking anyway throws, and the
  // throw is indistinguishable from a real failure, which is how a developer
  // ends up chasing an error that only exists on their own machine.
  if (!o.enabled) return false;

  // No signal is the normal state in a rural yard. It is not worth a request
  // and it is definitely not worth an error banner.
  if (!o.online) return false;

  // One at a time. Two overlapping fetches download the same bundle twice.
  if (o.phase === 'checking' || o.phase === 'downloading') return false;

  // Already holding one. Checking again cannot improve on "ready", and a
  // second answer arriving mid-decision would swap the banner out from under
  // the driver's thumb.
  if (o.phase === 'ready') return false;

  if (o.lastCheckAt === null) return true;

  const since = o.now - o.lastCheckAt;

  // A negative gap means the clock moved backwards — a handset that just got
  // its time from the network, or a driver fixing a wrong date. Treated as due
  // rather than as "not yet", because the alternative is a phone that silently
  // stops checking until the clock catches back up, which on a year-sized jump
  // is never.
  if (since < 0) return true;

  return since >= (o.lastFailed ? RETRY_INTERVAL_MS : (o.intervalMs ?? CHECK_INTERVAL_MS));
}

/**
 * THE BANNER APPEARS ON THE TABS AND NOWHERE ELSE.
 *
 * Not on the scan screen: a driver mid-load is holding a cylinder in one hand
 * and looking at the reticle, and anything that appears near their thumb at
 * that moment is either missed or hit by accident. "Restart the app" is a
 * particularly bad thing to hit by accident.
 *
 * Not on login: an update prompt in front of somebody who has not proven who
 * they are is confusing, and the restart would land them back on the same
 * screen having lost what they typed.
 *
 * Not on a pushed screen either — those have a header and no tab bar, and the
 * banner is positioned against the tab bar. A driver reaches a tab within
 * seconds of finishing anything, so nothing is lost by waiting for one.
 */
export function bannerRoute(segment?: string | null): boolean {
  return segment === '(tabs)';
}

/**
 * Is there something to show?
 *
 * `dismissedId` is per-update, not a global "never ask again": dismissing this
 * one must not hide the next one. The update stays downloaded either way and
 * applies on the next cold start, so dismissing costs nothing but the prompt.
 */
export function bannerVisible(o: {
  phase: Phase;
  readyId: string | null;
  dismissedId: string | null;
  segment?: string | null;
}): boolean {
  if (o.phase !== 'ready') return false;
  if (o.readyId !== null && o.readyId === o.dismissedId) return false;
  return bannerRoute(o.segment);
}

/**
 * What the banner says under the title.
 *
 * The queue line is there because the first question a driver asks about any
 * button labelled Restart is "do I lose my scans", and the honest answer —
 * every scan is written to SQLite as it is taken, and the app reloads straight
 * back into the same job — is worth saying before they ask rather than after
 * they have avoided the button for a week.
 */
export function restartHint(unsent: number): string {
  if (unsent <= 0) return 'Takes a couple of seconds. Nothing on this phone is lost.';
  return `Takes a couple of seconds. Your ${unsent} unsent scan${unsent === 1 ? '' : 's'} `
    + 'and the job you are on stay on the phone.';
}

/**
 * A NEWER BUILD IN THE STORE IS A DIFFERENT FACT THAN A NEWER BUNDLE ON DISK,
 * AND NEEDS ITS OWN RULES.
 *
 * Everything above this point answers "is there a JS bundle expo-updates has
 * already fetched" — a question the phone can answer itself, offline, in
 * milliseconds. This answers a completely different one: "does the App Store
 * / Play Store have a build newer than the native binary installed right
 * now" — something only Scanified's own server can say (see
 * api/mobile/store-version's doc comment for why neither Apple's nor
 * Google's own answer is one the phone can ask for itself). A newer native
 * build can NEVER arrive over the air — new native code, a new permission, a
 * fixed crash in code that runs before any JS does — so a driver on one has
 * no path forward except the store, and until this existed the app had no
 * way to say so at all. Reported 27 Aug 2026: "users can't tell if there is
 * a new update on the app store or play store."
 */

/** Four times a day. A store release is a rare event, not worth 15-minute polling. */
export const STORE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Same idea as shouldCheck above, with the same reasons, minus the ones that don't apply. */
export function shouldCheckStore(o: {
  online: boolean;
  checking: boolean;
  lastCheckAt: number | null;
  now: number;
  intervalMs?: number;
}): boolean {
  if (!o.online) return false;
  if (o.checking) return false;
  if (o.lastCheckAt === null) return true;
  const since = o.now - o.lastCheckAt;
  if (since < 0) return true; // clock moved backwards — see shouldCheck's note
  return since >= (o.intervalMs ?? STORE_CHECK_INTERVAL_MS);
}

/**
 * Strictly greater than, never `!==`. The server's answer is occasionally
 * stale in the SAFE direction — bumped a little early, or not yet bumped
 * right after a submit — and `!==` would tell a driver already on the
 * newest build to go "update" to the exact build they're running, which
 * reads as the app being wrong about something obvious to them.
 */
export function storeBuildIsNewer(installed: number | null, published: number | null): boolean {
  if (installed === null || published === null) return false;
  return published > installed;
}

/**
 * Same placement rule as the OTA banner, and for the same reasons —
 * `bannerRoute`'s doc comment covers both. The two are also mutually
 * exclusive on screen: an OTA bundle is free and instant to apply, so if one
 * is ready it is always the more useful thing to show a driver than "go to
 * the store", even when both happen to be true at once.
 */
export function storeBannerVisible(o: {
  available: boolean;
  dismissedBuild: number | null;
  published: number | null;
  otaBannerVisible: boolean;
  segment?: string | null;
}): boolean {
  if (!o.available) return false;
  if (o.otaBannerVisible) return false;
  if (o.published !== null && o.published === o.dismissedBuild) return false;
  return bannerRoute(o.segment);
}

/** One line of plain English for the Settings row. */
export function statusLine(phase: Phase, o: { enabled: boolean; error?: string | null }): string {
  if (!o.enabled) return 'Updates are off in this build';
  switch (phase) {
    case 'checking': return 'Checking…';
    case 'downloading': return 'Downloading the update…';
    case 'ready': return 'An update is ready — restart to use it';
    case 'error': return o.error || 'Could not check';
    default: return 'Up to date';
  }
}
