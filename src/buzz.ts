/**
 * THE DOUBLE-SCAN BUZZ, ONE PATTERN FOR EVERY SCREEN THAT CAN SEE ONE.
 *
 * Asked 1 Oct 2026: "when a barcode has been double scanned, the phone should
 * vibrate as warning". The scan screen already did — but with two 60 ms
 * pulses, the weakest buzz in the app, quieter than an ordinary accept
 * (90 ms) and easy to miss through gloves. The order screen's hand-typed add
 * and the warehouse shelf gave no motor buzz at all, only the OS haptic.
 *
 * Three pulses, because the count is what a gloved hand reads without looking:
 * one solid thump is "counted", two is "unknown" or "wrong kind of code"
 * (scan.tsx take()), three is "you already have this one". Each pulse is long
 * enough to feel through a work glove.
 *
 * Vibration.vibrate takes [wait, on, off, on, ...] in milliseconds.
 */
export const DUPLICATE_BUZZ = [0, 110, 70, 110, 70, 110];
