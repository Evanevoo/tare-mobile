/**
 * ScanX — the from-scratch barcode decoder, running inside the JS bundle.
 *
 * WHY IT LOOKS LIKE THIS
 *
 * ScanX is a C++ core. The two normal ways to reach it from this app are a
 * native module (needs a config plugin, a prebuild and an EAS build before the
 * screen will even open) or a WebView (needs react-native-webview, which is not
 * a dependency, which also means a new binary). Both put a store release
 * between us and the first real-world measurement.
 *
 * So the core is compiled to plain JavaScript instead — asm.js, via Emscripten
 * with `-s WASM=0` — and Hermes runs it directly. That makes the decoder an
 * ordinary module in `src/`, which means this whole screen ships over OTA and
 * can be on all thirteen handsets in fifteen minutes.
 *
 * WHAT THAT COSTS
 *
 * Hermes has no JIT. The decode RESULTS are identical to the native build — the
 * same 132-image corpus scores 97.0% either way, because it is the same code —
 * but the TIMINGS here are 10-50x slower than the native SDK will be. Treat
 * this as a correctness and coverage harness. Do not quote its milliseconds.
 *
 * `core.js` is generated. Rebuild it with bindings/rn/build.sh in the scanx
 * repo; do not hand-edit it.
 */

export type ScanXCode = {
  format: string;
  text: string;
  /** x0,y0,x1,y1,x2,y2,x3,y3 in decoded-image pixels (see `w`/`h`). */
  quad: number[];
  conf: number;
  /** Symbols corrected by error correction; -1 for symbologies with no ECC. */
  ecc: number;
  gs1: boolean;
};

export type ScanXResult = {
  /** Core decode time in ms. NOT representative of native — see the note above. */
  ms: number;
  /** Size the decoder actually saw, after downscaling. */
  w: number;
  h: number;
  /** Size of the image handed in. */
  sourceW: number;
  sourceH: number;
  codes: ScanXCode[];
  error?: string;
};

/** Mirrors scanx::Symbology in core/include/scanx/types.hpp. */
export const SYMBOLOGY = {
  Code128: 1, GS1_128: 2, Code39: 3, Code93: 4, Code11: 5, Code32: 6, ITF: 7,
  IATA25: 8, Codabar: 9, MSIPlessey: 10, EAN13: 11, EAN8: 12, EAN5: 13, EAN2: 14,
  UPCA: 15, UPCE: 16, ISBN: 17, DataBar: 18, DataBarExpanded: 19, QRCode: 20,
} as const;

export const PRESETS = {
  /** Everything the core supports. */
  all: [] as number[],
  /** What a cylinder label or a product carton actually carries. */
  retail: [SYMBOLOGY.EAN13, SYMBOLOGY.EAN8, SYMBOLOGY.UPCA, SYMBOLOGY.UPCE, SYMBOLOGY.ISBN],
  /** Asset tags: the formats this fleet prints. */
  assets: [SYMBOLOGY.Code128, SYMBOLOGY.GS1_128, SYMBOLOGY.Code39, SYMBOLOGY.Code93,
    SYMBOLOGY.ITF, SYMBOLOGY.Codabar],
  qr: [SYMBOLOGY.QRCode],
} as const;

export type Effort = 0 | 1 | 2;   // Fast | Balanced | Thorough
export const EFFORT_LABEL: Record<Effort, string> = { 0: 'Fast', 1: 'Balanced', 2: 'Thorough' };

/**
 * A symbology list as a bitmask. It crosses into C as a double because asm.js
 * has no 64-bit integer type; every value we use is well under 2^53 so this is
 * exact, not approximate.
 */
export function maskOf(list: readonly number[]): number {
  return list.reduce((m, v) => m + Math.pow(2, v), 0);
}

type Native = {
  cwrap: (name: string, ret: string | null, args: string[]) => (...a: any[]) => any;
  UTF8ToString: (ptr: number) => string;
  HEAPU8: Uint8Array;
};

let loading: Promise<Native> | null = null;

/**
 * The module is ~400 KB of generated JS. `require` is deferred to first use so
 * nothing pays for it during app start — only opening the test screen does.
 */
function load(): Promise<Native> {
  if (!loading) {
    loading = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const createScanX = require('./core.js');
      return (await createScanX()) as Native;
    })().catch((e) => {
      loading = null;      // let the next attempt retry rather than cache the failure
      throw e;
    });
  }
  return loading;
}

/** Pull the module in ahead of the first scan, so the first tap is not the slow one. */
export async function warmUp(): Promise<void> { await load(); }

export async function coreVersion(): Promise<string> {
  const M = await load();
  return M.cwrap('sx_version', 'string', [])();
}

/**
 * Base64 → bytes.
 *
 * Hermes has no `atob` and no `Buffer`, and pulling a polyfill in for eight
 * lines of table lookup is not worth a dependency.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  // Tolerate a data: prefix, whitespace and missing padding — every source of
  // base64 in this app spells it slightly differently.
  const s = b64.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/=]/g, '');
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v === 255) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

export type DecodeOptions = {
  /** Longest side the decoder sees. Cost is ~linear in pixel count. */
  maxDim?: number;
  effort?: Effort;
  /** Symbology allow-list. Empty/omitted means everything. */
  symbologies?: readonly number[];
  /** Also try a light-on-dark pass. Doubles the work. */
  inverted?: boolean;
};

/**
 * Decode a JPEG or PNG (as base64) and return everything found.
 *
 * The bytes go straight into the module's heap and are freed in a `finally`, so
 * a throw inside the decoder cannot leak the frame.
 */
export async function decodeBase64Image(
  b64: string,
  opts: DecodeOptions = {},
): Promise<ScanXResult> {
  const M = await load();
  const bytes = base64ToBytes(b64);
  if (!bytes.length) {
    return { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [], error: 'empty image' };
  }

  const alloc = M.cwrap('sx_alloc', 'number', ['number']);
  const free = M.cwrap('sx_free', null, ['number']);
  const decode = M.cwrap('sx_decode_image', 'number',
    ['number', 'number', 'number', 'number', 'number', 'number']);

  const ptr: number = alloc(bytes.length);
  if (!ptr) {
    return { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [], error: 'out of memory' };
  }
  try {
    // Re-read HEAPU8 on every call: ALLOW_MEMORY_GROWTH can replace the buffer
    // and a cached view would be detached.
    M.HEAPU8.set(bytes, ptr);
    const json = M.UTF8ToString(decode(
      ptr,
      bytes.length,
      opts.maxDim ?? 900,
      opts.effort ?? 1,
      maskOf(opts.symbologies ?? []),
      opts.inverted ? 1 : 0,
    ));
    return JSON.parse(json) as ScanXResult;
  } catch (e: any) {
    return {
      ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [],
      error: e?.message ? String(e.message) : 'decode failed',
    };
  } finally {
    free(ptr);
  }
}
