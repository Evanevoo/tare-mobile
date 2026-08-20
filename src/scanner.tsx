import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  CameraView, useCameraPermissions, scanFromURLAsync, type BarcodeType,
} from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { T, Icon, ICON, wash } from '@/ui';
import { useStore } from './store';
import { candidatesFrom, matchKnown, recognizeText, OcrUnavailable } from './ocr';
import { decodeBase64Image as zxDecode, type FormatName as ZXFormatName } from './zxing';
import { key } from './scan-match';
import { RETICLE, withinReticle } from './reticle';
import { discard } from './tmpfiles';

/**
 * The one camera surface.
 *
 * Every screen that reads a barcode goes through this component, because every
 * lesson about scanning in a yard was paid for once and should be paid for
 * once only. The previous generation of this app earned these the hard way:
 *
 * DOUBLE-READ CONFIRM. A live decoder fires on half-read frames — code39 in
 * particular happily yields a truncated string off a motion-blurred label. A
 * code is only accepted after the SAME value arrives twice within a short
 * window, which costs ~100ms and removes almost every misread.
 *
 * COOLDOWN. After acceptance, the same code is ignored for 2.5s, or a label
 * sitting in frame fires ten times a second.
 *
 * POSITION FILTER. The decoder reads the whole frame and cannot be told not
 * to, so a code found well outside the reticle is refused after the fact, on
 * the bounds the read arrives with. It fails open wherever those bounds are
 * missing or unreliable, which on iOS is most reads — see src/reticle.ts.
 *
 * READY GATE. `onBarcodeScanned` is not attached until the native camera
 * reports ready — attaching earlier crashes some iOS devices mid-session
 * teardown.
 *
 * GRACEFUL CLOSE. The view deactivates before unmount (`closing`), because
 * tearing down an AVCaptureSession that is still delivering frames is a
 * known iOS crash.
 *
 * PERIODIC REFOCUS, PLUS TAP TO FORCE ONE. Continuous autofocus-on locks focus
 * at the wrong distance on some phones, so the lens is nudged off and back on
 * every second or so instead — the legacy app's trick, kept, and, since
 * 2026-08-18, applied on both platforms (see PERIODIC REFOCUS below). This
 * used to be iOS-only via a default-off/tap-to-pulse path, which — checked
 * directly against the legacy app — was backwards: iOS never actually
 * refocused on its own, only when someone tapped first. Tapping the preview
 * still forces one extra cycle on demand and, once it settles, fires the
 * still-frame read, so the one gesture a driver reaches for when a label will
 * not go does both halves of what it needs to. See `tapToRead`.
 *
 * TORCH AFTER FAILURE. If the camera has been open for a while with nothing
 * read, the torch button starts glowing as a hint; frost, shadow and dented
 * labels are usually a light problem.
 *
 * STILL-FRAME FALLBACK. On builds that include ML Kit (EAS dev/production
 * builds — not Expo Go), a "Snap" button appears when live decoding is
 * struggling: it takes a photo and hands it to ML Kit, which reads damaged
 * labels the live pipeline misses. The module is loaded lazily and the
 * feature simply does not appear where it is not installed.
 *
 * READ TEXT. One tier below Snap, for a label whose bars are destroyed but
 * whose printed number is still legible. On-device OCR (ML Kit again), and a
 * result is only accepted if it matches something already in this org's
 * downloaded data. See src/ocr.ts — that file carries the reasoning, and the
 * reasoning is the point.
 */

/**
 * THE ROOT MUST NEVER BE ZERO-HEIGHT.
 *
 * A camera preview has no intrinsic size — it is whatever box you put it in.
 * Mounted inside a full-screen <Modal> with no height and no flex, this View
 * laid out at exactly 0px and the driver saw the Modal's own white backdrop:
 * the "scan opens a white screen" bug. Nothing threw, nothing logged, the
 * camera really was running behind a zero-pixel window.
 *
 * flexGrow makes it fill a flex parent (a Modal, a screen). flexBasis 'auto'
 * — NOT the 0% that `flex: 1` implies — means an explicit height from a
 * caller still wins, which is what the two inline 230/260px scanners rely on.
 * So one default serves both shapes and neither call site has to know.
 */
const FILL = { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', backgroundColor: '#000' } as const;

/**
 * THE POSITION FILTER IS ON FOR iOS ONLY, AND THAT IS A STATEMENT ABOUT WHAT
 * HAS BEEN TESTED, NOT ABOUT WHAT WORKS.
 *
 * `withinReticle` fails open on every uncertainty it can SEE — no bounds, a
 * zero-sized box, an unmeasured view, a centre outside the frame. Android has
 * one it cannot see, and it is the dangerous kind, because the numbers look
 * perfectly reasonable.
 *
 * expo-camera's Android path builds its bounding box from ML Kit corner points
 * and, in one of its rotation branches, swaps x and y on the corners while
 * leaving the box that was derived from them alone. A read that came back
 * transposed still lands inside 0..1 and still has a plausible size, so every
 * guard in reticle.ts passes it through to the comparison — and then the
 * comparison is asked the wrong question.
 *
 * Work out what that costs and it is not evenly spread. The box is 78% of the
 * frame wide and 28% tall, so the horizontal test accepts almost everything
 * and the vertical test is the one with teeth. Transposed, a label sitting
 * legitimately off to one side — cx 0.8, comfortably inside the outline — is
 * judged as cy 0.8 and refused. A label in the middle survives, so this would
 * not show up as "the scanner is broken". It would show up as a driver who
 * has to re-aim more than they used to and never says anything about it.
 *
 * That is the exact failure this filter was written to be worth avoiding, and
 * on the platform most of the fleet carries. There is no Android device on
 * this desk to check it against, and the honest thing to do with an untested
 * guess about somebody's working day is not to ship it. iOS gets the filter
 * now, because that is what is in hand and being tested on.
 *
 * TO TURN IT ON FOR ANDROID: open the scanner on an Android phone, put a
 * label near the left or right edge of the outline, and confirm it still
 * reads. If it does, this becomes `true`. Nothing else has to change —
 * `withinReticle` is already platform-neutral and its tests already cover the
 * Android shapes.
 */
const POSITION_FILTER = Platform.OS === 'ios';

/**
 * expo-camera's symbology names to zxing's, for the Snap fallback.
 *
 * THE TWO LIBRARIES DISAGREE ON EVERY NAME AND NEITHER WILL SAY SO.
 * expo wants lowercase `upc_a`; zxing wants `UPC-A`. Hand zxing a name it does
 * not recognise and it does not throw — the format simply never matches, and
 * the fallback quietly reads nothing forever. That is the identical failure
 * shape as the `regionOfInterest` key that sat dead in this file's scanner
 * settings through two entire codebases, so it gets a real table rather than a
 * `.toUpperCase()` and a hope.
 *
 * `itf14` maps to plain ITF: zxing has no ITF-14 variant, and ITF-14 is an ITF
 * symbol carrying fourteen digits. Anything unmapped is dropped rather than
 * guessed at — a narrower format list still reads, a wrong one cannot.
 */
const ZX_FORMAT: Partial<Record<string, ZXFormatName>> = {
  code128: 'Code128', code39: 'Code39', code93: 'Code93', codabar: 'Codabar',
  itf14: 'ITF', ean13: 'EAN-13', ean8: 'EAN-8', upc_a: 'UPC-A', upc_e: 'UPC-E',
  qr: 'QRCode', pdf417: 'PDF417', datamatrix: 'DataMatrix', aztec: 'Aztec',
};

function zxFormatsFor(types: readonly BarcodeType[]): ZXFormatName[] {
  const out: ZXFormatName[] = [];
  for (const t of types) {
    const m = ZX_FORMAT[String(t).toLowerCase()];
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

// Lowercase names are REQUIRED on iOS — uppercase silently matches nothing.
const DEFAULT_TYPES: BarcodeType[] = [
  'code128', 'code39', 'code93', 'codabar', 'itf14',
  'ean13', 'ean8', 'upc_a', 'upc_e', 'qr', 'pdf417', 'datamatrix', 'aztec',
];

/**
 * THERE IS NO REGION OF INTEREST, AND THERE NEVER WAS.
 *
 * Both this file and the legacy Android app it was ported from used to pass
 * `regionOfInterest` inside `barcodeScannerSettings`, with a comment explaining
 * that it stopped the decoder "catching" an order-number barcode an inch away
 * from the one being aimed at. It never did anything. expo-camera's
 * `BarcodeSettings` is `{ barcodeTypes }` and nothing else — grep the installed
 * package, JS and native both, and `regionOfInterest` does not appear. The key
 * was silently dropped and the decoder always read the whole frame.
 *
 * It survived review in two codebases because it was spread in conditionally —
 * `...(reticle ? { regionOfInterest } : {})` — and TypeScript exempts a
 * conditional spread from excess-property checking. Written as a plain property
 * it would not have compiled.
 *
 * That matters beyond a dead line: the legacy app scanned well in the field for
 * years WITH this doing nothing, which means the things that actually earned
 * that reputation are the focus handling and the deferred mount below, not a
 * decode-area constraint. Keeping the dead key would have told the next person
 * a real safeguard was in place while the reticle quietly shrank to a band far
 * smaller than what is actually being decoded.
 *
 * All of that is still true, and the decoder still reads every pixel of every
 * frame. What has changed is what happens afterwards.
 *
 * WHERE A CODE WAS FOUND IS A LEVER; WHERE IT IS LOOKED FOR IS NOT.
 * Drivers reported the symptom the dead key was supposed to prevent — a code
 * from outside the outline landing in the list — and the fix is not to
 * constrain the decode, because nothing in this stack lets us. It is to
 * decline the answer. `onBarcodeScanned` hands back a `bounds` rectangle in
 * the view's own units alongside the data, so a read whose centre sits well
 * outside the reticle can be dropped after the fact. `withinReticle` in
 * src/reticle.ts is that test, and its comment carries the part that matters:
 * it fails open on every uncertainty, and on iOS it will usually have no
 * bounds to weigh at all, because the ZXing path most of this fleet's code39
 * labels take does not report any.
 *
 * So the reticle is still, honestly, an aiming guide — it does not narrow what
 * is decoded, only what is accepted, and only when the frame tells us enough
 * to be sure. Narrowing the decode itself remains possible in exactly one
 * place: cropping a still frame before handing the picture to a decoder, the
 * Snap path below, because that is where the pixels are ours to cut.
 */

export interface ScannerProps {
  /** Called once per accepted read. Already trimmed and uppercased. */
  onCode: (code: string) => void;
  /**
   * Called every time a decoded frame matches a code already accepted within
   * `cooldownMs` — i.e. every time the code is real and correctly read, just
   * too soon to fire again. Fires on EVERY such frame (several a second while
   * the phone holds steady over a barcode still in cooldown), not once — a
   * caller that wants a single "still alive" tick needs its own once-per-
   * window guard, the same shape `deliver` already uses for `lastAccepted`.
   * Distinct from a rejected read (`accept` returning false) or an outbox-
   * level "already scanned on this order," neither of which reaches here.
   */
  onDuplicate?: (code: string) => void;
  /** Reject values that cannot be right here (wrong shape, wrong length). */
  accept?: (code: string) => boolean;
  /** Narrow the symbologies to cut false positives — e.g. ['code39']. */
  types?: BarcodeType[];
  style?: StyleProp<ViewStyle>;
  /** Content drawn over the preview (headers, scrims). */
  children?: React.ReactNode;
  /** Show the aiming reticle. Default true. */
  reticle?: boolean;
  /** Called when the user asks to close (only if provided — else no button). */
  onClose?: () => void;
  /** Same code accepted again after this many ms. Default 2500. */
  cooldownMs?: number;
  /**
   * Extra clearance above `insets.bottom` for this component's own bottom-
   * right control stack (torch, zoom, Snap, Read text). A caller whose own
   * overlay (passed via `children`) occupies the bottom of the screen — a
   * full-bleed camera with a readout/action bar over it, e.g. scan.tsx —
   * sets this to that overlay's height so the two don't sit on top of each
   * other. Default 0: unchanged for every other caller.
   */
  controlsBottomInset?: number;
  /**
   * Focus once and then leave the lens alone.
   *
   * The legacy app carried the same flag and the same one-line reason: it
   * "avoids blur when pointing at barcode — use for customer barcode scanning".
   * The periodic refocus below is right for a driver sweeping a pallet at
   * changing distances; it is wrong for somebody holding a phone still over a
   * printed receipt, because a lens told to re-acquire every second spends a
   * good part of every second hunting, and the frames it delivers mid-hunt are
   * exactly the soft ones a long Code 39 label cannot survive. Applies on both
   * platforms — see PERIODIC REFOCUS below.
   */
  steadyFocus?: boolean;
}

export function Scanner({
  onCode, onDuplicate, accept, types, style, children, reticle = true, onClose, cooldownMs = 2000,
  controlsBottomInset = 0, steadyFocus = false,
}: ScannerProps) {
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [struggling, setStruggling] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  /** Why the last "Read text" tap produced nothing — shown under the button. */
  const [aiMiss, setAiMiss] = useState<string | null>(null);
  /** off for a beat = "refocus now" to the native camera. Drives `autofocus`
      below on both platforms — see PERIODIC REFOCUS. */
  const [focusOff, setFocusOff] = useState(false);
  const [mounted, setMounted] = useState(Platform.OS !== 'android');
  /**
   * EMBEDDED OR FULL-SCREEN — measured, not declared.
   *
   * This one component serves two rooms: the full-bleed modal camera
   * (scan.tsx, Locate, Home) and a ~260px box inside a form (Add, Batch,
   * Search). The safe-area insets and the vertical control stack are right
   * for the first and actively wrong for the second — inside a form box
   * there is no notch or gesture bar to clear, so adding insets.bottom
   * shoved torch/zoom INTO the middle of the little viewfinder, right where
   * the driver was aiming ("the buttons are in the way"). No phone renders
   * a full-screen camera under 420px tall, and no form box here is over
   * 260, so the frame's own measured height is the honest answer. State set
   * at most once per mount (onLayout fires once for a fixed-height box), so
   * the native camera never remounts over it.
   */
  const [embedded, setEmbedded] = useState(false);

  const cam = useRef<CameraView | null>(null);
  /**
   * The preview's own size, which is the space `bounds` is reported in.
   *
   * A ref rather than state: this is read inside a callback that fires several
   * times a second and is never rendered, and putting it in state would remount
   * the native camera on every rotation of the layout pass. It stays zero until
   * the first layout, which `withinReticle` treats as "no opinion".
   */
  const viewSize = useRef({ width: 0, height: 0 });
  const lastAccepted = useRef<Record<string, number>>({});
  const pending = useRef<{ code: string; at: number } | null>(null);
  const lastReadAt = useRef<number>(Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!perm?.granted) requestPerm();
    // The torch hint and the Snap fallback both key off "open a while with
    // nothing read" — checked on a slow tick, not per frame.
    const t = setInterval(() => {
      if (alive.current) setStruggling(Date.now() - lastReadAt.current > 5000);
    }, 1000);
    return () => { alive.current = false; clearInterval(t); };
  }, [perm?.granted]);

  /**
   * DEFERRED MOUNT (Android only).
   *
   * Ported from the legacy Android app, which mounted `CameraView` a beat after
   * permission was granted rather than on the same tick, specifically to avoid a
   * crash on some Android devices opening the camera immediately after layout.
   * iOS never needed the delay, so it stays mounted immediately there.
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!perm?.granted) { setMounted(false); return; }
    const t = setTimeout(() => { if (alive.current) setMounted(true); }, 150);
    return () => clearTimeout(t);
  }, [perm?.granted]);

  /**
   * PERIODIC REFOCUS — BOTH PLATFORMS.
   *
   * Checked directly against the legacy app on 2026-08-18 while chasing "the
   * autofocus never focuses, it's just blurry": gas-cylinder-android's
   * ScanArea.tsx starts its `autofocusMode` at 'on' and runs this exact
   * toggle — off for 180ms, back on — on an unconditional interval, for BOTH
   * platforms. Nothing in it is Android-only there.
   *
   * This file had it backwards. The toggle below ran on Android only; iOS
   * instead defaulted `autofocus` to 'off' permanently and only turned it on
   * for a 350ms pulse when the driver tapped the preview (`refocus`, below).
   * That means iOS autofocus never ran on its own — it needed a tap first,
   * every time — which is worse than what it was written to fix, and matches
   * the reported symptom exactly.
   *
   * One flag (`focusOff`) now drives `autofocus` on both platforms: off for a
   * beat forces most camera stacks to treat it as "focus again now" rather
   * than "stop focusing," same as it always did for Android alone. `cycleRef`
   * lets the manual tap (`refocus`) trigger the identical cycle instead of a
   * second, separate mechanism.
   *
   * REPORTED LIVE AGAINST LOCATE ON ANDROID (2026-08-18): "keeps focusing on
   * and off, never lands sharp." First response here widened the interval to
   * 2000ms on a theory that expo-camera's toggle is a heavier operation on
   * Android than whatever the legacy app's native module did — that theory
   * does not survive a real check. gas-cylinder-android/ScanArea.tsx renders
   * the SAME `CameraView` from the SAME `expo-camera` (~17.0.9 there,
   * ~17.0.7 here — not a meaningful difference), on the same React Native
   * 0.81.5 with the same `newArchEnabled=true`, running this exact toggle —
   * 600ms settle, kicks at +1400ms and +2500ms, then every 1000ms, 180ms
   * off — and by every report it worked in the field for years. There is no
   * library-level reason this file's copy of that same toggle should behave
   * worse. So the interval is reverted to the legacy numbers below, in full,
   * rather than a guessed one.
   *
   * What that leaves: either this exact mechanism has the same "never quite
   * lands" character in the legacy app too and nobody happened to stress it
   * on a screen like Locate — moving continuously along a rack, camera held
   * at varying, often close distances — the way it's being stressed now; or
   * something about the specific device this was tested on (model, Android
   * version, camera hardware) behaves differently than whatever ran the
   * legacy app. Neither is visible from source, and this file cannot see a
   * camera. If Locate still hunts on a byte-for-byte copy of the mechanism
   * that shipped in the legacy app, the next step is comparing against the
   * actual device and Android version in hand, not another guessed constant.
   */
  const cycleRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!ready) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cycle = () => {
      setFocusOff(true);
      // Tracked, not fire-and-forget: without this the inner timer outlives the
      // component, and on a fast close/reopen the stale one lands in the new
      // session and knocks focus off at random.
      timers.push(setTimeout(() => { if (alive.current) setFocusOff(false); }, 180));
    };
    cycleRef.current = cycle;

    // Let the preview settle before touching focus at all, or the first second
    // of every scan is a visible glitch.
    timers.push(setTimeout(cycle, 600));
    if (steadyFocus) return () => timers.forEach(clearTimeout);

    // Sweeping a pallet: keep re-acquiring. The later kicks are offset off the
    // interval's own ticks (600+1400, 600+2500 against a 1000ms period) so two
    // cycles never fire together — overlapping cycles cancel each other's
    // off-window early and the refocus silently does not happen.
    timers.push(setTimeout(cycle, 2000), setTimeout(cycle, 3100));

    /**
     * STOP HUNTING WHEN IT IS ALREADY READING.
     *
     * Reported from the yard, 19 Aug: "the focus keeps turning on and off
     * repeatedly." It does — once a second, visibly, by design, because that
     * is what legacy did and it is genuinely right for a driver sweeping a
     * pallet at changing distances.
     *
     * It is wrong the rest of the time. A lens told to re-acquire every second
     * spends a good part of every second hunting, and the frames it delivers
     * mid-hunt are exactly the soft ones a long Code 39 label cannot survive.
     * So the refocus that exists to help find a barcode was firing hardest
     * while barcodes were already being found, making the picture worse and
     * looking broken while it did it.
     *
     * `steadyFocus` was the existing answer and it is too blunt: it is a prop
     * set per screen, so it cannot know that THIS driver, right now, is
     * reading fine. The clock can. A read in the last three seconds means the
     * lens is where it needs to be, so leave it alone; go quiet, and resume
     * hunting only once the reads stop.
     *
     * Net effect: pulsing while searching, still while working. Which is what
     * the periodic refocus was always trying to be.
     */
    const iv = setInterval(() => {
      const since = Date.now() - lastReadAt.current;
      if (since < 3000) return;   // it is working; do not disturb the lens
      cycle();
    }, 1000);
    return () => { timers.forEach(clearTimeout); clearInterval(iv); };
  }, [ready, steadyFocus]);

  /**
   * Stable identity, because this is a prop on a native view.
   *
   * Built inline, a fresh object literal every render re-configured the native
   * barcode scanner on each of the twice-a-second focus re-renders above.
   */
  const BARCODE_SETTINGS = useMemo(
    () => ({ barcodeTypes: types ?? DEFAULT_TYPES }),
    [types],
  );

  const deliver = useCallback((raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    if (accept && !accept(code)) return;

    const now = Date.now();
    if (lastAccepted.current[code] && now - lastAccepted.current[code] < cooldownMs) {
      // A correct read, just too soon — the camera is alive and reading
      // exactly what it is pointed at. See `onDuplicate` above; a caller
      // that does nothing with this is exactly as correct as before.
      onDuplicate?.(code);
      return;
    }

    // The double-read confirm. First sighting arms; a second sighting of the
    // same value fires. A different value re-arms — a misread never gets a
    // partner, so it never fires.
    //
    // WHY THIS WINDOW IS 1200ms AND NOT 450ms.
    //
    // The autofocus cycle deliberately drops the lens for 180ms every second
    // (see refocus() — legacy's numbers, byte for byte). A meaningful share
    // of frames are therefore soft by design. Legacy accepted a barcode on
    // ONE good frame with a 175ms hold that only upgraded to a longer
    // candidate (ScanArea.tsx:181-254). We demanded two byte-identical reads
    // inside 450ms — which a single focus hunt is enough to break. Same
    // autofocus code, radically worse outcome, and it presents to the driver
    // as "the autofocus never lands."
    //
    // 1200ms is wide enough that two sightings separated by one focus hunt
    // still pair, while a stray misread still never finds a partner: a wrong
    // read has to be wrong the SAME WAY twice to get through, which is what
    // the confirm was actually protecting against.
    const p = pending.current;
    if (!p || p.code !== code || now - p.at > 1200) {
      pending.current = { code, at: now };
      return;
    }

    pending.current = null;
    lastAccepted.current[code] = now;
    lastReadAt.current = now;
    setStruggling(false);
    onCode(code);
  }, [accept, cooldownMs, onCode, onDuplicate]);

  /**
   * The still-frame path, for labels the live decoder cannot crack.
   *
   * THIS USED TO CALL ML KIT AND THE BUTTON NEVER APPEARED.
   * `@react-native-ml-kit/barcode-scanning` resolves its native side through
   * `NativeModules.BarcodeScanning`, and when that is missing the package
   * substitutes a Proxy whose every property access THROWS. `loadMlkit`
   * probed it with `typeof scanner?.scan === 'function'` — which is a property
   * access — so the probe threw, the catch set the module to null, and the
   * Snap button was never rendered at all. Not a subtle bug: the feature was
   * shipped twice and had never once run on a device.
   *
   * The native module is missing because that package is a plain old-
   * architecture React Native module (`ReactPackage`, no `codegenConfig`,
   * peer range stopping at RN 0.x) and this app runs `newArchEnabled: true` on
   * SDK 54 / RN 0.81. Rather than fight the linking, use the decoder that is
   * already in the build: expo-camera ships `scanFromURLAsync`, first-party,
   * new-architecture native, and doing precisely this job — decode a barcode
   * out of a still image file. One fewer dependency and it actually runs.
   *
   * MULTIPLE PASSES, CHEAPEST FIRST. A still frame can be re-read as many
   * times as we like, which is the one real advantage a photo has over the
   * video stream, and the old code used it twice. Now: the reticle crop, then
   * the full frame, then the full frame upscaled 2× — a small, low-contrast
   * code that resolves at no scale often resolves when the bars are wider than
   * one pixel. Every pass is a real decoder either resolving or failing, so
   * more attempts can only find a barcode that was genuinely in the picture.
   */
  const snap = useCallback(async () => {
    if (!cam.current || snapBusy) return;
    setSnapBusy(true);
    const scratch: string[] = [];
    try {
      // shutterSound: false — legacy passed this on every capture
      // (gas-cylinder-mobile ScanArea.tsx:520). Without it the phone plays a
      // camera shutter in a customer's yard on every Snap.
      const photo = await cam.current.takePictureAsync({ quality: 0.9, shutterSound: false, skipProcessing: true });
      if (!photo?.uri) return;
      // Every URI below is a real file in the cache directory. See tmpfiles.ts
      // for what happens to a warehouse handset when nobody deletes them.
      scratch.push(photo.uri);

      /**
       * CROP TO THE RETICLE BEFORE ML KIT EVER SEES THE FRAME.
       *
       * `takePictureAsync` captures the WHOLE scene, not just what the
       * reticle is drawn over — a competitor's shipping label, a second
       * barcode on the same document, anything else in frame reads exactly
       * as cleanly as the one the driver aimed at. `kit.scan` below used to
       * take `results.find(r => r?.value?.trim())` — the first barcode ML
       * Kit found ANYWHERE in the photo, in whatever order its own internal
       * scan returns them — which is how a driver photographing a Sales
       * Receipt with a courier sticker in the corner of frame got that
       * sticker's barcode back as "a completely random number." The reticle
       * is the only signal of intent this component has; cropping to it
       * (the exact box drawn on screen — see RETICLE above) is what makes
       * Snap read what the driver was actually pointing at.
       *
       * Falls back to the uncropped photo if the manipulator throws or the
       * photo reports no dimensions — a wrong-but-honest full-frame Snap
       * beats losing the fallback path entirely.
       */
      /*
       * THE CROP TAKES A MARGIN, AND THAT MARGIN IS NOT COSMETIC.
       *
       * Every linear symbology needs a QUIET ZONE — Code 128 wants about ten
       * module widths of blank either side — and a decoder that cannot see one
       * refuses the symbol outright rather than reading it short. Cropping
       * exactly to the drawn reticle therefore fails hardest on the driver who
       * aimed BEST: fill the box as asked, and the bars run to the crop edge
       * with no quiet zone left. Found on the test screen (2026-08-19) after
       * three engines returned nothing on a perfectly legible packing slip,
       * and it has been latent in this path the whole time.
       *
       * 8% of the frame either side clears ten modules comfortably for the
       * labels in this fleet, while still excluding the corners — which is
       * where the stray courier sticker that motivated cropping at all lives.
       */
      const PAD = 0.08;
      let uri = photo.uri;
      if (reticle && photo.width && photo.height) {
        try {
          const l = Math.max(0, RETICLE.left - PAD);
          const t = Math.max(0, RETICLE.top - PAD);
          const r = Math.min(1, RETICLE.left + RETICLE.width + PAD);
          const b = Math.min(1, RETICLE.top + RETICLE.height + PAD);
          const cropped = await ImageManipulator.manipulateAsync(photo.uri, [{
            crop: {
              originX: Math.round(photo.width * l),
              originY: Math.round(photo.height * t),
              width: Math.round(photo.width * (r - l)),
              height: Math.round(photo.height * (b - t)),
            },
          }], { compress: 1 });
          uri = cropped.uri;
          scratch.push(cropped.uri);
        } catch { /* fall through with the uncropped photo */ }
      }

      const wanted = types ?? DEFAULT_TYPES;
      const tryScan = async (imgUri: string) => {
        try {
          const results = await scanFromURLAsync(imgUri, wanted);
          return results?.find((r) => r?.data?.trim())?.data?.trim() ?? null;
        } catch {
          // One pass failing is not the operation failing — a later pass on a
          // different rendering of the same photo may still resolve.
          return null;
        }
      };

      let code = await tryScan(uri);

      /**
       * A CROP THAT MISSES IS NOT THE SAME FAILURE AS A BAD PHOTO.
       *
       * The crop above exists to keep Snap from reading a stray barcode
       * elsewhere in frame, but the reticle is a fixed band sized for a
       * cylinder label, not for every document a driver photographs. A long
       * order-number barcode running close to the edges of a Sales Receipt —
       * exactly the shape that sent this fix in — can extend past the
       * reticle's width and get cut mid-bar by the crop, which ML Kit then
       * correctly reports as "no barcode here" rather than a misread. That
       * is a real, previously silent failure mode: the crop succeeded, so the
       * old code never fell through to the uncropped photo it already had in
       * hand. One more ML Kit pass, only paid in this failure case, and a
       * barcode found in the full frame is still exactly what was in the
       * photo, never a guess.
       */
      if (!code && uri !== photo.uri) {
        code = await tryScan(photo.uri);
      }

      /**
       * LAST PASS: the same frame, twice the size.
       *
       * A code printed small, or photographed from far enough back that each
       * bar lands on roughly one pixel, gives a decoder nothing to work with —
       * the edges it needs are averaged away by the sensor. Upscaling does not
       * add information, but it does give the decoder's edge detection room to
       * find the transitions that are there, and in practice it is the single
       * cheapest thing that turns a stubborn label into a read. Paid only when
       * both earlier passes have already failed.
       */
      if (!code && photo.width && photo.height) {
        try {
          const big = await ImageManipulator.manipulateAsync(
            photo.uri,
            [{ resize: { width: Math.round(photo.width * 2) } }],
            { compress: 1 },
          );
          scratch.push(big.uri);
          code = await tryScan(big.uri);
        } catch { /* the two passes above were the real attempts */ }
      }

      /**
       * LAST RESORT: A DIFFERENT DECODER, NOT A DIFFERENT PICTURE.
       *
       * Every pass above is expo-camera's decoder looking at another
       * rendering of the same frame. When all three fail, more renderings of
       * the same pixels through the same engine is not where the next read
       * comes from — a different engine is.
       *
       * zxing-cpp, running as asm.js (src/zxing), applies a LOCAL ADAPTIVE
       * THRESHOLD before decoding, and that is the specific thing this path
       * has been missing. Measured against replicas of this fleet's own
       * paperwork: a shadow edge across a Code 128 symbol is unreadable by
       * expo-camera's decoder at EVERY resolution from 1 to 8 pixels per bar,
       * and cropping tighter, CLAHE and unsharp masking all fail to recover
       * it — while thresholding each pixel against its own neighbourhood
       * recovers it completely. Shadows across paperwork on a truck bed or a
       * shop bench are not an edge case here; they are most of the day.
       *
       * IT IS SLOW, AND THAT IS ACCEPTABLE **HERE AND ONLY HERE**. Hermes has
       * no JIT, so this costs several hundred milliseconds to a couple of
       * seconds. It never runs on the live video path, and it only runs after
       * three faster attempts have already come back empty — at which point
       * the alternative on offer is not a quicker read, it is typing the
       * number in by hand.
       *
       * Guarded and non-fatal: a decoder that fails to load must degrade Snap
       * back to exactly what it was, never break it.
       */
      if (!code) {
        try {
          const small = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: 1400 } }],
            { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true },
          );
          scratch.push(small.uri);
          if (small.base64) {
            const zx = await zxDecode(small.base64, {
              maxDim: 1400,
              effort: 1,
              binarize: true,
              maxResults: 1,
              // Same symbologies the live decoder was told to look for, so
              // Snap cannot return a format the caller would have rejected.
              formats: zxFormatsFor(wanted),
            });
            const hit = zx.codes.find((c) => c.text?.trim())?.text?.trim();
            if (hit) code = hit;
          }
        } catch { /* Snap keeps whatever the native passes found */ }
      }

      if (code) {
        // A still frame read deliberately bypasses the double-read confirm —
        // a full-resolution photo does not produce the partial reads that a
        // motion-blurred video frame does.
        code = code.toUpperCase();
        if (!accept || accept(code)) {
          lastAccepted.current[code] = Date.now();
          lastReadAt.current = Date.now();
          setStruggling(false);
          onCode(code);
          return;
        }
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      if (alive.current) setSnapBusy(false);
      // After the read is resolved and the driver has been answered, never
      // before: the decode above still holds these URIs.
      discard(...scratch);
    }
  }, [accept, onCode, snapBusy, reticle, types]);

  /**
   * READ TEXT — the OCR still-frame fallback, one tier below Snap.
   *
   * Reached only by hand, after Snap has already failed on this label: the
   * bars are gone, but the number printed underneath them is still legible.
   * ML Kit reads that number on the device — no API key, no network, no cost
   * per tap, works in a yard with no signal. It replaced a version that sent
   * the photo to a paid vision API through the server, which is deleted; that
   * design failed on all three counts at once, and the yard-with-no-bars case
   * is exactly when a driver needs this.
   *
   * WHAT MAKES THIS SAFE IS THE LOOKUP, NOT THE OCR. Whatever text comes
   * back, only a candidate that is already in this org's downloaded data is
   * accepted. Everything else is discarded as if the camera had read nothing.
   * A misread therefore costs a second tap, never a wrong cylinder on
   * somebody's invoice. src/ocr.ts explains why that boundary is where it is.
   */
  const readText = useCallback(async () => {
    if (!cam.current || aiBusy) return;
    setAiBusy(true);
    setAiMiss(null);
    const scratch: string[] = [];
    try {
      // shutterSound: false — legacy passed this on every capture
      // (gas-cylinder-mobile ScanArea.tsx:520). Without it the phone plays a
      // camera shutter in a customer's yard on every Snap.
      const photo = await cam.current.takePictureAsync({ quality: 0.9, shutterSound: false, skipProcessing: true });
      if (!photo?.uri) return;
      scratch.push(photo.uri);

      /**
       * THE ORG'S OWN DATA, WHICH IS THE ONLY THING AN OCR RESULT IS WEIGHED
       * AGAINST. Asset barcodes and, for every customer, the code printed on
       * their card and their account number — the two spellings a customer can
       * legitimately arrive as (see scan-match.ts). Uppercased, because
       * everything in this app compares uppercased.
       *
       * ONE ENTRY PER SPELLING THAT IS ACTUALLY DIFFERENT. `matchKnown` refuses
       * any reduced key that two entries in this set share, because that is
       * normally two different customers and choosing between them is how a
       * cylinder lands on the wrong account. But a card is usually nothing more
       * than the account number wrapped in printer decoration —
       * `*%800006D2-1614971550A*` against `800006D2-1614971550A` — and those
       * reduce to one key. Adding both unconditionally would make every
       * ordinary customer look like a collision with themselves and refuse the
       * match it was about to make. So the account number only goes in when it
       * is genuinely a second code, which is the same precedence `classify`
       * uses: the card is what the counter scans, the account number is the
       * fallback.
       *
       * A phone that has never synced has no `boot`, so the set is empty and
       * nothing is ever accepted. That is deliberate and it is the correct
       * conservative behaviour: with no data to check a read against, there
       * is no way to tell a correct read from an invented one, and the safe
       * answer to that is no.
       */
      const boot = useStore.getState().boot;
      const known = new Set<string>();
      if (boot) {
        for (const bc of Object.keys(boot.assets)) known.add(bc.toUpperCase());
        for (const c of boot.customers) {
          const card = c.bc ? c.bc.toUpperCase() : null;
          if (card) known.add(card);
          const account = c.customerListId ? c.customerListId.toUpperCase() : null;
          if (account && (!card || key(account) !== key(card))) known.add(account);
        }
      }

      // Same reticle crop Snap uses, and the same reasoning: without it, any
      // other printed number elsewhere on the document is just as readable as
      // the one the driver aimed the camera at. ML Kit takes a file URI, so
      // unlike the deleted API version there is no base64 round trip at all.
      let uri = photo.uri;
      if (reticle && photo.width && photo.height) {
        try {
          const cropped = await ImageManipulator.manipulateAsync(photo.uri, [{
            crop: {
              originX: Math.round(photo.width * RETICLE.left),
              originY: Math.round(photo.height * RETICLE.top),
              width: Math.round(photo.width * RETICLE.width),
              height: Math.round(photo.height * RETICLE.height),
            },
          }], { compress: 1 });
          uri = cropped.uri;
          scratch.push(cropped.uri);
        } catch { /* fall through with the uncropped photo */ }
      }

      // Same two-pass shape as Snap: a fixed reticle can cut a long number off
      // a document it was never sized for, and the full frame is already in
      // hand. The known-set check applies identically to both passes, so the
      // wider net cannot widen what is accepted.
      let code = matchKnown(candidatesFrom(await recognizeText(uri)), known);
      if (!code && uri !== photo.uri) {
        code = matchKnown(candidatesFrom(await recognizeText(photo.uri)), known);
      }

      if (code && (!accept || accept(code))) {
        lastAccepted.current[code] = Date.now();
        lastReadAt.current = Date.now();
        setStruggling(false);
        onCode(code);
        return;
      }
      // Read something, matched nothing. Said precisely, because "no match"
      // and "not working" are different problems and a driver reporting the
      // wrong one costs a day.
      setAiMiss(known.size
        ? 'read it, but nothing on this phone matched'
        : 'this phone has not synced yet — nothing to match against');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (e) {
      // The one failure worth naming on screen: the module is not in the
      // build. Everything else is an ordinary bad frame.
      setAiMiss(e instanceof OcrUnavailable
        ? 'text reading is not in this build'
        : 'could not read that frame');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      if (alive.current) setAiBusy(false);
      discard(...scratch);
    }
  }, [accept, onCode, aiBusy, reticle]);

  /** Manual nudge: run one focus cycle right now, same one PERIODIC REFOCUS
      uses, on both platforms. */
  const refocus = useCallback(() => {
    cycleRef.current();
  }, []);

  /**
   * TAP THE PREVIEW: FOCUS, THEN READ THE STILL.
   *
   * These were two separate gestures for one intention. Tapping the preview
   * pulsed autofocus and nothing else; reading a stubborn label meant finding
   * the Snap button in the control row. A driver reported (17 Aug) doing the
   * entire job through that button — "I have to take a picture for it to scan
   * the customer number and sales barcode" — because the live decoder will not
   * take a long customer or sales-order code: it only accepts a value it has
   * read twice identically, and a dense code rarely obliges before the window
   * closes. The still path has no such gate, so the button worked and the
   * camera appeared not to.
   *
   * Focus-then-capture is also simply the right order, which is why the delay
   * is here rather than snapping on the touch: the cycle settles the lens and
   * the capture lands on the sharp frame. 380ms is the 180ms refocus toggle
   * plus enough beyond it for the lens to actually re-settle.
   *
   * The Snap button stays exactly where it was. This is a second door into the
   * same room — the button is the discoverable one, the tap is the fast one —
   * and `snap()` shares the accept path, so its cooldown and duplicate rules
   * apply identically no matter which way in you took.
   */
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapToRead = useCallback(() => {
    // A TAP REFOCUSES. IT DOES NOT TAKE A PICTURE.
    //
    // It used to schedule snap() 380ms later, and that was the single worst
    // thing in this file. Tapping the preview is the reflex when a picture
    // looks soft — so the driver's instinct stalled the live camera session
    // for a full-resolution capture plus up to five decode passes (one of
    // them asm.js zxing on Hermes, hundreds of ms to seconds), flashed the
    // preview white and played a shutter sound. Live decoding stopped for
    // that whole window. That is "the scanner froze."
    //
    // Legacy's tap did exactly one thing (gas-cylinder-android ScanArea.tsx
    // :360-369): toggle autofocus for 180ms. It also explicitly banned the
    // competing capture during Locate (EnhancedScanScreen.tsx:2431, "it can
    // interfere with rapid consecutive scans by competing for camera
    // processing"). We reintroduced the exact thing legacy had learned to
    // forbid. Snap is still one press away — on the button, deliberately.
    refocus();
  }, [refocus]);

  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);

  const close = useCallback(() => {
    // Deactivate first; unmount on the next frame. See GRACEFUL CLOSE above.
    setClosing(true);
    setTimeout(() => onClose?.(), 60);
  }, [onClose]);

  if (!perm?.granted) {
    return (
      <View style={[FILL, { alignItems: 'center', justifyContent: 'center', padding: 24 }, style]}>
        <Text style={{ color: T.steel, fontSize: 14.5, textAlign: 'center', lineHeight: 21 }}>
          Scanified needs the camera to read barcodes.
        </Text>
        <Pressable onPress={requestPerm} style={{ marginTop: 14, minHeight: 44, justifyContent: 'center' }} hitSlop={12}>
          <Text style={{ color: T.brandLit, fontWeight: '700', fontSize: 15 }}>Allow camera</Text>
        </Pressable>
        {children}
      </View>
    );
  }

  return (
    <View
      style={[FILL, { overflow: 'hidden' }, style]}
      // The camera fills this View exactly, and the reticle is positioned
      // against it, so this one measurement is the frame both the outline and
      // the position check are talking about.
      onLayout={(e) => {
        viewSize.current = e.nativeEvent.layout;
        const isSmall = e.nativeEvent.layout.height > 0 && e.nativeEvent.layout.height < 420;
        if (isSmall !== embedded) setEmbedded(isSmall);
      }}
    >
      {!mounted ? (
        // Deferred-mount window (Android only, ~150ms) — see the effect above.
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: T.faint, fontSize: 13 }}>Starting camera…</Text>
        </View>
      ) : (
      <Pressable style={{ flex: 1 }} onPress={tapToRead}>
        <CameraView
          ref={cam}
          style={{ flex: 1 }}
          active={!closing}
          facing="back"
          enableTorch={torch}
          zoom={zoom}
          // Legacy set this false (ScanArea.tsx:406). Left at its default
          // `true` the preview flashes white on every capture — in a dark
          // yard that reads as the camera glitching.
          animateShutter={false}
          autofocus={focusOff ? 'off' : 'on'}
          onCameraReady={() => setReady(true)}
          barcodeScannerSettings={BARCODE_SETTINGS}
          // Gated on `reticle` for the same reason the Snap crop is: with no
          // outline drawn there is no box the driver was asked to aim at, and
          // rejecting a read against an invisible one is indistinguishable from
          // the camera being broken. And gated on POSITION_FILTER — see below.
          onBarcodeScanned={
            ready && !closing
              ? ({ data, bounds }) => {
                  if (POSITION_FILTER && reticle
                      && !withinReticle(bounds, viewSize.current)) return;
                  deliver(data);
                }
              : undefined
          }
        />
      </Pressable>
      )}

      {/* ── reticle: one rectangle, wide, a little above centre ── */}
      {/* A full outline reads unambiguously as "put the barcode in here" — the
          corner-bracket version this replaced looked more like a camera focus
          reticle, which is the wrong metaphor for a driver glancing at it for
          half a second with gloves on. The proportions and why they are what
          they are live with the numbers, in src/reticle.ts.

          IT STILL GUIDES MORE THAN IT CONSTRAINS. The decoder reads the whole
          frame; only acceptance is filtered by where a code was found, and only
          when the platform reports where that was. So this box has to stay
          generous enough that a driver who fills it is comfortably inside what
          is being read, and a code landing just outside it still scans rather
          than mysteriously not working. */}
      {reticle && (
        <View pointerEvents="none" style={{
          position: 'absolute',
          left: `${RETICLE.left * 100}%`, width: `${RETICLE.width * 100}%`,
          top: `${RETICLE.top * 100}%`, height: `${RETICLE.height * 100}%`,
        }}>
          <View style={{
            flex: 1, borderRadius: 12, borderWidth: 2,
            borderColor: struggling ? T.amber : T.brandLit, opacity: 0.85,
          }} />
        </View>
      )}

      {/* ── controls: torch, zoom, snap, close ──
          Fixed `bottom: 10` used to mean "10px above whatever is physically at
          the bottom of the screen" — which on a phone with three-button nav or
          a gesture pill is the nav bar, not the bottom of the glass. The zoom
          and torch buttons sat exactly where a thumb going for the system back
          button landed, on every Android phone with on-screen nav. insets.bottom
          is that bar's own height; adding it is the same trick useBottomInset
          does for every other floating footer in this app — this is the one
          surface that never went through it, because a full-screen Modal has
          no navigator chrome to make the omission obvious in a simulator. */}
      <View
        style={embedded
          // A form box: no OS chrome to clear, and every pixel of preview is
          // precious — so one horizontal row hugging the bottom-right corner,
          // BELOW the reticle (which ends at 57% of the frame). Hints are
          // dropped here; there is no room to whisper in.
          ? { position: 'absolute', right: 8, bottom: 8, flexDirection: 'row', gap: 8, alignItems: 'center' }
          : { position: 'absolute', right: 12, bottom: 12 + insets.bottom + controlsBottomInset, gap: 10, alignItems: 'flex-end' }}
      >
        {/*
          SNAP IS ALWAYS OFFERED NOW, AND THAT IS THE FIX.
          It used to be gated on a native module that was never in the build,
          so it was invisible on every device it ever shipped to — a feature
          discussed for two sessions that no driver could have tapped. Its
          decoder is expo-camera's own, which is always present, so there is
          nothing left to gate on. Still hidden until `struggling`, because a
          button that appears the instant the camera opens is noise for the
          99% of labels that just read.
        */}
        {struggling && (
          <Ctl
            label={snapBusy ? 'Reading…' : 'Snap'}
            hint={embedded ? undefined : 'photo read for damaged labels'}
            active={snapBusy}
            onPress={snap}
          />
        )}
        {/*
          "Read text" is the tier below Snap and the one still standing on a
          third-party native module. `hasOcr()` cannot be trusted to answer
          whether it is really there — the package hands back a plain object
          whose method throws only when called — so the button is shown and
          the failure is REPORTED rather than swallowed. A driver who taps it
          and sees "text reading is not in this build" has told us more in one
          tap than another round of guessing would.
        */}
        {struggling && (
          <Ctl
            label={aiBusy ? 'Reading…' : 'Read text'}
            hint={embedded ? undefined : (aiMiss ?? 'reads the printed number on the label')}
            active={aiBusy}
            onPress={readText}
          />
        )}
        <Ctl
          icon="zap"
          active={torch}
          glow={struggling && !torch}
          onPress={() => { setTorch((v) => !v); Haptics.selectionAsync(); }}
        />
        <Ctl
          label={zoom === 0 ? '1×' : zoom === 0.15 ? '1.5×' : '2×'}
          onPress={() => { setZoom((z) => (z === 0 ? 0.15 : z === 0.15 ? 0.3 : 0)); Haptics.selectionAsync(); }}
        />
      </View>

      {onClose && (
        // Same fix as the control stack, at the other edge: `top: 10` sat under
        // the status bar / notification shade's swipe-down target on a
        // full-screen camera, where nothing else pushes content below it the
        // way a navigator header would. insets.top is the status bar's own
        // height.
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Stop scanning"
          hitSlop={8}
          style={({ pressed }) => ({
            // Embedded boxes have no status bar to duck under — the same
            // measurement that moved the bottom controls (see `embedded`).
            position: 'absolute', right: embedded ? 8 : 12,
            top: embedded ? 8 : 12 + insets.top,
            paddingHorizontal: 16, minHeight: 44, borderRadius: 12,
            backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13.5 }}>Stop</Text>
        </Pressable>
      )}

      {children}
    </View>
  );
}

function Ctl({
  icon, label, hint, active, glow, onPress,
}: {
  icon?: React.ComponentProps<typeof Icon>['name'];
  label?: string;
  hint?: string;
  active?: boolean;
  glow?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label ?? icon}
      accessibilityHint={hint}
      // 44pt is the floor for gloves, and the glass around these buttons is
      // dead camera anyway — hitSlop costs nothing and misses cost a rescan.
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 44, minWidth: 44, borderRadius: 12,
        paddingHorizontal: label ? 14 : 0,
        alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
        backgroundColor: active ? wash(0.85) : 'rgba(0,0,0,0.62)',
        borderWidth: glow ? 1.5 : 0,
        borderColor: glow ? T.amber : 'transparent',
        // Pressed feedback on glass-over-camera, where a ripple can't draw:
        // opacity is the one channel that always reads. (Was: none at all.)
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {icon && <Icon name={icon} size={ICON.sm} color={active ? T.onBrand : glow ? T.amber : '#fff'} />}
      {label && (
        <View>
          <Text style={{ color: active ? T.onBrand : '#fff', fontWeight: '800', fontSize: 12.5 }}>
            {label}
          </Text>
          {/* 8.5px was decoration pretending to be information. 10px with
              real line-height is the smallest honest whisper. */}
          {hint && (
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 10, lineHeight: 13 }}>
              {hint}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}
