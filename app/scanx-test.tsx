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
  size: string;
  verdict: Verdict;
  error?: string;
};

const EMPTY_TALLY = {
  runs: 0, agree: 0, scanxOnly: 0, currentOnly: 0, differ: 0, neither: 0,
  currentHits: 0, scanxHits: 0, scanxMs: 0, currentMs: 0,
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
  const [maxDim, setMaxDim] = useState(720);

  const [shots, setShots] = useState<Shot[]>([]);
  const [tally, setTally] = useState({ ...EMPTY_TALLY });

  // Pull the decoder in on mount. It is ~400 KB of generated JS and Hermes has
  // to walk all of it once; doing that here rather than on the first tap keeps
  // the first capture honest instead of charging it for the module load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await warmUp();
        const v = await coreVersion();
        if (alive) { setVersion(v); setReady(true); }
      } catch (e: any) {
        if (alive) setLoadError(e?.message ? String(e.message) : 'could not start the decoder');
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

      const photo = await cam.current.takePictureAsync({ quality: 0.9, skipProcessing: true });
      if (!photo?.uri) throw new Error('the camera returned no image');

      // A — what ships today. Given the file, not the live preview, so both
      // engines see the same frame.
      const t0 = Date.now();
      const current = await scanFromURLAsync(photo.uri).catch(() => []);
      const currentMs = Date.now() - t0;

      // B — ScanX. Resize natively first: handing a 12-megapixel JPEG through
      // base64 into the JS heap costs more than the decode does.
      const small = await manipulateAsync(
        photo.uri,
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
      const scanxWallMs = Date.now() - t1;

      const currentTexts = dedupe(current.map((c) => c.data));
      const scanxTexts = dedupe(sx.codes.map((c) => c.text));

      const shot: Shot = {
        at: Date.now(),
        current: currentTexts,
        currentFormats: dedupe(current.map((c) => String(c.type))),
        currentMs,
        scanx: scanxTexts,
        scanxFormats: dedupe(sx.codes.map((c) => c.format)),
        scanxMs: sx.ms,
        scanxWallMs,
        size: sx.w ? `${sx.sourceW}×${sx.sourceH} → ${sx.w}×${sx.h}` : '—',
        verdict: judge(currentTexts, scanxTexts),
        error: sx.error,
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
        currentMs: t.currentMs + currentMs,
        scanxMs: t.scanxMs + sx.ms,
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
          <Segments
            label="Size"
            items={[540, 720, 900].map((v) => ({ value: v, label: `${v} px` }))}
            value={maxDim}
            onChange={(v) => setMaxDim(v as number)}
          />
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
            Narrowing the formats is the biggest speed win there is, and it also removes any
            chance of a stray Code 39 read off packaging text. Size trades range for time:
            below about 1.5 pixels per bar nothing decodes, above that the extra pixels
            mostly cost seconds — and without a JIT they really are seconds.
          </Text>
          {(effort === 2 || maxDim === 900) && (
            <Text style={{ color: T.amber, fontSize: 12, marginTop: 9, lineHeight: 18 }}>
              Measured on a desktop Hermes build, one retail barcode goes from 0.2 s at
              Fast / 720 to 0.9 s at Balanced / 900, and a frame with six codes on it takes
              3.3 s at Balanced / 900. A phone is slower again. Expect this capture to take
              a while; it is the missing JIT, not the decoder.
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
        <Text style={[mono(12, '600'), { color: T.faint }]}>{shot.size}</Text>
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

      {!!shot.error && (
        <>
          <Hairline />
          <Text style={{ color: T.needle, fontSize: 12.5, paddingHorizontal: 18, paddingVertical: 12 }}>
            {shot.error}
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
