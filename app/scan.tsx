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
import { T, shipTone, Surface, Btn, Edge, Tag, mono, shadow, tint } from '@/ui';
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
export default function Scan() {
  const router = useRouter();
  const {
    orderNumber, customerName, customerListId, mode, setMode,
    outbox, addScan, dispatch, endDelivery, boot, sync, syncing, dbUnavailable,
  } = useStore();

  const [last, setLast] = useState<{ barcode: string; kind: string } | null>(null);
  const [manual, setManual] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const cooldown = useRef<Record<string, number>>({});
  // One tick per cooldown window, not one per frame — see `take()`.
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

  function take(raw: string) {
    const barcode = raw.trim().toUpperCase();
    if (!barcode) return;

    const now = Date.now();
    if (cooldown.current[barcode] && now - cooldown.current[barcode] < 2500) {
      /**
       * A SILENT COOLDOWN IS A CAMERA THAT LOOKS DEAD.
       *
       * The scanner reads the same code every frame while it stays in view,
       * and swallowing every one of those with zero feedback for 2.5 seconds
       * made a live camera indistinguishable from a broken one — the one
       * complaint a driver has no way to describe except "it stopped
       * working." One light tick, the first time a cooldown window blocks a
       * read rather than every frame it does, proves the loop is alive
       * without re-queuing the scan or buzzing continuously while the phone
       * sits still over a barcode.
       */
      if (!cooldownNoted.current[barcode]) {
        cooldownNoted.current[barcode] = true;
        Haptics.selectionAsync();
      }
      return;
    }
    cooldown.current[barcode] = now;
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
    if (kind === 'added') { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); Vibration.vibrate(90); playScanAccept(); }
    else if (kind === 'unknown') { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); Vibration.vibrate([0, 130, 90, 130]); playScanAlert(); }
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function finish() {
    const n = c.pending;
    if (removedTimer.current) clearTimeout(removedTimer.current);
    setRemoved(null);
    endDelivery();
    router.replace('/');
    // finish() also runs from the bare "Done" tap with nothing scanned, which
    // is a quiet exit and should stay quiet. The confirmation belongs to the
    // moment there is actually an order going out — same condition sync()
    // already gates on below, so this reuses it rather than restating it.
    if (n) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The order going out deserves the most confident buzz of all — one
      // long solid pulse, unmistakable through gloves and a coat pocket.
      Vibration.vibrate(250);
      playSubmitSuccess();
      sync().catch(() => {});
    }
  }

  /** What this org knows about the thing just scanned, if it knows it. */
  const rec = last ? boot?.assets[last.barcode] : undefined;

  const banner =
    last?.kind === 'duplicate' ? { text: 'Already scanned', tone: T.steel }
    : last?.kind === 'customer' ? { text: 'That is a customer code, not a cylinder — scan the bottle', tone: T.needle }
    : last?.kind === 'unknown' ? { text: 'New barcode — recorded; the office assigns its type', tone: T.amber }
    : last ? { text: mode === 'SHIP' ? 'Shipped out' : 'Returned in', tone: T.bottle }
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      {/* ── camera ── */}
      <View style={{ height: '36%', backgroundColor: '#000' }}>
        {/* One shared surface carries the hard-won parts: double-read
            confirm, cooldown, torch, zoom, tap-to-refocus, and the ML Kit
            still-frame fallback on builds that have it. */}
        <Scanner onCode={take} style={{ flex: 1 }} />

        {/* Scrim, so white text over a bright yard is still readable. */}
        <LinearGradient
          colors={['rgba(0,0,0,0.82)', 'rgba(0,0,0,0.34)', 'transparent']}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 54,
                   paddingHorizontal: 18, paddingBottom: 22 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable onPress={finish} hitSlop={14}>
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
            <Pressable onPress={() => setManual(true)} hitSlop={14}>
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
      </View>

      {/* ── mode: the single most-pressed control on the phone ── */}
      <View style={{ flexDirection: 'row', padding: 14, gap: 11 }}>
        {(['SHIP', 'RETURN'] as const).map((m) => {
          const on = mode === m;
          const tone = shipTone(m);
          return (
            <Pressable
              key={m}
              onPress={() => { setMode(m); Haptics.selectionAsync(); }}
              style={{ flex: 1 }}
            >
              {on ? (
                <LinearGradient
                  colors={[tone, tone + 'CC']}
                  start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                  style={[
                    { height: 66, borderRadius: T.radiusSm,
                      alignItems: 'center', justifyContent: 'center' },
                    shadow(2, tone),
                  ]}
                >
                  <Edge inset={14} opacity={0.9} />
                  <Text style={{ color: T.onBrand, fontSize: 16.5, fontWeight: '900', letterSpacing: 0.4 }}>
                    {m === 'SHIP' ? 'SHIP OUT' : 'RETURN IN'}
                  </Text>
                  <Text style={{ color: 'rgba(4,35,26,0.66)', fontSize: 11.5, marginTop: 2, fontWeight: '700' }}>
                    {m === 'SHIP' ? `${c.ship} scanned` : `${c.ret} scanned`}
                  </Text>
                </LinearGradient>
              ) : (
                <View
                  style={{
                    height: 66, borderRadius: T.radiusSm,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tint(0.04),
                    borderWidth: 1, borderColor: T.rule,
                  }}
                >
                  <Text style={{ color: T.steel, fontSize: 16.5, fontWeight: '800', letterSpacing: 0.4 }}>
                    {m === 'SHIP' ? 'SHIP OUT' : 'RETURN IN'}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2, fontWeight: '600' }}>
                    {m === 'SHIP' ? `${c.ship} scanned` : `${c.ret} scanned`}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* ── the last scan, large ──
          WHAT IT IS, AND WHAT JUST HAPPENED TO IT, ARE TWO DIFFERENT FACTS.
          The card's frame flashes in the colour of the EVENT — accepted,
          already-scanned, unrecognised — because that is feedback on the tap
          and it fades. The chips inside carry the STATE of the thing in the
          driver's hand, and they do not fade, because he is still holding it.
          Mixing the two into one colour is how "green" ends up meaning both
          "full" and "that worked".

          THE SLOT IS ALWAYS HERE, EMPTY OR NOT. It used to render only after
          the first read, so the first cylinder of every order shoved the list
          down the screen underneath a thumb that was already moving. A fixed
          minimum height costs one quiet line before the first scan and buys a
          screen that never moves again.

          `· [object Object]` LIVED HERE. The line under the barcode appended
          `boot.assets[barcode]` straight into a template string. That map used
          to hold a product code and now holds a record — store.ts version-gates
          the cache for exactly this reason — so what a driver actually saw
          after every scan of a known cylinder was the literal text
          "[object Object]". It typechecked, because template literals will
          stringify anything. */}
      <Animated.View
        style={{
          marginHorizontal: 14, marginBottom: 12, borderRadius: T.radius,
          minHeight: 130, justifyContent: 'center',
          borderWidth: 1,
          borderColor: flash.interpolate({
            inputRange: [0, 1], outputRange: [T.rule, banner?.tone ?? T.rule],
          }),
          backgroundColor: flash.interpolate({
            inputRange: [0, 1],
            outputRange: [tint(0.04), (banner?.tone ?? T.steel) + '2E'],
          }),
          overflow: 'hidden',
        }}
      >
        {banner && last ? (
          <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: banner.tone }} />
            <View style={{ flex: 1 }}>
              {/* The barcode is the answer to "which one did I just scan?", so
                  it is the biggest thing on the screen. It has to stay on one
                  line and the card has to stay the same height, so long codes
                  are stepped down instead of wrapping.

                  SIZED IN JS, NOT BY adjustsFontSizeToFit, BECAUSE OF ANDROID.
                  That prop looks cross-platform and is not, under the New
                  Architecture this app runs: RN serialises `adjustsFontSizeToFit`,
                  `minimumFontSize` and `maximumFontSize` across to Android and
                  drops `minimumFontScale` on the way (conversions.h,
                  toMapBuffer(ParagraphAttributes)). TextLayoutManager then finds
                  no minimum, and falls back to a floor of FOUR dp. So the same
                  long code that iOS shrinks politely to ~16pt, Android is free
                  to shrink until it is unreadable — and it fails silently, on
                  the platform the drivers actually carry, in the one piece of
                  text on this screen that exists to be read at arm's length.

                  Three steps off the code's own length is duller and it is the
                  same on both phones. 30 carries the 8-to-12 character cylinder
                  codes that are almost all of them; the smaller steps are for
                  the account-length outliers. */}
              <Text
                numberOfLines={1}
                style={[
                  mono(last.barcode.length > 16 ? 21 : last.barcode.length > 12 ? 25 : 30, '800'),
                  { color: T.ink, letterSpacing: -1 },
                ]}
              >
                {last.barcode}
              </Text>
              {/* The chip row wraps, because it can hold three at once — FULL,
                  OUT and an odd-state one like MAINTENANCE — and every label in
                  the app scales with the phone's font setting. Android exposes
                  both a font size and a display size slider and drivers do turn
                  them up, at which point a row that cannot wrap runs off the
                  card instead of moving down a line. */}
              {rec && (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8,
                  flexWrap: 'wrap', rowGap: 6,
                }}>
                  <StateChips a={rec} />
                  {rec.p ? (
                    <Text
                      numberOfLines={1}
                      style={[mono(12, '600'), { color: T.faint, flexShrink: 1 }]}
                    >
                      {rec.p}
                    </Text>
                  ) : null}
                </View>
              )}
              <Text
                numberOfLines={2}
                style={{ color: banner.tone, fontSize: 13, marginTop: 8, fontWeight: '700' }}
              >
                {banner.text}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={{ color: T.faint, fontSize: 13.5, textAlign: 'center', paddingHorizontal: 20, lineHeight: 20 }}>
            The last one you scan shows here.
          </Text>
        )}
      </Animated.View>

      {/* ── this order so far ── */}
      <FlatList
        data={[...rows].reverse()}
        keyExtractor={(s) => s.clientId}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListEmptyComponent={
          <Text style={{ color: T.faint, fontSize: 13.5, textAlign: 'center', paddingTop: 34, lineHeight: 20 }}>
            Point the camera at a barcode.
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
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
                {item.state !== 'QUEUED' ? ` · ${item.state.toLowerCase()}` : ''}
              </Text>
            </View>
            {/* The same green and red as the card above, small. A load that
                went out right is a column of green; a pickup that went right is
                a column of red, and either one being broken by the wrong colour
                is visible from further away than any of the text is. Known and
                unknown are mutually exclusive, so this never adds a chip to a
                row that already has one. */}
            {a
              ? <Tag label={a.f ? 'FULL' : 'EMPTY'} tone={a.f ? T.fern : T.needle} />
              : boot ? <Tag label="UNKNOWN" tone={T.amber} /> : null}
            {item.state === 'QUEUED' && (
              <Pressable
                hitSlop={12}
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

      {/* ── undo, one slot, six seconds ──
          Sits above the submit bar rather than inside it — that bar is
          Btn's own 56pt+ target and a second control layered on top of it
          risks eating the tap meant for Submit. 150 clears the bar's own
          ~124pt (34 top pad + 56 button + 34 bottom pad) with a little air,
          the same hand-tuned-offset approach the tab-bar-clearing update
          banner uses. */}
      {removed && (
        <View style={{ position: 'absolute', left: 14, right: 14, bottom: 150 }}>
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

      {/* ── submit ── */}
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <LinearGradient
          colors={['transparent', 'rgba(7,9,10,0.92)', T.zinc]}
          style={{ paddingHorizontal: 14, paddingTop: 34, paddingBottom: 34 }}
        >
          <Btn
            label={`Submit order · ${c.total}`}
            sub={c.total ? `${c.ship} out · ${c.ret} in` : undefined}
            busy={syncing}
            disabled={!c.total}
            onPress={() => {
              Alert.alert(
                'Submit order',
                `${c.ship} shipped, ${c.ret} returned on ${orderNumber}.\n\nThey upload now if you have signal, and stay safe on this phone if you do not.`,
                [{ text: 'Keep scanning', style: 'cancel' }, { text: 'Submit', onPress: finish }],
              );
            }}
          />
        </LinearGradient>
      </View>

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
              <TextInput
                value={manualCode} onChangeText={(v) => setManualCode(v.toUpperCase())}
                autoFocus autoCapitalize="characters" autoCorrect={false}
                placeholder="PW-K-041827" placeholderTextColor={T.faint}
                style={[
                  {
                    height: 54, borderRadius: T.radiusSm, paddingHorizontal: 15, color: T.ink,
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
