import * as aesjs from 'aes-js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * ═══ THE SESSION LIVED IN PLAIN TEXT ═══
 *
 * Supabase's default Expo setup — and this app's, until now — hands its auth
 * client a plain `AsyncStorage` as `storage`. AsyncStorage is unencrypted:
 * on Android it is a SharedPreferences XML file, on iOS a SQLite file inside
 * the app's own sandbox, and either one is readable by anything that gets
 * filesystem access to the phone — a lost or resold handset with USB
 * debugging turned on, a backup extracted to a laptop, a bug in an unrelated
 * dependency that reads more of the sandbox than it should. What was sitting
 * in it: a live access token and a refresh token, together the same thing as
 * a signed-in session. Not a password, but not far off it — anyone holding
 * that pair reads and writes this org's data as the driver who last signed
 * in, until the refresh token is revoked.
 *
 * SecureStore (Keychain on iOS, Keystore-backed EncryptedSharedPreferences on
 * Android) is the fix already used for the remembered email in login.tsx —
 * but SecureStore alone will not do here. Expo's own docs warn its values are
 * capped at 2048 bytes, and a real Supabase session (access token + refresh
 * token + user metadata, JSON-stringified together) has been seen well past
 * that on this project's own tokens. Storing the session directly in
 * SecureStore does not fail loudly in that case — `setItemAsync` throws on
 * Android past the cap, which would turn *every* sign-in on a phone with a
 * slightly larger token into a crash, which is worse than the problem being
 * fixed.
 *
 * So: encrypt the session with a random AES key, keep the (small, fixed-size)
 * key in SecureStore where the OS keystore protects it, and let the
 * (arbitrarily large) encrypted bytes sit in AsyncStorage — readable by
 * anyone with filesystem access, same as before, but now ciphertext instead
 * of a usable token. This is the pattern Supabase's own Expo quickstart
 * documents for exactly this reason.
 */
class LargeSecureStore {
  private async encryptionKeyFor(key: string): Promise<Uint8Array> {
    const existing = await SecureStore.getItemAsync(key);
    if (existing) return aesjs.utils.hex.toBytes(existing);

    const generated = await Crypto.getRandomBytesAsync(256 / 8);
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(generated));
    return generated;
  }

  async getItem(key: string): Promise<string | null> {
    const encrypted = await AsyncStorage.getItem(key);
    if (!encrypted) return null;

    const keyName = `${key}.key`;
    const encryptionKeyHex = await SecureStore.getItemAsync(keyName);
    // The blob exists but its key does not — the keystore was cleared (an
    // Android "clear app data that keeps files" quirk, or a restored backup
    // on a different device) independently of AsyncStorage. Unrecoverable;
    // treat it as no session rather than throwing on every app launch.
    if (!encryptionKeyHex) return null;

    const cipher = new aesjs.ModeOfOperation.ctr(
      aesjs.utils.hex.toBytes(encryptionKeyHex),
      new aesjs.Counter(1),
    );
    const decrypted = cipher.decrypt(aesjs.utils.hex.toBytes(encrypted));
    return aesjs.utils.utf8.fromBytes(decrypted);
  }

  async setItem(key: string, value: string): Promise<void> {
    const keyName = `${key}.key`;
    // A FRESH KEY EVERY WRITE WOULD ORPHAN THE PREVIOUS BLOB'S KEY SILENTLY —
    // moot here since both are overwritten together, but reusing whatever key
    // already exists (rather than always generating a new one) means a crash
    // between the two awaits below leaves the OLD blob still decryptable by
    // the key already in SecureStore, instead of a blob nothing can open.
    const encryptionKey = await this.encryptionKeyFor(keyName);
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await AsyncStorage.setItem(key, aesjs.utils.hex.fromBytes(encrypted));
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(`${key}.key`);
  }
}

/** One instance is enough — it holds no per-call state, only the methods above. */
export const supabaseSecureStorage = new LargeSecureStore();
