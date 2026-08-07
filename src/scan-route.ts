import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import type { Bootstrap } from '@/api';

/**
 * WHAT A SCANNED CODE TURNED OUT TO BE.
 *
 * Two screens now point a camera at a label without knowing in advance what
 * kind of label it is — the Delivery setup and the search bar on Home — and
 * both have to answer the same question in the same order. That order is the
 * whole point of this file, and it is not alphabetical:
 *
 *   1. an asset the fleet already knows about
 *   2. a code matching a customer account
 *   3. anything else: it is just a string
 *
 * Asset first, because a mis-scanned cylinder landing silently in an
 * order-number field is precisely the error that makes an invoice
 * unexplainable three weeks later. Held in one place because two copies of a
 * disambiguation rule drift, and the drift is silent.
 */
export type ScanTarget =
  | { kind: 'asset'; barcode: string }
  | { kind: 'customer'; id: string; name: string }
  | { kind: 'text'; code: string };

export function classify(raw: string, boot: Bootstrap | null): ScanTarget | null {
  const up = raw.trim().toUpperCase();
  if (!up) return null;

  if (boot?.assets?.[up]) return { kind: 'asset', barcode: up };

  const hit = (boot?.customers ?? []).find((c) => c.customerListId.toUpperCase() === up);
  if (hit) return { kind: 'customer', id: hit.customerListId, name: hit.name };

  return { kind: 'text', code: up };
}

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
