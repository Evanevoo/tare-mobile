import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { View, ActivityIndicator, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { supabase } from '@/api';
import { useStore } from '@/store';
import { T, Aurora, applyPalette } from '@/ui';
import { useTheme } from '@/theme';

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
export default function RootLayout() {
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
  const setSystem = useTheme((s) => s.setSystem);
  const hydrateTheme = useTheme((s) => s.hydrate);
  useEffect(() => { hydrateTheme(); }, []);
  useEffect(() => { setSystem(os === 'light' ? 'light' : 'dark'); }, [os]);
  applyPalette(mode);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ? 'in' : 'out'));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ? 'in' : 'out'));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session === 'in') hydrate(); }, [session]);

  useEffect(() => {
    if (session === 'loading') return;
    const onLogin = segments[0] === 'login';
    if (session === 'out' && !onLogin) router.replace('/login');
    if (session === 'in' && onLogin) router.replace('/');
  }, [session, segments]);

  if (session === 'loading') {
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
      <Stack
        key={mode}
        screenOptions={{
          headerTransparent: true,
          headerStyle: { backgroundColor: 'transparent' },
          headerTintColor: T.ink,
          headerShadowVisible: false,
          headerTitleStyle: { fontWeight: '700', fontSize: 16.5, color: T.ink },
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
        <Stack.Screen name="asset/edit/[barcode]" options={{ title: 'Correct' }} />
        <Stack.Screen name="asset/[barcode]" options={{ title: '' }} />
        <Stack.Screen name="customer/[id]" options={{ title: '' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
