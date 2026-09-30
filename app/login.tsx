import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, KeyboardAvoidingView, Platform, ScrollView, Pressable, Image,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { signIn, requestPasswordReset } from '@/api';
import { T, Aurora, Surface, Btn, Rise, tint, wash } from '@/ui';
import { canSavePassword, savedEmail, savePassword, forgetPassword, unlockSavedLogin } from '@/saved-login';

/**
 * The email is remembered; the password only if the driver asks, and then
 * only behind the phone's own fingerprint or face (src/saved-login.ts).
 *
 * A driver signs into the same phone every morning and should not retype their
 * address with cold hands. A plain saved password would be a different trade
 * — a stolen phone would be a stolen account — which is why the saved one
 * never opens without the owner's biometric check, and is not offered at all
 * on a phone without one. SecureStore rather than AsyncStorage because it is
 * already a dependency and an email address is still personal data.
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
  const [canSave, setCanSave] = useState(false);
  const [savePw, setSavePw] = useState(true);
  const [savedFor, setSavedFor] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(REMEMBERED)
      .then((v) => { if (alive && v) { setEmail(v); setRemember(true); } })
      .catch(() => { /* a missing keychain entry is the normal first run */ });
    Promise.all([canSavePassword(), savedEmail()])
      .then(([ok, who]) => { if (alive) { setCanSave(ok); setSavedFor(ok ? who : null); } })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /** Fingerprint or face, then the saved password - no typing. */
  async function quickSignIn() {
    if (busy) return;
    setError(null);
    const login = await unlockSavedLogin();
    if (!login) return; // cancelled, or the check failed: the form is still there
    setBusy(true);
    try {
      await signIn(login.email, login.password);
    } catch (e: any) {
      // A password changed elsewhere makes the saved one wrong for ever - drop
      // it rather than failing the same way every morning.
      if (/invalid login/i.test(e?.message ?? '')) {
        await forgetPassword();
        setSavedFor(null);
        setEmail(login.email);
        setError('Your saved password no longer works. Type the new one — you can save it again.');
      } else {
        setError(e?.message ?? 'Could not sign in');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;
    /*
      SAY WHY, RATHER THAN DOING NOTHING.

      This used to return silently when either field was empty, which is fine
      for a driver who can see the box is blank and useless for the case that
      actually happened: iOS filled both fields from the keychain, they LOOKED
      filled, state was empty, and the button did nothing at all. Reported 3
      Sep 2026 as "the login button doesn't work" — the worst kind of report,
      because there is nothing on screen to describe.

      The onChange handlers below are the real fix. This is the guarantee that
      a dead-looking button can never happen again for any other reason: from
      here, pressing Sign in always produces something to read.
    */
    const addr = email.trim();
    if (!addr || !password) {
      setError(!addr && !password ? 'Enter your email or username, and your password.'
        : !addr ? 'Enter your email or username.' : 'Enter your password.');
      return;
    }
    setBusy(true); setError(null); setSent(false);
    try {
      await signIn(addr, password);
      // Only after the credential is known good — otherwise a typo gets
      // remembered and refilled every morning.
      if (remember) SecureStore.setItemAsync(REMEMBERED, addr).catch(() => {});
      else SecureStore.deleteItemAsync(REMEMBERED).catch(() => {});
      if (canSave && savePw) await savePassword(addr, password);
      else await forgetPassword();
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
    // A reset link goes to an email. The server will not say which email a
    // username belongs to, so a username gets words instead of a link.
    if (!addr.includes('@')) {
      setError('Reset links go to your email. Type your work email, or ask your manager to set a new password for you.');
      return;
    }
    setBusy(true); setError(null);
    try { await requestPasswordReset(addr); setSent(true); }
    catch (e: any) { setError(e?.message ?? 'Could not send the link'); }
    finally { setBusy(false); }
  }

  const field = {
    minHeight: 54, borderRadius: T.radiusSm, paddingHorizontal: 16,
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
                  Email or username
                </Text>
                <TextInput
                  style={[field, { marginBottom: 16 }]}
                  placeholder="you@company.com or username" placeholderTextColor={T.faint}
                  autoCapitalize="none" autoCorrect={false}
                  /* The email keyboard still has every character a username
                     can use (letters, digits, . - _), with @ and . up front. */
                  keyboardType="email-address" textContentType="username"
                  autoComplete="username" importantForAutofill="yes"
                  value={email} onChangeText={setEmail} editable={!busy}
                  /* iOS AUTOFILL DOES NOT ALWAYS FIRE onChangeText.
                     textContentType invites iCloud Keychain to fill this
                     field, and when it does the native text changes while
                     React state stays empty — the box looks filled, `email`
                     is '', and submit() returns silently on its own guard.
                     Reported 3 Sep 2026 as "the login button doesn't work".
                     onChange carries the native value, so filling either way
                     lands in state. Both handlers set the same thing, so
                     typing is unaffected. */
                  onChange={(e) => setEmail(e.nativeEvent.text)}
                />

                <Text style={{ color: T.faint, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>
                  Password
                </Text>
                <View>
                  <TextInput
                    style={[field, { paddingRight: 64 }]}
                    placeholder="••••••••" placeholderTextColor={T.faint}
                    secureTextEntry={!show} textContentType="password"
                    /* With Show on, the phone treats this as ordinary text:
                       it capitalised the first letter and "corrected" words,
                       and a right password went up wrong (28 Sep 2026). */
                    autoCapitalize="none" autoCorrect={false} spellCheck={false}
                    /* Lets the phone's own password manager offer to save and
                       fill it, as well as the in-app saved password below. */
                    autoComplete="password" importantForAutofill="yes"
                    value={password} onChangeText={setPassword} editable={!busy}
                    /* Same as the email field above — keychain fill does not
                       reliably fire onChangeText on iOS. */
                    onChange={(e) => setPassword(e.nativeEvent.text)}
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
                      {canSave ? 'Your email, ready for next time.' : 'Password is never saved on the phone.'}
                    </Text>
                  </View>
                </Pressable>

                {canSave && (
                  <Pressable
                    onPress={() => setSavePw((v) => !v)}
                    hitSlop={8}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: savePw }}
                    accessibilityLabel="Save my password on this phone"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 14 }}
                  >
                    <View
                      style={{
                        width: 24, height: 24, borderRadius: 7,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: savePw ? T.bottle : 'transparent',
                        borderWidth: savePw ? 0 : 1.5,
                        borderColor: T.faint,
                      }}
                    >
                      {savePw && <Text style={{ color: T.onBrand, fontSize: 14, fontWeight: '900' }}>✓</Text>}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: T.ink, fontSize: 14, fontWeight: '600' }}>Save my password</Text>
                      <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 1 }}>
                        Only opens with this phone&apos;s fingerprint or face.
                      </Text>
                    </View>
                  </Pressable>
                )}

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
                      Open it on this phone — it opens Scanified directly, and setting a
                      new password signs you straight in.
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
              /* NOT disabled on empty fields any more.
                 With iOS keychain autofill the boxes look filled while React
                 state is still empty, so this greyed the button out on a form
                 the driver could see was complete — "the login button doesn't
                 work", 3 Sep 2026. The onChange handlers above stop the state
                 going stale in the first place; leaving the button live means
                 that even if some other autofill path misses both handlers,
                 pressing it produces a readable message instead of nothing.
                 `busy` still guards the double-tap, which is the disable that
                 was actually earning its place. */
              onPress={submit}
            />

            {savedFor && (
              <Btn
                variant="ghost"
                label={`Sign in as ${savedFor}`}
                sub="Uses your fingerprint or face"
                style={{ marginTop: 10 }}
                onPress={quickSignIn}
                disabled={busy}
              />
            )}

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
