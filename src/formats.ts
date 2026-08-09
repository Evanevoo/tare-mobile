/**
 * The org's number rules, on the handset.
 *
 * MUST STAY IN STEP WITH tare/src/lib/formats.ts. The console writes these
 * patterns and the bootstrap ships them; this file is the reader. The two
 * implementations are deliberately small and identical rather than shared,
 * because the alternative — a package both repos depend on — buys nothing at
 * this size and costs a publish step on every tweak.
 *
 * The tokens, written the way an office manager describes a number:
 *
 *   #  one digit          A  one letter          *  one letter or digit
 *
 * Anything else in the pattern stands for itself: dashes, dots, a literal S.
 * Commas separate alternatives and a value passes if it matches any of them.
 *
 * ADVISORY, NEVER A GATE. A driver in a yard holding a bottle whose label was
 * printed wrong still has to be able to record that scan — the whole point of
 * the outbox is that work is never lost to a validation rule. What these
 * produce is a line of text saying "that does not look like one of yours",
 * which is how the odd one out becomes visible at the moment it is typed
 * rather than three weeks later on an invoice nobody can explain.
 */

/** One alternative → a regex. Tokens expand; everything else is literal. */
function altToRegex(alt: string): RegExp | null {
  const t = alt.trim();
  if (!t) return null;
  let out = '';
  for (const ch of t) {
    if (ch === '#') out += '\\d';
    else if (ch === 'A' || ch === 'a') out += '[A-Za-z]';
    else if (ch === '*') out += '[A-Za-z0-9]';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`^${out}$`, 'i'); } catch { return null; }
}

/**
 * Does a value fit the pattern?
 *
 * An empty pattern accepts everything. That default is load-bearing: most orgs
 * never write their rules down, and "no rule" reading as "everything is wrong"
 * would put a warning under every field in the app on day one, which trains
 * people to ignore the warning that eventually matters.
 */
export function matchesFormat(value: string, pattern: string | null | undefined): boolean {
  const rs = (pattern ?? '').split(',').map(altToRegex).filter((r): r is RegExp => r !== null);
  if (!rs.length) return true;
  const v = value.trim();
  return rs.some((r) => r.test(v));
}

/**
 * A concrete example built from the FIRST alternative, for placeholders.
 * "#####, S#####" → "12345". One example beats restating the rule.
 */
export function formatExample(pattern: string | null | undefined): string {
  const first = (pattern ?? '').split(',')[0]?.trim() ?? '';
  if (!first) return '';
  let out = '';
  let d = 0, l = 0;
  for (const ch of first) {
    if (ch === '#') out += String((d++ % 9) + 1);
    else if (ch === 'A' || ch === 'a') out += 'ABCDEFGH'[l++ % 8];
    else if (ch === '*') out += 'X';
    else out += ch;
  }
  return out;
}

/**
 * The shortest thing the pattern could possibly accept.
 *
 * Every token stands for exactly one character, so an alternative's length IS
 * its minimum length. Used only to keep the nudge quiet while somebody is still
 * typing.
 */
function shortestMatch(pattern: string | null | undefined): number {
  const lens = (pattern ?? '')
    .split(',')
    .map((a) => a.trim().length)
    .filter((n) => n > 0);
  return lens.length ? Math.min(...lens) : 0;
}

/**
 * The nudge itself, or null when there is nothing worth saying.
 *
 * Returns null for an empty value as well as a passing one — a field nobody
 * has typed in yet is not wrong, it is empty, and saying otherwise is noise.
 *
 * AND IT STAYS QUIET WHILE THEY TYPE. A barcode rule of nine digits would
 * otherwise light the field amber from the first character through the eighth
 * and go green only on the ninth — a warning that is wrong far more often than
 * it is right, and the fastest way to teach somebody to stop reading warnings.
 * Nothing is said until the value is at least as long as the shortest thing the
 * rule could accept, which is the first moment "too short" and "wrong" become
 * distinguishable.
 */
export function formatNudge(
  value: string,
  pattern: string | null | undefined,
  label: string,
): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length < shortestMatch(pattern)) return null;
  if (matchesFormat(value, pattern)) return null;
  const eg = formatExample(pattern);
  return eg
    ? `That does not look like one of your ${label} — yours look like ${eg}.`
    : `That does not look like one of your ${label}.`;
}
