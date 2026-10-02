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
  // Compare the tail itself, not an index into a lower-cased copy: lower-casing
  // can lengthen a string ("İ" becomes two characters), which moved the index
  // and left the made-up address on screen (found by fuzz-strings, 1 Oct).
  const tail = `@${CREW_DOMAIN}`;
  return e.length > tail.length && e.slice(-tail.length).toLowerCase() === tail
    ? e.slice(0, -tail.length) : e;
}
