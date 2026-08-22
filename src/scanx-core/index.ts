/**
 * SCANX-CORE — the in-house decoder, on the phone. THIRD ENGINE (22 Aug, same day).
 *
 * WHAT CHANGED AND WHY, AGAIN. The streaming JS/WASM build below (scanx2.js)
 * fixed the freeze (bounded time, always returns) but a same-day rebuild --
 * scanx2core, native C++, Code 128 + Code 39, tuned against the real corpus
 * (11/20 vs this engine's 8/20) -- could not be shipped the same way: under
 * `node --jitless` (this project's proxy for Hermes' no-JIT execution), its
 * survey phase did not even finish inside an 8s budget at 700px. Full
 * writeup: claude/scanx2core-emscripten-perf-finding-2026-08-22.md. That is
 * not a JS problem to tune away today -- it is compute that belongs compiled.
 *
 * So: scanx2core is wired in as a REAL compiled native Android module (JNI +
 * CMake, see android/app/src/main/cpp/scanx2core/), not as more JS. On
 * Android it runs FIRST, at true native speed (300-1900 ms/frame measured on
 * the real corpus, native x86 -O2 -- ARM release will differ but is real
 * machine code either way, not an interpreter). The streaming engine below
 * stays as the fallback: iOS (no native module there yet), or if the native
 * module is missing from a given build, or if it runs and reports no read.
 * Nothing about the existing streaming path changes; it just moves to
 * second place on Android instead of being the only option.
 *
 * Classic bridge, not TurboModule (RN New Architecture's interop layer still
 * runs `ReactContextBaseJavaModule`/`ReactPackage` unchanged), and classic
 * bridge cannot share raw memory -- so the luma frame crosses as base64 out
 * (`bytesToBase64`, hand-written for the same reason `base64ToBytes` already
 * is: Hermes has neither `Buffer` nor `btoa`) and a JSON string comes back,
 * parsed on the Kotlin side into the map JS receives.
 *
 * ORIGINAL HEADER BELOW, UNCHANGED, for the streaming engine's own history.
 */

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
import { base64ToBytes, bytesToBase64 } from '@/zxing';
import { NativeModules, Platform } from 'react-native';

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
  /** Which engine actually produced this result. Added with the native
   *  module (22 Aug) so a test screen or bug report can tell them apart. */
  engine?: 'native' | 'streaming';
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
 *
 * Since the native module became the primary path on Android, this load is
 * now lazy in truth as well as in name: `decodeBase64Image` only calls it
 * when the native module is absent, or ran and found nothing.
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

/**
 * Warms the STREAMING (fallback) engine only. The native module has no
 * warm-up cost worth paying for — it is a compiled library, not 2 MB of JS
 * to walk — so there is nothing to do for it here.
 */
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
  /** Hard wall-clock cap for the NATIVE engine only, ms. The streaming
   *  engine has no equivalent knob (it is a single scan() call with no
   *  internal budget loop). Default 3000 — plenty for the 300-1900 ms this
   *  engine measures on real photos, short enough that a failed native
   *  attempt still leaves time for the streaming fallback. */
  budgetMs?: number;
}

const FORMAT_NAME: Record<string, string> = {
  CODE_128: 'Code128',
  GS1_128: 'GS1-128',
  CODE_39: 'Code39',
  CODE_93: 'Code93',
  QR_CODE: 'QRCode',
};

type NativeScanxCore = {
  decode: (
    grayBase64: string, width: number, height: number,
    minMargin: number, budgetMs: number,
  ) => Promise<{
    ok: boolean; text: string; format: string; margin: number; modulePx: number;
    chars: number; bandY: number; rotated: boolean; reversed: boolean;
    ms: number; timedOut: boolean; failure: string;
  }>;
  version: () => Promise<string>;
};

function nativeModule(): NativeScanxCore | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules as any).ScanxCore ?? null;
}

export async function nativeVersion(): Promise<string | null> {
  const n = nativeModule();
  if (!n) return null;
  try {
    return await n.version();
  } catch {
    return null;
  }
}

/** Decode one base64-encoded JPEG — the same shape takePictureAsync gives. */
export async function decodeBase64Image(
  b64: string,
  opts: ScanxOptions = {},
): Promise<ScanxResult> {
  const { maxDim = 1400, minMargin = 0, budgetMs = 3000 } = opts;

  const started = Date.now();
  const blank: ScanxResult = {
    ok: false, text: '', format: '', margin: 0, module: 0, chars: 0,
    w: 0, h: 0, sourceW: 0, sourceH: 0, ms: 0,
  };

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return { ...blank, error: 'could not read the photo' };
  }
  if (!bytes.length) return { ...blank, error: 'empty image' };

  // JPEG → luminance, in JS either way: the native module takes the same
  // luma plane the streaming engine does, not the JPEG bytes, so both
  // engines are provably fed byte-identical input (same rationale as the
  // shared base64 reader above).
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

  // NATIVE FIRST (Android only). Real compiled code, not JS — see the header
  // comment for why this exists alongside, not instead of, the engine below.
  const native = nativeModule();
  if (native) {
    try {
      const b64luma = bytesToBase64(luma);
      const r = await native.decode(b64luma, w, h, minMargin, budgetMs);
      if (r.ok) {
        return {
          ok: true,
          text: r.text,
          format: r.format,
          margin: r.margin,
          module: r.modulePx || 0,
          chars: r.chars,
          w, h, sourceW, sourceH,
          ms: Date.now() - started,
          engine: 'native',
        };
      }
      // Native ran cleanly but found nothing (or below minMargin) — fall
      // through to the streaming engine as a second opinion rather than
      // reporting failure on its say-so alone.
    } catch {
      // Module missing from this build, or threw — fall through silently.
      // This is the expected path on any build shipped before this native
      // module lands, not just an error case.
    }
  }

  // STREAMING FALLBACK (iOS always; Android when native found nothing).
  let eng: { m: Engine; api: Api; scanner: number };
  try {
    eng = await load();
  } catch (e: any) {
    return { ...blank, w, h, sourceW, sourceH, ms: Date.now() - started,
             error: e?.message ? String(e.message) : 'scanx did not start' };
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
        engine: 'streaming',
      };
    }
    return {
      ...blank, w, h, sourceW, sourceH, ms: Date.now() - started,
      failure: 'no barcode found',
      engine: 'streaming',
    };
  } catch (e: any) {
    return { ...blank, w, h, ms: Date.now() - started,
             error: e?.message ? String(e.message) : 'decode failed' };
  } finally {
    api.free(buf);
  }
}
