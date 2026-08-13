import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { View, ActivityIndicator, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Sentry from '@sentry/react-native';
import { supabase } from '@/api';
import { useStore } from '@/store';
import { T, Aurora, applyPalette } from '@/ui';
import { useTheme } from '@/theme';
import { useUpdateWatch } from '@/updates';
import { UpdateBanner } from '@/update-banner';
import { useAutoSync } from '@/auto-sync';

/**
 * Crash reporting, and only when it has somewhere to report to.
 *
 * A handset in a yard cannot be attached to a debugger, so a crash that nobody
 * captures is a bug report that reads "it closed" and nothing more. Sentry is
 * how that stops being the whole story.
 *
 * The DSN is read once here rather than at the call site because everything
 * below keys off whether it exists. A checkout with no `.env` — a new machine,
 * CI, anyone running the app for the first time — must behave exactly as it did
 * before Sentry was added: no init, no wrapper, no console noise about a client
 * that was never configured. Monitoring that punishes you for not having set it
 * up yet is monitoring people rip back out.
 */
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Scans carry customer names and order numbers. Breadcrumbs and request
    // bodies are where that leaks into a third party, so default PII stays off
    // and anything we want on a crash gets attached deliberately.
    sendDefaultPii: false,
  });
}

/**
 * The root is a stack that holds one tab navigator and the things that sit on
 * top of it.
 *
 * Scanning is a full-screen modal rather than a tab, because a scan session is
 * a mode you are in until you submit — offering a tab bar mid-session invites
 * a driver to wander off with forty unsent scans.
 *
 * Nothing is registered here that does not exist. A route that opens a blank
 * screen costs more trust than a missing feature.
 */
function RootLayout() {
  const [session, setSession] = useState<'loading' | 'in' | 'out'>('loading');
  const hydrate = useStore((s) => s.hydrate);
  const router = useRouter();
  const segments = useSegments();

  /* Theme. The palette is swapped during render — before any screen below has
     read a colour — and `key={mode}` remounts the tree so every inline style
     is recomputed. Both are cheap because this happens twice a year, and the
     alternative is a theme prop threaded through forty screens. */
  const os = useColorScheme();
  const mode = useTheme((s) => s.mode);
  const themeReady = useTheme((s) => s.ready);
  const setSystem = useTheme((s) => s.setSystem);
  const hydrateTheme = useTheme((s) => s.hydrate);

  /* Read the saved preference once, handing it what the OS reports so the two
     resolve together. Nothing below mounts until it lands — see `ready`. */
  useEffect(() => { hydrateTheme(os === 'light' ? 'light' : 'dark'); }, []);

  /* Afterwards, follow the OS. Skipped until ready, or this races the hydrate
     above and applies the system value before the saved preference has been
     read — which is the flash it is meant to prevent. */
  useEffect(() => {
    if (themeReady) setSystem(os === 'light' ? 'light' : 'dark');
  }, [os, themeReady]);

  applyPalette(mode);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ? 'in' : 'out'));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ? 'in' : 'out'));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session === 'in') hydrate(); }, [session]);

  /**
   * Ask Expo whether there is newer JavaScript, on launch and on every return
   * to the foreground. Mounted here and only here — see useUpdateWatch. It is
   * a no-op in development and on a phone with no signal, and it never
   * restarts anything by itself; all it can do is put the banner below on
   * screen.
   */
  useUpdateWatch();

  /**
   * Retry the outbox on its own — see auto-sync.ts. Mounted here, once, next
   * to the update watcher it is modelled on.
   */
  useAutoSync();

  useEffect(() => {
    if (session === 'loading') return;
    const onLogin = segments[0] === 'login';
    if (session === 'out' && !onLogin) router.replace('/login');
    if (session === 'in' && onLogin) router.replace('/');
  }, [session, segments]);

  /**
   * Nothing mounts until BOTH the session and the theme are known.
   *
   * The theme half is what stops the launch flash. `key={mode}` below tears the
   * whole navigator down and rebuilds it whenever the mode changes — correct
   * for a deliberate switch, ruinous one frame into a cold start. Waiting the
   * few frames AsyncStorage takes costs nothing visible and means the first
   * screen a driver sees is already the right colour.
   */
  if (session === 'loading' || !themeReady) {
    return (
      <View style={{ flex: 1, backgroundColor: T.zinc, justifyContent: 'center' }}>
        <Aurora />
        <ActivityIndicator color={T.brandLit} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={T.statusBar} />
      {/* The navigator and the update banner are siblings so the banner can
          float above every screen without any of them knowing it exists. It
          renders itself only on the tabs — see update-policy.bannerRoute for
          why not on the scan modal. */}
      <View style={{ flex: 1 }}>
      <Stack
        key={mode}
        screenOptions={{
          /**
           * NOT transparent, deliberately, after two goes at the bug it caused.
           *
           * A transparent header makes the screen start at y=0, underneath the
           * back button, and every screen then has to remember to push its own
           * content clear. Two did; the rest did not, which is why tapping the
           * search field slid it up under the back arrow — on Android the
           * keyboard resizes the window and content that begins under the
           * header simply stays there.
           *
           * An opaque bar costs the aurora running behind the back arrow, which
           * nobody has ever noticed, and buys a header that content physically
           * cannot get behind. The aurora still fills the rest of the screen.
           */
          headerTransparent: false,
          headerStyle: { backgroundColor: T.zinc },
          headerTintColor: T.ink,
          headerShadowVisible: false,
          /**
           * 17, NOT 16.5, AND IT HAS TO BE A WHOLE NUMBER.
           *
           * This is the only font size in the app that crosses into a native
           * view's props rather than being laid out by JavaScript.
           * `headerTitleStyle` is handed to react-native-screens'
           * `RNSScreenStackHeaderConfig`, whose Fabric codegen types the title
           * size as an integer, and the New Architecture refuses a lossy
           * conversion rather than rounding it quietly:
           *
           *   Exception in HostFunction: Loss of precision during arithmetic
           *   conversion: (long long) 16.5
           *
           * which arrives as a full-screen red render error at startup, before
           * any screen paints — not as a warning about a header. The stack
           * names ReactFabric and ScreenStackHeaderConfig and nothing about
           * this line, which is why it is worth the paragraph.
           *
           * Half-point sizes are used freely everywhere else in this app and
           * are fine there; JS layout takes floats. The rule is only: a size
           * that reaches a native prop must be whole.
           */
          headerTitleStyle: { fontWeight: '700', fontSize: 17, color: T.ink },
          headerBackTitle: 'Back',
          contentStyle: { backgroundColor: T.zinc },
        }}
      >
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="scan"
          options={{ headerShown: false, presentation: 'fullScreenModal' }}
        />
        <Stack.Screen name="search" options={{ title: 'Search' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="history" options={{ title: 'History' }} />
        <Stack.Screen name="analytics" options={{ title: 'Analytics' }} />
        <Stack.Screen name="asset/new" options={{ title: 'Add' }} />
        <Stack.Screen name="asset/batch" options={{ title: 'Add a pallet' }} />
        <Stack.Screen name="asset/edit/[barcode]" options={{ title: 'Correct' }} />
        <Stack.Screen name="asset/[barcode]" options={{ title: '' }} />
        <Stack.Screen name="customer/[id]" options={{ title: '' }} />
      </Stack>
        <UpdateBanner segment={segments[0]} />
      </View>
    </SafeAreaProvider>
  );
}

/**
 * `Sentry.wrap` is what catches a render that throws and attaches navigation
 * breadcrumbs to it, so a crash arrives naming the screen the driver was on.
 *
 * It is applied conditionally rather than always, for the same reason the init
 * above is guarded: with no client configured the wrapper's profiler warns on
 * every mount that Sentry was not initialised, which is exactly the noise a
 * developer without a DSN should never have to read past.
 */
export default SENTRY_DSN ? Sentry.wrap(RootLayout) : RootLayout;
