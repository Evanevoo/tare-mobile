import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { hasNativeModule } from './notifications';

/**
 * A SAVED PASSWORD THAT ONLY OPENS WITH THE PHONE'S OWNER.
 *
 * The app used to refuse to keep the password at all ("a stolen phone would
 * be a stolen account"). That was right about the risk and wrong about the
 * cost: the idle sign-out puts a driver back on the login screen after an
 * hour, and typing a password there with gloves on is where the invalid-login
 * reports came from (28 Sep 2026).
 *
 * So it is kept, opt-in, in SecureStore (Keychain / Keystore-encrypted), and
 * it is only ever read back after the phone's own fingerprint or face check
 * passes. A phone left in a truck does not sign anyone in. No biometrics on
 * the phone, no saved password: the option is simply not offered.
 *
 * iOS FACE ID needs NSFaceIDUsageDescription in the native build, which the
 * builds in the field (runtime 1.2.4) do not carry - evaluating Face ID
 * without it is not safe to ship over the air. Until a native build adds the
 * expo-local-authentication plugin, iPhones with Face ID are not offered this;
 * Touch ID iPhones and Android fingerprint/face are. Flip FACE_ID_IN_BUILD
 * with that build.
 */

const KEY = 'tare.savedLogin';
const FACE_ID_IN_BUILD = false;

async function la() {
  // A bare import of an absent native module is fatal under Metro - probe first.
  if (!hasNativeModule('ExpoLocalAuthentication')) return null;
  try { return await import('expo-local-authentication'); } catch { return null; }
}

/** Can this phone protect a saved password with the owner's fingerprint or face? */
export async function canSavePassword(): Promise<boolean> {
  const LA = await la();
  if (!LA) return false;
  try {
    const [hw, enrolled, types] = await Promise.all([
      LA.hasHardwareAsync(), LA.isEnrolledAsync(), LA.supportedAuthenticationTypesAsync(),
    ]);
    if (!hw || !enrolled) return false;
    if (Platform.OS === 'ios' && !FACE_ID_IN_BUILD
        && types.includes(LA.AuthenticationType.FACIAL_RECOGNITION)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function savedEmail(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw).email ?? null) : null;
  } catch {
    return null;
  }
}

export async function savePassword(email: string, password: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify({ email, password })).catch(() => {});
}

export async function forgetPassword(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}

/** The saved login, only after the owner's fingerprint or face passes. */
export async function unlockSavedLogin(): Promise<{ email: string; password: string } | null> {
  const LA = await la();
  if (!LA || !(await canSavePassword())) return null;
  const r = await LA.authenticateAsync({ promptMessage: 'Sign in to Scanified', cancelLabel: 'Type it instead' });
  if (!r.success) return null;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v?.email && v?.password ? { email: v.email, password: v.password } : null;
  } catch {
    return null;
  }
}
