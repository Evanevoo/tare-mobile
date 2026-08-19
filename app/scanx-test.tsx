import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, Alert } from 'react-native';
import { CameraView, useCameraPermissions, scanFromURLAsync } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import {
  T, Screen, Surface, Btn, Eyebrow, Rise, Hairline, Icon, ICON, mono, tint, wash,
} from '@/ui';
import {
  decodeBase64Image, coreVersion, warmUp, PRESETS, EFFORT_LABEL,
  type Effort, type ScanXResult,
} from '@/scanx';
import { RETICLE } from '@/reticle';
import {
  decodeBase64Image as zxDecode, coreVersion as zxVersion, warmUp as zxWarmUp,
  PRESETS as ZX_PRESETS, type ZXResult,
} from '@/zxing';
import {
  decodeBase64Image as coreDecode, version as coreEngineVersion,
  warmUp as coreWarmUp, type ScanxResult as CoreResult,
} from '@/scanx-core';

/**
 * SCANNER TEST — the new decoder against the one in the truck, on the same frame.
 *
 * The question this screen exists to answer is not "does ScanX work" (there is a
 * corpus for that) but "does it read the labels THIS fleet actually has, on THESE
 * handsets, in the shop where they are read". Nothing off-device answers that.
 *
 * So it takes one photo and gives the identical still to both engines:
 *
 *   · the one shipping today — expo-camera's `scanFromURLAsync`, the same
 *     decoder behind every scan in Delivery, Add and Warehouse
 *   · ScanX — the from-scratch core, compiled into the JS bundle (see src/scanx)
 *
 * Same pixels, same moment, so a disagreement is a real difference between the
 * decoders and not a difference in how the shot was framed.
 *
 * ON THE TIMINGS: ScanX is running as asm.js under Hermes, which has no JIT, so
 * it is 10-50x slower here than the native SDK will be. The payloads it returns
 * are exactly what the native library returns — same code — but the
 * milliseconds are not a forecast. The screen says so rather than letting a
 * number be quoted out of context.
 */

/**
 * The verdict is about ScanX vs the shipping decoder, and it stays that way
 * even though a third engine now runs on the same frame.
 *
 * zxing is a CANDIDATE, not a contestant: it is the engine the SDK is likely
 * to be built on, and it is here to answer "does this read WeldCor's labels",
 * which is a question about the labels, not a race. Folding it into the
 * verdict would make every historical score incomparable with the ones
 * already collected. It gets its own row and its own hit count instead.
 */
type Verdict = 'agree' | 'scanx-only' | 'current-only' | 'differ' | 'neither';

type Shot = {
  at: number;
  current: string[];
  currentFormats: string[];
  currentMs: number;
  scanx: string[];
  scanxFormats: string[];
  scanxMs: number;        // core time
  scanxWallMs: number;    // core + base64 + JSON, i.e. what the tap costs
  zx: string[];
  zxFormats: string[];
  zxMs: number;
  zxWallMs: number;
  /**
   * scanx-core: the in-house grey-level engine. Nullable because it is the
   * newest piece here and a screen that cannot render without it would be a
   * harness that breaks whenever the thing under test does.
   */
  core: string[];
  coreFormat: string;
  coreMs: number;
  /** Confidence: how far the weakest character beat its nearest rival. */
  coreMargin: number;
  /** Estimated narrow-bar width in pixels. Under 2 is past the classical floor. */
  coreModule: number;
  coreError?: string;
  size: string;
  /**
   * What the camera actually handed back, before any crop or resize.
   *
   * On the card because it is the first thing to check when everything returns
   * nothing: no Size setting can add detail the sensor never captured, so a
   * small number here means the bottleneck is the capture and nothing
   * downstream will fix it.
   */
  capture: string;
  verdict: Verdict;
  error?: string;
  zxError?: string;
};

const EMPTY_TALLY = {
  runs: 0, agree: 0, scanxOnly: 0, currentOnly: 0, differ: 0, neither: 0,
  currentHits: 0, scanxHits: 0, zxHits: 0, scanxMs: 0, currentMs: 0, zxMs: 0,
};

const PRESET_KEYS = ['all', 'retail', 'assets', 'qr'] as const;
const PRESET_LABEL: Record<(typeof PRESET_KEYS)[number], string> = {
  all: 'All', retail: 'Retail', assets: 'Asset tags', qr: 'QR',
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export default function ScanXTest() {
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView | null>(null);

  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zxVersionText, setZxVersionText] = useState<string | null>(null);
  const [zxLoadError, setZxLoadError] = useState<string | null>(null);
  const [coreVersionText, setCoreVersion] = useState<string | null>(null);
  const [coreLoadError, setCoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState(false);
  /**
   * Continuous autofocus locks onto whatever the lens first settles on and,
   * on a lot of Android hardware, never re-evaluates — the same problem
   * src/scanner.tsx's "PERIODIC REFOCUS" fixes for every live scan screen
   * with a background off/on toggle loop. This screen has no ambient video
   * decode running to have already nudged it that way, so without a pulse
   * of its own every still came back locked wherever the camera happened to
   * land at mount — usually not on a barcode a few inches away — and BOTH
   * decoders read nothing, every time, regardless of which one is "right":
   * neither can decode a genuinely out-of-focus photo. See `capture`.
   */
  const [autofocus, setAutofocus] = useState<'on' | 'off'>('off');

  // Auto mode: loop `capture` on its own instead of waiting for a tap. A ref
  // (not just the `auto` state) is what the capture loop actually reads —
  // state from the render that scheduled a setTimeout can be stale by the
  // time it fires, a ref can't be. `captureRef` sidesteps the same staleness
  // for the *function* itself, since capture is rebuilt on every settings
  // change (effort/preset/maxDim are its deps).
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(false);
  const captureRef = useRef<() => void>(() => {});
  const alive = useRef(true);
  useEffect(() => { autoRef.current = auto; if (auto) captureRef.current(); }, [auto]);
  useEffect(() => () => { alive.current = false; }, []);

  const [effort, setEffort] = useState<Effort>(0);
  const [preset, setPreset] = useState<(typeof PRESET_KEYS)[number]>('all');
  // 1200, not 720. The bench says a 20-character Code 128 needs ~660 px of
  // barcode to clear 3 px per narrow bar, and at 720 across the whole frame
  // that label lands under 2 -- undecodable by anything. Starting below the
  // floor means the first capture of every session fails for a reason that
  // has nothing to do with the decoders being compared.
  const [maxDim, setMaxDim] = useState(1200);

  const [shots, setShots] = useState<Shot[]>([]);
  const [tally, setTally] = useState({ ...EMPTY_TALLY });

  // Pull both decoders in on mount. Together they are ~2 MB of generated JS
  // and Hermes has to walk all of it once; doing that here rather than on the
  // first tap keeps the first capture honest instead of charging it for the
  // module load.
  //
  // zxing loading is NOT fatal to this screen. ScanX is what the screen was
  // built to evaluate and the comparison still stands without a third column,
  // so a zxing failure is reported in its own row rather than blocking the
  // capture button — the opposite arrangement would mean a problem in the
  // newest, least-proven piece takes the whole test harness down with it.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await warmUp();
        const v = await coreVersion();
        if (alive) { setVersion(v); setReady(true); }
        // scanx-core last and separately: it is the newest engine here, and a
        // fault in it must not stop the screen that exists to evaluate it.
        try {
          await coreWarmUp();
          const cv = await coreEngineVersion();
          if (alive) setCoreVersion(cv);
        } catch (e: any) {
          if (alive) setCoreError(e?.message ? String(e.message) : 'scanx-core did not start');
        }
      } catch (e: any) {
        if (alive) setLoadError(e?.message ? String(e.message) : 'could not start the decoder');
      }
    })();
    (async () => {
      try {
        await zxWarmUp();
        const v = await zxVersion();
        if (alive) setZxVersionText(v);
      } catch (e: any) {
        if (alive) setZxLoadError(e?.message ? String(e.message) : 'could not start zxing');
      }
    })();
    return () => { alive = false; };
  }, []);

  const capture = useCallback(async () => {
    if (!cam.current || busy) return;
    setBusy(true);
    try {
      // Force a fresh focus pull before every still — off, then on, then a
      // real wait for the lens to converge — rather than trusting whatever
      // continuous autofocus already locked onto. See the `autofocus` state
      // doc above for why this exists.
      setAutofocus('off');
      await sleep(60);
      setAutofocus('on');
      await sleep(550);

      /*
       * NO skipProcessing, AND THE REASON IS WORTH KEEPING.
       *
       * It was set for speed. On Android it also skips the step that applies
       * the sensor's own orientation and, on some devices, hands back a frame
       * closer to preview resolution than to the sensor's. Three engines
       * returning nothing at once on a legible label is almost never three
       * decoder failures -- it is one bad input -- and capture resolution is
       * the input that decides whether a barcode is readable in principle.
       * Saving a few milliseconds on a screen whose whole purpose is deciding
       * whether labels CAN be read is a bad trade, so the processing stays on
       * and the size that actually came back is now reported on the card
       * rather than assumed.
       */
      const photo = await cam.current.takePictureAsync({ quality: 0.95 });
      if (!photo?.uri) throw new Error('the camera returned no image');
      const captureSize = `${photo.width ?? 0}×${photo.height ?? 0}`;

      /**
       * CROP TO THE RETICLE FIRST — same box, same reason, as src/scanner.tsx's
       * `snap()`. `takePictureAsync` captures the whole scene: a driver holding
       * up a full invoice or packing slip hands both decoders a photo where the
       * actual barcode is a small fraction of the frame, at a bar width neither
       * engine can resolve, and BOTH come back empty — which looks exactly like
       * a decoder bug and is actually a framing one. Cropping down to the
       * reticle first is what makes this test represent what the live scanner
       * (which crops the same way) can actually do, not what a raw uncropped
       * photo can. Falls back to the full frame if the crop itself finds
       * nothing — a badly-aimed crop can cut a wide code the full frame would
       * still have caught whole.
       */
      const runBoth = async (imgUri: string) => {
        const t0 = Date.now();
        const cur = await scanFromURLAsync(imgUri).catch(() => []);
        const curMs = Date.now() - t0;

        const small = await manipulateAsync(
          imgUri,
          [{ resize: { width: maxDim } }],
          // manipulateAsync is deprecated in favour of the contextual API, but it
          // is still exported and is one call instead of three. Swap it when the
          // project moves off SDK 54.
          { compress: 0.85, format: SaveFormat.JPEG, base64: true },
        );

        const t1 = Date.now();
        const sx: ScanXResult = small.base64
          ? await decodeBase64Image(small.base64, {
              maxDim, effort, symbologies: PRESETS[preset],
            })
          : { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [], error: 'no base64 from the resize' };
        const wallMs = Date.now() - t1;

        // C — zxing-cpp, the SDK's candidate engine. Same base64, same frame,
        // same moment as the other two. Adaptive binarisation is on by
        // default and that is deliberate: without it a shadow across a
        // packing slip is unreadable at any resolution, which is a condition
        // two of the reference photographs from the floor actually have.
        const t2 = Date.now();
        const zx: ZXResult = small.base64
          ? await zxDecode(small.base64, {
              maxDim, effort: effort > 0 ? 1 : 0, formats: ZX_PRESETS[preset], binarize: true,
            })
          : { ms: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, codes: [], error: 'no base64 from the resize' };
        const zxWallMs = Date.now() - t2;

        /**
         * D — scanx-core, the in-house grey-level decoder.
         *
         * The other three all binarise before they decode. This one never
         * does: it correlates the raw luminance profile against every pattern
         * Code 128 is allowed to contain and asks which the signal most
         * resembles. That is the whole reason it exists, and it is why it
         * reads below the resolution floor the others share — measured at
         * 40.7% where the classical approach gets 0.0%, at one pixel per
         * narrow bar.
         *
         * minMargin 0 on purpose. The engine would normally refuse a read it
         * is not confident about, but on a test screen a refusal and a wrong
         * answer look identical unless the number behind them is visible. So
         * it reports everything and the margin is shown; judge it yourself.
         *
         * Failing to load is NOT fatal here, exactly as for zxing above: this
         * is the newest and least-proven piece on the screen, and a fault in
         * it must not take the harness down with it.
         */
        const t3 = Date.now();
        let core: CoreResult | null = null;
        try {
          core = small.base64
            ? await coreDecode(small.base64, { maxDim, minMargin: 0 })
            : null;
        } catch {
          core = null;
        }
        const coreWallMs = Date.now() - t3;

        return { cur, curMs, sx, wallMs, zx, zxWallMs, core, coreWallMs };
      };

      /*
       * CROP WIDER THAN THE BOX THAT WAS DRAWN.
       *
       * Every linear symbology requires a QUIET ZONE -- Code 128 wants ten
       * module widths of blank either side -- and a decoder that cannot see
       * one refuses the symbol outright rather than reading it short. Cropping
       * exactly to the reticle guarantees the failure whenever someone fills
       * the box properly, which is precisely what they were asked to do: the
       * better the aim, the closer the bars sit to the edge, the more certain
       * the miss. An aiming guide that punishes good aim is worse than none.
       *
       * So the drawn box stays where it is and the crop is taken with a margin
       * around it. 8% of frame width is comfortably past ten modules for the
       * labels in this fleet while still excluding the corners, which is where
       * the stray courier sticker that motivated cropping in the first place
       * lives.
       */
      const PAD = 0.08;
      let uri = photo.uri;
      let cropped = false;
      if (photo.width && photo.height) {
        try {
          const l = Math.max(0, RETICLE.left - PAD);
          const t = Math.max(0, RETICLE.top - PAD);
          const r = Math.min(1, RETICLE.left + RETICLE.width + PAD);
          const b = Math.min(1, RETICLE.top + RETICLE.height + PAD);
          const c = await manipulateAsync(photo.uri, [{
            crop: {
              originX: Math.round(photo.width * l),
              originY: Math.round(photo.height * t),
              width: Math.round(photo.width * (r - l)),
              height: Math.round(photo.height * (b - t)),
            },
          }], { compress: 1 });
          uri = c.uri;
          cropped = true;
        } catch { /* fall through with the uncropped photo */ }
      }

      let pass = await runBoth(uri);
      let usedFallback = false;
      if (cropped && pass.cur.length === 0 && pass.sx.codes.length === 0
          && pass.zx.codes.length === 0) {
        usedFallback = true;
        pass = await runBoth(photo.uri);
      }

      const currentTexts = dedupe(pass.cur.map((c) => c.data));
      const scanxTexts = dedupe(pass.sx.codes.map((c) => c.text));
      const zxTexts = dedupe(pass.zx.codes.map((c) => c.text));

      const shot: Shot = {
        at: Date.now(),
        current: currentTexts,
        currentFormats: dedupe(pass.cur.map((c) => String(c.type))),
        currentMs: pass.curMs,
        scanx: scanxTexts,
        scanxFormats: dedupe(pass.sx.codes.map((c) => c.format)),
        scanxMs: pass.sx.ms,
        scanxWallMs: pass.wallMs,
        zx: zxTexts,
        zxFormats: dedupe(pass.zx.codes.map((c) => c.format)),
        zxMs: pass.zx.ms,
        zxWallMs: pass.zxWallMs,
        core: pass.core?.ok && pass.core.text ? [pass.core.text] : [],
        coreFormat: pass.core?.format ?? '',
        coreMs: pass.coreWallMs,
        coreMargin: pass.core?.margin ?? 0,
        coreModule: pass.core?.module ?? 0,
        coreError: pass.core?.error ?? pass.core?.failure,
        size: (pass.sx.w ? `${pass.sx.sourceW}×${pass.sx.sourceH} → ${pass.sx.w}×${pass.sx.h}` : '—')
          + (usedFallback ? ' · full frame, crop missed' : cropped ? ' · cropped to reticle' : ''),
        capture: captureSize,
        verdict: judge(currentTexts, scanxTexts),
        error: pass.sx.error,
        zxError: pass.zx.error,
      };

      setShots((prev) => [shot, ...prev].slice(0, 12));
      setTally((t) => ({
        runs: t.runs + 1,
        agree: t.agree + (shot.verdict === 'agree' ? 1 : 0),
        scanxOnly: t.scanxOnly + (shot.verdict === 'scanx-only' ? 1 : 0),
        currentOnly: t.currentOnly + (shot.verdict === 'current-only' ? 1 : 0),
        differ: t.differ + (shot.verdict === 'differ' ? 1 : 0),
        neither: t.neither + (shot.verdict === 'neither' ? 1 : 0),
        currentHits: t.currentHits + (currentTexts.length ? 1 : 0),
        scanxHits: t.scanxHits + (scanxTexts.length ? 1 : 0),
        zxHits: t.zxHits + (zxTexts.length ? 1 : 0),
        currentMs: t.currentMs + pass.curMs,
        scanxMs: t.scanxMs + pass.sx.ms,
        zxMs: t.zxMs + pass.zx.ms,
      }));
    } catch (e: any) {
      // A real failure (camera/resize), not "nothing decoded" — that path
      // above always produces a shot, empty or not, no throw. In auto mode
      // a repeating alert every ~quarter-second is its own kind of bug, so
      // this stops the loop instead of stacking dialogs.
      if (autoRef.current) setAuto(false);
      Alert.alert('Capture failed', e?.message ? String(e.message) : 'Try again.');
    } finally {
      setBusy(false);
      if (autoRef.current && alive.current) {
        setTimeout(() => { if (alive.current) captureRef.current(); }, 250);
      }
    }
  }, [busy, effort, maxDim, preset]);

  useEffect(() => { captureRef.current = capture; }, [capture]);

  if (!perm) return <Screen intensity={0.7}><View /></Screen>;

  if (!perm.granted) {
    return (
      <Screen intensity={0.7}>
        <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
          <Text style={{ color: T.ink, fontSize: 20, fontWeight: '700' }}>
            The camera is off
          </Text>
          <Text style={{ color: T.faint, fontSize: 14, lineHeight: 21 }}>
            This screen photographs a barcode and gives the same photo to both decoders.
            It needs the camera to do that.
          </Text>
          <Btn label="Allow the camera" onPress={() => { requestPerm().catch(() => {}); }} />
        </View>
      </Screen>
    );
  }

  const avgCurrent = tally.runs ? Math.round(tally.currentMs / tally.runs) : 0;
  const avgScanx = tally.runs ? Math.round(tally.scanxMs / tally.runs) : 0;
  const avgZx = tally.runs ? Math.round(tally.zxMs / tally.runs) : 0;

  return (
    <Screen intensity={0.7}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 44 }}>
        <Rise>
          <Surface>
            <View style={{ height: 250, backgroundColor: '#000', overflow: 'hidden', borderRadius: T.radius }}>
              <CameraView
                ref={cam}
                style={{ flex: 1 }}
                facing="back"
                enableTorch={torch}
                autofocus={autofocus}
              />
              {/* Aim guide, same box `capture` crops to first — see the doc
                  comment on that crop. Without this drawn, there's nothing
                  telling you the crop exists at all, let alone where it is. */}
              <View pointerEvents="none" style={{
                position: 'absolute',
                left: `${RETICLE.left * 100}%`, width: `${RETICLE.width * 100}%`,
                top: `${RETICLE.top * 100}%`, height: `${RETICLE.height * 100}%`,
              }}>
                <View style={{
                  flex: 1, borderRadius: 12, borderWidth: 2,
                  borderColor: T.brandLit, opacity: 0.85,
                }} />
              </View>
            </View>
          </Surface>
        </Rise>

        <Rise delay={40} style={{ marginTop: 12, flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Btn
              label={auto ? 'Auto — tap to stop' : busy ? 'Reading…' : 'Capture and compare'}
              busy={busy && !auto}
              disabled={!ready}
              onPress={() => { if (auto) setAuto(false); else capture(); }}
            />
          </View>
          <Pressable
            onPress={() => setAuto((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: auto }}
            accessibilityLabel="Auto scan"
            disabled={!ready}
            style={({ pressed }) => ({
              width: 58, borderRadius: T.radiusSm, alignItems: 'center', justifyContent: 'center',
              borderWidth: 1, borderColor: auto ? T.rule : 'transparent',
              backgroundColor: auto ? T.stamp : pressed ? T.soft : tint(0.04),
            })}
          >
            <Icon name="repeat" size={ICON.md} color={auto ? T.bottle : T.faint} />
          </Pressable>
          <Pressable
            onPress={() => setTorch((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: torch }}
            accessibilityLabel="Torch"
            style={({ pressed }) => ({
              width: 58, borderRadius: T.radiusSm, alignItems: 'center', justifyContent: 'center',
              borderWidth: 1, borderColor: torch ? T.rule : 'transparent',
              backgroundColor: torch ? T.stamp : pressed ? T.soft : tint(0.04),
            })}
          >
            <Icon name="zap" size={ICON.md} color={torch ? T.bottle : T.faint} />
          </Pressable>
        </Rise>

        {auto && (
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 10, lineHeight: 18 }}>
            Recapturing on its own, back to back — hold the barcode steady in frame. Each
            capture still costs what the timing note below says; this doesn't make ScanX
            faster, it just removes the tap.
          </Text>
        )}

        {!ready && !loadError && (
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 10 }}>
            Starting the decoder…
          </Text>
        )}
        {!!loadError && (
          <Text style={{ color: T.needle, fontSize: 12.5, marginTop: 10, lineHeight: 18 }}>
            The decoder did not start: {loadError}
          </Text>
        )}
        {!!zxLoadError && (
          <Text style={{ color: T.amber, fontSize: 12.5, marginTop: 8, lineHeight: 18 }}>
            zxing did not start: {zxLoadError} — the other two engines still run.
          </Text>
        )}
        {!!zxVersionText && (
          <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 8 }}>
            {version ? `${version} · ` : ''}{zxVersionText}
          </Text>
        )}

        {shots.length > 0 && (
          <Rise delay={60} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 12 }}>Last capture</Eyebrow>
            <LastShot shot={shots[0]} />
          </Rise>
        )}

        <Rise delay={90} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Score</Eyebrow>
          <Surface>
            <Row label="Captures" value={String(tally.runs)} mono />
            <Hairline />
            <Row label="Read by the app today" value={`${tally.currentHits}/${tally.runs}`} mono />
            <Hairline />
            <Row label="Read by ScanX" value={`${tally.scanxHits}/${tally.runs}`} mono />
            <Hairline />
            <Row label="Read by zxing" value={`${tally.zxHits}/${tally.runs}`} mono />
            <Hairline />
            <Row label="Same answer" value={String(tally.agree)} mono />
            <Hairline />
            <Row label="Only ScanX got it" value={String(tally.scanxOnly)} mono />
            <Hairline />
            <Row label="Only today's got it" value={String(tally.currentOnly)} mono />
            <Hairline />
            <Row label="Disagreed" value={String(tally.differ)} mono />
            <Hairline />
            <Row label="Neither" value={String(tally.neither)} mono />
            <Hairline />
            <Row label="Average, today" value={`${avgCurrent} ms`} mono />
            <Hairline />
            <Row label="Average, ScanX core" value={`${avgScanx} ms`} mono />
            <Hairline />
            <Row label="Average, zxing core" value={`${avgZx} ms`} mono />
          </Surface>
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
            “Only ScanX got it” and “Disagreed” are the two rows worth chasing. The first is
            the case for the new decoder; the second is a bug in one of them, and which one
            is worth finding out before either ships.
          </Text>
        </Rise>

        <Rise delay={120} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Settings for the test</Eyebrow>
          <Segments
            label="Effort"
            items={[0, 1, 2].map((v) => ({ value: v, label: EFFORT_LABEL[v as Effort] }))}
            value={effort}
            onChange={(v) => setEffort(v as Effort)}
          />
          <View style={{ height: 10 }} />
          <Segments
            label="Formats"
            items={PRESET_KEYS.map((k) => ({ value: k, label: PRESET_LABEL[k] }))}
            value={preset}
            onChange={(v) => setPreset(v as (typeof PRESET_KEYS)[number])}
          />
          <View style={{ height: 10 }} />
          {/*
            RANGE PICKED FROM A MEASUREMENT, NOT FROM ROUND NUMBERS.

            The old 540/720/900 ladder topped out below what WeldCor's own
            paperwork needs. A 20-character Code 128 is ~220 modules wide, and
            the desktop bench put the floor at 2.5-3.0 px per narrow bar on a
            clean frame and 5-6 on a soft one. At 720 px across a frame the
            barcode fills a little over half of, that is under 2 px per bar --
            genuinely undecodable, by any engine, which is exactly what three
            simultaneous "nothing" results looked like on the floor.

            660 px of barcode is the 3 px/bar line for that label; 1200 clears
            it with room, 1600 covers the soft-frame case. The cost is real and
            superlinear under asm.js, so the ladder is offered rather than
            forced -- but the useful part of it now extends past the floor
            instead of stopping just short of it.
          */}
          <Segments
            label="Size"
            items={[720, 900, 1200, 1600].map((v) => ({ value: v, label: `${v} px` }))}
            value={maxDim}
            onChange={(v) => setMaxDim(v as number)}
          />
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
            Narrowing the formats is the biggest speed win there is — measured at 10.7× for
            an identical read rate — and it also removes any chance of a stray Code 39 read
            off packaging text. Size is the one that decides whether a label can be read at
            all: a barcode needs about 3 pixels per narrow bar, so a 20-character Code 128
            has to span roughly 660 px in the frame. Below that nothing decodes, at any
            effort, in any engine.
          </Text>
          {maxDim >= 1200 && (
            <Text style={{ color: T.amber, fontSize: 12, marginTop: 9, lineHeight: 18 }}>
              Above 900 px the decode cost climbs steeply — asm.js under Hermes has no JIT,
              so these really are seconds rather than milliseconds. Worth it to find out
              whether a label is readable at all; not a forecast of the native SDK, which
              measured 0.5 ms on the same decoder.
            </Text>
          )}
        </Rise>

        {shots.length > 1 && (
          <Rise delay={150} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 12 }}>Earlier</Eyebrow>
            <Surface>
              {shots.slice(1).map((s, i) => (
                <View key={s.at}>
                  {i > 0 && <Hairline />}
                  <HistoryRow shot={s} />
                </View>
              ))}
            </Surface>
          </Rise>
        )}

        <Rise delay={180} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>About this test</Eyebrow>
          <Surface>
            <Row label="ScanX core" value={version ?? '—'} mono />
            <Hairline />
            <Row label="Running as" value="asm.js in Hermes" />
            <Hairline />
            <Row label="Today's decoder" value="expo-camera" />
          </Surface>
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
            ScanX is a C++ library. To ship it without a new build it is compiled to plain
            JavaScript, and Hermes runs that without a JIT — so it reads exactly what the
            real SDK reads and takes far longer doing it. On the same photo the native build
            is around 12 ms where this is around 800. Trust the payloads on this screen; the
            milliseconds are a property of the harness, not of the SDK.
          </Text>
        </Rise>

        {tally.runs > 0 && (
          <Rise delay={210} style={{ marginTop: 20 }}>
            <Btn
              label="Clear the score"
              variant="ghost"
              onPress={() => { setShots([]); setTally({ ...EMPTY_TALLY }); }}
            />
          </Rise>
        )}
      </ScrollView>
    </Screen>
  );
}

/* ── the result of one capture, both engines side by side ─────────────────── */

function LastShot({ shot }: { shot: Shot }) {
  const v = VERDICT[shot.verdict];
  return (
    <Surface>
      <View style={{
        paddingHorizontal: 18, paddingVertical: 13,
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: wash(0.10, v.tone),
      }}>
        <Icon name={v.icon} size={ICON.md} color={v.tone} />
        <Text style={{ color: v.tone, fontSize: 14.5, fontWeight: '700', flex: 1 }}>
          {v.label}
        </Text>
      </View>
      <View style={{
        paddingHorizontal: 18, paddingBottom: 11,
        backgroundColor: wash(0.10, v.tone),
      }}>
        <Text style={[mono(11.5, '600'), { color: T.faint }]}>
          camera {shot.capture} → {shot.size}
        </Text>
      </View>
      <Hairline />

      <Engine
        name="In the app today"
        sub="expo-camera"
        codes={shot.current}
        formats={shot.currentFormats}
        ms={`${shot.currentMs} ms`}
      />
      <Hairline />
      <Engine
        name="ScanX"
        sub={`${shot.scanxMs} ms core · ${shot.scanxWallMs} ms with the handover`}
        codes={shot.scanx}
        formats={shot.scanxFormats}
        ms={`${shot.scanxMs} ms`}
      />
      <Hairline />
      <Engine
        name="zxing (SDK candidate)"
        sub={`${Math.round(shot.zxMs)} ms core · ${shot.zxWallMs} ms with the handover · adaptive threshold on`}
        codes={shot.zx}
        formats={shot.zxFormats}
        ms={`${Math.round(shot.zxMs)} ms`}
      />
      <Hairline />
      {/*
        The in-house engine. It reports the two numbers the others cannot:
        MARGIN — how far the weakest character beat its nearest rival, which is
        the difference between a read and a confident guess — and MODULE, the
        measured width of one narrow bar. Module under 2 px means this label is
        past the resolution floor the other three share, so a read there is the
        whole reason this engine exists and a miss there is expected.
      */}
      <Engine
        name="scanx-core (in-house)"
        sub={
          shot.core.length
            ? `${shot.coreMs} ms · margin ${shot.coreMargin.toFixed(2)} · ${shot.coreModule.toFixed(1)} px per narrow bar`
            : `${shot.coreMs} ms · ${shot.coreError ?? 'no read'}`
        }
        codes={shot.core}
        formats={shot.coreFormat ? [shot.coreFormat] : []}
        ms={`${shot.coreMs} ms`}
      />

      {!!shot.error && (
        <>
          <Hairline />
          <Text style={{ color: T.needle, fontSize: 12.5, paddingHorizontal: 18, paddingVertical: 12 }}>
            ScanX: {shot.error}
          </Text>
        </>
      )}
      {!!shot.zxError && (
        <>
          <Hairline />
          <Text style={{ color: T.needle, fontSize: 12.5, paddingHorizontal: 18, paddingVertical: 12 }}>
            zxing: {shot.zxError}
          </Text>
        </>
      )}
    </Surface>
  );
}

function Engine({
  name, sub, codes, formats, ms,
}: { name: string; sub: string; codes: string[]; formats: string[]; ms: string }) {
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text style={{ color: T.ink, fontSize: 14, fontWeight: '700', flex: 1 }}>{name}</Text>
        <Text style={[mono(12, '600'), { color: T.faint }]}>{ms}</Text>
      </View>
      <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>{sub}</Text>

      {codes.length === 0 ? (
        <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 9, fontStyle: 'italic' }}>
          nothing
        </Text>
      ) : (
        codes.map((c, i) => (
          <View key={`${c}-${i}`} style={{ marginTop: 9 }}>
            <Text style={[mono(14, '700'), { color: T.ink }]} selectable>{c}</Text>
            {!!formats[i] && (
              <Text style={{ color: T.faint, fontSize: 11, marginTop: 2 }}>{formats[i]}</Text>
            )}
          </View>
        ))
      )}
    </View>
  );
}

function HistoryRow({ shot }: { shot: Shot }) {
  const v = VERDICT[shot.verdict];
  const shown = shot.scanx[0] ?? shot.current[0] ?? '—';
  return (
    <View style={{
      paddingHorizontal: 18, paddingVertical: 13,
      flexDirection: 'row', alignItems: 'center', gap: 12,
    }}>
      <Icon name={v.icon} size={ICON.sm} color={v.tone} />
      <Text style={[mono(13, '600'), { color: T.ink, flex: 1 }]} numberOfLines={1}>
        {shown}
      </Text>
      <Text style={{ color: T.faint, fontSize: 11.5 }}>{v.short}</Text>
    </View>
  );
}

/* ── bits ─────────────────────────────────────────────────────────────────── */

const VERDICT: Record<Verdict, {
  label: string; short: string; tone: string; icon: React.ComponentProps<typeof Icon>['name'];
}> = {
  agree: { label: 'Both read it the same', short: 'same', tone: T.bottle, icon: 'check-circle' },
  'scanx-only': { label: 'Only ScanX read it', short: 'ScanX only', tone: T.amber, icon: 'trending-up' },
  'current-only': { label: "Only today's decoder read it", short: 'today only', tone: T.needle, icon: 'alert-triangle' },
  differ: { label: 'They disagreed', short: 'differ', tone: T.needle, icon: 'alert-octagon' },
  neither: { label: 'Neither read it', short: 'neither', tone: T.steel, icon: 'minus-circle' },
};

function judge(current: string[], scanx: string[]): Verdict {
  if (!current.length && !scanx.length) return 'neither';
  if (!current.length) return 'scanx-only';
  if (!scanx.length) return 'current-only';
  const a = [...current].sort().join('');
  const b = [...scanx].sort().join('');
  return a === b ? 'agree' : 'differ';
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function Segments<V extends string | number>({
  label, items, value, onChange,
}: {
  label: string;
  items: Array<{ value: V; label: string }>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <Surface>
      <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
        <Text style={{ color: T.faint, fontSize: 11.5, fontWeight: '600' }}>{label}</Text>
      </View>
      <View style={{ flexDirection: 'row', padding: 6, gap: 6 }}>
        {items.map((it) => {
          const on = it.value === value;
          return (
            <Pressable
              key={String(it.value)}
              onPress={() => onChange(it.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${label} ${it.label}`}
              style={({ pressed }) => ({
                flex: 1, minHeight: 44, borderRadius: T.radiusSm,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: on ? T.stamp : pressed ? T.soft : 'transparent',
                borderWidth: 1, borderColor: on ? T.rule : 'transparent',
              })}
            >
              <Text style={{
                color: on ? T.ink : T.faint,
                fontSize: 12.5, fontWeight: on ? '700' : '600',
              }}>
                {it.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Surface>
  );
}

function Row({ label, value, mono: isMono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', gap: 14 }}>
      <Text style={{ color: T.faint, fontSize: 13.5, flex: 1 }}>{label}</Text>
      <Text
        style={[
          isMono ? mono(14, '600') : { fontSize: 14.5, fontWeight: '600' },
          { color: T.ink, textAlign: 'right', flexShrink: 1 },
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}
