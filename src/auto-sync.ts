/**
 * Retrying the outbox without being told to.
 *
 * Nothing anywhere in this app retried a failed upload on its own — no
 * AppState listener, no connectivity listener, no timer (`package.json` has
 * no NetInfo). A truck driving under a bridge rolled the batch back to
 * QUEUED exactly as `sync()` is designed to do, and then nothing tried again
 * until a driver happened to reopen the app, notice the pending count, and
 * press Sync by hand. On a route with real dead zones that can be hours, and
 * the entire pitch of an offline-tolerant app is that the driver should
 * never have to think about this.
 *
 * Modelled on useUpdateWatch in updates.ts — same shape, same reasoning.
 * Foreground is the primary trigger: it is the moment a driver is looking at
 * the phone and also the moment signal is likeliest to have changed. The
 * interval underneath it covers the case that matters more here than it does
 * for the update checker — a phone mounted on a dashboard that never leaves
 * the foreground, regaining and losing signal in the background while a
 * route runs. Nobody foregrounds an app that is already in front of them.
 *
 * No connectivity library. `sync()` already fails cheaply with no signal — a
 * `fetch` with nothing to talk to rejects in milliseconds — so attempting on
 * a plain timer costs nothing worth guarding with a native network-state
 * module, which would be one more thing this build depends on and one more
 * thing that can be wrong on a given phone. `sync()` itself already no-ops
 * when the outbox is empty or a sync is already in flight, so this can call
 * it freely without duplicating that bookkeeping here.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useStore } from './store';

/** How often to try again while the app is open and nobody has asked. */
const RETRY_INTERVAL_MS = 45_000;

/** Mounted once, at the root — a second mount would only duplicate timers. */
export function useAutoSync() {
  useEffect(() => {
    const attempt = () => { useStore.getState().sync().catch(() => {}); };

    attempt();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') attempt();
    });
    const timer = setInterval(attempt, RETRY_INTERVAL_MS);

    return () => { sub.remove(); clearInterval(timer); };
  }, []);
}
