/**
 * WHETHER A SCAN COUNTS, DECIDED SYNCHRONOUSLY.
 *
 * The locate screen reads the same label several times a second while the
 * driver is still holding the bottle. Everything that decides whether a read
 * is new therefore has to be true AT THE INSTANT OF THE READ — and React
 * state is not, because it lands a render later.
 *
 * The screen had two guards and a hole between them:
 *
 *   1. `codes.includes(bc)` — the shelf so far, read out of the render
 *      closure, so it is one render behind whatever just happened.
 *   2. `deciding.has(bc)` — a ref, always current, added when a driver
 *      reported "scanning three and saving five": one warned bottle, three
 *      stacked dialogs, three taps, three copies.
 *
 * Guard 2 is released the moment the driver taps "Shelve it anyway", and the
 * `setCodes` beside it does not reach `codes` until the next render. Between
 * those two events a camera frame passes BOTH guards — the ref no longer
 * holds it, the array does not hold it yet — and lands on the unguarded
 * append at the bottom of `add`. That is the double count, and it is why the
 * first fix did not end it: it closed the dialog-stacking case and left the
 * release window open.
 *
 * `justAdded` closes it. A barcode goes in there at the same instant it is
 * handed to `setCodes`, and the screen clears it when `codes` next changes --
 * at which point `codes` is authoritative again and the ref has nothing left
 * to say. That ordering is what makes removing a bottle, saving a shelf, or
 * restoring a draft all still work: each of them changes `codes`, which
 * empties the ref, so nothing is permanently un-scannable.
 */

export type Admit =
  /** Not on the shelf and nothing pending — count it. */
  | 'add'
  /** Already on this shelf. Tick, and say nothing. */
  | 'duplicate'
  /** A dialog is open about this one; the camera is just still looking. */
  | 'deciding';

export function admit(
  bc: string,
  codes: readonly string[],
  justAdded: ReadonlySet<string>,
  deciding: ReadonlySet<string>,
): Admit {
  // `codes` first, matching the screen: a bottle already on the shelf gets the
  // light tick, a bottle mid-decision gets silence.
  if (codes.includes(bc) || justAdded.has(bc)) return 'duplicate';
  if (deciding.has(bc)) return 'deciding';
  return 'add';
}
