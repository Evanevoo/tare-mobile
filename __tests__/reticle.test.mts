/**
 * node --experimental-strip-types __tests__/reticle.test.mts
 *
 * WHERE A CODE WAS FOUND, AND WHEN THAT IS ALLOWED TO MATTER.
 *
 * The decoder reads the whole frame and always did; the only lever is refusing
 * an answer that came from the wrong part of it. Which makes the interesting
 * property here the opposite of the obvious one: this is mostly a test of the
 * cases where the check must decline to have an opinion, because a scanner
 * that silently stops reading is a driver's whole day, and a stray read is one
 * line on one order that the office can fix in a minute.
 */
import { withinReticle, RETICLE, RETICLE_SLACK } from '../src/reticle.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** A phone-shaped preview, in the points/dp both platforms report bounds in. */
const VIEW = { width: 400, height: 800 };

/** A code of a believable size, centred on a fraction of the frame. */
const at = (fx: number, fy: number, w = 200, h = 40) => ({
  origin: { x: fx * VIEW.width - w / 2, y: fy * VIEW.height - h / 2 },
  size: { width: w, height: h },
});

section('THE BOX ITSELF — taller after a day in the field, same centre');
{
  ok('still wide, because every code this app reads is linear',
    RETICLE.width === 0.78);
  ok('28% tall, not the old 20%', RETICLE.height === 0.28);
  ok('and the vertical centre did not move off 0.43',
    Math.abs(RETICLE.top + RETICLE.height / 2 - 0.43) < 1e-9,
    String(RETICLE.top + RETICLE.height / 2));
}

section('A CODE WHERE THE DRIVER WAS AIMING');
{
  ok('dead centre of the box', withinReticle(at(0.5, 0.43), VIEW));
  ok('at the top edge of the box', withinReticle(at(0.5, RETICLE.top), VIEW));
  ok('at the bottom edge of the box',
    withinReticle(at(0.5, RETICLE.top + RETICLE.height), VIEW));
  ok('near the left end of a wide label', withinReticle(at(0.13, 0.43), VIEW));
  ok('near the right end of a wide label', withinReticle(at(0.87, 0.43), VIEW));
}

section('JUST OUTSIDE IS STILL A READ — the slack is the point');
{
  const above = RETICLE.top - RETICLE_SLACK / 2;
  const below = RETICLE.top + RETICLE.height + RETICLE_SLACK / 2;
  ok('a hand held a little high', withinReticle(at(0.5, above), VIEW));
  ok('a hand held a little low', withinReticle(at(0.5, below), VIEW));
  ok('sideways, the slack reaches the frame edge — by design, not by accident',
    withinReticle(at(0.97, 0.43), VIEW));
}

section('SOMEWHERE ELSE IN THE FRAME — the read Evan reported');
{
  ok('the order-number barcode further down the page',
    !withinReticle(at(0.5, 0.88), VIEW));
  ok('a label above the one being aimed at',
    !withinReticle(at(0.5, 0.08), VIEW));
  ok('the first fraction past the slack is refused',
    !withinReticle(at(0.5, RETICLE.top + RETICLE.height + RETICLE_SLACK + 0.01), VIEW));
  ok('and the last fraction inside it is not',
    withinReticle(at(0.5, RETICLE.top + RETICLE.height + RETICLE_SLACK - 0.01), VIEW));
}

section('IT FAILS OPEN — every one of these must scan');
{
  ok('no bounds at all (iOS ZXing: code39, pdf417, codabar)',
    withinReticle(undefined, VIEW));
  ok('bounds null', withinReticle(null, VIEW));
  ok('a zero rectangle (no corner points on either platform)',
    withinReticle({ origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } }, VIEW));
  ok('an origin but no size', withinReticle({ origin: { x: 10, y: 10 } }, VIEW));
  ok('a size but no origin', withinReticle({ size: { width: 200, height: 40 } }, VIEW));
  ok('numbers that are not numbers',
    withinReticle({ origin: { x: NaN, y: 10 }, size: { width: 200, height: 40 } }, VIEW));
  ok('a view that has not been laid out yet',
    withinReticle(at(0.5, 0.9), { width: 0, height: 0 }));
  ok('coordinates that are plainly not this view’s (raw image pixels)',
    withinReticle({ origin: { x: 1200, y: 900 }, size: { width: 300, height: 100 } }, VIEW));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
