import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { RETICLE } from '@/reticle';
import { decodeBase64Image as coreDecode } from '@/scanx-core';
import { T, Btn, mono } from '@/ui';

/**
 * LIVE TEST — scanx-core ALONE, with every other decoder removed.
 *
 * WHY THIS IS NOT THE `Scanner` COMPONENT. Scanner is the app's real scan
 * surface, and its live reads come from expo-camera's `onBarcodeScanned`,
 * which is Google's ML Kit on Android and AVFoundation on iOS. Passing it a
 * different engine is not possible: the native decoder is wired into the
 * camera session itself, and anything sitting alongside it would be a race
 * between two decoders rather than a test of one. The only way to be certain
 * nothing else is reading the frame is to not ask for it — so this mounts a
 * bare CameraView with NO `barcodeScannerSettings` and NO `onBarcodeScanned`.
 * ML Kit is not running here. Every barcode on this screen was read by
 * scanx-core.
 *
 * HOW IT IS "LIVE" WHEN THE ENGINE READS STILLS. It captures on a loop:
 * photograph, crop to the reticle, decode, show, repeat. At roughly two
 * seconds a pass that is closer to a fast shutter than a video scanner, and
 * that is the honest shape of this engine today — asm.js under Hermes, which
 * has no WebAssembly and therefore no JIT. Native would be 10–100× faster and
 * genuinely live. Sweeping a rack at this speed is not the point; pointing it
 * at ONE bad label and watching what it does is.
 *
 * WHAT TO WATCH. `module` is the measured width of one narrow bar in pixels.
 * Under 2 is past the floor every other engine in this app shares, so a read
 * there is the entire reason this engine exists. `margin` is how far the
 * weakest character beat its nearest rival — the mechanism that keeps misreads
 * at zero, and the difference between a read and a confident guess.
 */

export interface CoreRead {
  code: string;
  format: string;
  margin: number;
  module: number;
  ms: number;
  at: number;
}

export function CoreLiveTest({ onClose }: { onClose: () => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView | null>(null);

  const [running, setRunning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState(false);
  const [reads, setReads] = useState<CoreRead[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [lastMiss, setLastMiss] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * Periodic refocus, the same trick src/scanner.tsx uses.
   *
   * Continuous autofocus on a lot of Android hardware locks onto whatever the
   * lens first settled on and never re-evaluates. Without a pulse of its own
   * every capture here comes back focused wherever the camera happened to land
   * at mount — usually not on a label a few inches away — and the engine gets
   * blamed for the lens.
   */
  const [focusOff, setFocusOff] = useState(false);
  useEffect(() => {
    const cycle = () => {
      setFocusOff(true);
      setTimeout(() => { if (alive.current) setFocusOff(false); }, 180);
    };
    const first = setTimeout(cycle, 600);
    const iv = setInterval(cycle, 2000);
    return () => { clearTimeout(first); clearInterval(iv); };
  }, []);

  const once = useCallback(async () => {
    if (!cam.current || busy) return;
    setBusy(true);
    try {
      const photo = await cam.current.takePictureAsync({
        quality: 0.9, shutterSound: false, skipProcessing: true,
      });
      if (!photo?.uri) return;

      /**
       * Crop to the reticle with a margin, exactly as the app's Snap path
       * does. The margin is not optional: Code 128 requires a quiet zone of
       * ten module widths either side, and a decoder that cannot see one
       * refuses the symbol outright. Cropping tight to the drawn box punishes
       * good aim.
       */
      const PAD = 0.08;
      let b64: string | undefined;
      try {
        const l = Math.max(0, RETICLE.left - PAD);
        const t = Math.max(0, RETICLE.top - PAD);
        const r = Math.min(1, RETICLE.left + RETICLE.width + PAD);
        const b = Math.min(1, RETICLE.top + RETICLE.height + PAD);
        const out = await manipulateAsync(
          photo.uri,
          [{
            crop: {
              originX: Math.round(photo.width * l),
              originY: Math.round(photo.height * t),
              width: Math.round(photo.width * (r - l)),
              height: Math.round(photo.height * (b - t)),
            },
          }],
          { base64: true, compress: 0.95, format: SaveFormat.JPEG },
        );
        b64 = out.base64 ?? undefined;
      } catch {
        b64 = photo.base64 ?? undefined;   // crop failed: try the whole frame
      }
      if (!b64) return;

      const res = await coreDecode(b64, { maxDim: 1400, minMargin: 0 });
      if (!alive.current) return;

      setAttempts((n) => n + 1);
      if (res.ok && res.text) {
        setLastMiss(null);
        setReads((prev) => [
          { code: res.text, format: res.format, margin: res.margin,
            module: res.module, ms: res.ms, at: Date.now() },
          ...prev,
        ].slice(0, 40));
      } else {
        setLastMiss(res.failure ?? res.error ?? 'no read');
      }
    } catch {
      /* a dropped frame is not worth interrupting a test for */
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [busy]);

  // The loop. Deliberately sequential — a second capture while the first is
  // still decoding would fight for the camera and measure nothing useful.
  useEffect(() => {
    if (!running) return;
    let stop = false;
    (async () => {
      while (!stop && alive.current) {
        await once();
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => { stop = true; };
  }, [running, once]);

  if (!perm?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
        <Text style={{ color: T.steel, fontSize: 14, textAlign: 'center', lineHeight: 21 }}>
          The camera is needed to test the decoder.
        </Text>
        <Btn label="Allow camera" onPress={() => { void requestPerm(); }} style={{ marginTop: 16 }} />
        <Btn label="Close" variant="quiet" onPress={onClose} style={{ marginTop: 10 }} />
      </View>
    );
  }

  const last = reads[0];

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        ref={cam}
        style={{ flex: 1 }}
        facing="back"
        enableTorch={torch}
        animateShutter={false}
        autofocus={focusOff ? 'off' : 'on'}
        /*
          NO barcodeScannerSettings AND NO onBarcodeScanned.
          That absence is the whole point of this screen: without them the
          platform decoder is never attached to the session, so nothing but
          scanx-core is reading these frames.
        */
      >
        {/* the reticle, drawn where the crop is taken */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: `${RETICLE.left * 100}%`,
            top: `${RETICLE.top * 100}%`,
            width: `${RETICLE.width * 100}%`,
            height: `${RETICLE.height * 100}%`,
            borderWidth: 2, borderColor: T.amber, borderRadius: 12,
          }}
        />

        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 52, paddingHorizontal: 18,
                       flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable onPress={onClose} hitSlop={14} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Done</Text>
          </Pressable>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', opacity: 0.85 }}>
            scanx-core only
          </Text>
          <Pressable onPress={() => setTorch((t) => !t)} hitSlop={14}
                     style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: torch ? T.amber : '#fff', fontSize: 20 }}>⚡</Text>
          </Pressable>
        </View>

        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 18, paddingBottom: 34,
                       backgroundColor: 'rgba(0,0,0,0.62)' }}>
          {last ? (
            <>
              <Text style={[mono(30, '800'), { color: '#fff', letterSpacing: -1 }]} numberOfLines={1}>
                {last.code}
              </Text>
              <Text style={{ color: T.bottle, fontSize: 13, fontWeight: '700', marginTop: 5 }}>
                {last.format} · margin {last.margin.toFixed(2)} · {last.module.toFixed(1)} px per narrow bar · {last.ms} ms
              </Text>
              {last.module > 0 && last.module < 2 && (
                <Text style={{ color: T.amber, fontSize: 12.5, fontWeight: '700', marginTop: 5 }}>
                  Below 2 px per bar — past where every other engine in this app gives up.
                </Text>
              )}
            </>
          ) : (
            <Text style={{ color: '#fff', fontSize: 15, opacity: 0.85 }}>
              {busy ? 'Reading…' : 'Point at a label. Nothing is saved.'}
            </Text>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12 }}>
            {busy && <ActivityIndicator color="#fff" />}
            <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12 }}>
              {reads.length} read · {attempts} tried
              {lastMiss && !busy ? ` · ${lastMiss}` : ''}
            </Text>
            <Pressable onPress={() => setRunning((r) => !r)} hitSlop={12}
                       style={{ marginLeft: 'auto', minHeight: 44, justifyContent: 'center' }}>
              <Text style={{ color: T.brandLit, fontSize: 14, fontWeight: '700' }}>
                {running ? 'Pause' : 'Resume'}
              </Text>
            </Pressable>
          </View>
        </View>
      </CameraView>
    </View>
  );
}
