import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { signIn } from '@/api';
import { T } from '@/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try { await signIn(email.trim(), password); }
    catch (e: any) { setError(e?.message ?? 'Could not sign in'); }
    finally { setBusy(false); }
  }

  const input = {
    height: 48, borderRadius: T.radius, paddingHorizontal: 14, color: T.ink,
    backgroundColor: T.face, borderWidth: 1, borderColor: T.rule, fontSize: 16,
  } as const;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: T.zinc, justifyContent: 'center', padding: 24 }}
    >
      <View style={{ marginBottom: 28 }}>
        <View style={{
          width: 48, height: 48, borderRadius: 14, backgroundColor: T.bottle,
          alignItems: 'center', justifyContent: 'center', marginBottom: 16,
        }}>
          <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>T</Text>
        </View>
        <Text style={{ color: T.ink, fontSize: 26, fontWeight: '700', letterSpacing: -0.6 }}>
          Tare
        </Text>
        <Text style={{ color: T.steel, fontSize: 14, marginTop: 4 }}>
          Sign in with your Tare account.
        </Text>
      </View>

      <TextInput
        style={[input, { marginBottom: 10 }]}
        placeholder="Email" placeholderTextColor={T.steel}
        autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        value={email} onChangeText={setEmail} editable={!busy}
      />
      <TextInput
        style={input}
        placeholder="Password" placeholderTextColor={T.steel}
        secureTextEntry value={password} onChangeText={setPassword} editable={!busy}
        onSubmitEditing={submit}
      />

      {error && (
        <Text style={{ color: T.needle, fontSize: 13, marginTop: 12 }}>{error}</Text>
      )}

      <Pressable
        onPress={submit}
        disabled={busy || !email || !password}
        style={{
          height: 50, borderRadius: T.radius, backgroundColor: T.bottle, marginTop: 18,
          alignItems: 'center', justifyContent: 'center',
          opacity: busy || !email || !password ? 0.5 : 1,
        }}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Sign in</Text>}
      </Pressable>
    </KeyboardAvoidingView>
  );
}
