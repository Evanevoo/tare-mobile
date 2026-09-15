import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishSignOut } from '../src/sign-out.ts';

test('does not sign out while an unforced handover retains scans', async () => {
  let signedOut = false;
  const result = await finishSignOut(
    async () => ({ handed: false, unsent: 3 }),
    async () => { signedOut = true; },
  );

  assert.deepEqual(result, { handed: false, unsent: 3 });
  assert.equal(signedOut, false);
});

test('signs out once the handover is safe', async () => {
  let signedOut = false;
  const result = await finishSignOut(
    async () => ({ handed: true, unsent: 0 }),
    async () => { signedOut = true; },
  );

  assert.deepEqual(result, { handed: true, unsent: 0 });
  assert.equal(signedOut, true);
});
