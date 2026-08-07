import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
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

// Lowercase names are REQUIRED on iOS — uppercase silently matches nothing.
const DEFAULT_TYPES: BarcodeType[] = [
  'code128', 'code39', 'code93', 'codabar', 'itf14',
  'ean13', 'ean8', 'upc_a', 'upc_e', 'qr', 'pdf417', 'datamatrix', 'aztec',
];

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
}

export function Scanner({
  onCode, accept, types, style, children, reticle = true, onClose, cooldownMs = 2500,
}: ScannerProps) {
  const [perm, requestPerm] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [focusPulse, setFocusPulse] = useState(false);
  const [struggling, setStruggling] = useState(false);
  const [snapBusy, setSnapBusy] = useState(false);

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
      const results = await kit.scan(photo.uri);
      const hit = results?.find((r) => r?.value?.trim());
      if (hit?.value) {
        // A still frame read deliberately bypasses the double-read confirm —
        // ML Kit on a full-resolution photo does not produce partial reads.
        const code = hit.value.trim().toUpperCase();
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
  }, [accept, onCode, snapBusy]);

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
      <Pressable style={{ flex: 1 }} onPress={refocus}>
        <CameraView
          ref={cam}
          style={{ flex: 1 }}
          active={!closing}
          facing="back"
          enableTorch={torch}
          zoom={zoom}
          autofocus={Platform.OS === 'ios' ? (focusPulse ? 'on' : 'off') : 'on'}
          onCameraReady={() => setReady(true)}
          barcodeScannerSettings={{ barcodeTypes: types ?? DEFAULT_TYPES }}
          onBarcodeScanned={ready && !closing ? ({ data }) => deliver(data) : undefined}
        />
      </Pressable>

      {/* ── reticle: four corners, nothing covering the label ── */}
      {reticle && (
        <View pointerEvents="none" style={{ position: 'absolute', left: '16%', right: '16%', top: '30%', bottom: '26%' }}>
          {([
            { pos: { top: 0, left: 0 }, n: 2, s: 0, w: 2, e: 0, r: { borderTopLeftRadius: 10 } },
            { pos: { top: 0, right: 0 }, n: 2, s: 0, w: 0, e: 2, r: { borderTopRightRadius: 10 } },
            { pos: { bottom: 0, left: 0 }, n: 0, s: 2, w: 2, e: 0, r: { borderBottomLeftRadius: 10 } },
            { pos: { bottom: 0, right: 0 }, n: 0, s: 2, w: 0, e: 2, r: { borderBottomRightRadius: 10 } },
          ] as const).map((k, i) => (
            <View key={i} style={{
              position: 'absolute', width: 26, height: 26, ...k.pos, ...k.r,
              borderColor: struggling ? T.amber : T.brandLit,
              borderTopWidth: k.n, borderBottomWidth: k.s,
              borderLeftWidth: k.w, borderRightWidth: k.e, opacity: 0.85,
            }} />
          ))}
        </View>
      )}

      {/* ── controls: torch, zoom, snap, close ── */}
      <View style={{ position: 'absolute', right: 10, bottom: 10, gap: 8, alignItems: 'flex-end' }}>
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
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Stop scanning"
          style={{
            position: 'absolute', right: 10, top: 10,
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
