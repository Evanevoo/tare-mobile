import { useEffect, useState } from 'react';
import { getAsset } from './api';

/** The two facts the Add screen's warning needs, in the bootstrap's own words. */
export interface LiveDupe {
  barcode: string;
  location: string | null;
  customerListId: string | null;
}

/**
 * THE GAP THIS CLOSES.
 *
 * Add's duplicate check compares a scanned barcode against `boot.assets` —
 * the bootstrap downloaded at last sync. That is right for speed and right
 * offline, and wrong exactly once: a bottle another phone added to the same
 * fleet since this phone last synced is not in that snapshot, so the local
 * check says "new" all the way through the form, and the collision only
 * surfaces when Save hits the server's own uniqueness check and throws the
 * finished form away. See assets-old-vs-new-2026-08-20.md — this was the
 * "gets caught server-side instead" line.
 *
 * This asks the server the same question the moment a barcode settles, using
 * the same GET /api/mobile/assets/:barcode the "Look it up" flow already
 * calls elsewhere, so the collision is known before the driver has typed a
 * single field rather than after.
 *
 * DELIBERATELY SILENT OFFLINE, AND DELIBERATELY NOT THE ONLY GUARD. A phone
 * with no signal cannot ask this, and that is the normal case this app is
 * built for (see api.ts's own fetchHistory comment on the same point). A
 * failed or slow check just means the local check is all that ran, which is
 * exactly today's behaviour — never worse, and the server still refuses a
 * true duplicate at save time regardless of what this found. So a rejection
 * here is swallowed rather than shown; there is nothing actionable to tell a
 * driver about a check they did not ask for and cannot retry by hand.
 *
 * Debounced, not fired per keystroke: a scan hands the whole barcode over in
 * one call to `take`, but a thumb typing it in changes `barcode` once per
 * character, and every call before the last one would be wasted.
 */
export function useLiveDuplicateCheck(
  barcode: string,
  /** Skip when there is nothing to check yet, or the local check already found it. */
  skip: boolean,
): { checking: boolean; found: LiveDupe | null } {
  const [found, setFound] = useState<LiveDupe | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!barcode || skip) {
      setFound(null);
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);

    const t = setTimeout(() => {
      getAsset(barcode)
        .then(({ asset }) => {
          if (cancelled) return;
          setFound(asset ? { barcode: asset.barcode, location: asset.l, customerListId: asset.c } : null);
        })
        .catch(() => {
          if (!cancelled) setFound(null);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `skip` deliberately excluded from re-triggering a fresh check once it
    // flips true mid-flight — the cleanup above already cancels that run,
    // and re-running this effect for its own sake would do nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcode, skip]);

  return { checking, found };
}
