import { hasNativeModule } from './notifications';

/**
 * THE CAMERA LEAVES A TRAIL, AND NOBODY WAS SWEEPING IT.
 *
 * `takePictureAsync` and every `manipulateAsync` derived from it write a real
 * file into the app's cache directory and hand back a `file://` URI. Nothing
 * in this app ever deleted one. A single Snap in scanner.tsx leaves up to four
 * behind — the full-resolution original (12 MP with `skipProcessing`, so no
 * downscale either), the reticle crop, a 2x UPSCALE of the original, and the
 * 1400 px JPEG handed to zxing — which is comfortably 10-20 MB per press of a
 * button a driver presses whenever a label will not read.
 *
 * Android reclaims a cache directory only under storage pressure, and "under
 * pressure" on a 32 GB warehouse handset means after it has already started
 * refusing to save the outbox. The failure this produces is therefore not
 * "the phone is a bit full", it is the offline queue failing to write on the
 * one device holding the only copy of a shift.
 *
 * DELIBERATELY UNAWAITABLE AND DELIBERATELY SILENT. This runs on the scan
 * path. A cleanup that can throw, block, or surface an error to a driver is
 * strictly worse than the leak it fixes: nothing here is worth costing anyone
 * a read. Every failure mode degrades to exactly the old behaviour — the file
 * stays, and the OS deals with it eventually.
 */

/** Flips permanently on the first sign the module is not usable on this build. */
let off = false;

type FileCtor = new (uri: string) => { delete: () => void };

let ctor: FileCtor | null = null;

function load(): FileCtor | null {
  if (off) return null;
  if (ctor) return ctor;
  try {
    // See notifications.ts: a bare import of an absent native module is fatal
    // under Metro, try/catch or not. Probe for the native side first.
    if (!hasNativeModule('ExpoFileSystem')) { off = true; return null; }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('expo-file-system');
    if (typeof fs?.File !== 'function') { off = true; return null; }
    ctor = fs.File as FileCtor;
    return ctor;
  } catch {
    off = true;
    return null;
  }
}

/**
 * Delete camera scratch files. Pass anything — undefined, a URI that was never
 * created, a URI already gone — it is all a no-op.
 *
 * Never awaited by callers and never rejects.
 */
export function discard(...uris: Array<string | null | undefined>): void {
  const F = load();
  if (!F) return;
  for (const uri of uris) {
    if (!uri || !uri.startsWith('file://')) continue;
    try {
      new F(uri).delete();
    } catch {
      /**
       * Already gone, never existed, or the platform refused. All three mean
       * the same thing here: there is nothing useful left to do, and there is
       * certainly nothing worth telling the driver.
       */
    }
  }
}
