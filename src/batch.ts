/**
 * A pallet, held on the phone until somebody says save.
 *
 * The single-cylinder screen next door is a form with a scanner at the top of
 * it. Receiving a pallet is the other way round: the scanner IS the screen, and
 * the form is one thing filled in at the end, once, for all forty. What sits
 * between those two is this file — a list of barcode-and-serial pairs, the
 * rules for what is allowed to join it, and nothing that has ever heard of a
 * camera.
 *
 * It is pure so the rules can be run without a phone, because the yard is the
 * one place they cannot be tested. Refusing a barcode that is already in the
 * batch is two seconds on a handset and an afternoon in the office if it is got
 * wrong, and the driver holding that cylinder is not in a position to tell the
 * difference between "it refused this" and "it dropped this".
 *
 * NOTHING HERE CREATES ANYTHING. Every function returns a new list; the screen
 * holds it in state and the server hears about the whole thing once, on Save.
 * That is what lets the capture loop be as fast as it is — a driver who backs
 * out at cylinder twelve has changed nothing anywhere.
 */

/**
 * The most that goes up in one call, matching the server's own ceiling.
 *
 * It lives here rather than only on the server so the refusal happens at scan
 * time, while the cylinder is still in the driver's hand, instead of arriving
 * as a rejected save at the end of a long afternoon of scanning.
 */
export const MAX_BATCH = 500;

export interface BatchRow {
  /** Stable across edits, so a row keeps its identity when its barcode is retyped. */
  id: string;
  barcode: string;
  /** '' means this one has no serial, which is a real answer and not a gap. */
  serial: string;
}

/**
 * What the phone already knows is on the fleet.
 *
 * A structural `has` rather than the bootstrap's asset map, for two reasons: a
 * plain Set satisfies it in a test, and the screen needs to fold in the
 * barcodes it created a minute ago, which are real but will not be in the
 * downloaded copy until the next bootstrap lands.
 */
export interface Fleet {
  has(barcode: string): boolean;
}

export type RefusalReason = 'blank' | 'full' | 'in-batch' | 'on-fleet';

export interface Refusal {
  reason: RefusalReason;
  barcode: string;
  /** 1-based position of the row it collided with; 0 when it collided with no row. */
  at: number;
  /** What goes on the screen, in the words somebody holding that bottle needs. */
  says: string;
}

/** The list, the row that landed, and the reason nothing did. Exactly one of the last two. */
export interface BatchChange {
  /** Unchanged when the entry was refused — a refusal never edits the list. */
  rows: BatchRow[];
  row: BatchRow | null;
  refused: Refusal | null;
}

export interface BatchItem {
  barcode: string;
  serialNumber: string | null;
}

/** What POST /api/mobile/assets/bulk answers with. Partial success is a 200. */
export interface BulkCreateResult {
  created: number;
  createdBarcodes: string[];
  skipped: { barcode: string; reason: 'exists' }[];
  invalid: { barcode: string; reason: string }[];
}

/**
 * The Scanner hands back a trimmed, uppercased string already; a thumb on a
 * keyboard does not. Both routes end up here so a barcode typed with a stray
 * space cannot become a second, near-identical row further down the list.
 */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Whether this barcode may join the batch, and if not, what to say out loud.
 *
 * BOTH DUPLICATE CHECKS ANSWER THE SAME QUESTION FROM DIFFERENT SIDES. Scanning
 * one cylinder twice off the same pallet is the mistake a person makes forty
 * bottles into a job; scanning one that is already on the fleet is the mistake
 * a person makes when half a pallet was booked in yesterday. Neither is caught
 * by the server in time to be useful — a save at the end of the afternoon
 * reports it long after the cylinder has been put down and forgotten.
 *
 * AND IT IS A REFUSAL, NOT A DROP. Every one of these returns a sentence
 * naming the barcode, because the driver is standing there holding that bottle
 * and needs to know why it did not go in. A batch that silently ignores the
 * second scan looks exactly like a batch that missed the read, and the answer
 * to those two is opposite: put it down, or scan it again.
 *
 * `ignoreId` is the row being retyped. Without it, correcting a serial on row
 * twelve and leaving its barcode alone would refuse the edit on the grounds
 * that row twelve already has that barcode.
 */
export function whyRefused(
  raw: string,
  rows: BatchRow[],
  fleet: Fleet | null,
  ignoreId?: string,
): Refusal | null {
  const barcode = normalizeCode(raw);

  if (!barcode) {
    return {
      reason: 'blank', barcode, at: 0,
      says: 'Nothing came back off that one. Try the label again.',
    };
  }

  // Only an add can push the list past the ceiling; an edit leaves the count
  // where it was, so it is never refused for being one too many.
  if (!ignoreId && rows.length >= MAX_BATCH) {
    return {
      reason: 'full', barcode, at: rows.length,
      says: `That is ${MAX_BATCH} in this batch already — save these before scanning any more.`,
    };
  }

  const at = rows.findIndex((r) => r.barcode === barcode && r.id !== ignoreId);
  if (at >= 0) {
    return {
      reason: 'in-batch', barcode, at: at + 1,
      says: `${barcode} is already number ${at + 1} in this batch. It has not gone in twice.`,
    };
  }

  if (fleet?.has(barcode)) {
    return {
      reason: 'on-fleet', barcode, at: 0,
      says: `${barcode} is already on the fleet. Nothing has been added.`,
    };
  }

  return null;
}

/**
 * One more cylinder, on the end.
 *
 * Appended rather than unshifted because the position in this list is the
 * position on the pallet — "already number twelve" only means anything if the
 * numbering is the order they were scanned in. Which way round the screen
 * chooses to DRAW them is a separate question, and the screen's own.
 */
export function addRow(
  rows: BatchRow[],
  entry: { id: string; barcode: string; serial?: string },
  fleet: Fleet | null,
): BatchChange {
  const refused = whyRefused(entry.barcode, rows, fleet);
  if (refused) return { rows, row: null, refused };

  const row: BatchRow = {
    id: entry.id,
    barcode: normalizeCode(entry.barcode),
    serial: (entry.serial ?? '').trim().toUpperCase(),
  };
  return { rows: [...rows, row], row, refused: null };
}

/**
 * Fix one that is already in the list.
 *
 * The reason this exists at all: a mistyped serial noticed at cylinder twelve
 * must not mean starting the pallet again. Both fields are editable because
 * both are typed by a person — the serial always, and the barcode whenever the
 * label was too far gone to read and the number was keyed in by hand.
 *
 * An id that is not in the list is a no-op rather than a throw. It means the
 * row was deleted while its editor was open, and the correct answer to that is
 * the list the caller already has.
 */
export function editRow(
  rows: BatchRow[],
  id: string,
  patch: { barcode?: string; serial?: string },
  fleet: Fleet | null,
): BatchChange {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return { rows, row: null, refused: null };

  const current = rows[i];
  const barcode = patch.barcode === undefined ? current.barcode : normalizeCode(patch.barcode);

  // Only re-run the duplicate checks when the barcode actually moved. Retyping
  // it to what it already was is not somebody adding a duplicate.
  if (barcode !== current.barcode) {
    const refused = whyRefused(barcode, rows, fleet, id);
    if (refused) return { rows, row: null, refused };
  }

  const row: BatchRow = {
    ...current,
    barcode,
    serial: patch.serial === undefined ? current.serial : patch.serial.trim().toUpperCase(),
  };
  const next = rows.slice();
  next[i] = row;
  return { rows: next, row, refused: null };
}

/**
 * Take one back out.
 *
 * By id, not by barcode, so that removing a row frees its barcode to be
 * scanned again — which is exactly what happens when a driver deletes the one
 * they scanned off the wrong cylinder and then scans the right one.
 */
export function removeRow(rows: BatchRow[], id: string): BatchRow[] {
  return rows.filter((r) => r.id !== id);
}

/** The shared half of the batch — asked once, applied to every row. */
export interface BatchDetails {
  productCode: string;
  isFull: boolean | null;
  /**
   * Whether the typed requalification date is a real day. The check itself is
   * `isRealDate` in src/form.tsx, which lives next to the field that owns it;
   * this module stays free of anything that imports React Native so it can run
   * under plain node.
   */
  dateOk: boolean;
}

/**
 * Why Save is not available yet, said as a sentence rather than a boolean.
 *
 * The sentence is the point. A greyed-out button with no explanation is the
 * single most common way a driver decides an app is broken, and every one of
 * these conditions is one tap from being resolved — so the button carries its
 * own reason underneath it.
 *
 * A SERIAL IS NEVER ONE OF THEM. Most cylinders have one stamped on the collar
 * and this screen exists to capture it, but some genuinely have none, and the
 * add-one-at-a-time screen has always treated it as optional. A batch that
 * refuses to save because bottle nineteen has a worn collar would be resolved
 * by typing something false into the box, which is worse than a blank.
 */
export function whyNotReady(rows: BatchRow[], d: BatchDetails): string | null {
  if (!rows.length) return 'Scan one to start.';
  if (rows.length > MAX_BATCH) return `${MAX_BATCH} at a time is the most that can go up in one save.`;
  if (!d.productCode.trim()) return 'Say what kind these are.';
  if (d.isFull === null) return 'Say whether they are full or empty.';
  if (!d.dateOk) return 'That requalification date is not a real day.';
  return null;
}

/** The rows as the server wants them. A blank serial goes up as null, not "". */
export function toItems(rows: BatchRow[]): BatchItem[] {
  return rows.map((r) => ({ barcode: r.barcode, serialNumber: r.serial.trim() || null }));
}

/**
 * What is still in hand after a save.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE, not a failure. Half a pallet booked in
 * yesterday means half the barcodes come back skipped, and the honest thing to
 * leave on screen is the half that did not go in — nothing else. The driver
 * presses Save again, or fixes the two that were wrong, without re-scanning
 * the thirty-eight that worked.
 */
export function applyResult(rows: BatchRow[], result: BulkCreateResult): BatchRow[] {
  const done = new Set(result.createdBarcodes.map(normalizeCode));
  return rows.filter((r) => !done.has(r.barcode));
}

/**
 * The result in one line, for the top of the panel and for the haptic to match.
 *
 * Counts only, and never the word "error". Skipped and invalid are different
 * things — one is already on the fleet and is fine, the other could not be read
 * — and the panel underneath names both sets barcode by barcode. This is the
 * sentence somebody reads at arm's length before deciding whether to care.
 */
export function describeResult(r: BulkCreateResult, label: string, plural: string): string {
  const parts: string[] = [
    r.created === 0 ? 'Nothing new went on the fleet.'
      : r.created === 1 ? `1 ${label} added.`
      : `${r.created} ${plural} added.`,
  ];
  if (r.skipped.length) {
    parts.push(r.skipped.length === 1
      ? '1 was already on the fleet.'
      : `${r.skipped.length} were already on the fleet.`);
  }
  if (r.invalid.length) {
    parts.push(r.invalid.length === 1
      ? '1 could not be added.'
      : `${r.invalid.length} could not be added.`);
  }
  return parts.join(' ');
}
