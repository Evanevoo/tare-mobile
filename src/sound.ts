import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * Scan and submit sound feedback.
 *
 * Haptics already existed on the scan and mode-toggle paths (see scan.tsx's
 * take()) — nothing played a sound on any of it, and finish() had no
 * feedback of any kind. A driver with the phone in a chest pocket, gloves
 * on, or a noisy truck cab had no way to know a scan landed or an order
 * actually went out, short of watching the screen. Three short synthesized
 * tones (no licensing, no asset hunting) close that gap.
 *
 * Imperative players, not the useAudioPlayer hook — take() and finish() are
 * plain functions called from deep inside a scan loop and a submit handler,
 * not components, so there is nothing to attach a hook to.
 *
 * mixWithOthers, not exclusive audio focus: this app has no music or video
 * of its own, and grabbing focus for a 150ms beep would be a worse driver
 * experience than any two apps ever colliding here. playsInSilentMode is on
 * because drivers commonly carry the phone with the ring switch off, and a
 * feedback sound that silences itself exactly when a chest-pocketed phone
 * needs it most would be pointless.
 *
 * Every call is wrapped — a missing player, a failed decode, a device with
 * no audio output, none of that may ever block or throw into a scan.
 */

let audioModeReady: Promise<void> | null = null;
function ensureAudioMode(): Promise<void> {
  if (!audioModeReady) {
    audioModeReady = setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'mixWithOthers',
    }).catch(() => {});
  }
  return audioModeReady;
}

function safePlayer(source: number): AudioPlayer | null {
  try {
    return createAudioPlayer(source);
  } catch {
    return null;
  }
}

// Bundled, not fetched — synthesized tones checked into the repo so playback
// never depends on network or CDN availability in a yard with no signal.
const acceptPlayer = safePlayer(require('../assets/sounds/scan-accept.wav'));
const alertPlayer = safePlayer(require('../assets/sounds/scan-alert.wav'));
const submitPlayer = safePlayer(require('../assets/sounds/submit-success.wav'));

function fire(player: AudioPlayer | null) {
  if (!player) return;
  ensureAudioMode().finally(() => {
    try {
      player.seekTo(0);
      player.play();
    } catch {}
  });
}

/** A scan that counted — a queued cylinder, shipped or returned. */
export const playScanAccept = () => fire(acceptPlayer);

/** A scan that needs a second look — unknown barcode, or a customer code held up to the lens. */
export const playScanAlert = () => fire(alertPlayer);

/** An order actually went — the moment finish() hands scans off to sync(). */
export const playSubmitSuccess = () => fire(submitPlayer);
