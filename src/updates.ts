/**
 * Over-the-air updates: the part that talks to expo-updates.
 *
 * The rules — how often to ask, when a banner is allowed — are in
 * update-policy.ts and are tested. This file is the plumbing around them, and
 * is deliberately thin, because none of it can run under `node` in a test.
 *
 * The whole feature exists because of one line in app.json:
 *
 *     "updates": { "fallbackToCacheTimeout": 0 }
 *
 * which tells the app never to block on the network at launch. It boots from
 * the bundle it already has and swaps in a newer one on the NEXT launch. On a
 * phone that gets force-quit every night that is invisible and correct. On a
 * handset that lives in a truck cradle and is never closed, "next launch" can
 * be a week away — so a fix ships, everything reports green, and the driver
 * keeps running the broken build. Nothing in the stack notices, because from
 * the server's point of view the update WAS delivered.
 */
import { create } from 'zustand';
import { AppState } from 'react-native';
import { useEffect } from 'react';
import * as Updates from 'expo-updates';
import * as Sentry from '@sentry/react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { saveOutbox } from './db';
import { useStore } from './store';
import { shouldCheck, type Phase } from './update-policy';

/**
 * `Updates.isEnabled` says whether expo-updates is CONFIGURED — the
 * "updates" key in app.json — not whether the client running right now can
 * do anything with that config. It reads true inside Expo Go too, because
 * the config is still there; only `checkForUpdateAsync()` itself knows Expo
 * Go can't act on it, and it finds out by throwing:
 *
 *   Error: checkForUpdateAsync() is not supported in Expo Go.
 *
 * caught below and reported to Sentry as a real failure (SCANIFIED-MOBILE,
 * 22 Aug) — fired from a phone running the app straight out of Expo Go for a
 * quick test, nothing was actually broken. `executionEnvironment` is the
 * signal that actually answers "which client is this": StoreClient is Expo
 * Go specifically, distinct from a real build or a dev client.
 */
const IS_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** Compiled in, pointed at a channel, and running somewhere that can use it. */
export const UPDATES_ENABLED: boolean = Updates.isEnabled && !IS_EXPO_GO;

/**
 * THE VERSION A DRIVER READS OUT MUST BE THE BINARY'S, NOT THE MANIFEST'S.
 *
 * This was `Constants.expoConfig?.version`, and expoConfig is the UPDATE
 * MANIFEST — `eas update` bakes the whole of app.json into it at publish time.
 * So the instant a phone takes an OTA, this screen starts reporting whatever
 * versionCode happened to be sitting in app.json on the machine that
 * published it, regardless of which APK is actually installed underneath.
 *
 * On 20 Aug that meant every handset in the field reported "1.2.3 / 223" while
 * running binary 219 — a build number that had never been built, let alone
 * shipped. Sentry read the binary and said 219; the app read the manifest and
 * said 223; and every conversation about "is this fixed in the build you have"
 * was conducted in those two numbers without anyone knowing they disagreed.
 * Hours went into debugging a fleet nobody could identify.
 *
 * expo-application reads the real thing out of the package manager. It is
 * guarded because it is a NATIVE module and this JS ships by OTA to binaries
 * that predate it — 219 has no ExpoApplication, exactly as it has no
 * ExpoDevice, and an unguarded import there is a fatal (see notifications.ts).
 * The module name is verified against expo-application's own source, which is
 * a lesson from getting `ExpoFileSystem` wrong the same morning: the real name
 * there was `FileSystem`.
 *
 * When it cannot be read the answer is "unknown", never the manifest's guess.
 * A build number that might be a lie is worse than no build number, because
 * only one of the two stops people trusting it.
 */
function nativeBuild(): { version: string; build: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    if (!core?.requireOptionalNativeModule?.('ExpoApplication')) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const App = require('expo-application');
    const version = App?.nativeApplicationVersion;
    const build = App?.nativeBuildVersion;
    if (!version && !build) return null;
    return { version: String(version ?? '?'), build: String(build ?? '?') };
  } catch {
    return null;
  }
}

const NATIVE = nativeBuild();

/** What is actually installed: "1.2.2 (219)". Never the manifest's opinion. */
export const APP_VERSION: string =
  NATIVE ? `${NATIVE.version} (${NATIVE.build})` : 'unknown build';

/**
 * What app.json claimed when the running bundle was published. Useful only
 * beside APP_VERSION, and only for spotting exactly the drift described above
 * — never on its own, and never labelled "version".
 */
export const BUNDLE_VERSION: string =
  Constants.expoConfig?.version ?? Updates.runtimeVersion ?? '—';

/**
 * Which bundle is actually running.
 *
 * `isEmbeddedLaunch` distinguishes "the JavaScript that shipped inside the
 * binary" from "an update that was downloaded later", which is the single most
 * useful fact when somebody reports a bug that was supposedly fixed. Without
 * it, the version number says 1.2.0 in both cases and tells you nothing.
 */
export function runningBundle(): string {
  if (!Updates.isEnabled) return 'development';
  if (Updates.isEmbeddedLaunch) return 'as installed';
  const at = Updates.createdAt;
  return at ? `updated ${at.toLocaleDateString()}` : 'updated';
}

interface UpdateState {
  phase: Phase;
  /** The id of the update sitting on disk waiting for a restart. */
  readyId: string | null;
  /** The id the driver has already waved away. Per-update, never global. */
  dismissedId: string | null;
  lastCheckAt: number | null;
  lastFailed: boolean;
  error: string | null;

  check: (opts?: { manual?: boolean }) => Promise<'none' | 'ready' | 'error' | 'skipped'>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdates = create<UpdateState>((set, get) => ({
  phase: 'idle',
  readyId: null,
  dismissedId: null,
  lastCheckAt: null,
  lastFailed: false,
  error: null,

  async check({ manual = false } = {}) {
    const s = get();

    // A manual check comes from a finger on a button in Settings, so it skips
    // the interval — but not the "is this even possible" guard below, or the
    // button would report a failure that is really just a dev build.
    if (!manual && !shouldCheck({
      enabled: UPDATES_ENABLED,
      online: useStore.getState().online,
      phase: s.phase,
      lastCheckAt: s.lastCheckAt,
      lastFailed: s.lastFailed,
      now: Date.now(),
    })) return 'skipped';

    if (!UPDATES_ENABLED) return 'skipped';
    if (s.phase === 'checking' || s.phase === 'downloading') return 'skipped';

    set({ phase: 'checking', error: null });
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found.isAvailable) {
        set({ phase: 'idle', lastCheckAt: Date.now(), lastFailed: false });
        return 'none';
      }

      /**
       * DOWNLOAD BEFORE TELLING ANYONE.
       *
       * The banner offers a restart, and a restart with the bundle only
       * half-fetched drops the driver back onto the old code having lost a few
       * seconds for nothing — which reads as "the update button does not
       * work". Fetching first means the button is honest: by the time it is on
       * screen the new bundle is already on the phone and the restart is local.
       */
      set({ phase: 'downloading' });
      const got = await Updates.fetchUpdateAsync();
      if (!got.isNew) {
        set({ phase: 'idle', lastCheckAt: Date.now(), lastFailed: false });
        return 'none';
      }

      set({
        phase: 'ready',
        // The manifest id is what makes a dismissal apply to THIS update and
        // not to whatever comes next. If a manifest ever arrives without one,
        // null means "cannot be dismissed permanently", which errs toward
        // showing the prompt again rather than hiding a fix.
        readyId: (got.manifest as { id?: string } | undefined)?.id ?? null,
        lastCheckAt: Date.now(),
        lastFailed: false,
        error: null,
      });
      return 'ready';
    } catch (e: unknown) {
      /**
       * THE MESSAGE EXPO GIVES US IS NOT THE REASON.
       *
       * A native rejection arrives as "Call to function
       * 'ExpoUpdates.checkForUpdateAsync' rejected" — the expo-modules bridge
       * wrapper, identical for every possible cause. Showing that to a driver,
       * and keeping nothing else, is how "updates are broken" became a report
       * with no way to act on it: the server was verified healthy and the
       * error text ruled nothing in or out.
       *
       * The cause is one layer down, in `code` and `cause`. Keep both, show
       * the useful part, and report the whole thing once per failure so the
       * next occurrence is an event with a device and a build attached rather
       * than a sentence.
       */
      const err = e as { message?: string; code?: string; cause?: unknown };
      const cause =
        err?.cause instanceof Error ? err.cause.message
        : typeof err?.cause === 'string' ? err.cause
        : null;

      Sentry.captureException(e, {
        tags: { kind: 'update-check-failed', code: err?.code ?? 'none' },
        extra: { manual, cause, currentUpdateId: Updates.updateId ?? null,
                 channel: Updates.channel ?? null, runtime: Updates.runtimeVersion ?? null },
      });

      set({
        phase: 'error',
        lastCheckAt: Date.now(),
        lastFailed: true,
        // Prefer the specific half. Falling back to the wrapper is better than
        // inventing a reason, but it should be the last resort, not the first.
        error: cause
          ?? (err?.code ? `${err.code}: ${err.message ?? 'update check failed'}` : null)
          ?? err?.message
          ?? 'Could not reach the update server',
      });
      return 'error';
    }
  },

  /**
   * FLUSH THE QUEUE BEFORE TEARING THE JS CONTEXT DOWN.
   *
   * `dispatch` in the store writes the outbox to SQLite fire-and-forget — the
   * in-memory state is already correct and a driver must never wait on a disk
   * write between two scans. That is right, and it means there is a window of
   * a few milliseconds after the last scan where the newest row is in memory
   * only. `reloadAsync` ends the JavaScript context immediately, and anything
   * still in that window goes with it.
   *
   * One awaited write closes it. It costs nothing on a restart the driver
   * asked for, and the alternative is the worst class of bug this app can
   * have: a scan the driver watched land, gone, with no error anywhere.
   */
  async install() {
    try {
      await saveOutbox(useStore.getState().outbox);
    } catch {
      // A failed write is not a reason to refuse the restart — the row is
      // still in SQLite from an earlier dispatch in all but the last few
      // milliseconds, and blocking the update helps nobody.
    }
    await Updates.reloadAsync();
  },

  dismiss() {
    // Phase goes back to idle so nothing else thinks a prompt is pending, but
    // the bundle stays downloaded: the driver gets it on the next cold start
    // whether or not they ever tap Restart.
    set({ dismissedId: get().readyId, phase: 'idle' });
  },
}));

/**
 * Ask on launch, and again whenever the app comes back to the front.
 *
 * Foreground is the right trigger rather than a timer: it is the moment a
 * driver is looking at the phone, and it is also the moment they are between
 * tasks. The interval in update-policy.ts stops a driver who switches apps
 * every thirty seconds from generating a check every thirty seconds.
 *
 * Mounted once, at the root. Everything it needs is in the store above, so a
 * second mount would only duplicate requests.
 */
export function useUpdateWatch() {
  const check = useUpdates((s) => s.check);
  const online = useStore((s) => s.online);

  useEffect(() => {
    check().catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check().catch(() => {});
    });
    return () => sub.remove();
  }, [check]);

  // Coming back into signal is the other moment worth a look: a driver who
  // spent the morning out of range would otherwise wait out the interval from
  // a check that never had a chance of succeeding.
  useEffect(() => {
    if (online) check().catch(() => {});
  }, [online, check]);
}
