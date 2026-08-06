import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { supabase } from '@/api';
import { useStore } from '@/store';
import { T, Aurora } from '@/ui';

export default function RootLayout() {
  const [session, setSession] = useState<'loading' | 'in' | 'out'>('loading');
  const hydrate = useStore((s) => s.hydrate);
  const router = useRouter();
  const segments = useSegments();

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
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          // Transparent rather than a slab: the light on each screen runs under
          // the header, so it is continuous instead of stopping at a hard edge
          // below the status bar.
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
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="delivery" options={{ title: 'New delivery' }} />
        <Stack.Screen
          name="scan"
          options={{ title: 'Scanning', headerShown: false, presentation: 'fullScreenModal' }}
        />
        <Stack.Screen name="locate" options={{ title: 'Locate' }} />
        <Stack.Screen name="queue" options={{ title: 'Sync' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="asset/[barcode]" options={{ title: '' }} />
        <Stack.Screen name="customer/[id]" options={{ title: '' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
