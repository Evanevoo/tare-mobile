export type LocateDraft = {
  location: string;
  custom: boolean;
  state: 'full' | 'empty' | null;
  codes: string[];
  at?: number;
};

/** A Locate draft may be resumed only after the driver explicitly chooses it. */
export function locateDraftAction(
  draft: LocateDraft | null | undefined,
  now = Date.now(),
  freshMs = 6 * 60 * 60 * 1000,
): 'ask' | 'discard' {
  if (!draft?.codes.length) return 'discard';
  if (draft.at != null && now - draft.at >= freshMs) return 'discard';
  return 'ask';
}
