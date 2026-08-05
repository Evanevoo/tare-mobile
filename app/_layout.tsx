import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { supabase } from '@/api';
import { useStore } from '@/store';
import { T } from '@/ui';

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
        <ActivityIndicator color={T.bottle} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: T.face },
          headerTintColor: T.ink,
          headerTitleStyle: { fontWeight: '600', fontSize: 16 },
          contentStyle: { backgroundColor: T.zinc },
        }}
      >
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="index" options={{ title: 'Tare' }} />
        <Stack.Screen name="scan" options={{ title: 'Scanning', headerShown: false, presentation: 'fullScreenModal' }} />
        <Stack.Screen name="queue" options={{ title: 'Sync' }} />
      </Stack>
    </>
  );
}
