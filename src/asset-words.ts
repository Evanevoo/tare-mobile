/**
 * WHAT THE DESCRIPTIVE BOXES ARE CALLED, FOR WHAT THIS COMPANY TRACKS.
 *
 * The app was built inside a gas distributor, so every screen that describes
 * an asset asked for a "Gas type". A company tracking kegs was asked that too,
 * and so was one renting out tools. The columns underneath are the same for
 * everyone; only the word on the box differs, and whether the box for what a
 * thing CONTAINS is there at all — a pallet contains nothing.
 *
 * The server says which kind of thing the company tracks (`org.assetType` in
 * the bootstrap). The words live here, on the phone, so they are there with no
 * signal. A phone talking to an older server, or holding an older download,
 * gets no `assetType` and reads as a cylinder company — which is every company
 * that existed before this file did.
 *
 * The cylinder words are the ones these screens always showed, character for
 * character. Pure: no React, no store, so the table runs in a test.
 */

export interface FieldWords {
  /** On the box: "Gas type". */
  label: string;
  /** Under the box on Add and Edit. */
  hint: string;
  /** Inside the box on Add and Edit. */
  placeholder: string;
}

export interface AssetWords {
  /** Null when the thing carries nothing: the box is not shown. */
  contents: FieldWords | null;
  category: FieldWords;
  group: FieldWords;
}

const GROUP: FieldWords = {
  label: 'Group', hint: 'How it is grouped on reports.', placeholder: 'Group',
};

const WORDS: Record<string, AssetWords> = {
  cylinder: {
    contents: { label: 'Gas type', hint: 'What is in it.', placeholder: 'Gas type — Oxygen, Acetylene…' },
    category: { label: 'Category', hint: 'Industrial, medical, beverage.', placeholder: 'Category — Industrial, Medical…' },
    group: { label: 'Group', hint: 'How it is grouped on reports.', placeholder: 'Group — High-Pressure, Cryo…' },
  },
  keg: {
    contents: { label: 'Contents', hint: 'What is in it.', placeholder: 'Contents — Pale ale, Lager…' },
    category: { label: 'Size', hint: 'Half barrel, sixtel, 50 L.', placeholder: 'Size — Half barrel, Sixtel…' },
    group: { label: 'Brand', hint: 'Whose beer it is.', placeholder: 'Brand' },
  },
  tote: {
    contents: { label: 'Contents', hint: 'What is in it.', placeholder: 'Contents — Glycol, DEF…' },
    category: { label: 'Capacity', hint: '275 gal, 330 gal, 1000 L.', placeholder: 'Capacity — 275 gal, 1000 L…' },
    group: GROUP,
  },
  pallet: {
    contents: null,
    category: { label: 'Type', hint: 'CHEP, euro, custom.', placeholder: 'Type — CHEP, Euro…' },
    group: { label: 'Grade', hint: 'A, B, repair.', placeholder: 'Grade' },
  },
  tool: {
    contents: null,
    category: { label: 'Category', hint: 'Drills, saws, survey.', placeholder: 'Category — Drills, Saws…' },
    group: { label: 'Make', hint: 'Who makes it.', placeholder: 'Make — DeWalt, Hilti…' },
  },
  equipment: {
    contents: null,
    category: { label: 'Category', hint: 'Monitors, pumps, cameras.', placeholder: 'Category — Monitors, Pumps…' },
    group: { label: 'Manufacturer', hint: 'Who makes it.', placeholder: 'Manufacturer' },
  },
  container: {
    contents: null,
    category: { label: 'Size', hint: '20 ft, 40 ft, 10 yd.', placeholder: 'Size — 20 ft, 40 ft…' },
    group: { label: 'Type', hint: 'Dry, reefer, open top.', placeholder: 'Type — Dry, Reefer…' },
  },
};

/** The words for a kind of thing. Unknown or absent reads as a cylinder. */
export function assetWords(assetType: string | null | undefined): AssetWords {
  return WORDS[assetType ?? ''] ?? WORDS.cylinder;
}

/** The label as it reads mid-sentence: "gas type". */
export function wordFor(f: FieldWords): string {
  return f.label.toLowerCase();
}

/** Bulk edit's hint: a blank box changes nothing. */
export function leaveAloneHint(f: FieldWords): string {
  return `Leave blank to leave each one's ${wordFor(f)} alone.`;
}

/** What picking a kind fills in, on the batch screen. */
export function kindHint(w: AssetWords): string {
  const rest = [w.contents, w.category, w.group].filter((f): f is FieldWords => !!f).map(wordFor);
  const first = rest[0].charAt(0).toUpperCase() + rest[0].slice(1);
  return `Pick one. ${[first, ...rest.slice(1)].join(', ')} and description fill in from it.`;
}

/**
 * A changed field as a person would say it, for the three descriptive columns.
 * Null for any other key, so each screen keeps its own names for the rest.
 */
export function describedField(k: string, w: AssetWords): string | null {
  switch (k) {
    case 'gasType': return wordFor(w.contents ?? WORDS.cylinder.contents!);
    case 'category': return wordFor(w.category);
    case 'groupName': return wordFor(w.group);
    default: return null;
  }
}
