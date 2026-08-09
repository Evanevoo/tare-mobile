import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { classify, type ScanTarget } from './scan-match';

/**
 * The navigation half of "what did I just scan".
 *
 * The decision itself lives in scan-match.ts, which imports nothing from React
 * or expo-router so it can be run and tested off a phone. This file is only the
 * wiring: classify, then go somewhere if there is somewhere honest to go.
 */
export { classify, type ScanTarget } from './scan-match';

/**
 * Classify, and for the two cases that have a screen of their own, go there.
 *
 * The classification is still returned, because a caller may want to do
 * something else with a `text` result — Delivery puts it in the order-number
 * field. Nothing navigates on `text`: there is nowhere honest to send an
 * unrecognised string, and guessing is how you end up on the wrong customer.
 */
export function useScanRoute() {
  const router = useRouter();
  const boot = useStore((s) => s.boot);

  return useCallback((raw: string): ScanTarget | null => {
    const t = classify(raw, boot);
    if (!t) return null;
    if (t.kind === 'asset') router.push(`/asset/${encodeURIComponent(t.barcode)}` as never);
    if (t.kind === 'customer') router.push(`/customer/${encodeURIComponent(t.id)}` as never);
    return t;
  }, [boot, router]);
}
