import { gcmsiv } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js';

const VERSION = 'v2';

/**
 * The stored key, back as bytes noble will accept.
 *
 * The key is kept in SecureStore as hex. It used to be read back with
 * aes-js's `utils.hex.toBytes`, which returns a plain Array; gcmsiv refuses
 * anything but a Uint8Array ("key" expected Uint8Array, got type=object). A
 * fresh install never noticed, because a newly generated key is already a
 * Uint8Array. Every phone that had signed in before could not sign in again
 * on build 231 (11 Sep 2026). Every read of a stored key goes through here.
 */
export function keyFromHex(hex: string): Uint8Array {
  return hexToBytes(hex.trim());
}

/**
 * Whatever byte-ish thing arrived, as a plain Uint8Array of this realm.
 *
 * noble's check is strict: a real Uint8Array or nothing. keyFromHex fixed the
 * stored-key path, but the other two sources still reached it unchecked — the
 * key and nonce from expo-crypto's getRandomBytesAsync, which on a native
 * build can come back as an array-like that is not a Uint8Array. Signing in
 * with no stored key (a fresh install, or after sign-out cleared it) then
 * failed with the same "key expected Uint8Array, got type=object". Copying
 * into a new Uint8Array costs 44 bytes and makes the source irrelevant.
 */
function asBytes(value: ArrayLike<number> | ArrayBuffer): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : Uint8Array.from(value as ArrayLike<number>);
}

/**
 * Encrypts an auth session with authenticated encryption. The nonce travels
 * with the ciphertext so every write can use a fresh random nonce.
 */
export function encryptSession(key: Uint8Array, nonce: Uint8Array, session: string): string {
  key = asBytes(key); nonce = asBytes(nonce);
  const encrypted = gcmsiv(key, nonce).encrypt(new TextEncoder().encode(session));
  return `${VERSION}:${bytesToHex(nonce)}:${bytesToHex(encrypted)}`;
}

/** Throws when the blob is malformed or its authentication tag does not verify. */
export function decryptSession(key: Uint8Array, value: string): string {
  const [version, nonceHex, encryptedHex, ...extra] = value.split(':');
  if (version !== VERSION || !nonceHex || !encryptedHex || extra.length) {
    throw new Error('Invalid encrypted session format');
  }

  const decrypted = gcmsiv(asBytes(key), hexToBytes(nonceHex)).decrypt(hexToBytes(encryptedHex));
  return new TextDecoder().decode(decrypted);
}