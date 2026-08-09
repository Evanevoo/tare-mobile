/**
 * TIME, SHOWN IN THE TIME ZONE THE PERSON IS STANDING IN.
 *
 * Every timestamp in this app is stored as an ISO string in UTC, which is
 * correct and is not the bug. The bug was reading it with `.slice(11, 16)` —
 * lifting the characters straight out of the UTC string and printing them as
 * if they were a wall clock. In Saskatchewan that is six hours out all year
 * (UTC−6, no daylight saving), so a bottle scanned at 2:38pm displayed as
 * 8:38. Every screen that formatted a time did it that way, so every screen
 * was wrong by the same six hours, which is exactly the kind of consistent
 * wrongness nobody catches by looking.
 *
 * `.slice(0, 10)` for the date is the same bug with a longer fuse: it is the
 * UTC date, so from 6pm local onwards everything scanned reads as tomorrow.
 * "Today's scans" on the home screen quietly stopped counting the evening's
 * work — the busiest end of a delivery day.
 *
 * So nothing here slices. `new Date(iso)` parses the UTC instant, and every
 * getter below is a LOCAL getter, which is what a phone in a yard should be
 * showing. Handled in one file rather than at thirty call sites, because the
 * call sites are where it went wrong.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 14:38, in the phone's own zone. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 2026-08-09, in the phone's own zone — for grouping and comparing days. */
export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day, right now. What "today" means to somebody holding the phone. */
export const today = () => localDay(new Date());

/**
 * Today / Yesterday / Aug 7 — from an instant, not from a pre-sliced string.
 *
 * Takes the ISO instant rather than a date string so the caller cannot
 * reintroduce the bug by slicing before it gets here.
 */
export function dayLabel(iso: string): string {
  const day = localDay(iso);
  if (!day) return '';
  const now = new Date();
  if (day === localDay(now)) return 'Today';
  const yest = new Date(now.getTime() - 864e5);
  if (day === localDay(yest)) return 'Yesterday';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Today 14:38" — the pair, since every screen shows them together. */
export const whenLabel = (iso: string) => `${dayLabel(iso)} ${localTime(iso)}`.trim();
