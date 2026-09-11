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

test('the cipher refuses a key that is a plain array, so no reader may produce one', () => {
  const plain = Array.from(key) as unknown as Uint8Array;
  assert.throws(() => encryptSession(plain, nonce(4), 'session'), /Uint8Array/);
});
