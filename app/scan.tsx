import { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, FlatList, Alert, TextInput, Modal, ActivityIndicator, Animated, Vibration,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { forOrder, counts, type QueuedScan } from '@/outbox';
import { classify } from '@/scan-match';
import { playScanAccept, playScanAlert, playSubmitSuccess } from '@/sound';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, shipTone, Surface, Btn, Tag, mono } from '@/ui';
import { Scanner } from '@/scanner';
import type { AssetRec } from '@/api';

/**
 * The scan loop.
 *
 * Everything here is tuned for one situation: a driver holding a phone in cold
 * hands, in a yard, with no signal. Nothing blocks on the network, every scan
 * gets a distinct buzz, the mode toggle is thumb-sized, and the most recent
 * scan is always the biggest thing on screen.
 *
 * The visual work serves that rather than decorating it — the reticle tells you
 * where to point, the confirmation card flashes in the colour of what just
 * happened, and the active mode is a lit object rather than a tinted rectangle,
 * because shipping when you meant to receive is the expensive mistake.
 */

/**
 * WHAT KIND OF THING THIS IS, in the fewest words that are still specific.
 *
 * The bootstrap sends assets in compact keys to keep the payload small: `p` is
 * the product code, `gt` the gas type, `cat` the category, `ds` a free
 * description. A driver reading a confirmation wants the noun — "OXY 244" or
 * "Argon" — not all four, so this takes the most specific field present and
 * stops. Product code first because it is what the paperwork and the office
 * both use; gas type next because it is what the bottle is; category and
 * description are the fallbacks for fleets that fill neither.
 *
 * Returns null when the org knows nothing about this barcode, which is a real
 * and common case (a new bottle scanned before the office has typed it in) and
 * must render as nothing rather than as "Unknown".
 */
function kindOf(a: { p?: string | null; gt?: string | null; cat?: string | null; ds?: string | null } | undefined): string | null {
  if (!a) return null;
  const pick = (a.p || a.gt || a.cat || a.ds || '').trim();
  return pick.length ? pick : null;
}

export default function Scan() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    orderNumber, customerName, customerListId, mode, setMode,
    outbox, addScan, dispatch, endDelivery, boot, sync, syncing, dbUnavailable,
  } = useStore();

  const [last, setLast] = useState<{ barcode: string; kind: string } | null>(null);
  const [manual, setManual] = useState(false);
  const [manualCode, setManualCode] = useState('');
  // The scan history (list, undo, submit) used to sit permanently below a
  // 36%-height camera box. The camera is now full-screen, so that content
  // moved into a sheet a driver opens on purpose — see the "Order · N" pill
  // in the header below. Closing it changes nothing about the order; it is
  // a review surface, not a step in the loop.
  const [review, setReview] = useState(false);
  // The bottom overlay (readout + SHIP/RETURN) is measured, not guessed, so
  // Scanner's own torch/zoom/Snap/Read-text stack (bottom-right, see
  // `controlsBottomInset` in scanner.tsx) never sits underneath it. 230 is
  // just a reasonable first-frame guess before onLayout reports the real
  // number.
  const [bottomH, setBottomH] = useState(230);
  // One tick per cooldown window, not one per frame — see `onDuplicate()`.
  const cooldownNoted = useRef<Record<string, boolean>>({});
  const geo = useRef<{ lat: number; lng: number; accuracyM: number | null; at: number } | null>(null);

  /**
   * REMOVE, WITH A WAY BACK.
   *
   * The old Remove button had no confirm and no undo — one mistap on a moving
   * truck and a real scan was gone with nothing recorded anywhere that it had
   * ever existed. A confirmation dialog was the other option and the wrong
   * one for this screen: it stops the batch to ask a question on every single
   * correction, which is the opposite of what a fast-moving scan loop needs.
   * An undo affordance gets the same safety without the interruption — it
   * costs nothing when nobody needed it, and it is one tap when they did.
   * Single slot on purpose: only the most recent removal is undoable, which
   * matches what a driver actually means by "wait, put that back."
   */
  const [removed, setRemoved] = useState<{ scan: QueuedScan } | null>(null);
  const removedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (removedTimer.current) clearTimeout(removedTimer.current); }, []);

  // The confirmation card flashes on each accepted scan. On a phone held at
  // arm's length this is read peripherally — you should not have to focus on
  // the screen to know the scan landed.
  const flash = useRef(new Animated.Value(0)).current;

  const rows = orderNumber ? forOrder(outbox, orderNumber) : [];
  const c = counts(outbox, orderNumber ?? undefined);

  /**
   * ONE FIX, STAMPED ON EVERY SCAN, IS NOT EVIDENCE OF WHERE A SCAN HAPPENED.
   *
   * This took a single position when the screen mounted and wrote it onto
   * every barcode taken afterwards. The dispute packet prints that as
   * "Location at scan", to four decimal places — about eleven metres — for a
   * bottle that may have been scanned an hour later at the far end of a yard,
   * or at the next customer if the driver never left the screen. Precision
   * with no basis is worse than a blank field, because the packet is the
   * document the argument is settled from.
   *
   * A watch keeps it honest at no extra cost to the driver: the fix is
   * whatever the phone last knew, and it goes stale in seconds rather than
   * hours. The 25 m / 10 s thresholds are deliberately loose — this locates a
   * delivery, not a cylinder, and a tight filter would drain the battery of
   * the one device the shift depends on.
   *
   * Anything older than two minutes is dropped rather than attached. "We do
   * not know" is a truthful answer and the packet already renders it.
   */
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;

      const stamp = (p: Location.LocationObject) => {
        geo.current = {
          lat: p.coords.latitude, lng: p.coords.longitude,
          accuracyM: p.coords.accuracy ? Math.round(p.coords.accuracy) : null,
          at: p.timestamp ?? Date.now(),
        };
      };

      stamp(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (cancelled) return;

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 10_000 },
        stamp,
      );
    })().catch(() => {});

    return () => { cancelled = true; sub?.remove(); };
  }, []);

  /** The fix only counts if it is recent enough to describe THIS scan. */
  const freshGeo = () => {
    const g = geo.current;
    if (!g) return undefined;
    if (Date.now() - g.at > 120_000) return undefined;
    return { lat: g.lat, lng: g.lng, accuracyM: g.accuracyM };
  };

  /**
   * LEAVING IS A SIDE EFFECT, SO IT CANNOT HAPPEN DURING RENDER.
   *
   * This was `if (!orderNumber || !customerListId) { router.replace('/'); return null; }`
   * written inline, which React reports as:
   *
   *   Cannot update a component while rendering a different component
   *
   * That warning is not cosmetic here. expo-router's `linkTo` writes into a
   * store other components are subscribed to, so redirecting mid-render mutates
   * navigation state while React is still walking the tree, and the update it
   * schedules can be dropped or applied against a tree that no longer exists.
   *
   * It also fired on the ordinary path rather than some edge case: `finish()`
   * calls `endDelivery()`, which clears `orderNumber`, which re-renders this
   * screen with nothing left to scan against — one tick before the `replace()`
   * it had already issued has committed. Every completed delivery went through
   * it.
   *
   * The guard itself stays. A scan screen with no order is not a screen, it is
   * a way to file scans against nothing. It just runs after the commit now, and
   * renders nothing in the single frame before the redirect lands.
   */
  const ready = Boolean(orderNumber && customerListId);
  useEffect(() => { if (!ready) router.replace('/'); }, [ready, router]);
  if (!ready) return null;

  /**
   * A SILENT COOLDOWN IS A CAMERA THAT LOOKS DEAD.
   *
   * The scanner reads the same code every frame while it stays in view.
   * Swallowing every one of those with zero feedback for the Scanner's own
   * 2.5s cooldown (see `deliver()` in src/scanner.tsx) made a live camera
   * indistinguishable from a broken one — the one complaint a driver has no
   * way to describe except "it stopped working."
   *
   * This used to be a second, screen-level cooldown check duplicating the
   * Scanner's own — and it could never fire, because the Scanner already
   * suppresses a repeat of the same code before `take()` is ever called
   * again for it. Found comparing this file line by line against the legacy
   * scanner (2026-08-18): the intended "prove the loop is alive" tick had
   * never once fired in production. `onDuplicate` is the Scanner reporting
   * the suppression itself, so this can react to it instead of guessing.
   *
   * One light tick, the first time a cooldown window blocks a read rather
   * than every frame it does, proves the loop is alive without re-queuing
   * the scan or buzzing continuously while the phone sits still over a
   * barcode.
   */
  function onDuplicate(barcode: string) {
    if (!cooldownNoted.current[barcode]) {
      cooldownNoted.current[barcode] = true;
      Haptics.selectionAsync();
    }
  }

  function take(raw: string) {
    const barcode = raw.trim().toUpperCase();
    if (!barcode) return;
    // A fresh accepted code starts a new cooldown window at the Scanner
    // level; reset the tick guard so the next window gets its own one tick.
    cooldownNoted.current[barcode] = false;

    /**
     * A CUSTOMER CARD IS NOT A CYLINDER.
     *
     * This loop used to hand every accepted read straight to addScan(), which
     * queues it as a bottle on the current order no matter what it actually
     * was. delivery.tsx guards its order-number field with classify() for
     * exactly this reason — a mis-scanned code landing silently in the wrong
     * place is the error that makes an invoice unexplainable later — but the
     * scan loop itself had no such guard. A driver who reflexively scanned
     * the customer's card instead of a bottle (easy to do: same clipboard,
     * same motion) got a normal "Shipped out" confirmation and a cylinder
     * queued under a barcode that will never match anything real. Nothing
     * about that looked wrong on the phone; it surfaced weeks later as an
     * unexplained line on a statement.
     *
     * Only the customer case is rejected. An unrecognised code still queues
     * as an unknown cylinder — see addScan() — because a bottle the office
     * has not synced yet is common and must never be refused in the field.
     */
    const target = classify(barcode, boot);
    if (target?.kind === 'customer') {
      setLast({ barcode, kind: 'customer' });
      flash.setValue(1);
      Animated.timing(flash, { toValue: 0, duration: 620, useNativeDriver: false }).start();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // Error gets the longest buzz of the three — see the glove note below.
      Vibration.vibrate([0, 160, 90, 160]);
      playScanAlert();
      return;
    }

    const kind = addScan(barcode, freshGeo());
    setLast({ barcode, kind });

    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 620, useNativeDriver: false }).start();

    // Duplicate stays quiet on purpose — see `take()`'s cooldown-tick comment
    // above: a repeat read of a code still in view is the normal case while
    // the phone holds steady over it, and a sound on every one of those
    // would turn "still pointed at the same barcode" into a nuisance beep.
    //
    // Why Vibration.vibrate ALONGSIDE the Haptics call: driver feedback
    // (17 Aug — "more vibrate feedback for each scan cause it's hard to feel
    // through gloves"). expo-haptics maps to the OS's semantic feedback,
    // which on most Androids is a refined tick tuned for a bare fingertip;
    // Vibration drives the motor for a real, gloved-hand buzz. Durations
    // are deliberate: a short solid thump for accept, a longer double for
    // unknown — distinguishable by feel alone, without looking at the
    // screen. Duplicates keep only the light tick; a strong buzz there
    // would read as "another one counted", which is exactly wrong.
    if (kind === 'added' || kind === 'unknown') {
      // A different code has been read, so the next repeat of whatever was
      // last flagged as a duplicate is a genuine second visit rather than the
      // phone still sitting over the same label — let it speak again.
      lastDupe.current = null;
    }

    if (kind === 'added') { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); Vibration.vibrate(90); playScanAccept(); }
    else if (kind === 'unknown') { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); Vibration.vibrate([0, 130, 90, 130]); playScanAlert(); }
    else if (kind === 'duplicate') dupe(barcode);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  /**
   * A REPEAT READ AND A SECOND SCAN ARE THE SAME EVENT TO THE DECODER AND
   * COMPLETELY DIFFERENT EVENTS TO THE DRIVER.
   *
   * Holding the phone steady over a barcode produces `duplicate` several
   * times a second, and that is the case the silence above was written for —
   * a beep on each would be a nuisance and would read as "another one
   * counted", which is exactly wrong. But the same silence also covers the
   * case that actually matters: picking a bottle up, scanning it, and
   * scanning it again a minute later because you lost track. Legacy played a
   * dedicated duplicate sound, buzzed a double pulse and left a message up
   * for five seconds; ours said nothing at all, which is why it reads as
   * "it let me scan it twice" — it did not, it just never said so.
   *
   * So: the first repeat of a given barcode within a session speaks up, and
   * subsequent repeats of that SAME barcode go quiet again until a different
   * code intervenes. Holding steady stays silent after the first tick.
   * Coming back to a bottle later is loud, because by then something else
   * has been scanned in between.
   *
   * Deliberately NOT the accept buzz. A double pulse with a gap is what the
   * legacy app used for duplicates and what a gloved hand can tell apart
   * from the single solid thump of a real add without looking.
   */
  const lastDupe = useRef<string | null>(null);
  function dupe(barcode: string) {
    if (lastDupe.current === barcode) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    }
    lastDupe.current = barcode;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Vibration.vibrate([0, 60, 70, 60]);
    playScanAlert();
  }

  /**
   * ONE EXIT, ONE CONFIRMATION, WHICHEVER CONTROL YOU PRESSED.
   *
   * This was reachable two ways with two different levels of care. The Submit
   * bar wrapped it in an Alert; the "Done" word at the top of the header
   * called it bare. Both run the same body — endDelivery() and a replace() to
   * Home — so a driver with forty bottles queued who tapped Done submitted the
   * lot and left the screen, with nothing asked and nothing to undo.
   *
   * The `if (n)` guard below reads like it was meant to prevent exactly that,
   * and it does gate the haptic, the buzz, the sound and the sync. But
   * endDelivery() and the navigation sat ABOVE it and ran regardless, so the
   * intent never reached the two lines that actually end the order.
   *
   * The confirmation now lives in here rather than in either caller, so it
   * cannot go missing from one of them again. An empty order still leaves
   * silently — there is nothing to confirm, and a driver who opened this
   * screen by mistake should not have to answer a question to get out of it.
   *
   * CALL IT AS `() => finish()`, NEVER `onPress={finish}`. Pressable hands the
   * press event to its handler as the first argument, which would arrive here
   * as a truthy `confirmed` and skip the very dialog this exists to show.
   *
   * WHAT CONFIRMATION MEANS HERE CHANGED, AND WHY.
   *
   * It used to be an Alert reading "3 shipped, 1 returned." Two numbers are
   * not a check — they are the same two numbers already on the header pill,
   * and a driver cannot tell from them whether the bottle they scanned twice
   * by accident is in there, or whether the one they meant to scan is
   * missing. Confirming a total you cannot inspect is a formality, and the
   * legacy app knew better: it showed the line items.
   *
   * So Done now opens the review sheet — the itemised list, with what each
   * barcode actually is — and Submit lives at the bottom of it, next to the
   * evidence. Same list that was already one tap away behind the count pill;
   * it was simply in the wrong place for the one moment it matters most.
   *
   * An empty order still leaves silently. There is nothing to review, and a
   * driver who opened this screen by mistake should not have to dismiss a
   * sheet to get out of it.
   */
  function finish(confirmed = false) {
    const n = c.pending;

    if (n && !confirmed) {
      setReview(true);
      return;
    }

    if (removedTimer.current) clearTimeout(removedTimer.current);
    setRemoved(null);

    /**
     * DISMISS THE SHEET BEFORE LEAVING THE SCREEN. THIS LINE IS THE BUG FIX.
     *
     * Reported 19 Aug 2026, twice, from a real delivery to Flatstone
     * Construction: "scanned a delivery, then clicked Done, Submit, and the
     * screen went grey and froze. Closed the app, and the scan is gone."
     *
     * Submit lives INSIDE this Modal, so pressing it ran the whole of finish()
     * with `review` still true. `router.replace('/')` then tore this screen
     * down while a visible Modal was still mounted on it. On Android a Modal
     * is a real platform dialog window, not a view in the tree: unmounting its
     * owner without lowering `visible` first leaves that window orphaned on
     * top of the app. It renders as a grey sheet over the new screen and
     * swallows every touch, and there is no way back — the only exit is force
     * closing the app. Exactly what was reported, both times.
     *
     * `onRequestClose` was the only place that ever set this false, which is
     * the Android back button — so the one path a driver actually uses to
     * finish a delivery was the one path that never dismissed the sheet.
     *
     * The data loss is the second half and is fixed separately, in the outbox:
     * force-closing during the sync this function kicks off used to strand
     * every row in UPLOADING for ever. See RECOVER_INFLIGHT.
     */
    setReview(false);

    /**
     * AND THEN LET THE SHEET ACTUALLY CLOSE BEFORE LEAVING.
     *
     * Dismissing the Modal and calling router.replace in the same synchronous
     * block fixed the grey frozen screen and produced a BLACK one instead —
     * reported on the very next delivery. Both are the same underlying race.
     * `setReview(false)` does not close an Android dialog window; it schedules
     * a React re-render which then asks the platform to close it, and that
     * takes a frame. Tearing the owning screen down inside that frame — while
     * the dialog is mid-dismiss and a live CameraView is being unmounted on
     * the same commit — leaves the app showing this screen's own black
     * background with nothing left mounted on it.
     *
     * One frame of patience removes the race entirely. 150ms rather than a
     * bare requestAnimationFrame because the work being waited on is native
     * dialog teardown plus camera release, not a JS paint, and a driver cannot
     * perceive the difference.
     *
     * THE SYNC IS KICKED OFF FIRST, DELIBERATELY. Whatever the UI does next,
     * the scans are already on their way, and if this process dies mid-flight
     * RECOVER_INFLIGHT puts them back in the queue at next launch. Data
     * safety must not depend on the navigation succeeding — that assumption
     * is what cost the Flatstone delivery.
     */
    if (n) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The order going out deserves the most confident buzz of all — one
      // long solid pulse, unmistakable through gloves and a coat pocket.
      Vibration.vibrate(250);
      playSubmitSuccess();
      sync().catch(() => {});
    }

    // Both together, on the far side of the wait. Clearing the job while this
    // screen is still mounted would leave it rendering for a frame with no
    // order and no customer — the exact inconsistent state its own guard was
    // once written to bail out of.
    setTimeout(() => {
      endDelivery();
      router.replace('/');
    }, 150);
  }

  /** What this org knows about the thing just scanned, if it knows it. */
  const rec = last ? boot?.assets[last.barcode] : undefined;

  const banner =
    last?.kind === 'duplicate' ? { text: 'Already scanned', tone: T.steel }
    : last?.kind === 'customer' ? { text: 'That is a customer code, not a cylinder — scan the bottle', tone: T.needle }
    : last?.kind === 'unknown' ? { text: 'New barcode — recorded; the office assigns its type', tone: T.amber }
    : last ? { text: mode === 'SHIP' ? 'Shipped out' : 'Returned in', tone: T.bottle }
    : null;

  /**
   * A PLAIN SCAN IS THE COMMON CASE AND SHOULD LOOK LIKE IT.
   *
   * Every accepted read used to render the same full card — colour bar,
   * FULL/EMPTY + OUT/IN-HOUSE chips, a banner sentence — whether or not there
   * was anything to read. That is the right amount of information for a
   * duplicate, a customer code, an unrecognised barcode, or a cylinder the
   * office has flagged; it is clutter for the thing that happens every few
   * seconds and needs nothing more than "yes, that one, got it." Only the
   * cases that actually need a driver's judgement get the full treatment —
   * the odd-status one in particular is a genuine stop-and-look safety catch
   * (see StateChips below), not decoration.
   */
  const oddStatus = rec ? (rec.s !== 'available' && rec.s !== 'rented') : false;
  const needsFullCard = last ? (last.kind !== 'added' || oddStatus) : false;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* ── full-screen camera ──
          Used to be a fixed 36%-height box with everything else stacked
          below it — mode toggle, a permanently-visible last-scan card, the
          whole order list. That put most of the screen on things a driver
          reads occasionally and the smallest part on the one thing he is
          actually holding the phone up to do. Everything below is `children`
          now: drawn over the live preview (Scanner already supports this —
          see warehouse.tsx's scanning modal for the same pattern), so the
          reticle shows where to point and the readout/SHIP/RETURN below are
          readable without looking away from the barcode. `controlsBottomInset`
          is the measured height of the bottom overlay, so Scanner's own
          torch/zoom/Snap/Read-text stack sits above it instead of under it. */}
      <Scanner
        onCode={take}
        onDuplicate={onDuplicate}
        style={{ flex: 1 }}
        controlsBottomInset={bottomH}
      >
        {/* ── header ── */}
        <LinearGradient
          colors={['rgba(0,0,0,0.82)', 'rgba(0,0,0,0.34)', 'transparent']}
          // Measured, not guessed: `paddingTop: 54` was one phone's status
          // bar. On a Dynamic Island it crowded the notch; on a small status
          // bar it floated too low — "not lined up". The inset IS the answer.
          style={{ position: 'absolute', top: 0, left: 0, right: 0,
                   paddingTop: insets.top + 12,
                   paddingHorizontal: 18, paddingBottom: 30 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable
              onPress={() => finish()}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel={c.total ? `Done. Submits ${c.total} scans on this order` : 'Done. Leave this order'}
            >
              <Text style={{ color: '#fff', fontSize: 15.5, fontWeight: '700' }}>Done</Text>
            </Pressable>
            <View style={{ marginLeft: 14, flex: 1 }}>
              <Text numberOfLines={1} style={{ color: '#fff', fontSize: 14.5, fontWeight: '700' }}>
                {customerName}
              </Text>
              <Text style={[mono(12, '500'), { color: 'rgba(255,255,255,0.68)' }]}>
                {orderNumber}
              </Text>
            </View>
            {/* Everything the old stacked layout showed at all times — the
                order list, Remove, Undo, Submit — is one tap away here
                instead. The number on the pill is the answer to "how many so
                far", which is the only part of that a driver needs mid-scan. */}
            <Pressable
              onPress={() => setReview(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Review this order. ${c.total} scanned`}
              style={({ pressed }) => ({
                marginRight: 12, minWidth: 38, minHeight: 34, paddingHorizontal: 10,
                borderRadius: 17, backgroundColor: pressed ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.16)',
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
                alignItems: 'center', justifyContent: 'center',
              })}
            >
              <Text style={[mono(13, '800'), { color: '#fff' }]}>{c.total}</Text>
            </Pressable>
            <Pressable onPress={() => setManual(true)} hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Type a barcode by hand">
              <Text style={{ color: T.brandLit, fontSize: 14, fontWeight: '700' }}>Type code</Text>
            </Pressable>
          </View>
          {/* The moment this matters is right here, not on Home — this is
              the screen where a scan that never reaches disk is happening. */}
          {dbUnavailable && (
            <Text
              numberOfLines={1}
              style={{ color: T.needle, fontSize: 11.5, fontWeight: '800', marginTop: 8 }}
            >
              Not saving to this phone — upload before you stop
            </Text>
          )}
        </LinearGradient>

        {/* ── bottom overlay: readout, then SHIP/RETURN ──
            WHAT IT IS, AND WHAT JUST HAPPENED TO IT, ARE TWO DIFFERENT FACTS.
            The card's frame still flashes in the colour of the EVENT and the
            chips still carry the STATE, same reasoning as before — see
            `needsFullCard` above for what changed: a plain accepted scan now
            gets only the barcode, large, and nothing else competing for the
            eye. Measured via onLayout so Scanner's own bottom-right controls
            (see `controlsBottomInset` above) never land underneath it. */}
        <View
          onLayout={(e) => setBottomH(Math.round(e.nativeEvent.layout.height))}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
          <LinearGradient
            colors={['transparent', 'rgba(7,9,10,0.58)', 'rgba(7,9,10,0.9)']}
            style={{ paddingHorizontal: 14, paddingTop: 46, paddingBottom: 34 }}
          >
            <Animated.View
              style={{
                borderRadius: T.radius, justifyContent: 'center', overflow: 'hidden',
                minHeight: needsFullCard ? 108 : 58,
                borderWidth: 1,
                borderColor: flash.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['rgba(255,255,255,0.18)', banner?.tone ?? 'rgba(255,255,255,0.18)'],
                }),
                backgroundColor: flash.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['rgba(255,255,255,0.06)', (banner?.tone ?? T.steel) + '3D'],
                }),
              }}
            >
              {banner && last ? (
                needsFullCard ? (
                  <View style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: banner.tone }} />
                    <View style={{ flex: 1 }}>
                      <Text
                        numberOfLines={1}
                        style={[
                          mono(last.barcode.length > 16 ? 19 : last.barcode.length > 12 ? 22 : 26, '800'),
                          { color: '#fff', letterSpacing: -1 },
                        ]}
                      >
                        {last.barcode}
                      </Text>
                      {rec && (
                        <View style={{
                          flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 7,
                          flexWrap: 'wrap', rowGap: 6,
                        }}>
                          <StateChips a={rec} />
                          {rec.p ? (
                            <Text
                              numberOfLines={1}
                              style={[mono(12, '600'), { color: 'rgba(255,255,255,0.68)', flexShrink: 1 }]}
                            >
                              {rec.p}
                            </Text>
                          ) : null}
                        </View>
                      )}
                      <Text
                        numberOfLines={2}
                        style={{ color: banner.tone, fontSize: 12.5, marginTop: 7, fontWeight: '700' }}
                      >
                        {banner.text}
                      </Text>
                    </View>
                  </View>
                ) : (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                    <Text
                      numberOfLines={1}
                      style={[
                        mono(last.barcode.length > 16 ? 22 : last.barcode.length > 12 ? 27 : 32, '800'),
                        { color: '#fff', letterSpacing: -1 },
                      ]}
                    >
                      {last.barcode}
                    </Text>
                    {/*
                      WHAT IT WAS, NOT JUST WHICH ONE.
                      A barcode alone confirms the read landed but not that the
                      right THING was picked up — and on a rack of identical
                      cylinders the number is the one part a driver cannot check
                      by looking. Asked for directly, 19 Aug: "the screen should
                      show what kind of asset was scanned last."
                      Only on the plain path; the full card already carries the
                      product beside its chips.
                    */}
                    {kindOf(rec) ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          color: 'rgba(255,255,255,0.72)', fontSize: 13.5,
                          fontWeight: '700', marginTop: 4,
                        }}
                      >
                        {kindOf(rec)}
                      </Text>
                    ) : null}
                  </View>
                )
              ) : (
                <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13.5, textAlign: 'center', paddingHorizontal: 20 }}>
                  Point the camera at a barcode.
                </Text>
              )}
            </Animated.View>

            {/* ── mode: the single most-pressed control on the phone ──
                Translucent over the live feed on purpose — two clear boxes
                over the camera, not two opaque tiles blocking it, so the
                yard stays visible behind them while SHIP OUT / RETURN IN
                stays the loudest thing in the frame. */}
            <View style={{ flexDirection: 'row', gap: 11, marginTop: 12 }}>
              {(['SHIP', 'RETURN'] as const).map((m) => {
                const on = mode === m;
                const tone = shipTone(m);
                return (
                  <Pressable
                    key={m}
                    onPress={() => { setMode(m); Haptics.selectionAsync(); }}
                    style={{ flex: 1 }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={
                      m === 'SHIP'
                        ? `Ship out. ${c.ship} scanned`
                        : `Return in. ${c.ret} scanned`
                    }
                  >
                    <View
                      style={{
                        // minHeight, not height — see the original note this
                        // carried forward: text scales with the system size
                        // setting, and a clipped SHIP OUT is the one label in
                        // the app that must never be ambiguous.
                        minHeight: 72, paddingVertical: 10, borderRadius: T.radiusSm,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: on ? tone + '4D' : 'rgba(255,255,255,0.07)',
                        borderWidth: on ? 1.5 : 1,
                        borderColor: on ? tone : 'rgba(255,255,255,0.25)',
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16.5, fontWeight: '900', letterSpacing: 0.4 }}>
                        {m === 'SHIP' ? 'SHIP OUT' : 'RETURN IN'}
                      </Text>
                      <Text style={{ color: on ? '#fff' : 'rgba(255,255,255,0.7)', fontSize: 11.5, marginTop: 2, fontWeight: '700' }}>
                        {m === 'SHIP' ? `${c.ship} scanned` : `${c.ret} scanned`}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </LinearGradient>
        </View>
      </Scanner>

      {/* ── undo, one slot, six seconds ──
          Floats above everything, including the review sheet — a removal
          only happens from inside that sheet, but the driver may close it
          right after tapping Remove, and the undo window should survive
          that. */}
      {removed && (
        <View style={{ position: 'absolute', left: 14, right: 14, bottom: 28 }}>
          <Pressable
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              if (removedTimer.current) clearTimeout(removedTimer.current);
              dispatch({ type: 'ENQUEUE', scan: removed.scan });
              setRemoved(null);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Undo removing ${removed.scan.barcode}`}
          >
            <Surface level={3}>
              <View style={{
                paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 10,
              }}>
                <Text
                  numberOfLines={1}
                  style={[mono(13, '600'), { color: T.faint, flex: 1 }]}
                >
                  Removed {removed.scan.barcode}
                </Text>
                <Text style={{ color: T.brandLit, fontSize: 13.5, fontWeight: '800' }}>
                  Undo
                </Text>
              </View>
            </Surface>
          </Pressable>
        </View>
      )}

      {/* ── order review: the list, Remove, and Submit ──
          One tap away via the header pill rather than permanently on screen
          underneath a small boxed camera. Opening or closing this changes
          nothing about the order — scanning behind it works exactly the
          same whether it is open or closed. */}
      <Modal visible={review} animationType="slide" onRequestClose={() => setReview(false)}>
        <View style={{ flex: 1, backgroundColor: T.zinc }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', paddingTop: 54,
            paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: T.rule,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.ink, fontSize: 17, fontWeight: '800' }}>This order so far</Text>
              <Text style={[mono(12, '500'), { color: T.faint, marginTop: 2 }]}>{orderNumber}</Text>
            </View>
            <Pressable onPress={() => setReview(false)} hitSlop={14}
              accessibilityRole="button" accessibilityLabel="Close">
              <Text style={{ color: T.brandLit, fontSize: 15, fontWeight: '700' }}>Close</Text>
            </Pressable>
          </View>

          <FlatList
            data={[...rows].reverse()}
            keyExtractor={(s) => s.clientId}
            contentContainerStyle={{ paddingBottom: 120 }}
            ListEmptyComponent={
              <Text style={{ color: T.faint, fontSize: 13.5, textAlign: 'center', paddingTop: 34, lineHeight: 20 }}>
                Nothing scanned yet.
              </Text>
            }
            renderItem={({ item }) => {
              const a = boot?.assets[item.barcode];
              return (
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingHorizontal: 18, paddingVertical: 13,
                  borderBottomWidth: 1, borderBottomColor: T.soft,
                }}
              >
                <View style={{ width: 3, height: 26, borderRadius: 2, backgroundColor: shipTone(item.mode) }} />
                <View style={{ flex: 1 }}>
                  <Text style={[mono(15, '600'), { color: T.ink }]}>{item.barcode}</Text>
                  {/* WHAT IT IS, NOT JUST WHICH WAY IT WENT.
                      A driver checking an order before submitting it is
                      checking that the right THINGS are on it, and a column
                      of barcodes cannot answer that — the numbers are
                      identical to look at. The product code is the only
                      thing on the row that says "this is a 60L argon" out
                      loud. Falls back to the direction alone when the office
                      has not synced the asset yet, which is exactly when the
                      UNKNOWN tag beside it is doing the talking. */}
                  <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                    {a?.p ? `${a.p} · ` : ''}
                    {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
                    {item.state !== 'QUEUED' ? ` · ${item.state.toLowerCase()}` : ''}
                  </Text>
                </View>
                {/* The same green and red as the readout card, small. Known
                    and unknown are mutually exclusive, so this never adds a
                    chip to a row that already has one. */}
                {a
                  ? <Tag label={a.f ? 'FULL' : 'EMPTY'} tone={a.f ? T.fern : T.needle} />
                  : boot ? <Tag label="UNKNOWN" tone={T.amber} /> : null}
                {item.state === 'QUEUED' && (
                  <Pressable
                    // 13pt of text with hitSlop 12 was a ~40pt target — under
                    // the 44pt floor on a destructive control on the glove
                    // screen. minHeight centres the label in a real target;
                    // the slop tops it up sideways where rows leave room.
                    hitSlop={16}
                    style={{ minHeight: 44, justifyContent: 'center' }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.barcode} from this order`}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      if (removedTimer.current) clearTimeout(removedTimer.current);
                      setRemoved({ scan: item });
                      dispatch({ type: 'REMOVE', clientId: item.clientId });
                      removedTimer.current = setTimeout(() => setRemoved(null), 6000);
                    }}
                  >
                    <Text style={{ color: T.needle, fontSize: 13, fontWeight: '700' }}>Remove</Text>
                  </Pressable>
                )}
              </View>
              );
            }}
          />

          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
            <LinearGradient
              colors={['transparent', 'rgba(7,9,10,0.92)', T.zinc]}
              style={{ paddingHorizontal: 14, paddingTop: 34, paddingBottom: 34 }}
            >
              {/* This IS the confirmation now — the sheet above it is the
                  itemised list a driver is confirming, so pressing here goes
                  straight through rather than reopening the sheet it is
                  already sitting in. `finish(true)` skips the review branch;
                  see the note on finish(). */}
              <Btn
                label={`Submit order · ${c.total}`}
                sub={c.total ? `${c.ship} out · ${c.ret} in` : undefined}
                busy={syncing}
                disabled={!c.total}
                onPress={() => { setReview(false); finish(true); }}
              />
            </LinearGradient>
          </View>
        </View>
      </Modal>

      {/* ── manual entry ── */}
      <Modal visible={manual} transparent animationType="fade" onRequestClose={() => setManual(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(3,5,6,0.78)', justifyContent: 'center', padding: 22 }}>
          <Surface level={3}>
            <View style={{ padding: 20 }}>
              <Text style={{ color: T.ink, fontSize: 18.5, fontWeight: '700', marginBottom: 5 }}>
                Type a barcode
              </Text>
              <Text style={{ color: T.faint, fontSize: 13, marginBottom: 16, lineHeight: 19 }}>
                For a label that is scratched, painted over, or under frost.
              </Text>

              {/*
                SHIP OR RETURN, DECIDED HERE, WITH THE BARCODE IN VIEW.
                Asked for 19 Aug. A typed barcode used to inherit whatever the
                toggle behind this sheet happened to be set to, and the sheet
                covers that toggle — so the one entry path where the driver
                cannot see the mode was the one path that silently used it.
                Typing a barcode is already the slow, deliberate, gloves-off
                case; it is exactly where a wrong direction is most likely and
                least noticed, and shipping when you meant to receive is the
                expensive mistake this whole screen is built around.

                This writes the real store mode rather than keeping a private
                copy, so what you pick here is what `take()` uses and what the
                toggle shows when the sheet closes — one source of truth, and
                no way for the sheet and the screen behind it to disagree.
              */}
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                {(['SHIP', 'RETURN'] as const).map((m) => {
                  const on = mode === m;
                  return (
                    <Pressable
                      key={m}
                      onPress={() => { setMode(m); Haptics.selectionAsync(); }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={m === 'SHIP' ? 'Ship out' : 'Return in'}
                      style={{
                        flex: 1, minHeight: 52, borderRadius: T.radiusSm,
                        alignItems: 'center', justifyContent: 'center',
                        borderWidth: on ? 2 : 1,
                        borderColor: on ? (m === 'SHIP' ? T.brandLit : T.bottle) : T.rule,
                        backgroundColor: on
                          ? (m === 'SHIP' ? 'rgba(56,189,248,0.16)' : 'rgba(52,211,153,0.16)')
                          : 'rgba(0,0,0,0.25)',
                      }}
                    >
                      <Text style={{
                        color: on ? T.ink : T.faint,
                        fontSize: 14.5, fontWeight: on ? '800' : '600',
                      }}>
                        {m === 'SHIP' ? 'Ship out' : 'Return in'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={manualCode} onChangeText={(v) => setManualCode(v.toUpperCase())}
                autoFocus autoCapitalize="characters" autoCorrect={false}
                placeholder="PW-K-041827" placeholderTextColor={T.faint}
                style={[
                  {
                    minHeight: 54, borderRadius: T.radiusSm, paddingHorizontal: 15, color: T.ink,
                    backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: T.rule,
                  },
                  mono(18, '600'),
                ]}
                onSubmitEditing={() => { take(manualCode); setManualCode(''); setManual(false); }}
              />
              <View style={{ flexDirection: 'row', gap: 11, marginTop: 16 }}>
                <Btn
                  label="Cancel" variant="quiet" style={{ flex: 1 }}
                  onPress={() => { setManual(false); setManualCode(''); }}
                />
                <Btn
                  label="Add" style={{ flex: 1 }}
                  disabled={!manualCode.trim()}
                  onPress={() => { take(manualCode); setManualCode(''); setManual(false); }}
                />
              </View>
            </View>
          </Surface>
        </View>
      </Modal>
    </View>
  );
}

/**
 * THE STATE OF A CYLINDER IS TWO FACTS, NOT ONE, AND THEY DO NOT RANK.
 *
 * The record carries `f` (full or empty) and `c` (the account it is out with,
 * null when it is in house) as separate fields, maintained separately: a
 * cylinder at a customer's site still has a fill state, and one on the shelf
 * still has a custody state. So "rented" is not a third value of full/empty —
 * it is the answer to a different question, and giving the two of them one
 * colour to fight over would mean the screen could only ever say half of what
 * it knows.
 *
 * Fill gets the loud colour, because it is what the driver is deciding on with
 * a cylinder in his hand — green full, red empty. Custody gets a quieter one
 * beside it. Both are spelled out in words: red and green is the single worst
 * pair for a colour-blind driver and a chip that only differs by colour would
 * be, to him, two identical chips.
 *
 * EMPTY REUSES `needle`, WHICH IS ALSO THE ERROR COLOUR — deliberately, rather
 * than adding a second red nobody could tell from the first. Red only reads as
 * "something is wrong" where it is used as an alert; here it is a state chip
 * sitting against an asset code, beside a green one, both labelled, and an
 * empty cylinder is a completely ordinary thing to be holding on a return.
 * Two reds a shade apart, one meaning "empty" and one meaning "this failed",
 * would be a far worse mistake than the one shared red.
 *
 * FILL IS THE LAST RECORDED FILL, and for something that is OUT that is as old
 * as the delivery that took it there — the customer has been using it since.
 * That is the honest reason both chips are shown rather than the fill being
 * suppressed while it is out: "recorded full, currently at Weldcor" is
 * something a driver can reason about, where either half on its own would
 * quietly mislead him.
 *
 * OUT IS BLUE, which is the brand colour and also this screen's RETURN IN
 * colour, and that collision was accepted with eyes open. Blue for "out with a
 * customer" is already what the web console shows, what the customer list on
 * the delivery screen shows, and what the company's own material uses; one
 * product cannot say "out" in two colours. The alternative was amber, which on
 * this screen already means both SHIP OUT and "we have never seen this
 * barcode" — a third meaning would have been worse, not better.
 *
 * The amber chip is the exception rather than the rule: a cylinder the office
 * has marked for maintenance, lost or retired should not be going onto a
 * truck, and a driver holding it is the last person who can stop it.
 */
function StateChips({ a }: { a: AssetRec }) {
  const odd = a.s !== 'available' && a.s !== 'rented';
  return (
    <>
      <Tag big label={a.f ? 'FULL' : 'EMPTY'} tone={a.f ? T.fern : T.needle} />
      <Tag big label={a.c ? 'OUT' : 'IN HOUSE'} tone={a.c ? T.bottle : T.steel} />
      {odd && <Tag big label={a.s.toUpperCase()} tone={T.amber} />}
    </>
  );
}
