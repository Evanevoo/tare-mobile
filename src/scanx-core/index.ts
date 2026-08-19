/**
 * SCANX-CORE — the in-house decoder, on the phone.
 *
 * WHAT THIS IS. A grey-level barcode decoder written in C++ and compiled to
 * asm.js. It never thresholds the image and never finds an edge. Instead it
 * correlates the raw luminance profile against every pattern Code 128 is
 * allowed to contain and asks which one the signal looks most like — a matched
 * filter, with the codebook as the prior.
 *
 * WHY THAT MATTERS. The ZXing family (which is what ships in the app today,
 * and what ML Kit does internally) binarises first: every pixel is called black
 * or white before decoding starts. Below about three pixels per narrow bar most
 * of the pixels on an edge are somewhere in between, and once a 40%-grey pixel
 * has been called white nothing downstream can recover it. Keeping the grey is
 * why this reads labels the other engines cannot.
 *
 * MEASURED, on a 270-image synthetic corpus with ground truth, against a fair
 * classical baseline (Otsu threshold + run-length matching on the same
 * codebook):
 *
 *     px per narrow module   scanx-core   classical
 *     1.0                        40.7%         0.0%
 *     1.2                        37.0%         3.7%
 *     2.0                        88.9%        25.9%
 *     4.0                        96.3%        66.7%
 *     overall                    66.3%        47.8%
 *
 * Zero misreads for both engines across every configuration tested. The 1.0 and
 * 1.2 rows are the interesting ones: that is below the resolution floor the
 * classical approach has, and it is the regime a frosted or worn cylinder label
 * actually lives in.
 *
 * WHAT IS NOT PROVEN. Those numbers are synthetic. This engine has never been
 * run against the 516 real degraded labels, and on the harshest synthetic
 * condition (heavy blur plus low contrast — the closest thing to a frosty
 * bottle) it still LOSES to the classical baseline, 41% to 47%. Putting it on
 * the phone is how that gets settled. Treat every number above as a hypothesis
 * about real labels until the Lab screen says otherwise.
 *
 * ON THE SPEED. ~2 seconds per photo. That is not the algorithm, it is Hermes:
 * React Native's engine has no WebAssembly (facebook/hermes#429, open since
 * 2020), so Emscripten output has to be asm.js, which Hermes interprets rather
 * than JITs. Native would be 10–100× faster. Two seconds is fine for a
 * diagnostic that reads one photograph; it is nowhere near fast enough for the
 * live scan loop, and nothing here is wired into it.
 */

// Reused rather than reimplemented, and NOT replaced with a package: Hermes
// has neither `atob` nor `Buffer`, which is why this function exists in the
// zxing wrapper in the first place. Two decoders sharing one base64 reader
// also means the two engines are provably fed byte-identical input.
import { base64ToBytes } from '@/zxing';

export interface ScanxResult {
  ok: boolean;
  text: string;
  /** 'Code128' | 'Code39' | '' */
  format: string;
  /**
   * The weakest per-character confidence in the whole symbol: how far the
   * winning codeword beat its nearest rival. THIS is the number that separates
   * "I read it" from "I picked the least bad of 107 guesses", and it is why a
   * wrong read is rare rather than merely unlikely.
   */
  margin: number;
  /** Estimated width of one narrow bar, in pixels. Under 2 is past where the
   *  classical decoders give up. */
  module: number;
  chars: number;
  w: number;
  h: number;
  sourceW: number;
  sourceH: number;
  ms: number;
  failure?: string;
  error?: string;
}

type Wasm = {
  _scanx_decode: (ptr: number, len: number, maxDim: number, minMargin: number) => number;
  _scanx_version: () => number;
  _scanx_alloc: (n: number) => number;
  _scanx_free: (p: number) => void;
  UTF8ToString: (ptr: number) => string;
  HEAPU8: Uint8Array;
};

let modPromise: Promise<Wasm> | null = null;

/**
 * Loaded once, lazily, and never on the scan path.
 *
 * The factory is a 262KB module — small next to the 5MB zxing build, but still
 * something no driver should pay for on a screen that does not use it. The
 * dynamic import keeps it out of the initial bundle evaluation entirely.
 */
function load(): Promise<Wasm> {
  if (!modPromise) {
    modPromise = (async () => {
      const factory = (await import('./scanx.js')).default;
      return (await factory()) as Wasm;
    })();
  }
  return modPromise;
}

export async function warmUp(): Promise<void> {
  await load();
}

export async function version(): Promise<string> {
  const m = await load();
  return m.UTF8ToString(m._scanx_version());
}

export interface ScanxOptions {
  /**
   * Downscale the long edge before decoding. Not for speed — a 12-megapixel
   * still of a label 300 pixels wide is mostly a picture of a yard. 1400 is
   * what the app's own Snap path uses, so passing the same number keeps the
   * comparison honest.
   */
  maxDim?: number;
  /**
   * Refuse anything below this confidence. Defaults to 0 HERE, unlike the
   * engine's own default, because on a test screen a refusal and a wrong
   * answer look identical unless you can see the number behind them. Read
   * `margin` off the result and judge it yourself.
   */
  minMargin?: number;
}

/** Decode one base64-encoded JPEG or PNG — the same shape takePictureAsync gives. */
export async function decodeBase64Image(
  b64: string,
  opts: ScanxOptions = {},
): Promise<ScanxResult> {
  const { maxDim = 1400, minMargin = 0 } = opts;

  const started = Date.now();
  const blank: ScanxResult = {
    ok: false, text: '', format: '', margin: 0, module: 0, chars: 0,
    w: 0, h: 0, sourceW: 0, sourceH: 0, ms: 0,
  };

  let m: Wasm;
  try {
    m = await load();
  } catch (e: any) {
    return { ...blank, error: e?.message ? String(e.message) : 'scanx did not start' };
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return { ...blank, error: 'could not read the photo' };
  }
  if (!bytes.length) return { ...blank, error: 'empty image' };

  // One allocation, always freed — a leak here would grow every time the
  // screen is used and be blamed on the camera.
  const ptr = m._scanx_alloc(bytes.length);
  if (!ptr) return { ...blank, error: 'out of memory' };

  try {
    m.HEAPU8.set(bytes, ptr);
    const raw = m.UTF8ToString(
      m._scanx_decode(ptr, bytes.length, maxDim, Math.round(minMargin * 1000)),
    );
    const parsed = JSON.parse(raw) as Omit<ScanxResult, 'ms'>;
    return { ...blank, ...parsed, ms: Date.now() - started };
  } catch (e: any) {
    return { ...blank, ms: Date.now() - started,
             error: e?.message ? String(e.message) : 'decode failed' };
  } finally {
    m._scanx_free(ptr);
  }
}
