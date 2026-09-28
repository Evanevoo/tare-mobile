/**
 * SIGNED IN WITH NO SIGNAL.
 *
 * The access token lives about an hour. With signal, supabase-js renews it
 * silently. With none, a COLD START after that hour asks getSession(), which
 * tries to renew, retries with backoff for ~25 seconds, and then answers "no
 * session" - even though the session is sitting on the phone, intact, and
 * will renew the moment there are bars again. The app took that answer at
 * face value and sent the driver to the login screen, which also needs
 * signal. Result: a phone killed in a dead zone (by the driver, or by the OS
 * reclaiming memory) could not scan again until it found coverage. Found
 * 28 Sep 2026 by simulating exactly that against auth-js 2.112.1.
 *
 * The rule now: a network failure is not a sign-out. If the renewal failed
 * because the server could not be reached, or is simply taking too long, and
 * a session is stored on this phone, the driver is still signed in. Scans go
 * to the outbox as always and upload once the token renews. A server that
 * actually REFUSES the renewal (revoked, user removed) still signs out: auth-js
 * removes the stored session and emits SIGNED_OUT, and that is honoured.
 *
 * The idle sign-out and the app lock (guard.tsx) keep working offline - they
 * key off the same verdict, so nobody gains a phone they could not already
 * open.
 *
 * Pure, so it runs under plain node in tests.
 */

export type Verdict = 'in' | 'out';

export type SessionCheck =
  | { kind: 'slow' }
  | { kind: 'done'; hasSession: boolean; errorName: string | null };

/** How long to wait for getSession() before trusting the stored session. */
export const SESSION_CHECK_MS = 5_000;

/** auth-js's name for "could not reach the server", as opposed to a refusal. */
const OFFLINE_ERROR = 'AuthRetryableFetchError';

export function sessionVerdict(check: SessionCheck, storedOnPhone: boolean): Verdict {
  if (check.kind === 'done' && check.hasSession) return 'in';
  if (!storedOnPhone) return 'out';
  if (check.kind === 'slow') return 'in';
  return check.errorName === OFFLINE_ERROR ? 'in' : 'out';
}

/**
 * What an auth event means for the gate, or null for "no change".
 *
 * INITIAL_SESSION is ignored: it carries the same null that getSession() gives
 * offline, and the launch check above has already made the call. Taking it at
 * face value would undo that call a moment later.
 */
export function verdictForEvent(event: string, hasSession: boolean): Verdict | null {
  if (event === 'INITIAL_SESSION') return null;
  if (event === 'SIGNED_OUT') return 'out';
  return hasSession ? 'in' : null;
}

/**
 * The session supabase-js keeps on the phone, if it is one it could renew.
 * A blob with no refresh token cannot become a live session, so it does not
 * count - trusting it would let the driver in and then fail every upload.
 */
export function parseStoredSession(raw: string | null): { email: string | null } | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    const session = s?.currentSession ?? s;
    if (typeof session?.refresh_token !== 'string' || !session.refresh_token) return null;
    return { email: typeof session.user?.email === 'string' ? session.user.email : null };
  } catch {
    return null;
  }
}
