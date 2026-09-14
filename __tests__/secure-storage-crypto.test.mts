import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '@noble/ciphers/utils.js';
import { decryptSession, encryptSession, keyFromHex } from '../src/session-crypto.ts';

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const nonce = (value: number) => Uint8Array.from({ length: 12 }, () => value);

test('session encryption uses a fresh nonce, so equal sessions do not have equal ciphertext', () => {
  const session = '{"access_token":"same-token"}';
  const first = encryptSession(key, nonce(1), session);
  const second = encryptSession(key, nonce(2), session);

  assert.notEqual(first, second);
  assert.equal(decryptSession(key, first), session);
  assert.equal(decryptSession(key, second), session);
});

test('session ciphertext is authenticated', () => {
  const encrypted = encryptSession(key, nonce(7), 'session');
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('0') ? '1' : '0'}`;

  assert.throws(() => decryptSession(key, tampered));
});

// Build 231, 11 Sep 2026: every phone that had signed in before got
// '"key" expected Uint8Array, got type=object'. The key goes into SecureStore
// as hex, and aes-js's hex.toBytes handed it back as a plain Array.
test('a key stored as hex and read back still encrypts and decrypts', () => {
  const stored = bytesToHex(key);
  const back = keyFromHex(stored);

  assert.ok(back instanceof Uint8Array);
  const blob = encryptSession(back, nonce(3), 'session');
  assert.equal(decryptSession(keyFromHex(stored), blob), 'session');
  assert.equal(decryptSession(key, blob), 'session');
});

// 14 Sep 2026: the stored-key fix was not enough. A key or nonce straight from
// expo-crypto can reach the cipher as an array-like that is not a Uint8Array,
// and sign-in failed with the same message. The session functions now copy
// their inputs into a real Uint8Array, so no source can trip noble's check.
test('a key and nonce that arrive as plain arrays still encrypt and decrypt', () => {
  const plainKey = Array.from(key) as unknown as Uint8Array;
  const plainNonce = Array.from(nonce(4)) as unknown as Uint8Array;
  const blob = encryptSession(plainKey, plainNonce, 'session');
  assert.equal(decryptSession(plainKey, blob), 'session');
  assert.equal(decryptSession(key, blob), 'session');
});

test('an array-like object (not an Array, not a Uint8Array) is accepted too', () => {
  const like = { length: 32, ...Object.fromEntries(Array.from(key, (v, i) => [i, v])) } as unknown as Uint8Array;
  const blob = encryptSession(like, nonce(5), 'session');
  assert.equal(decryptSession(key, blob), 'session');
});
