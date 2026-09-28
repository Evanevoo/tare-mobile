/**
 * NOTHING THE UPLOAD WAITS ON MAY WAIT FOR EVER.
 *
 * timedFetch (api.ts) bounds the scan POST itself at 90 s, but three things
 * sat outside it with no limit at all:
 *
 *   1. `supabase.auth.getSession()` in authHeader. With an expired access
 *      token it refreshes over the network through supabase-js's own fetch —
 *      React Native's, which has no timeout (OkHttp's read timeout is zero).
 *   2. Reading the response body. timedFetch clears its timer when the
 *      headers arrive; `res.json()` after that is unbounded.
 *   3. The sync as a whole.
 *
 * `sync()` sets `syncing: true`, the Send button shows "Working…", and every
 * later sync returns early while it is true. So one of those hanging leaves
 * the button on "Working…" and the queue undelivered until the app is killed.
 * That is order 79642 on 23 Sep 2026: the driver saw "Working…", took
 * screenshots, and none of the scans reached the server.
 *
 * Pure, so it is unit-tested without React Native.
 */
export class DeadlineError extends Error {
  constructor(what: string) {
    super(`${what} — no answer in time. Nothing is lost: your scans stay on this phone `
      + 'and go on the next sync (sending twice is safe).');
    this.name = 'DeadlineError';
  }
}

/** Resolve or reject with `p`, or reject with DeadlineError after `ms`. */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new DeadlineError(what)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/**
 * A fetch that gives up after `ms`, for handing to supabase-js as its
 * `global.fetch` so a token refresh on a dead socket cannot hang. Honours a
 * signal the caller already passed.
 */
export function boundedFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  return ((input: any, init: any = {}) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const outer: AbortSignal | undefined = init?.signal;
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    return base(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
  }) as typeof fetch;
}
