import { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import * as Sentry from '@sentry/react-native';
import { useRouter } from 'expo-router';
import { T, Btn } from '@/ui';

/**
 * WHAT A SCREEN RENDERS WHILE IT IS ON ITS WAY SOMEWHERE ELSE.
 *
 * The "grey screen" has been reported five times and fixed four, every time by
 * assuming it was Android's Modal window being torn down mid-navigation. It was
 * not, and the evidence that settled it is an absence: Sentry has 12 fatals on
 * build 219 and ZERO on 221, 222 and 223 — the builds the report keeps coming
 * from. Whatever is drawing that empty screen is not throwing. Nothing crashes.
 *
 * That leaves one shape: a screen whose render path reaches `return null` and
 * stays there. `null` from a full-screen route is EXACTLY the screenshot — no
 * header, no tab bar, no content, app alive, touches doing nothing. And these
 * screens have such a path by design:
 *
 *   const ready = Boolean(orderNumber && customerListId);
 *   useEffect(() => { if (!ready) router.replace('/'); }, [ready, router]);
 *   if (!ready) return null;
 *
 * That is correct exactly as long as the `replace()` lands. If it does not —
 * two replaces racing on the submit path, a navigator not yet mounted, an
 * update dropped against a tree mid-transition — the effect has already run,
 * nothing retries, and the screen renders nothing forever. Silently, because
 * from React's point of view everything worked.
 *
 * So this component replaces the bare `null`, and does three things the `null`
 * could not:
 *
 *   1. DRAWS SOMETHING. Even if the navigation never lands, the driver sees a
 *      screen that says what is happening rather than a dead rectangle.
 *   2. RETRIES, then OFFERS A WAY OUT. One more replace at 1.2s, and a button
 *      after that. A driver in a yard is never stuck holding a black phone.
 *   3. TELLS US. If it is still mounted at 2.5s the redirect demonstrably did
 *      not land, and that is reported to Sentry with the screen's name. The
 *      next occurrence stops being a screenshot and starts being an event with
 *      a stack, a build number and a device.
 *
 * If this never fires, the hypothesis was wrong and we have lost nothing but a
 * spinner nobody saw. If it fires, we finally know.
 */

/** How long to wait before assuming the first replace() did not take. */
const RETRY_MS = 1_200;
/** How long before this counts as stuck, gets reported, and offers a button. */
const STUCK_MS = 2_500;

export function Redirecting({ to = '/', from }: { to?: string; from: string }) {
  const router = useRouter();
  const [stuck, setStuck] = useState(false);
  const reported = useRef(false);

  useEffect(() => {
    const retry = setTimeout(() => {
      // Cheap and idempotent: if the first replace landed this component is
      // already unmounted and this never runs.
      try { router.replace(to as never); } catch { /* the button below is the real answer */ }
    }, RETRY_MS);

    const giveUp = setTimeout(() => {
      setStuck(true);
      if (reported.current) return;
      reported.current = true;
      Sentry.captureMessage(`Navigation did not land: stuck leaving ${from}`, {
        level: 'error',
        tags: { kind: 'stuck-redirect', from, to },
      });
    }, STUCK_MS);

    return () => { clearTimeout(retry); clearTimeout(giveUp); };
  }, [router, to, from]);

  return (
    <View style={{
      flex: 1, backgroundColor: T.zinc,
      alignItems: 'center', justifyContent: 'center', padding: 32,
    }}>
      {!stuck ? (
        <>
          <ActivityIndicator color={T.brandLit} />
          <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 14 }}>
            One moment…
          </Text>
        </>
      ) : (
        <>
          <Text style={{ color: T.amber, fontSize: 16, fontWeight: '800', textAlign: 'center' }}>
            This screen got stuck
          </Text>
          <Text style={{
            color: T.faint, fontSize: 13.5, marginTop: 10,
            textAlign: 'center', lineHeight: 20,
          }}>
            Nothing has been lost — every scan you have taken is saved on this phone.
            {'\n\n'}This has been reported automatically.
          </Text>
          <Btn
            label="Back to the start"
            onPress={() => { try { router.replace(to as never); } catch { /* nothing else to try */ } }}
            style={{ marginTop: 22 }}
          />
        </>
      )}
    </View>
  );
}
