/**
 * How a signed-in person is named on screen.
 *
 * A driver added without an email (web: Settings > Team > "Add someone
 * without email") has a login address made from their username on a domain
 * that cannot receive mail, e.g. mike.t@crew.scanified.com. Nobody should see
 * that; they sign in as "mike.t", so that is what the app shows.
 * MIRRORS CREW_DOMAIN in the web app's src/lib/login-id.ts.
 */
export const CREW_DOMAIN = 'crew.scanified.com';

export function displayLogin(email: string | null | undefined): string {
  const e = String(email ?? '').trim();
  const at = e.toLowerCase().lastIndexOf(`@${CREW_DOMAIN}`);
  return at > 0 && at + CREW_DOMAIN.length + 1 === e.length ? e.slice(0, at) : e;
}
