import { useCallback } from 'react';
import { Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { playScanAccept } from './sound';
import { classify, type ScanTarget } from './scan-match';

/**
 * The navigation half of "what did I just scan".
 *
 * The decision itself lives in scan-match.ts, which imports nothing from React
 * or expo-router so it can be run and tested off a phone. This file is only the
 * wiring: classify, then go somewhere if there is somewhere honest to go.
 */
export { classify, explainMiss, type ScanTarget } from './scan-match';

export interface ScanRouteOptions {
  /**
   * Open the customer's own screen when a customer code is read. Default true.
   *
   * Home passes nothing: there a scan is a lookup, and the account is where
   * you wanted to go. Delivery setup passes false, because there a customer
   * code is an ANSWER TO THE FIELD ALREADY ON SCREEN — the driver is halfway
   * through setting up a job, and navigating them onto a different screen
   * mid-setup loses the order number they were about to type and reads as the
   * app having ignored them.
   */
  customerScreen?: boolean;
}

/**
 * Classify, and for the two cases that have a screen of their own, go there.
 *
 * The classification is still returned, because a caller may want to do
 * something else with a `text` result — Delivery puts it in the order-number
 * field. Nothing navigates on `text`: there is nowhere honest to send an
 * unrecognised string, and guessing is how you end up on the wrong customer.
 */
export function useScanRoute(opts?: ScanRouteOptions) {
  const router = useRouter();
  const boot = useStore((s) => s.boot);
  // Read to a primitive before the callback closes over it, or an options
  // object built inline at the call site rebuilds the callback every render.
  const toCustomer = opts?.customerScreen !== false;

  return useCallback((raw: string): ScanTarget | null => {
    const t = classify(raw, boot);
    if (!t) return null;
    /**
     * A read that resolved deserves the same buzz-and-chirp everywhere.
     *
     * Home's quick scan and Delivery's setup fields went through here and
     * made no sound and no vibration at all — the driver-feedback fix for
     * gloved hands only ever reached the scan loop. From the driver's side
     * these are all one gesture, "point the phone at a barcode", and a
     * gesture that buzzes on one screen and stays dead on another reads as
     * broken, not as scoped.
     */
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    Vibration.vibrate(90);
    playScanAccept();
    // Every caller of this is inside an open scanner sheet, so both of these
    // navigations happen in the same tick as the caller's setScanning(null).
    // That used to orphan an Android dialog window and freeze the app; the
    // sheets are ordinary views now (src/sheet.tsx), so there is no window to
    // orphan and these can go straight through.
    if (t.kind === 'asset') {
      router.push(`/asset/${encodeURIComponent(t.barcode)}` as never);
    }
    // The ACCOUNT NUMBER, not the uuid — see the note in app/customer/[id].tsx
    // for why that screen has to answer to both.
    if (t.kind === 'customer' && toCustomer) {
      router.push(`/customer/${encodeURIComponent(t.id)}` as never);
    }
    return t;
  }, [boot, router, toCustomer]);
}
