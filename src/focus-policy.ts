/**
 * Forced autofocus pulses help a moving rack scan, but interrupt a driver
 * holding a long customer or asset barcode still in front of the lens.
 */
export function focusPulseDelays(steadyFocus: boolean): number[] {
  return steadyFocus ? [] : [600, 2000, 3100];
}
