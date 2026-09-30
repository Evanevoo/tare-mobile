import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionVerdict, verdictForEvent, parseStoredSession } from '../src/offline-session.ts';

const stored = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: { email: 'driver@example.com' } });

test('a live session is signed in, stored or not', () => {
  assert.equal(sessionVerdict({ kind: 'done', hasSession: true, errorName: null }, false), 'in');
});

test('offline cold start with the session on the phone stays signed in', () => {
  // What auth-js 2.112.1 returns when the renewal cannot reach the server.
  assert.equal(sessionVerdict({ kind: 'done', hasSession: false, errorName: 'AuthRetryableFetchError' }, true), 'in');
  // Still retrying after the wait: do not hold the driver on a spinner.
  assert.equal(sessionVerdict({ kind: 'slow' }, true), 'in');
});

test('a refusal from the server is a sign-out, even with something stored', () => {
  assert.equal(sessionVerdict({ kind: 'done', hasSession: false, errorName: 'AuthApiError' }, true), 'out');
  assert.equal(sessionVerdict({ kind: 'done', hasSession: false, errorName: null }, true), 'out');
});

test('nothing on the phone is signed out, offline or not', () => {
  assert.equal(sessionVerdict({ kind: 'done', hasSession: false, errorName: 'AuthRetryableFetchError' }, false), 'out');
  assert.equal(sessionVerdict({ kind: 'slow' }, false), 'out');
});

test('INITIAL_SESSION never overrides the launch check; SIGNED_OUT always wins', () => {
  assert.equal(verdictForEvent('INITIAL_SESSION', false), null);
  assert.equal(verdictForEvent('INITIAL_SESSION', true), null);
  assert.equal(verdictForEvent('SIGNED_OUT', false), 'out');
  assert.equal(verdictForEvent('SIGNED_IN', true), 'in');
  assert.equal(verdictForEvent('TOKEN_REFRESHED', true), 'in');
  assert.equal(verdictForEvent('TOKEN_REFRESHED', false), null);
});

test('only a session that could renew counts as stored', () => {
  assert.deepEqual(parseStoredSession(stored), { email: 'driver@example.com', id: null });
  assert.deepEqual(parseStoredSession(JSON.stringify({ currentSession: JSON.parse(stored) })), { email: 'driver@example.com', id: null });
  assert.equal(parseStoredSession(JSON.stringify({ access_token: 'a' })), null);
  assert.equal(parseStoredSession('not json'), null);
  assert.equal(parseStoredSession(null), null);
});
