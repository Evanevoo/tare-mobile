import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { displayLogin, CREW_DOMAIN } from '../src/who.ts';

/**
 * A driver with no email is shown their username, never the made-up address
 * behind their login. The domain must stay the web app's CREW_DOMAIN.
 */

test('a crew address shows as the username', () => {
  assert.equal(displayLogin('mike.t@crew.scanified.com'), 'mike.t');
  assert.equal(displayLogin(' Mike.T@Crew.Scanified.com '), 'Mike.T');
});

test('a username that grows when lower-cased still loses the crew domain (fuzz, 1 Oct)', () => {
  // "İ".toLowerCase() is two characters, which used to shift the index check.
  assert.equal(displayLogin('İpek@crew.scanified.com'), 'İpek');
  assert.equal(displayLogin('a@crew.scanified.com@crew.scanified.com'), 'a@crew.scanified.com');
  assert.equal(displayLogin('@crew.scanified.com'), '@crew.scanified.com');
});

test('every other address is shown as it is', () => {
  assert.equal(displayLogin('jace@weldcor.ca'), 'jace@weldcor.ca');
  assert.equal(displayLogin('mike@evilcrew.scanified.com'), 'mike@evilcrew.scanified.com');
  assert.equal(displayLogin('mike@crew.scanified.com.au'), 'mike@crew.scanified.com.au');
  assert.equal(displayLogin(null), '');
});

test('the screens that name the signed-in person go through it', () => {
  assert.equal(CREW_DOMAIN, 'crew.scanified.com');
  for (const f of ['../app/settings.tsx', '../app/(tabs)/more.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /displayLogin\(boot\?\.user\.email \|\| email\)/, f);
  }
});
