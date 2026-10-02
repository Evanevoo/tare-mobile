/**
 * "This account is on hold in QuickBooks."
 *
 * The office puts accounts on hold in QuickBooks ("Hard Hold", "Soft Hold",
 * "Hold", "DO NOT SELL"), and the bootstrap carries that label on each
 * customer as `hold` — absent when the account is fine. This file turns it
 * into the one line a driver reads when they pick that customer.
 *
 * ADVISORY, NEVER A GATE. The office decides what a hold means for a given
 * delivery; a driver standing at the customer's door with a full truck must
 * still be able to scan. Nothing here returns "blocked" and no caller should
 * treat a notice as one.
 *
 * Pure on purpose — no React, no store — so it runs under node in the tests.
 */

export interface HoldNotice {
  /** The label exactly as QuickBooks has it, trimmed: "Hard Hold". */
  label: string;
  /** What goes on the screen. */
  text: string;
  /**
   * A hold that reads as "do not supply" (hard hold, do not sell) gets the
   * red tone; anything softer gets amber. Colour only — both say the same
   * thing in words, and neither stops scanning.
   */
  severe: boolean;
}

/** One customer's hold, from whatever the bootstrap sent. Blank means none. */
export function holdNotice(hold: string | null | undefined): HoldNotice | null {
  const label = typeof hold === 'string' ? hold.trim() : '';
  if (!label) return null;
  const k = label.toLowerCase().replace(/[^a-z]/g, '');
  const severe = k.includes('hard') || k.includes('donotsell') || k.includes('dontsell');
  return {
    label,
    text: `On hold in QuickBooks: ${label}. Check with the office before delivering.`,
    severe,
  };
}

/**
 * The hold for an account number, looked up in the customer list on this
 * phone. The job in flight stores only the account number and name, so the
 * scan screen reads the hold fresh from the latest bootstrap — a hold the
 * office lifts mid-shift disappears on the next sync rather than lingering.
 */
export function holdFor(
  customers: ReadonlyArray<{ customerListId: string; hold?: string | null }> | null | undefined,
  customerListId: string | null | undefined,
): HoldNotice | null {
  // A bootstrap from an older server or cache may carry something other than
  // a list here, or holes in it; a hold is advisory, so none is the answer
  // rather than a scan screen that will not open (K5, 1 Oct 2026).
  if (!Array.isArray(customers) || !customerListId) return null;
  const c = customers.find((x) => x?.customerListId === customerListId);
  return c ? holdNotice(c.hold) : null;
}
