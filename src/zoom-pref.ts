/**
 * THE SCANNER'S ZOOM, REMEMBERED PER PHONE (23 Sep 2026).
 *
 * The camera opened at 1x every time. On an iPhone 11 the dense Code 39 card
 * on WeldCor's paperwork (`%80000E8C-1789575264A`, 21 characters) will not
 * decode at 1x - the bars are too thin at any distance the lens can focus -
 * so a driver had to tap the zoom button on every single scan. Now the last
 * zoom this phone chose is where the next scan starts. It is per phone, not
 * per company, because the problem is the camera, not the customer.
 *
 * Pure: parsing and stepping only. The AsyncStorage read/write lives in the
 * scanner, where a failure is ignored and the scan starts at 1x as before.
 */

/** expo-camera zoom values (0..1, relative) behind the 1x / 1.5x / 2x button. */
export const ZOOM_STEPS = [0, 0.15, 0.3] as const;
export type ZoomStep = (typeof ZOOM_STEPS)[number];

export const ZOOM_PREF_KEY = 'scanner.zoom.v1';

/** A stored value back into a zoom step. Anything unrecognised starts at 1x. */
export function parseZoom(raw: string | null | undefined): ZoomStep {
  const n = Number(raw);
  return (ZOOM_STEPS as readonly number[]).includes(n) ? (n as ZoomStep) : 0;
}

/** The button's cycle: 1x -> 1.5x -> 2x -> 1x. */
export function nextZoom(z: number): ZoomStep {
  const i = (ZOOM_STEPS as readonly number[]).indexOf(z);
  return ZOOM_STEPS[(i + 1) % ZOOM_STEPS.length];
}

export function zoomLabel(z: number): string {
  return z === 0.15 ? '1.5\u00d7' : z === 0.3 ? '2\u00d7' : '1\u00d7';
}
