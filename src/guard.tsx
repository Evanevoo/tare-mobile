import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, signOut } from './api';
import { useStore } from './store';
import { pending } from './outbox';
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
  /**
   * How many scans stopped the hand-over. Non-null means the phone is blocked:
   * the shift is safe on disk, and nobody can start a new one over the top of
   * it. Deliberately separate from `locked` — biometrics answer "is this the
   * right person", this answers "is this phone finished with", and resolving
   * one must never look like resolving the other.
   */
  const [heldBack, setHeldBack] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const sync = useStore((s) => s.sync);
  const unsentNow = useStore((s) => pending(s.outbox).length);

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
        /**
         * THE HAND-OVER MAY REFUSE, AND A REFUSAL IS NOT A FAILURE.
         *
         * handOver() tries to upload first and declines to clear the phone
         * while anything is still unsent. Before that guard existed this line
         * deleted a driver's whole shift from disk at the hour mark, in a dead
         * zone, with the only warning being an Alert nobody was there to read
         * — which is precisely the loss the offline design exists to prevent.
         *
         * On a refusal the phone is BLOCKED rather than handed over. That
         * keeps the actual security promise (the next driver cannot work
         * under this one's name) while costing nobody their afternoon, and it
         * puts the problem where somebody will see it instead of resolving it
         * silently in the wrong direction.
         */
        void (async () => {
          const r = await handOver();
          if (!r.handed) { setHeldBack(r.unsent); return; }
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
      {/*
        THE SHIFT IS SAFE AND THE PHONE IS OUT OF SERVICE UNTIL IT IS SENT.
        Above the biometric lock deliberately: if both fire, this is the one
        somebody has to act on, and unlocking must not look like clearing it.
      */}
      {heldBack !== null && (
        <View
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: T.zinc, alignItems: 'center', justifyContent: 'center',
            padding: 32, zIndex: 200, elevation: 32,
          }}
        >
          <Text style={{ color: T.amber, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>
            {unsentNow} scan{unsentNow === 1 ? '' : 's'} still to send
          </Text>
          <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 10, textAlign: 'center', lineHeight: 20 }}>
            This phone would normally have signed itself out by now. It has not, because
            that would have thrown this work away. Nothing is lost — it is saved here.
            {'\n\n'}Find signal and send it, then hand the phone over.
          </Text>
          <Pressable
            onPress={() => {
              setSending(true);
              void (async () => {
                try { await sync(); } catch { /* the count below tells the story */ }
                // Only stand down when there is genuinely nothing left. Clearing
                // on a failed send is how this becomes the bug it replaced.
                if (pending(useStore.getState().outbox).length === 0) setHeldBack(null);
                setSending(false);
              })();
            }}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Send the scans that are still waiting"
            style={{
              marginTop: 24, minHeight: 52, paddingHorizontal: 28, borderRadius: 10,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: sending ? T.rule : T.brandLit,
            }}
          >
            <Text style={{ color: sending ? T.faint : '#04121A', fontSize: 15, fontWeight: '800' }}>
              {sending ? 'Sending…' : 'Send now'}
            </Text>
          </Pressable>
        </View>
      )}
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
