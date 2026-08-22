/**
 * SCANX-CORE — the in-house decoder, on the phone. SECOND ENGINE (22 Aug).
 *
 * WHAT CHANGED AND WHY. The original artifact here (scanx.js, kept beside
 * this file for rollback but no longer imported) was the v0.1.0 correlator:
 * one synchronous `_scanx_decode` call that measured 4-31 SECONDS per real
 * photo in a JIT — which under Hermes (no JIT, facebook/hermes#429) is
 * minutes of blocked JS thread per frame. That is the "Working… / frozen,
 * only the camera preview moves" hang reported on both Lab screens, in Expo
 * Go and in the native APK alike. No JS-side deadline can interrupt a
 * synchronous call, so the engine itself had to go.
 *
 * THE REPLACEMENT is the streaming build recovered from
 * `_scanx-demo/scanner.html` — a later evolution of the same C++ engine
 * (stateful sx_create/sx_scan/sx_reset API, corner-point output, per-code
 * confidence, multi-symbol, Code 39 included). Its WebAssembly was converted
 * to plain JS with Binaryen's wasm2js so Hermes can run it (scanx2.js), and
 * validated against the 20-photo real corpus: every frame returned in
 * 160-820 ms under a JIT, ~2-13 s interpreted, ZERO misreads — where the old
 * build produced garbage text on 18 of 20 photos at minMargin 0 and one
 * photo took 31 s. Full evidence: claude/scanx-engine-recovery-2026-08-22.md.
 *
 * STILL SYNCHRONOUS. A decode still blocks the JS thread while it runs; the
 * difference is it demonstrably RETURNS, in bounded time. Keep frames at or
 * under ~1200 px long edge — cost is roughly linear in pixels.
 *
 * INPUT CHANGED. The old C side decoded the JPEG itself; the streaming build
 * takes a raw 8-bit luminance plane, so the JPEG is decoded here in JS
 * (jpeg-js, ~1 s interpreted at 1200 px) and reduced to luma. Callers hand
 * over the same base64 JPEG as before — the interface below is unchanged.
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
   * Engine confidence for the weakest accepted symbol, 0..1. The streaming
   * engine reports per-code `conf` rather than the old per-character margin;
   * same purpose — how far the read beat the runner-up — same field so every
   * screen built against the old engine keeps working.
   */
  margin: number;
  /** The old engine measured narrow-bar width; the streaming engine does not
   *  report it. Always 0 — shown as such rather than invented. */
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

type Engine = {
  cwrap: (name: string, ret: string | null, args: string[]) => (...xs: any[]) => any;
  UTF8ToString: (ptr: number) => string;
  HEAPU8: Uint8Array;
};

type Api = {
  create: (mode: number, effort: number, mask: number, confirm: number, r: number) => number;
  reset: (h: number) => void;
  scan: (h: number, buf: number, w: number, hgt: number, stateful: number) => number;
  alloc: (n: number) => number;
  free: (p: number) => void;
  version: () => string;
};

let modPromise: Promise<{ m: Engine; api: Api; scanner: number }> | null = null;

/**
 * Loaded once, lazily, and never on the scan path. ~2 MB of generated JS
 * (wasm2js output plus the Emscripten glue), which Hermes walks once here
 * rather than on the first tap.
 */
function load() {
  if (!modPromise) {
    modPromise = (async () => {
      // CommonJS, same as every engine in this app — Metro cannot parse the
      // ES6 build's `import.meta.url`. The factory arrives on module.exports.
      const mod: any = await import('./scanx2.js');
      const factory = (mod?.default ?? mod) as (cfg: object) => Promise<Engine>;
      // The glue insists on fetching its wasm before instantiating; the
      // wasm2js conversion IS the compiled code, so any non-empty buffer
      // satisfies the check and is otherwise ignored.
      const m = await factory({ wasmBinary: new Uint8Array(1) });
      const api: Api = {
        create: m.cwrap('sx_create', 'number', ['number', 'number', 'number', 'number', 'number']),
        reset: m.cwrap('sx_reset', null, ['number']),
        scan: m.cwrap('sx_scan', 'number', ['number', 'number', 'number', 'number', 'number']),
        alloc: m.cwrap('sx_alloc', 'number', ['number']),
        free: m.cwrap('sx_free', null, ['number']),
        version: m.cwrap('sx_version', 'string', []) as () => string,
      };
      // Single-shot mode, balanced effort, mask 0 = every symbology the
      // engine has, confirm in 1 frame (these are stills, not video).
      const scanner = api.create(0, 1, 0, 1, 0);
      if (!scanner) throw new Error('sx_create returned null');
      return { m, api, scanner };
    })();
  }
  return modPromise;
}

export async function warmUp(): Promise<void> {
  await load();
}

export async function version(): Promise<string> {
  const { api } = await load();
  // Suffixed so a bug report can tell the two generations apart — the C
  // version string was never bumped between them.
  return `${api.version()}-streaming`;
}

export interface ScanxOptions {
  /**
   * Long-edge cap. Frames arrive already resized by expo-image-manipulator,
   * so this is a guard, not the resize: anything larger is nearest-neighbour
   * reduced here before the scan, because decode cost is linear in pixels
   * and the JS thread is blocked for the duration.
   */
  maxDim?: number;
  /** Refuse reads below this confidence (0..1). Default 0 HERE, as before:
   *  on a test screen a refusal and a wrong answer look identical unless the
   *  number behind them is visible. Read `margin` and judge it yourself. */
  minMargin?: number;
}

const FORMAT_NAME: Record<string, string> = {
  CODE_128: 'Code128',
  GS1_128: 'GS1-128',
  CODE_39: 'Code39',
  CODE_93: 'Code93',
  QR_CODE: 'QRCode',
};

/** Decode one base64-encoded JPEG — the same shape takePictureAsync gives. */
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

  let eng: { m: Engine; api: Api; scanner: number };
  try {
    eng = await load();
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

  // JPEG → luminance, in JS. jpeg-js is pure JavaScript (no native module,
  // no DOM), which is the whole reason it can run under Hermes at all.
  let luma: Uint8Array;
  let w: number;
  let h: number;
  const sourceW = 0;
  const sourceH = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jpeg = require('jpeg-js');
    const img = jpeg.decode(bytes, { maxMemoryUsageInMB: 256 });
    w = img.width; h = img.height;
    const rgba: Uint8Array = img.data;
    luma = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < luma.length; i += 4, j++) {
      // Rec.601 luma — what a camera's Y plane already carries.
      luma[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
  } catch (e: any) {
    return { ...blank, ms: Date.now() - started,
             error: e?.message ? String(e.message) : 'could not decode the JPEG' };
  }

  // Guard-rail resize; normally a no-op because callers pre-resize natively.
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * s));
    const nh = Math.max(1, Math.round(h * s));
    const small = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, Math.round(y / s));
      for (let x = 0; x < nw; x++) {
        small[y * nw + x] = luma[sy * w + Math.min(w - 1, Math.round(x / s))];
      }
    }
    luma = small; w = nw; h = nh;
  }

  const { m, api, scanner } = eng;
  const buf = api.alloc(luma.length);
  if (!buf) return { ...blank, w, h, ms: Date.now() - started, error: 'out of memory' };

  try {
    m.HEAPU8.set(luma, buf);
    api.reset(scanner);
    const raw = m.UTF8ToString(api.scan(scanner, buf, w, h, 0));
    const parsed = JSON.parse(raw) as {
      codes?: Array<{ format?: string; text?: string; conf?: number }>;
    };
    const codes = (parsed.codes ?? []).filter(
      (c) => c && c.text && (Number(c.conf) || 0) >= minMargin,
    );
    const best = codes[0];
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    if (best && best.text) {
      return {
        ...blank,
        ok: true,
        text: String(best.text),
        format: FORMAT_NAME[best.format ?? ''] ?? String(best.format ?? ''),
        margin: num(best.conf),
        chars: String(best.text).length,
        w, h, sourceW, sourceH,
        ms: Date.now() - started,
      };
    }
    return {
      ...blank, w, h, sourceW, sourceH, ms: Date.now() - started,
      failure: 'no barcode found',
    };
  } catch (e: any) {
    return { ...blank, w, h, ms: Date.now() - started,
             error: e?.message ? String(e.message) : 'decode failed' };
  } finally {
    api.free(buf);
  }
}
