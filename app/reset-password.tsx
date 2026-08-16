import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, KeyboardAvoidingView, Platform, ScrollView, Pressable,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/api';
import { T, Aurora, Surface, Btn, Rise, tint } from '@/ui';

/**
 * Where the recovery link actually lands now — see requestPasswordReset in
 * api.ts for why this is a screen in the app rather than a page in a browser.
 *
 * By the time this renders, the OS has already handed the phone a one-time
 * `code` from the email link, still unexchanged. Exchanging it here
 * establishes a session in THIS app's own Supabase client — the same one
 * every other screen reads — so saving a new password below is also, at the
 * same moment, signing in. No separate trip back to the login screen.
 *
 * _layout.tsx has to let this route render while signed out, the same way it
 * already lets /login — a recovery link arrives BEFORE the exchange that
 * signs the phone in, so treating this as an ordinary protected route would
 * bounce the driver to login before the screen built to sign them in ever ran.
 */
export default function ResetPassword() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const router = useRouter();

  const [state, setState] = useState<'checking' | 'ready' | 'invalid'>('checking');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const code = params.code;
    if (params.error || !code) { setState('invalid'); return; }
    supabase.auth.exchangeCodeForSession(code)
      .then(({ error }) => setState(error ? 'invalid' : 'ready'))
      .catch(() => setState('invalid'));
    // Off whatever the link carried on first mount, once — a code is
    // one-time-use, so re-running this on a later re-render would burn it
    // against an already-consumed value and always read as invalid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit() {
    setErr(null);
    if (password.length < 8) { setErr('Use at least 8 characters.'); return; }
    if (password !== again) { setErr('The two passwords do not match.'); return; }
    setBusy(true);
    supabase.auth.updateUser({ password })
      .then(({ error }) => {
        if (error) { setErr(error.message); return; }
        // The session this screen just established IS the app's real
        // session now — _layout's own auth listener already knows about it.
        // This just moves off a screen that has nothing left to do.
        router.replace('/');
      })
      .catch((e: any) => setErr(e?.message ?? 'Could not save that.'))
      .finally(() => setBusy(false));
  }

  const field = {
    height: 54, borderRadius: T.radiusSm, paddingHorizontal: 16,
    color: T.ink, fontSize: 16,
    backgroundColor: tint(0.045),
    borderWidth: 1, borderColor: T.rule,
  } as const;

  if (state === 'checking') {
    return (
      <View style={{ flex: 1, backgroundColor: T.zinc, justifyContent: 'center', alignItems: 'center' }}>
        <Aurora />
        <Text style={{ color: T.faint, fontSize: 13.5 }}>Checking your link…</Text>
      </View>
    );
  }

  if (state === 'invalid') {
    return (
      <View style={{ flex: 1, backgroundColor: T.zinc, justifyContent: 'center', padding: 24 }}>
        <Aurora />
        <Rise>
          <Text style={{ color: T.ink, fontSize: 22, fontWeight: '700', marginBottom: 10 }}>
            That link has expired or has already been used.
          </Text>
          <Text style={{ color: T.steel, fontSize: 14.5, lineHeight: 21, marginBottom: 22 }}>
            Ask for a fresh one from the sign-in screen — tap "Forgot your password?"
            under the password field.
          </Text>
          <Btn label="Back to sign in" variant="ghost" onPress={() => router.replace('/login')} />
        </Rise>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      <Aurora />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Rise>
            <Text style={{ color: T.ink, fontSize: 28, fontWeight: '700', letterSpacing: -0.8 }}>
              Set a new password
            </Text>
            <Text style={{ color: T.steel, fontSize: 14.5, marginTop: 6, lineHeight: 21 }}>
              The link signed you in. Choose something you will still know on a cold
              morning with gloves on.
            </Text>
          </Rise>

          <Rise delay={90} style={{ marginTop: 26 }}>
            <Surface style={{ marginBottom: 14 }} level={3}>
              <View style={{ padding: 18 }}>
                <Text style={{ color: T.faint, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
                  New password
                </Text>
                <View>
                  <TextInput
                    style={[field, { paddingRight: 64, marginBottom: 16 }]}
                    placeholder="••••••••" placeholderTextColor={T.faint}
                    secureTextEntry={!show} textContentType="newPassword"
                    autoFocus value={password} onChangeText={setPassword} editable={!busy}
                  />
                  <Pressable
                    onPress={() => setShow((v) => !v)} hitSlop={12}
                    style={{ position: 'absolute', right: 14, top: 0, height: 54, justifyContent: 'center' }}
                  >
                    <Text style={{ color: T.brandLit, fontSize: 13, fontWeight: '700' }}>
                      {show ? 'Hide' : 'Show'}
                    </Text>
                  </Pressable>
                </View>

                <Text style={{ color: T.faint, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
                  Once more
                </Text>
                <TextInput
                  style={[field, { marginBottom: 6 }]}
                  placeholder="••••••••" placeholderTextColor={T.faint}
                  secureTextEntry={!show} textContentType="newPassword"
                  value={again} onChangeText={setAgain} editable={!busy}
                  onSubmitEditing={submit} returnKeyType="go"
                />
                <Text style={{ color: T.faint, fontSize: 11.5 }}>At least 8 characters.</Text>

                {err && (
                  <View style={{
                    marginTop: 14, padding: 12, borderRadius: T.radiusSm,
                    backgroundColor: 'rgba(240,101,74,0.10)',
                    borderWidth: 1, borderColor: 'rgba(240,101,74,0.26)',
                  }}>
                    <Text style={{ color: T.needle, fontSize: 13.5, lineHeight: 19 }}>{err}</Text>
                  </View>
                )}
              </View>
            </Surface>

            <Btn label="Save and continue" busy={busy} disabled={!password || !again} onPress={submit} />
          </Rise>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
