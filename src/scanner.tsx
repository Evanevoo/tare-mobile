import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import { T, Icon, ICON, wash } from '@/ui';

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
 * READY GATE. `onBarcodeScanned` is not attached until the native camera
 * reports ready — attaching earlier crashes some iOS devices mid-session
 * teardown.
 *
 * GRACEFUL CLOSE. The view deactivates before unmount (`closing`), because
 * tearing down an AVCaptureSession that is still delivering frames is a
 * known iOS crash.
 *
 * TAP TO REFOCUS. Continuous autofocus-on locks focus at the wrong distance
 * on some phones. Default is off; tapping the preview pulses autofocus on for
 * a beat and back off — the legacy app's trick, kept.
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
 * The reticle band, as fractions of the frame — read by both the on-screen
 * outline and the Snap crop below, so the two can never drift apart. Left/top
 * are the near edge; width/height are the box's own size, which is the shape
 * expo-image-manipulator's crop wants (an origin + a size, not two edges).
 */
const RETICLE = { left: 0.11, width: 0.78, top: 0.33, height: 0.20 } as const;

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
 * The reticle is now honestly what it always was: an aiming guide for the
 * driver, not a constraint on the decoder. If the decode area ever genuinely
 * needs narrowing, it has to happen by cropping a still frame before handing it
 * to ML Kit — the Snap path below — because that is the only place in this
 * stack where the pixels are ours to cut.
 */

/** Loaded once, lazily. Null where the native module is not in the build. */
let mlkit: { scan: (uri: string) => Promise<{ value?: string | null }[]> } | null | undefined;
function loadMlkit() {
  if (mlkit !== undefined) return mlkit;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-ml-kit/barcode-scanning');
    const scanner = mod?.default ?? mod;
    mlkit = typeof scanner?.scan === 'function' ? scanner : null;
  } catch {
    mlkit = null;
  }
  return mlkit;
}

export interface ScannerProps {
  /** Called once per accepted read. Already trimmed and uppercased. */
  onCode: (code: string) => void;
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
   * Focus once and then leave the lens alone (Android).
   *
   * The legacy app carried the same flag and the same one-line reason: it
   * "avoids blur when pointing at barcode — use for customer barcode scanning".
   * The periodic refocus below is right for a driver sweeping a pallet at
   * changing distances; it is wrong for somebody holding a phone still over a
   * printed receipt, because a lens told to re-acquire every second spends a
   * good part of every second hunting, and the frames it delivers mid-hunt are
   * exactly the soft ones a long Code 39 label cannot survive.
   */
  steadyFocus?: boolean;
}

export function Scanner({
  onCode, accept, types, style, children, reticle = true, onClose, cooldownMs = 2500,
  steadyFocus = false,
}: ScannerProps) {
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [focusPulse, setFocusPulse] = useState(false);
  const [struggling, setStruggling] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);
  const [androidFocusOff, setAndroidFocusOff] = useState(false);
  const [mounted, setMounted] = useState(Platform.OS !== 'android');

  const cam = useRef<CameraView | null>(null);
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
   * ANDROID PERIODIC REFOCUS.
   *
   * The doc block at the top of this file says continuous autofocus "locks at
   * the wrong distance on some phones" and describes a pulse-to-refocus trick —
   * but until now that trick was wired for iOS only; Android ran plain
   * `autofocus="on"` with no refocus path at all. That is backwards: it is
   * Android's autofocus that tends to lock on the first thing it settles on and
   * never re-evaluate, which is exactly what the legacy Android app
   * (gas-cylinder-android/components/ScanArea.tsx) built a fix for and proved out
   * in the field — a driver holding a cylinder closer or farther after the first
   * lock got a soft, unreadable frame until they backed out and reopened the
   * scanner. The fix is a periodic toggle: autofocus off for a beat, then back
   * on, which most Android camera stacks treat as "focus again now" rather than
   * "stop focusing." Kept as a separate flag from `focusPulse` because the two
   * platforms' defaults are opposite — iOS defaults off and pulses on; Android
   * defaults on and pulses off — and collapsing them into one flag would make
   * one of the two platforms wrong.
   */
  useEffect(() => {
    if (Platform.OS !== 'android' || !ready) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const cycle = () => {
      setAndroidFocusOff(true);
      // Tracked, not fire-and-forget: without this the inner timer outlives the
      // component, and on a fast close/reopen the stale one lands in the new
      // session and knocks focus off at random.
      timers.push(setTimeout(() => { if (alive.current) setAndroidFocusOff(false); }, 180));
    };

    // Let the preview settle before touching focus at all, or the first second
    // of every scan is a visible glitch.
    timers.push(setTimeout(cycle, 600));
    if (steadyFocus) return () => timers.forEach(clearTimeout);

    // Sweeping a pallet: keep re-acquiring. The later kicks are offset off the
    // interval's own ticks (600+1400, 600+2500 against a 1000ms period) so two
    // cycles never fire together — overlapping cycles cancel each other's
    // off-window early and the refocus silently does not happen.
    timers.push(setTimeout(cycle, 2000), setTimeout(cycle, 3100));
    const iv = setInterval(cycle, 1000);
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
    if (lastAccepted.current[code] && now - lastAccepted.current[code] < cooldownMs) return;

    // The double-read confirm. First sighting arms; a second sighting of the
    // same value within 450ms fires. A different value re-arms — a misread
    // never gets a partner, so it never fires.
    const p = pending.current;
    if (!p || p.code !== code || now - p.at > 450) {
      pending.current = { code, at: now };
      return;
    }

    pending.current = null;
    lastAccepted.current[code] = now;
    lastReadAt.current = now;
    setStruggling(false);
    onCode(code);
  }, [accept, cooldownMs, onCode]);

  /** The ML Kit still-frame path, for labels the live decoder cannot crack. */
  const snap = useCallback(async () => {
    const kit = loadMlkit();
    if (!kit || !cam.current || snapBusy) return;
    setSnapBusy(true);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 0.9, skipProcessing: true });
      if (!photo?.uri) return;

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
        } catch { /* fall through with the uncropped photo */ }
      }

      const tryScan = async (imgUri: string) => {
        const results = await kit.scan(imgUri);
        return results?.find((r) => r?.value?.trim())?.value?.trim() ?? null;
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

      if (code) {
        // A still frame read deliberately bypasses the double-read confirm —
        // ML Kit on a full-resolution photo does not produce partial reads.
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
    }
  }, [accept, onCode, snapBusy, reticle]);

  /** iOS focus pulse: on for a beat, back to off. Continuous-on locks focus. */
  const refocus = useCallback(() => {
    if (Platform.OS !== 'ios') return;
    setFocusPulse(true);
    setTimeout(() => { if (alive.current) setFocusPulse(false); }, 350);
  }, []);

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

  const hasMlkit = loadMlkit() !== null;

  return (
    <View style={[FILL, { overflow: 'hidden' }, style]}>
      {!mounted ? (
        // Deferred-mount window (Android only, ~150ms) — see the effect above.
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: T.faint, fontSize: 13 }}>Starting camera…</Text>
        </View>
      ) : (
      <Pressable style={{ flex: 1 }} onPress={refocus}>
        <CameraView
          ref={cam}
          style={{ flex: 1 }}
          active={!closing}
          facing="back"
          enableTorch={torch}
          zoom={zoom}
          autofocus={
            Platform.OS === 'ios' ? (focusPulse ? 'on' : 'off') : (androidFocusOff ? 'off' : 'on')
          }
          onCameraReady={() => setReady(true)}
          barcodeScannerSettings={BARCODE_SETTINGS}
          onBarcodeScanned={ready && !closing ? ({ data }) => deliver(data) : undefined}
        />
      </Pressable>
      )}

      {/* ── reticle: one rectangle, wide and short, a little above centre ── */}
      {/* A full outline reads unambiguously as "put the barcode in here" — the
          corner-bracket version this replaced looked more like a camera focus
          reticle, which is the wrong metaphor for a driver glancing at it for
          half a second with gloves on. Wide rather than tall (78%/20%, not
          48%/38%) because every code this app reads is a linear barcode — a
          tall box just left dead space on either side and read as a vertical
          slot, the wrong shape for what's being aimed at. Positioned above
          true centre (33%/53%) because a phone held up at an object at chest
          height gets tilted down to aim, and that puts the object in the upper
          half of the frame, not dead centre.

          IT GUIDES, IT DOES NOT CONSTRAIN. The decoder reads the whole frame —
          see the note where the region of interest used to be. So this box has
          to be generous enough that a driver who fills it is comfortably inside
          what is actually being read, and a code landing just outside it still
          scans rather than mysteriously not working. */}
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
      <View style={{ position: 'absolute', right: 10, bottom: 10 + insets.bottom, gap: 8, alignItems: 'flex-end' }}>
        {hasMlkit && struggling && (
          <Ctl
            label={snapBusy ? 'Reading…' : 'Snap'}
            hint="photo read for damaged labels"
            active={snapBusy}
            onPress={snap}
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
          style={{
            position: 'absolute', right: 10, top: 10 + insets.top,
            paddingHorizontal: 14, minHeight: 36, borderRadius: 10,
            backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center',
          }}
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
      style={{
        minHeight: 40, minWidth: 40, borderRadius: 11,
        paddingHorizontal: label ? 13 : 0,
        alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
        backgroundColor: active ? wash(0.85) : 'rgba(0,0,0,0.62)',
        borderWidth: glow ? 1.5 : 0,
        borderColor: glow ? T.amber : 'transparent',
      }}
    >
      {icon && <Icon name={icon} size={ICON.sm} color={active ? T.onBrand : glow ? T.amber : '#fff'} />}
      {label && (
        <View>
          <Text style={{ color: active ? T.onBrand : '#fff', fontWeight: '800', fontSize: 12.5 }}>
            {label}
          </Text>
          {hint && <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 8.5 }}>{hint}</Text>}
        </View>
      )}
    </Pressable>
  );
}
