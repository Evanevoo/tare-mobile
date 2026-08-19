import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { API_URL, supabase } from './api';

/**
 * Push registration — every native touch behind a dynamic import.
 *
 * expo-notifications is a NATIVE module, and this JS ships by OTA to builds
 * that predate it (217–219 carry no such module). A static import would
 * crash those phones at bundle load; a dynamic one rejects, is caught, and
 * the feature is simply off until the phone runs a build that has it. The
 * same guard covers the other honest absences: Android without
 * google-services.json (no Firebase project wired yet), simulators, and a
 * driver who says no to the permission prompt. In every one of those cases
 * the answer is "not on this phone, carry on" — never a crash, never a
 * blocking prompt at sign-in.
 *
 * The registry itself is server-side (user_devices, migration 019).
 * Delivery additionally needs the FCM service account uploaded to Expo —
 * a dashboard step, on the morning list — but registration is real today:
 * the moment credentials land, every already-registered phone just works.
 */

const TOKEN_KEY = 'pushToken';

/**
 * True only if the named native module is actually linked into THIS binary.
 * requireOptionalNativeModule returns null rather than throwing, so nothing
 * reaches ErrorUtils and nothing can become a fatal. Wrapped again because
 * expo-modules-core itself is absent on truly ancient builds.
 */
export function hasNativeModule(name: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    return !!core?.requireOptionalNativeModule?.(name);
  } catch {
    return false;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Fire-and-forget after a signed-in bootstrap. Never throws. */
export async function registerPush(): Promise<void> {
  try {
    // A try/catch around `await import()` is NOT enough. Metro's
    // guardedLoadModule reports a module that throws while EVALUATING to
    // ErrorUtils as a FATAL error before the promise ever rejects, so on a
    // build without these native modules the app red-screens/crashes even
    // though the code "handles" it. Ask expo-modules-core first: it returns
    // null instead of throwing. Confirmed by SCANIFIED-MOBILE-1 (12 crashes,
    // 'Cannot find native module ExpoDevice', build 219).
    if (!hasNativeModule('ExpoDevice') || !hasNativeModule('ExpoPushTokenManager')) return;

    const Device = await import('expo-device');
    if (!Device.isDevice) return; // simulators have no push identity

    const Notifications = await import('expo-notifications');

    const have = await Notifications.getPermissionsAsync();
    let granted = have.granted;
    if (!granted && have.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return;

    if (Platform.OS === 'android') {
      // A channel is required on Android 8+ or sends silently vanish.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Scanified',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const Constants = (await import('expo-constants')).default;
    const projectId = Constants.easConfig?.projectId
      ?? (Constants.expoConfig?.extra as any)?.eas?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    )).data;
    if (!token) return;

    const res = await fetch(`${API_URL}/api/mobile/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' }),
    });
    if (res.ok) await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Old build, no Firebase, no signal — all the same non-event.
  }
}

/**
 * handOver(): this phone stops being anybody's. The token is deregistered
 * server-side FIRST, because after signOut the request has no session to
 * ride on. Never throws — a hand-over in a dead zone still signs out, and
 * the stale token is pruned the first time a send bounces.
 */
export async function deregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await fetch(`${API_URL}/api/mobile/devices`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ token }),
    });
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // See above: the send-side prune is the backstop.
  }
}
