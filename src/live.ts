import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useStore } from './store';
import { fetchBootstrapStamp } from './api';

/**
 * THE APP KEEPS ITSELF UP TO DATE. THE DRIVER STOPS SWIPING DOWN.
 *
 * Pull-to-refresh was the only way anything on this phone ever updated, which
 * put the burden in exactly the wrong place: the person who has to remember is
 * the one wearing gloves in a yard, and the cost of forgetting is scanning
 * against a stale fleet.
 *
 * Three triggers, in order of how much they matter:
 *
 *   1. FOCUS. Opening a screen is the moment somebody wants to know what is
 *      on it. Free, obvious, and on its own it removes most of the swiping.
 *   2. FOREGROUND. Coming back to the app after it has been in a pocket for
 *      an hour is the other moment the data on screen is most likely wrong.
 *   3. A CHEAP POLL. Every 45s while the screen is open and the app is in
 *      front, the handset asks the stamp endpoint whether anything changed —
 *      a couple of hundred bytes — and only downloads the real 700 KB payload
 *      when the answer differs. Polling the payload itself would burn a
 *      driver's data allowance all day to be told nothing had happened.
 *
 * The outbox sync runs on the same beats and is NOT gated on the stamp: that
 * direction is the driver's own work reaching the office, it is small, and it
 * matters more than anything coming the other way.
 *
 * Pull-to-refresh stays. It is now a way to insist rather than the only way to
 * find out, and a driver who has just been handed a cylinder at the counter
 * should not have to wait 45 seconds to believe the screen.
 */

/** Never two full refreshes closer together than this, whatever fires. */
const MIN_GAP_MS = 10_000;

/** How often to ask the cheap question while a screen is open and in front. */
const POLL_MS = 45_000;

export function useLiveData(enabled = true) {
  const refresh = useStore((s) => s.refresh);
  const sync = useStore((s) => s.sync);

  const busy = useRef(false);
  const lastFull = useRef(0);
  /** The last stamp we pulled a payload for. Null until the first check. */
  const seen = useRef<string | null>(null);

  /**
   * @param force skip both the stamp check and the rate gap — for the moments
   *              a person has actually asked, or has just come back to the app.
   */
  const tick = useCallback(async (force = false) => {
    if (!enabled || busy.current) return;
    busy.current = true;
    try {
      // Always. Small, and it is the driver's own work going out.
      await sync().catch(() => {});

      if (!force && Date.now() - lastFull.current < MIN_GAP_MS) return;

      if (!force) {
        /**
         * The cheap question — and a deliberate fall-through when it cannot be
         * asked.
         *
         * A failure here means offline, or a server that does not have this
         * route yet (it shipped after the app did). Treating that as "nothing
         * changed" would have been the tidy-looking choice and would have
         * turned this whole feature off silently on exactly the fleet running
         * an older console. So a missing answer degrades to the old behaviour
         * — refresh anyway, no worse than a pull — rather than to no behaviour
         * at all. MIN_GAP_MS above is what keeps that from being expensive.
         */
        const stamp = await fetchBootstrapStamp().catch(() => null);
        if (stamp) {
          const key = `${stamp.at ?? ''}|${stamp.assets}|${stamp.customers}`;
          if (seen.current === key) return;   // nothing moved; do not spend 700 KB
          seen.current = key;
        }
      } else {
        // A forced refresh invalidates what we think we know, so the next
        // cheap check compares against whatever the payload actually was
        // rather than a stamp from before it.
        seen.current = null;
      }

      lastFull.current = Date.now();
      await refresh();
    } finally {
      busy.current = false;
    }
  }, [enabled, refresh, sync]);

  // 1 + 3: on focus, then on a slow beat for as long as the screen is open.
  // The interval is torn down on blur, so a phone sitting on a passenger seat
  // with the app backgrounded is not polling anything.
  useFocusEffect(
    useCallback(() => {
      void tick();
      const iv = setInterval(() => { void tick(); }, POLL_MS);
      return () => clearInterval(iv);
    }, [tick]),
  );

  // 2: back from the pocket. Forced, because the app may have been away for
  // hours and the stamp check is not worth the round trip to find that out.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void tick(true);
    });
    return () => sub.remove();
  }, [tick]);

  /** For pull-to-refresh, which should always mean "now", not "if you like". */
  return useCallback(() => tick(true), [tick]);
}
