/**
 * "Go update from the App Store / Play Store" — the plumbing.
 *
 * The rules for when to ask and when to show something are in
 * update-policy.ts and are tested there. This file is the network call and
 * the zustand store around them, same split as updates.ts (OTA) — and
 * deliberately a SEPARATE store, not a mode bolted onto that one, because the
 * two answer different questions with different actions: OTA's "Restart now"
 * swaps a bundle already on the phone; this one's action leaves the app
 * entirely and opens a store listing. Conflating them was the fastest way to
 * end up with a banner whose button sometimes restarts and sometimes doesn't,
 * depending on which kind of update it happened to be showing.
 */
import { create } from 'zustand';
import { AppState, Linking, Platform } from 'react-native';
import { useEffect } from 'react';
import * as Sentry from '@sentry/react-native';
import { API_URL } from './api';
import { NATIVE_BUILD } from './updates';
import { useStore } from './store';
import { shouldCheckStore, storeBuildIsNewer } from './update-policy';

interface StoreRelease {
  ios: { version: string; build: number; storeUrl: string };
  android: { versionCode: number; storeUrl: string };
}

interface StoreUpdateState {
  checking: boolean;
  available: boolean;
  /** The build/versionCode this platform's store currently has, once known. */
  published: number | null;
  storeUrl: string | null;
  dismissedBuild: number | null;
  lastCheckAt: number | null;

  check: () => Promise<void>;
  dismiss: () => void;
}

export const useStoreUpdate = create<StoreUpdateState>((set, get) => ({
  checking: false,
  available: false,
  published: null,
  storeUrl: null,
  dismissedBuild: null,
  lastCheckAt: null,

  async check() {
    const s = get();
    if (!shouldCheckStore({
      online: useStore.getState().online,
      checking: s.checking,
      lastCheckAt: s.lastCheckAt,
      now: Date.now(),
    })) return;

    set({ checking: true });
    try {
      // Unauthenticated on purpose — see the endpoint's own doc comment. No
      // session to attach even if it wanted one: this is asked from the
      // login screen too.
      const res = await fetch(`${API_URL}/api/mobile/store-version`);
      if (!res.ok) throw new Error(`store-version failed (${res.status})`);
      const release: StoreRelease = await res.json();

      const platform = release[Platform.OS as 'ios' | 'android'];
      if (!platform) { set({ checking: false, lastCheckAt: Date.now() }); return; }

      const published = Platform.OS === 'ios'
        ? (release.ios.build ?? null)
        : (release.android.versionCode ?? null);

      set({
        checking: false,
        lastCheckAt: Date.now(),
        published,
        storeUrl: platform.storeUrl ?? null,
        available: storeBuildIsNewer(NATIVE_BUILD, published),
      });
    } catch (e) {
      // Never surfaced to the driver — the OTA check already has an error
      // path for "the server can't be reached", and a second, near-identical
      // banner for the same underlying cause (no signal) would just be
      // noise. Reported to Sentry so a genuine break in the endpoint itself
      // is still visible somewhere.
      Sentry.captureException(e, { tags: { kind: 'store-version-check-failed' } });
      set({ checking: false, lastCheckAt: Date.now() });
    }
  },

  dismiss() {
    set({ dismissedBuild: get().published });
  },
}));

/** Opens the store listing (or TestFlight, on iOS) for this platform. */
export async function openStore(url: string): Promise<void> {
  await Linking.openURL(url);
}

/**
 * Same trigger pattern as useUpdateWatch: on launch, on foreground, and on
 * regaining signal. Mounted once, at the root, alongside useUpdateWatch.
 */
export function useStoreUpdateWatch() {
  const check = useStoreUpdate((s) => s.check);
  const online = useStore((s) => s.online);

  useEffect(() => {
    check().catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check().catch(() => {});
    });
    return () => sub.remove();
  }, [check]);

  useEffect(() => {
    if (online) check().catch(() => {});
  }, [online, check]);
}
