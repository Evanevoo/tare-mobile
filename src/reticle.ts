/**
 * THE BOX, AND THE THREE THINGS THAT READ IT.
 *
 * One rectangle, written as fractions of the camera frame, read by the outline
 * drawn over the preview, by the crop Snap and Read text take out of a still
 * photo, and — since drivers started reporting codes picked up from elsewhere
 * in the frame — by the check that decides whether a live decode is accepted
 * at all. It sits in its own file because a pure predicate can be tested
 * without a camera, a phone or a yard: see __tests__/reticle.test.mts, which
 * is mostly a test of when this refuses to have an opinion.
 *
 * Left/top are the near edge; width/height are the box's own size, which is
 * the shape expo-image-manipulator's crop wants — an origin and a size, not
 * two edges.
 *
 * WIDE BECAUSE EVERY CODE IS LINEAR. TALLER BECAUSE THE FIELD SAID SO.
 * A tall box left dead space either side and read as a vertical slot, the
 * wrong shape for a barcode, and that is still why this is 78% wide. The same
 * argument was used to justify 20% tall, and one day of real deliveries
 * retired that half of it: the box a driver has to land on one-handed, in
 * gloves, with a cylinder in the other hand, is not the same size as the box
 * the label fits in. It is 28% now, grown around the same centre (0.43) —
 * above true centre, because a phone tilted down at something held at chest
 * height puts it in the upper half of the frame. Nothing that depended on
 * where the box sits had to move. The Snap and OCR crops grew with it, which
 * costs a little more of the photo on the paperwork path and buys an aiming
 * box that can actually be hit; the corners, where the stray courier sticker
 * that sent that crop in lived, are still outside it.
 */
export const RETICLE = { left: 0.11, width: 0.78, top: 0.29, height: 0.28 } as const;

/**
 * How far outside the box a code may be found and still be accepted, as a
 * fraction of the frame.
 *
 * Generous on purpose. The outline is an aiming guide, and a driver who lands
 * a label a centimetre past its edge has done nothing wrong — the thing being
 * prevented is a code read from somewhere else entirely.
 *
 * At 0.10 this barely bites sideways, because the box is already 78% of the
 * frame wide and the slack carries it to both edges. That is the honest shape
 * of the fix: it rejects a label well above or below the one being aimed at —
 * the order-number barcode further down the same document, the row of
 * cylinders under the one in frame — and it cannot separate two labels side by
 * side without shrinking a box drivers have already told us is too small.
 */
export const RETICLE_SLACK = 0.1;

/**
 * The shape of `bounds` on a scan result, as loosely as it can be written.
 *
 * expo-camera's own types promise `bounds: BarcodeBounds` on every result.
 * Three of its code paths do not deliver one, so nothing here may assume more
 * than "possibly an object with possibly some numbers in it".
 */
export interface ScanBounds {
  origin?: { x?: number; y?: number } | null;
  size?: { width?: number; height?: number } | null;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Was this code found somewhere the driver could plausibly have been aiming?
 *
 * IT FAILS OPEN, AND THAT IS THE DESIGN, NOT A HEDGE. Every uncertainty here
 * resolves to "accept": no bounds, a zero-sized box, a view that has not been
 * measured yet, a centre that lands outside the view entirely. A driver whose
 * scanner quietly stops reading anything is a lost day and a phone call from a
 * yard; a stray read is a wrong line on one order that the console can fix.
 * Those two are not close, so every doubt is spent on the same side.
 *
 * There is a lot of doubt to spend, and it was measured rather than assumed.
 * In expo-camera 17.0.10, the version installed here:
 *
 *   iOS, code39 / pdf417 / codabar — decoded by the bundled ZXing readers on
 *   the video-data path, and `zxResultToDictionary` (ios/Current/
 *   BarcodeScannerUtils.swift) builds a result of `type` and `data` and
 *   nothing else. No bounds key at all. That is most of this fleet's labels on
 *   half its phones, so on those reads this function has nothing to weigh and
 *   says yes — the reticle stays exactly the aiming guide it has always been.
 *
 *   iOS, everything else — AVFoundation metadata, transformed through the
 *   preview layer, so the numbers are in the view's own points. When the
 *   object carries no corners, `addEmptyCornerPoints` writes an origin and a
 *   size of zero rather than omitting them.
 *
 *   Android — ML Kit corner points, scaled to the preview view and divided by
 *   display density, so the numbers are in dp. No corner points means a
 *   bounding box of (0, 0, 0, 0).
 *
 * dp on Android and points on iOS are both what `onLayout` reports, so the
 * normalisation below is against the right box on both. The out-of-range check
 * is the guard for the one case where it would not be: Android skips its
 * transform to view coordinates while the preview has no size, which leaves
 * raw image pixels behind, and a fraction outside 0..1 is how that announces
 * itself.
 */
export function withinReticle(
  bounds: ScanBounds | null | undefined,
  view: { width: number; height: number },
): boolean {
  if (!num(view?.width) || !num(view?.height) || view.width <= 0 || view.height <= 0) return true;

  const x = bounds?.origin?.x;
  const y = bounds?.origin?.y;
  const w = bounds?.size?.width;
  const h = bounds?.size?.height;
  if (!num(x) || !num(y) || !num(w) || !num(h)) return true;
  if (w <= 0 || h <= 0) return true;

  const cx = (x + w / 2) / view.width;
  const cy = (y + h / 2) / view.height;
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return true;

  return (
    cx >= RETICLE.left - RETICLE_SLACK &&
    cx <= RETICLE.left + RETICLE.width + RETICLE_SLACK &&
    cy >= RETICLE.top - RETICLE_SLACK &&
    cy <= RETICLE.top + RETICLE.height + RETICLE_SLACK
  );
}
