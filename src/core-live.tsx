
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { decodeBase64Image as coreDecode, warmUp, version } from '@/scanx-core';
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
 * photograph, shrink, decode, show, repeat. A pass takes a couple of seconds,
 * which is closer to a fast shutter than a video scanner, and that is the
 * honest shape of this engine today — asm.js under Hermes, which has no
 * WebAssembly and therefore no JIT. Native would be 10-100x faster and
 * genuinely live. Sweeping a rack at this speed is not the point; pointing it
 * at ONE bad label and watching what it does is.
 *
 * WHY THERE IS NO CROP HERE ANY MORE. There was, and it was the bug: the
 * reticle's fractions describe the PREVIEW, which is full-bleed and roughly
 * 19.5:9, while the photo is about 4:3. The same numbers point at different
 * parts of the two images, so the crop landed beside the label and the screen
 * span forever reading nothing. Guessing where the label is was the wrong job
 * for this file. The decoder now sweeps bands down the frame itself and skips
 * the empty ones, so it gets the whole picture and finds the label in it.
 *
 * WHAT TO WATCH. `module` is the measured width of one narrow bar in pixels.
 * Under 2 is past the floor every other engine in this app shares, so a read
 * there is the entire reason this engine exists. `margin` is how far the
 * weakest character beat its nearest rival - the mechanism that keeps misreads
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

/**
 * The long edge handed to the decoder.
 *
 * Not the raw photo: a 12-megapixel still is mostly a picture of a warehouse,
 * and every one of those pixels is paid for three times over - JPEG decode,
 * base64 across the bridge, and the band sweep itself. At 1200 a label filling
 * half the frame still lands near four pixels per narrow bar, which is
 * comfortably inside what this engine reads, so nothing is being given away.
 */
const LONG_EDGE = 1200;

export function CoreLiveTest({ onClose }: { onClose: () => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView | null>(null);

  const [running, setRunning] = useState(true);
  const [torch, setTorch] = useState(false);
  const [reads, setReads] = useState<CoreRead[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [lastMiss, setLastMiss] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Loading the engine is a visible event, not a detail. It is a 262KB asm.js
  // module and Hermes has to evaluate all of it before the first decode; a
  // screen that just says "Reading..." through those seconds is indisputably
  // lying about what it is doing, and that is precisely how the last version
  // looked broken when it was merely slow.
  const [engine, setEngine] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      try {
        await warmUp();
        const v = await version();
        if (alive.current) setEngine(v);
      } catch (e: any) {
        if (alive.current) setEngineError(e?.message ? String(e.message) : 'engine did not start');
      }
    })();
  }, []);

  /**
   * Periodic refocus, the same trick src/scanner.tsx uses.
   *
   * Continuous autofocus on a lot of Android hardware locks onto whatever the
   * lens first settled on and never re-evaluates. Without a pulse of its own
   * every capture here comes back focused wherever the camera happened to land
   * at mount - usually not on a label a few inches away - and the engine gets
   * blamed for the lens.
   */
  const [focusOff, setFocusOff] = useState(false);
  useEffect(() => {
    const cycle = () => {
      setFocusOff(true);
      setTimeout(() => { if (alive.current) setFocusOff(false); }, 180);
    };
    const first = setTimeout(cycle, 600);
    const iv = setInterval(cycle, 2500);
    return () => { clearTimeout(first); clearInterval(iv); };
  }, []);

  /**
   * `busy` is BOTH a ref and a state, on purpose.
   *
   * The ref is the guard the capture loop reads; the state is only there to
   * drive the spinner. Guarding on the state instead meant the loop's effect
   * re-ran on every flip of it, tearing down and rebuilding the loop twice per
   * capture and leaving a torn-down copy still awaiting a decode. The ref does
   * not change identity, so the loop below starts exactly once.
   */
  const busyRef = useRef(false);

  const once = useCallback(async () => {
    if (!cam.current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      /**
       * NO `skipProcessing`. It skips EXIF rotation, so on Android the buffer
       * can come back landscape - and while the band sweep no longer cares
       * WHERE in the frame the label is, it very much cares which axis the
       * bars run across, because the profile is taken along image X.
       */
      const photo = await cam.current.takePictureAsync({
        quality: 0.9, shutterSound: false,
      });
      if (!photo?.uri) return;

      const shrunk = await manipulateAsync(
        photo.uri,
        [{ resize: photo.width >= photo.height
            ? { width: LONG_EDGE }
            : { height: LONG_EDGE } }],
        { base64: true, compress: 0.92, format: SaveFormat.JPEG },
      );
      if (!shrunk.base64) { setLastMiss('could not read the photo'); return; }

      // maxDim above the image we just made, so the decoder does not shrink it
      // a second time - the resize above already chose the resolution.
      const res = await coreDecode(shrunk.base64, { maxDim: 2000, minMargin: 0 });
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
        // The frame size and the time are reported next to the reason. Without
        // them "no barcode found" is unfalsifiable: it reads the same whether
        // the decoder failed, the photo was blank, or the engine never ran.
        setLastMiss(
          `${res.failure ?? res.error ?? 'no read'} · ${res.w}x${res.h} · ${res.ms} ms`,
        );
      }
    } catch (e: any) {
      if (alive.current) {
        setLastMiss(e?.message ? String(e.message) : 'camera did not return a frame');
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  // The loop. Deliberately sequential - a second capture while the first is
  // still decoding would fight for the camera and measure nothing useful. It
  // does not start until the engine is actually loaded, so the first pass is
  // not silently paying for module evaluation on top of a decode.
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);

  useEffect(() => {
    if (!engine) return;
    let stop = false;
    (async () => {
      while (!stop && alive.current) {
        if (runningRef.current) await once();
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => { stop = true; };
  }, [engine, once]);

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

  const status = engineError ? engineError
    : !engine ? 'Starting the decoder…'
    : busy ? 'Reading…'
    : !running ? 'Paused.'
    : 'Hold the label level and fill the width.';

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
        {/*
          An aiming guide, not a crop. The decoder reads the whole frame now,
          so this is only here to get the label roughly level and roughly
          filling the width - which is what actually decides pixels per bar.
        */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute', left: '6%', right: '6%', top: '42%', height: '16%',
            borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)', borderRadius: 10,
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
            <Text style={{ color: engineError ? T.amber : '#fff', fontSize: 15, opacity: 0.9 }}>
              {status}
            </Text>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12 }}>
            {(busy || !engine) && !engineError && <ActivityIndicator color="#fff" />}
            <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, flexShrink: 1 }}>
              {reads.length} read · {attempts} tried{lastMiss ? ` · ${lastMiss}` : ''}
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
