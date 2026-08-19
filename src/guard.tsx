import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, signOut } from './api';
import { useStore } from './store';
import { hasNativeModule } from './notifications';
import { T } from './ui';

/**
 * The two session guards legacy had and the rewrite dropped, in one wrapper:
 *
 * INACTIVITY TIMEOUT — 60 minutes, legacy's number. A handset lives in a
 * truck cradle signed in as whoever drove it last; the timeout is what stops
 * Tuesday's scans posting under Monday's name. "Activity" is any touch
 * anywhere (captured below without stealing a single gesture) OR a scan
 * arriving in the outbox — a driver mid-sweep touches the screen rarely,
 * and signing them out between two barcodes would be the guard causing the
 * exact harm it exists to prevent. Five minutes before the line a warning
 * offers to stay; at the line the phone hands itself over exactly like the
 * Settings button does.
 *
 * APP LOCK — biometric, opt-in from Settings, and honest about what it is:
 * this app never stores a password, so this is a lock on OPENING the app,
 * not stored-credential sign-in. Guarded dynamic import: on builds without
 * expo-local-authentication (everything before 220), or hardware without
 * enrolment, the toggle simply does nothing and the app opens as always —
 * a lock that could strand a driver in a yard is worse than no lock.
 */

const IDLE_MS = 60 * 60 * 1000;
const WARN_MS = 55 * 60 * 1000;
const LOCK_AFTER_BG_MS = 5 * 60 * 1000;
export const APP_LOCK_KEY = 'appLock';

export function SessionGuards({ children }: { children: React.ReactNode }) {
  const handOver = useStore((s) => s.handOver);
  const scanCount = useStore((s) => s.outbox.scans.length);

  const [signedIn, setSignedIn] = useState(false);
  const [locked, setLocked] = useState(false);
  const [lockMsg, setLockMsg] = useState<string | null>(null);

  const lastActive = useRef(Date.now());
  const warned = useRef(false);
  const bgAt = useRef<number | null>(null);
  const checking = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSignedIn(!!s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const touch = useCallback(() => {
    lastActive.current = Date.now();
    warned.current = false;
  }, []);

  // A scan is activity — see the header. Fires only when the count moves.
  useEffect(() => { touch(); }, [scanCount, touch]);

  /* ── the timeout clock ── */
  useEffect(() => {
    if (!signedIn) return;
    const t = setInterval(() => {
      const idle = Date.now() - lastActive.current;
      if (idle >= IDLE_MS) {
        // The same path as the Settings sign-out: local state first, then
        // the session, so nothing of this shift waits under the next name.
        void (async () => {
          await handOver();
          await signOut();
        })();
      } else if (idle >= WARN_MS && !warned.current) {
        warned.current = true;
        Alert.alert(
          'Still there?',
          'Nobody has touched this phone for a while. It signs itself out in five minutes so the next driver starts as themselves.',
          [{ text: 'Stay signed in', onPress: touch }],
        );
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [signedIn, handOver, touch]);

  /* ── the app lock ── */
  const tryUnlock = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      // See notifications.ts: a bare `await import()` of an absent native
      // module is FATAL under Metro, try/catch or not. Probe first.
      if (!hasNativeModule('ExpoLocalAuthentication')) { setLocked(false); return; }
      const LA = await import('expo-local-authentication');
      const [hw, enrolled] = await Promise.all([
        LA.hasHardwareAsync(), LA.isEnrolledAsync(),
      ]);
      if (!hw || !enrolled) { setLocked(false); return; } // never strand anyone
      const r = await LA.authenticateAsync({
        promptMessage: 'Unlock Scanified',
        cancelLabel: 'Not now',
      });
      if (r.success) { setLocked(false); setLockMsg(null); touch(); }
      else setLockMsg('Locked. Tap to try again.');
    } catch {
      setLocked(false); // module absent on this build — the toggle is inert
    } finally {
      checking.current = false;
    }
  }, [touch]);

  const maybeLock = useCallback(async () => {
    try {
      if ((await AsyncStorage.getItem(APP_LOCK_KEY)) !== '1') return;
      setLocked(true);
      void tryUnlock();
    } catch { /* storage unavailable — open as always */ }
  }, [tryUnlock]);

  useEffect(() => {
    if (signedIn) void maybeLock(); // cold start
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') bgAt.current = Date.now();
      if (st === 'active') {
        if (bgAt.current && Date.now() - bgAt.current > LOCK_AFTER_BG_MS && signedIn) {
          void maybeLock();
        }
        bgAt.current = null;
        touch();
      }
    });
    return () => sub.remove();
  }, [signedIn, maybeLock, touch]);

  return (
    // Capture-phase touch listener that CLAIMS nothing: returning false lets
    // every gesture through untouched while still telling the clock somebody
    // is here. This is the standard RN idle-detection shape.
    <View
      style={{ flex: 1 }}
      onStartShouldSetResponderCapture={() => { touch(); return false; }}
    >
      {children}
      {locked && (
        <Pressable
          onPress={() => { void tryUnlock(); }}
          accessibilityRole="button"
          accessibilityLabel="Unlock Scanified with your fingerprint or face"
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: T.zinc, alignItems: 'center', justifyContent: 'center',
            padding: 32,
          }}
        >
          <Text style={{ color: T.ink, fontSize: 20, fontWeight: '700' }}>Scanified is locked</Text>
          <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 8, textAlign: 'center', lineHeight: 20 }}>
            {lockMsg ?? 'Confirming it’s you…'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
