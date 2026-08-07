import { useState } from 'react';
import {
  View, Text, TextInput, KeyboardAvoidingView, Platform, ScrollView, Pressable,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { signIn, requestPasswordReset } from '@/api';
import { T, Aurora, Surface, Btn, Edge, Rise, shadow, tint } from '@/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!email || !password || busy) return;
    setBusy(true); setError(null); setSent(false);
    try { await signIn(email.trim(), password); }
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
            <LinearGradient
              colors={[T.brandLit, T.brandDark]}
              start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
              style={[
                {
                  width: 56, height: 56, borderRadius: 17,
                  alignItems: 'center', justifyContent: 'center', marginBottom: 22,
                },
                shadow(2, T.bottle),
              ]}
            >
              <Edge inset={12} />
              <Text style={{ color: T.onBrand, fontSize: 25, fontWeight: '800' }}>S</Text>
            </LinearGradient>

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

                <Pressable
                  onPress={forgot}
                  hitSlop={10}
                  style={{ alignSelf: 'flex-end', marginTop: 12 }}
                >
                  <Text style={{ color: T.steel, fontSize: 13, fontWeight: '600' }}>
                    Forgot your password?
                  </Text>
                </Pressable>

                {sent && (
                  <View
                    style={{
                      marginTop: 14, padding: 12, borderRadius: T.radiusSm,
                      backgroundColor: 'rgba(63,180,137,0.10)',
                      borderWidth: 1, borderColor: 'rgba(63,180,137,0.26)',
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
