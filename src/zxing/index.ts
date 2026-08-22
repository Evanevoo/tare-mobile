/**
 * ZXING — the candidate engine for the Scanified SDK, running on the phone
 * today so it can be pointed at real labels before anything is committed to.
 *
 * WHAT THIS IS. zxing-cpp compiled to asm.js with Emscripten (`-s WASM=0`),
 * because Hermes has no WebAssembly engine and no JIT. It ships inside the JS
 * bundle and reaches a handset over an OTA update, which is the entire reason
 * it exists in this form: a native module needs a config plugin, a prebuild
 * and a store-eligible build before anyone can point a camera at a cylinder,
 * and that is weeks of build-pipeline work standing between us and the first
 * real measurement. This is not the shipping design. The SDK compiles the
 * same C++ natively through JNI and Objective-C++.
 *
 * WHAT THE NUMBERS MEAN. A desktop bench measured this decoder at ~0.5ms per
 * decode natively across 516 degraded images. Interpreted asm.js costs one to
 * two orders of magnitude on top of that, so expect tens to low hundreds of
 * milliseconds here. The DECODED VALUES are exactly what the native library
 * returns -- same code -- but the MILLISECONDS ARE NOT A FORECAST of what the
 * SDK will do. The test screen says so on the screen rather than letting a
 * number be quoted out of context.
 *
 * ON THE VERSION. zxing-cpp 2.3.0, not the 3.1.1 the desktop bench measured.
 * The available Emscripten bundles clang 15, whose libc++ has no std::ranges
 * algorithms, which 3.x uses throughout; 2.3.0 is the last C++17 tree and
 * carries all twelve target symbologies. Re-measure before comparing phone
 * results against the desktop table.
 *
 * Rebuild with build.sh in the zxing-asmjs build tree. Do not hand-edit
 * core.js -- it is generated, and it is 1.5 MB of it.
 */

type Wasm = {
  cwrap: (name: string, ret: string | null, args: string[]) => (...a: any[]) => any;
  UTF8ToString: (ptr: number) => string;
  HEAPU8: Uint8Array;
  _zx_alloc: (n: number) => number;
  _zx_free: (p: number) => void;
};

/**
 * Every symbology the build can read, as zxing spells them.
 *
 * The strings matter: they go across the C boundary into
 * `BarcodeFormatsFromString`, which is case-insensitive but otherwise exact.
 * A typo here is not a compile error, it is a format that silently never
 * matches -- the same class of bug as the `regionOfInterest` property that sat
 * dead in this app's scanner settings through two codebases.
 */
export const FORMAT = {
  Aztec: 'Aztec',
  Codabar: 'Codabar',
  Code39: 'Code39',
  Code93: 'Code93',
  Code128: 'Code128',
  DataBar: 'DataBar',
  DataBarExpanded: 'DataBarExpanded',
  DataMatrix: 'DataMatrix',
  EAN8: 'EAN-8',
  EAN13: 'EAN-13',
  ITF: 'ITF',
  MaxiCode: 'MaxiCode',
  PDF417: 'PDF417',
  QRCode: 'QRCode',
  MicroQRCode: 'MicroQRCode',
  RMQRCode: 'rMQR',
  UPCA: 'UPC-A',
  UPCE: 'UPC-E',
} as const;

export type FormatName = (typeof FORMAT)[keyof typeof FORMAT];

/**
 * Presets, matching the ScanX wrapper's so the test screen can put the two
 * decoders on the same footing.
 *
 * Empty means "every format", which is also the app's current behaviour
 * everywhere and is measurably the wrong default: the desktop bench put
 * ungated decoding at 10.7x the cost of gated for an identical read rate.
 * The SDK will make this a required argument for that reason.
 */
export const PRESETS: Record<string, readonly FormatName[]> = {
  all: [],
  retail: [FORMAT.EAN13, FORMAT.EAN8, FORMAT.UPCA, FORMAT.UPCE],
  assets: [FORMAT.Code128, FORMAT.Code39, FORMAT.Code93, FORMAT.ITF, FORMAT.Codabar],
  qr: [FORMAT.QRCode, FORMAT.DataMatrix, FORMAT.Aztec, FORMAT.PDF417],
};

/** 0 = per-frame budget, 1 = still-frame pass with rotation/inversion on. */
export type Effort = 0 | 1;
export const EFFORT_LABEL: Record<Effort, string> = { 0: 'Fast', 1: 'Thorough' };

export type ZXCode = {
  format: string;
  text: string;
  /** Error-correction level where the symbology has one; '' where it does not. */
  ecc: string;
  /** How many scan lines agreed, for 1D reads. A 1 here is a single-line read. */
  lines: number;
  /** Four corner points, x0,y0..x3,y3, in decoded-image pixels. */
  quad: number[];
};

export type ZXResult = {
  /** Core decode time. See the note at the top before quoting this. */
  ms: number;
  /** Size the decoder actually saw, after the downscale. */
  w: number;
  h: number;
  /** Size of the image handed in. */
  sourceW: number;
  sourceH: number;
  codes: ZXCode[];
  error?: string;
};

export type DecodeOptions = {
  /** Longest edge the decoder sees. The bench floor is ~3px per narrow bar. */
  maxDim?: number;
  effort?: Effort;
  /** Empty or omitted means every format -- and costs about 10x for it. */
  formats?: readonly FormatName[];
  /** Stop after this many codes. 1 for the ordinary single-label case. */
  maxResults?: number;
  /**
   * Local adaptive threshold before the decoder sees the frame. Default on.
   *
   * Not a cosmetic option. Tested against replicas of WeldCor's own paperwork,
   * a shadow edge falling across a Code 128 symbol makes it UNREADABLE at
   * every resolution from 1 to 8 pixels per bar -- and cropping tighter,
   * CLAHE and unsharp masking all fail to recover it. Thresholding each pixel
   * against its own neighbourhood recovers it completely, and costs nothing
   * measurable (the binarised image is often faster to scan than the
   * grayscale). Two of the six photographs from the shop floor have exactly
   * that shadow. Left switchable so the test screen can show the difference.
   */
  binarize?: boolean;
};

let modPromise: Promise<Wasm> | null = null;

/**
 * Load the core once.
 *
 * Deferred rather than imported at module scope: it is 1.5 MB of generated
 * JavaScript and Hermes has to walk all of it, which is a visible stall if it
 * happens while a screen is trying to appear. Callers that care about the
 * first decode being honest should await `warmUp()` on mount so the module
 * load is not charged to it.
 */
function load(): Promise<Wasm> {
  if (!modPromise) {
    modPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const createZX = require('./core.js');
      return (await createZX()) as Wasm;
    })();
  }
  return modPromise;
}

export async function warmUp(): Promise<void> {
  await load();
}

export async function coreVersion(): Promise<string> {
  const m = await load();
  return m.cwrap('zx_version', 'string', [])();
}

/**
 * Base64 -> bytes, by hand.
 *
 * Hermes has neither `atob` nor `Buffer`. Tolerates a `data:` prefix,
 * embedded whitespace and missing padding, because every one of those has
 * turned up in a real payload at some point and none of them is worth a
 * failed scan.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64REV = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  const comma = b64.indexOf(',');
  let s = comma >= 0 && b64.slice(0, comma).indexOf('base64') >= 0 ? b64.slice(comma + 1) : b64;
  s = s.replace(/[\s=]/g, '');

  const out = new Uint8Array((s.length * 3) >> 2);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64REV[s.charCodeAt(i)];
    if (v === 255) continue;                 // skip anything that is not base64
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/**
 * Bytes -> base64, by hand -- the other direction of the function above and
 * for the same reason (Hermes has neither `btoa` nor `Buffer`). Added 22 Aug
 * 2026 for the scanx2core native module (`@/scanx-core`), which crosses the
 * classic RN bridge as a JSON string and so needs the luma frame it decodes
 * base64-encoded going IN, not just coming back out.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * Decode one still image.
 *
 * Takes the encoded JPEG/PNG rather than pixels: the phone already has a JPEG
 * from `takePictureAsync`, and pushing a decoded RGBA buffer through the JS
 * heap costs more than the decode. stb_image turns it into a single luminance
 * plane inside the module -- which is also exactly what the native SDK will
 * hand its decoder, so this path is a rehearsal for that one.
 *
 * Returns a result with `error` set rather than throwing. A decoder that
 * throws into an Emscripten runtime aborts the module, and on a phone that
 * means the screen dies rather than the scan failing.
 */
export async function decodeBase64Image(
  b64: string,
  opts: DecodeOptions = {},
): Promise<ZXResult> {
  const { maxDim = 900, effort = 1, formats = [], maxResults = 4, binarize = true } = opts;

  let m: Wasm;
  try {
    m = await load();
  } catch (e: any) {
    return { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [],
             error: e?.message ? String(e.message) : 'the decoder did not load' };
  }

  const bytes = base64ToBytes(b64);
  if (!bytes.length) {
    return { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [], error: 'empty image' };
  }

  let ptr = 0, res = 0;
  try {
    ptr = m._zx_alloc(bytes.length);
    if (!ptr) throw new Error('out of memory in the decoder');
    // Re-read HEAPU8 rather than closing over it: ALLOW_MEMORY_GROWTH can
    // replace the backing buffer and detach any view taken earlier.
    m.HEAPU8.set(bytes, ptr);

    const decode = m.cwrap('zx_decode', 'number',
      ['number', 'number', 'number', 'string', 'number', 'number', 'number']);
    res = decode(ptr, bytes.length, maxDim, formats.join(','), effort, maxResults,
                 binarize ? 1 : 0);
    if (!res) throw new Error('the decoder returned nothing');

    return JSON.parse(m.UTF8ToString(res)) as ZXResult;
  } catch (e: any) {
    return { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [],
             error: e?.message ? String(e.message) : 'decode failed' };
  } finally {
    if (res) m!._zx_free(res);
    if (ptr) m!._zx_free(ptr);
  }
}
