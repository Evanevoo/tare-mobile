import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, KeyboardAvoidingView, Platform, ScrollView, Pressable, Image,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { signIn, requestPasswordReset } from '@/api';
import { T, Aurora, Surface, Btn, Rise, tint, wash } from '@/ui';

/**
 * The email is remembered, the password never is.
 *
 * A driver signs into the same phone every morning and should not retype their
 * address with cold hands. Storing the password would be a different trade
 * entirely — a stolen phone would be a stolen account — so it is not offered.
 * SecureStore rather than AsyncStorage because it is already a dependency and
 * an email address is still personal data.
 */
const REMEMBERED = 'tare.lastEmail';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(REMEMBERED)
      .then((v) => { if (alive && v) { setEmail(v); setRemember(true); } })
      .catch(() => { /* a missing keychain entry is the normal first run */ });
    return () => { alive = false; };
  }, []);

  async function submit() {
    if (!email || !password || busy) return;
    setBusy(true); setError(null); setSent(false);
    try {
      const addr = email.trim();
      await signIn(addr, password);
      // Only after the credential is known good — otherwise a typo gets
      // remembered and refilled every morning.
      if (remember) SecureStore.setItemAsync(REMEMBERED, addr).catch(() => {});
      else SecureStore.deleteItemAsync(REMEMBERED).catch(() => {});
    }
    catch (e: any) { setError(e?.message ?? 'Could not sign in'); }
    finally { setBusy(false); }
  }

  /**
   * Reuses whatever is already in the email field rather than opening a second
   * screen to ask for it again — by the time somebody taps this they have
   * usually typed their address once and failed the password twice.
   */
  async function forgot() {
    if (busy) return;
    const addr = email.trim();
    if (!addr) { setError('Type your work email first, then tap this again.'); return; }
    setBusy(true); setError(null);
    try { await requestPasswordReset(addr); setSent(true); }
    catch (e: any) { setError(e?.message ?? 'Could not send the link'); }
    finally { setBusy(false); }
  }

  const field = {
    height: 54, borderRadius: T.radiusSm, paddingHorizontal: 16,
    color: T.ink, fontSize: 16,
    backgroundColor: tint(0.045),
    borderWidth: 1, borderColor: T.rule,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      <Aurora />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Rise>
            {/* The real mark, not a letter in a box. A driver opening this at
                6am should see the same logo that is on the invoice. */}
            <Image
              source={require('../assets/logo.png')}
              style={{ width: 68, height: 68, marginBottom: 20 }}
              resizeMode="contain"
            />

            <Text style={{ color: T.ink, fontSize: 34, fontWeight: '700', letterSpacing: -1.1 }}>
              Scanified
            </Text>
            <Text style={{ color: T.steel, fontSize: 15, marginTop: 6, lineHeight: 22 }}>
              Sign in and this phone becomes part of the ledger.
            </Text>
          </Rise>

          <Rise delay={90} style={{ marginTop: 30 }}>
            <Surface style={{ marginBottom: 14 }} level={3}>
              <View style={{ padding: 18 }}>
                <Text style={{ color: T.faint, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
                  Work email
                </Text>
                <TextInput
                  style={[field, { marginBottom: 16 }]}
                  placeholder="you@company.com" placeholderTextColor={T.faint}
                  autoCapitalize="none" autoCorrect={false}
                  keyboardType="email-address" textContentType="username"
                  value={email} onChangeText={setEmail} editable={!busy}
                />

                <Text style={{ color: T.faint, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
                  Password
                </Text>
                <View>
                  <TextInput
                    style={[field, { paddingRight: 64 }]}
                    placeholder="••••••••" placeholderTextColor={T.faint}
                    secureTextEntry={!show} textContentType="password"
                    value={password} onChangeText={setPassword} editable={!busy}
                    onSubmitEditing={submit} returnKeyType="go"
                  />
                  {/* A driver typing a password with gloved hands in daylight
                      needs to be able to see what they typed. */}
                  <Pressable
                    onPress={() => setShow((v) => !v)}
                    hitSlop={12}
                    style={{ position: 'absolute', right: 14, top: 0, bottom: 0, justifyContent: 'center' }}
                  >
                    <Text style={{ color: T.brandLit, fontSize: 13, fontWeight: '700' }}>
                      {show ? 'Hide' : 'Show'}
                    </Text>
                  </Pressable>
                </View>

                {/* An actual control, because a setting nobody can see is a
                    setting nobody believes in. The box is the email only — the
                    password is never kept, and saying so here is better than
                    letting somebody assume it is. */}
                <Pressable
                  onPress={() => setRemember((v) => !v)}
                  hitSlop={8}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: remember }}
                  accessibilityLabel="Remember my email on this phone"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 18 }}
                >
                  <View
                    style={{
                      width: 24, height: 24, borderRadius: 7,
                      alignItems: 'center', justifyContent: 'center',
                      backgroundColor: remember ? T.bottle : 'transparent',
                      borderWidth: remember ? 0 : 1.5,
                      borderColor: T.faint,
                    }}
                  >
                    {remember && (
                      <Text style={{ color: T.onBrand, fontSize: 14, fontWeight: '900' }}>✓</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.ink, fontSize: 14, fontWeight: '600' }}>
                      Remember my email
                    </Text>
                    <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 1 }}>
                      Password is never saved on the phone.
                    </Text>
                  </View>
                </Pressable>

                <Pressable
                  onPress={forgot}
                  hitSlop={10}
                  style={{ alignSelf: 'flex-end', marginTop: 16 }}
                >
                  <Text style={{ color: T.steel, fontSize: 13, fontWeight: '600' }}>
                    Forgot your password?
                  </Text>
                </Pressable>

                {sent && (
                  <View
                    style={{
                      marginTop: 14, padding: 12, borderRadius: T.radiusSm,
                      backgroundColor: wash(0.10),
                      borderWidth: 1, borderColor: wash(0.26),
                    }}
                  >
                    <Text style={{ color: T.brandLit, fontSize: 13.5, lineHeight: 19 }}>
                      If {email.trim()} is on the account, a reset link is on its way.
                      Open it on this phone or any browser, set a new password, then
                      come back and sign in.
                    </Text>
                  </View>
                )}

                {error && (
                  <View
                    style={{
                      marginTop: 14, padding: 12, borderRadius: T.radiusSm,
                      backgroundColor: 'rgba(240,101,74,0.10)',
                      borderWidth: 1, borderColor: 'rgba(240,101,74,0.26)',
                    }}
                  >
                    <Text style={{ color: T.needle, fontSize: 13.5, lineHeight: 19 }}>{error}</Text>
                  </View>
                )}
              </View>
            </Surface>

            <Btn
              label="Sign in"
              busy={busy}
              disabled={!email || !password}
              onPress={submit}
            />

            <Text
              style={{
                color: T.faint, fontSize: 12.5, textAlign: 'center',
                marginTop: 20, lineHeight: 19,
              }}
            >
              Use the account your company invited you with.{'\n'}
              Scans are saved on this phone first, so you can work with no signal.
            </Text>
          </Rise>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
