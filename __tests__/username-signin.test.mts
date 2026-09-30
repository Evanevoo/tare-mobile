import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * SIGN IN WITH A USERNAME ON THE PHONE.
 *
 * Only the server knows which email a username belongs to, so a username
 * signs in through /api/mobile/session and the tokens it returns are handed
 * to this app's own Supabase client. An email still goes straight to
 * Supabase. These pin that split, and that "forgot password" never tries to
 * mail a username.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const api = read('../src/api.ts');
const login = read('../app/login.tsx');

const signIn = api.slice(api.indexOf('export async function signIn('));
const body = signIn.slice(0, signIn.search(/\r?\n\}\r?\n/) + 2);

test('a username goes through the server, an email straight to Supabase', () => {
  assert.match(body, /if \(!login\.includes\('@'\)\)/);
  assert.match(body, /`\$\{API_URL\}\/api\/mobile\/session`/);
  assert.match(body, /supabase\.auth\.setSession\(\{/);
  assert.match(body, /supabase\.auth\.signInWithPassword\(\{ email: login, password \}\)/);
  const server = body.indexOf('/api/mobile/session');
  const direct = body.indexOf('signInWithPassword');
  assert.ok(server > 0 && direct > server, 'the username branch returns before the email path');
});

test('a sign-in with no tokens is a failure, not a half-signed-in phone', () => {
  assert.match(body, /if \(!res\.ok \|\| !json\?\.access_token \|\| !json\?\.refresh_token\)/);
});

test('forgot-password never sends a username to the reset mailer', () => {
  const forgot = login.slice(login.indexOf('async function forgot()'));
  const guard = forgot.indexOf("if (!addr.includes('@'))");
  assert.ok(guard > 0, 'forgot() checks for an email');
  assert.ok(guard < forgot.indexOf('requestPasswordReset('), 'before asking for a link');
  assert.equal(forgot.split("if (!addr.includes('@'))").length, 2, 'once');
});

test('the box says it takes either', () => {
  assert.match(login, /Email or username/);
  assert.match(login, /autoComplete="username"/);
});
