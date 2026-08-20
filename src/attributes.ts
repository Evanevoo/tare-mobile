import { useMemo } from 'react';
import { useStore } from '@/store';

/**
 * WHAT THE FLEET ALREADY CALLS THINGS.
 *
 * Gas type, category, group and supplier were free-text boxes on every screen
 * that writes an asset. A text box is the wrong control for a value that has
 * to MATCH other rows: it is how "ARGON", "Argon", "ARGON " and "AGRON" all
 * end up in the same column, and after that no report can group by it and no
 * filter can find them all. The fleet does not need a fifth spelling; it needs
 * the four it has, offered.
 *
 * Nothing is fetched for this. The bootstrap already ships every asset's
 * `gt`/`cat`/`grp`/`sup` and the `types` catalogue, so the list of what this
 * org actually says is derivable on the phone — which also means the pickers
 * work with no signal, same as the rest of the app.
 *
 * Ordered by how often each value is used, commonest first, because the
 * commonest answer is the likeliest one and it should be the nearest thumb
 * movement. `Chips` puts a search box over the list past twelve entries, so a
 * long tail costs nothing.
 *
 * The escape hatch stays: `Chips` keeps its "Something else" toggle, so a
 * genuinely new gas can still be typed the first time it arrives — and from
 * then on it IS the list, because the next phone to sync sees it here.
 */
export interface Opt { key: string; sub?: string }

export interface AttributeOptions {
  gas: Opt[];
  category: Opt[];
  group: Opt[];
  supplier: Opt[];
}

const EMPTY: AttributeOptions = { gas: [], category: [], group: [], supplier: [] };

function tally(counts: Map<string, number>): Opt[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ key, sub: n ? `${n} on fleet` : 'from the catalogue' }));
}

/**
 * A value is counted under its trimmed, upper-cased form, and that form is
 * what the chip writes back. Two rows that differ only in case are the same
 * answer typed twice, and offering both would be offering the bug.
 */
function add(counts: Map<string, number>, raw: string | null | undefined, n = 1) {
  const v = (raw ?? '').trim().toUpperCase();
  if (!v) return;
  counts.set(v, (counts.get(v) ?? 0) + n);
}

export function useAttributeOptions(): AttributeOptions {
  const { boot } = useStore();

  return useMemo(() => {
    if (!boot) return EMPTY;

    const gas = new Map<string, number>();
    const category = new Map<string, number>();
    const group = new Map<string, number>();
    const supplier = new Map<string, number>();

    // One pass over the fleet. Seven thousand records, four map writes each,
    // memoised on the bootstrap — this runs when a sync lands, not on render.
    for (const a of Object.values(boot.assets)) {
      add(gas, a.gt);
      add(category, a.cat);
      add(group, a.grp);
      add(supplier, a.sup);
    }

    // The catalogue can name a type nothing carries yet — a product code was
    // taught its attributes before the first cylinder of it was added. Those
    // belong in the list too, at zero, so the first one to arrive is picked
    // rather than retyped.
    for (const t of boot.types ?? []) {
      add(gas, t.gasType, 0);
      add(category, t.category, 0);
      add(group, t.groupName, 0);
    }

    return {
      gas: tally(gas),
      category: tally(category),
      group: tally(group),
      supplier: tally(supplier),
    };
  }, [boot]);
}
