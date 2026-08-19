import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Alert, Modal } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import { playScanAccept, playScanAlert, playSubmitSuccess } from '@/sound';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { postFill } from '@/api';
import { locateWarning, hasLocalReturn } from '@/interlock';
import { cacheGet, cacheSet } from '@/db';
import {
  T, Screen, Surface, Btn, Eyebrow, Tag, Rise, Icon, ICON, mono, useBottomInset, tint, wash,
} from '@/ui';
import { Scanner } from '@/scanner';

/**
 * Locate — the yard half of the day.
 *
 * A delivery is customer plus order. This is neither: it is a person at a
 * shelf saying "these forty are here, and they are full". Nothing bills.
 *
 * The one thing the old app did silently and this does out loud: putting a
 * bottle away in-house takes it off a customer's balance, and if a rental was
 * open it has to be closed or they keep paying for something on your shelf.
 * The count of closed rentals comes back and is shown, because ending twelve
 * rentals with one tap is not something to find out about later.
 */
type LocateDraft = {
  location: string; custom: boolean; state: 'full' | 'empty' | null; codes: string[];
};
/** Same cache table startDelivery/endDelivery use for the job, one row over. */
const DRAFT_KEY = 'locateDraft';

export default function Locate() {
  const router = useRouter();
  const { boot, refresh, outbox } = useStore();
  const bottom = useBottomInset(24);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [location, setLocation] = useState('');
  const [custom, setCustom] = useState(false);
  const [state, setState] = useState<'full' | 'empty' | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** Guards the save-effect below from firing on the empty pre-load render
      and stomping a draft this same mount is about to restore. */
  const [hydrated, setHydrated] = useState(false);

  /**
   * A STAGED SHELF SURVIVES THE APP DYING.
   *
   * Delivery's job (customer, order, direction) is written to the on-device
   * cache on every change and restored on launch — store.ts's hydrate() does
   * it, and mobile-punchlist.md exists partly because losing that once
   * already cost a re-scanned load. This screen never got the same
   * treatment: `codes` lived only in component state, so someone forty
   * bottles into stocking a shelf who took a call, or whose phone died, or
   * who backgrounded the app long enough for Android to reclaim it, came
   * back to Locate reset to step one with nothing to show for the scanning
   * they had already done. The fix mirrors the delivery job exactly — same
   * cache table, same load-on-mount / save-on-change shape — because this is
   * the same problem in the other screen that has one.
   */
  useEffect(() => {
    let cancelled = false;
    cacheGet<LocateDraft>(DRAFT_KEY).then((d) => {
      if (cancelled) return;
      if (d) {
        setLocation(d.location);
        setCustom(d.custom);
        setState(d.state);
        setCodes(d.codes);
      }
      setHydrated(true);
    }).catch(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const empty = !location && !custom && !state && codes.length === 0;
    cacheSet(DRAFT_KEY, empty ? null : { location, custom, state, codes }).catch(() => {});
  }, [hydrated, location, custom, state, codes]);

  const locations = boot?.locations ?? [];

  function add(raw: string) {
    const bc = raw.trim().toUpperCase();
    if (!bc) return;
    if (codes.includes(bc)) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); return; }

    const known = boot?.assets[bc];

    /**
     * REFUSE AT THE SHELF, NOT AT THE SAVE.
     *
     * A barcode the fleet has never heard of used to go into the batch with
     * an UNKNOWN tag and only get rejected by the server at save — by which
     * point the worker has walked away from the shelf, and the one thing
     * they needed to do (find out what that bottle actually is, or write it
     * down) is now impossible without walking back. The legacy app refused
     * it out loud at scan time for exactly this reason, and it was right.
     *
     * It is a REFUSAL WITH A DOOR, not a wall: a bottle genuinely on the
     * shelf but not yet synced is a real and common case, so "Add anyway"
     * keeps it. What changes is that the decision happens while the bottle
     * is still in hand.
     *
     * Deliberately after the duplicate check and before the customer
     * interlock: an unknown barcode has no customer, so the two can never
     * both fire, and the cheaper test goes first.
     */
    if (boot && !known) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Vibration.vibrate([0, 130, 90, 130]);
      playScanAlert();
      Alert.alert(
        'Not in the system',
        `${bc} is not on the downloaded list. It may be new, or the barcode may have misread.\n\nAdding it still records the shelf — the office assigns what it is later.`,
        [
          { text: 'Skip it', style: 'cancel' },
          { text: 'Add anyway', onPress: () => setCodes((c) => [...c, bc]) },
        ],
      );
      return;
    }

    // A bottle still out at a customer is the interesting case: marking it
    // here is what ends that rental, so it is called out rather than accepted
    // in silence. THREE-WAY now (src/interlock.ts): the record must name a
    // customer AND an open rental must actually exist AND nothing on this
    // phone has already returned it — `c` alone is a stale snapshot, and
    // warning off it warned on exactly the case legacy learned to suppress.
    if (state === 'full' && locateWarning(known, hasLocalReturn(outbox.scans, bc))) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Still out at a customer',
        `${bc} is on ${known?.c}'s account with an open rental. Adding it here brings it back in-house and ends that rental.\n\nThe usual flow is to scan it empty when it comes back, then full once it has been refilled.`,
        [
          { text: 'Skip', style: 'cancel' },
          { text: 'Add anyway', onPress: () => setCodes((c) => [...c, bc]) },
        ],
      );
      return;
    }

    /**
     * THE SAME BUZZ AND CHIRP AS THE SCAN LOOP, FOR THE SAME HANDS.
     *
     * The driver feedback that added Vibration alongside Haptics on scan.tsx
     * ("hard to feel through gloves") was about scanning, full stop — but the
     * fix only ever landed on the delivery scan loop. A locating sweep reads
     * hundreds of bottles with the same gloves in the same yard, and all it
     * got was the OS's polite tick, which is exactly what the driver said
     * they could not feel. Same durations as scan.tsx so the language is one
     * language: short solid buzz = counted, double buzz = look at the screen.
     */
    if (known) { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); Vibration.vibrate(90); playScanAccept(); }
    else { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); Vibration.vibrate([0, 130, 90, 130]); playScanAlert(); }
    setCodes((c) => [...c, bc]);
  }

  async function save() {
    if (!location || !state || !codes.length) return;
    setBusy(true);
    try {
      const r = await postFill(location, state, codes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // A saved shelf is the warehouse's "order went out" — one long pulse.
      Vibration.vibrate(250);
      playSubmitSuccess();
      await refresh().catch(() => {});
      // This shelf is saved — a force-quit from here on out must not restore
      // it a second time and offer to submit the same bottles again.
      await cacheSet(DRAFT_KEY, null).catch(() => {});
      // THE CACHE WAS CLEARED. THE SCREEN WAS NOT.
      //
      // Locate lives on a tab — router.replace('/') below leaves this screen
      // mounted in the background, same as switching tabs by hand does. Only
      // the on-device draft was reset, so a tab back to Warehouse resurrected
      // the exact 15 bottles just saved and offered to mark them full again,
      // second-guessing a save that had already gone through. The persisted
      // draft and the live state were two different copies of the same
      // "what's on this shelf" fact, and clearing one was never going to
      // clear the other.
      // Only the shelf clears. Location and state are held so "Next shelf"
      // below can pick straight up — see the note on that button.
      setCodes([]); setTyped('');
      // "6 open rentals closed" told nobody WHO stopped being billed — the
      // question that actually gets asked back at the yard. Named, one line
      // per bottle, capped the same way the unknown list is so a 40-bottle
      // sweep doesn't turn this into a wall of text.
      const namedClosures = r.closedCustomers.slice(0, 6)
        .map((c) => `${c.barcode} — ${c.customerName}`).join('\n');
      // Per-bottle outcomes (v7 servers). One refused bottle must not hide
      // inside "updated 19" — legacy reported line by line and was right to.
      const failures = (r.results ?? []).filter((x) => !x.ok);
      const failureLines = failures.slice(0, 5)
        .map((f) => `${f.barcode} — ${f.reason ?? 'refused'}`).join('\n');
      Alert.alert(
        'Saved',
        [
          `${r.updated} marked ${state} at ${location}.`,
          r.closed
            ? `${r.closed} open rental${r.closed === 1 ? '' : 's'} closed — those customers stop being charged.\n${namedClosures}${r.closedCustomers.length > 6 ? `\n…and ${r.closedCustomers.length - 6} more` : ''}`
            : null,
          failures.length
            ? `${failures.length} not saved:\n${failureLines}${failures.length > 5 ? `\n…and ${failures.length - 5} more` : ''}`
            : r.unknown.length
              ? `${r.unknown.length} not in the system: ${r.unknown.slice(0, 5).join(', ')}${r.unknown.length > 5 ? '…' : ''}`
              : null,
        ].filter(Boolean).join('\n\n'),
        /**
         * TWO WAYS OUT, BECAUSE A YARD IS SHELF AFTER SHELF.
         *
         * "Done" was the only exit, and it dropped the worker on Home — so
         * the next shelf cost a tab back, a location chip and a Full/Empty
         * button before a single barcode could be read. Legacy had "Scan
         * More" for exactly this and kept the location and status; doing
         * forty shelves it is the difference between two taps and six,
         * every time.
         *
         * Next shelf keeps the location deliberately: a sweep is usually
         * several passes at ONE location (fulls, then empties), and the
         * location is the slower of the two to re-pick. Changing it is one
         * tap on the chip that is already on screen.
         */
        [
          { text: 'Next shelf', onPress: () => { setStep(3); } },
          { text: 'Done', style: 'cancel', onPress: () => {
            setStep(1); setLocation(''); setCustom(false); setState(null);
            router.replace('/');
          } },
        ],
      );
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not save', e?.message ?? 'Try again when you have signal.');
    } finally {
      setBusy(false);
    }
  }

  const field = {
    minHeight: 52, borderRadius: T.radiusSm, paddingHorizontal: 15,
    color: T.ink, fontSize: 16,
    backgroundColor: tint(0.05),
    borderWidth: 1, borderColor: T.rule,
  } as const;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 44, paddingBottom: bottom + 90 }}
        keyboardShouldPersistTaps="handled"
      >
        <Rise>
          <Text style={{ color: T.ink, fontSize: 29, fontWeight: '700', letterSpacing: -1 }}>
            Locate
          </Text>
          <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 5, lineHeight: 20 }}>
            Put things away and set what is in them. No order, no customer — this is
            housekeeping, and it does not bill.
          </Text>
        </Rise>

        {/* ── 1 · where ── */}
        <Rise delay={60} style={{ marginTop: 26 }}>
          <Eyebrow style={{ marginBottom: 11 }}>1 · Where</Eyebrow>
          {custom || locations.length === 0 ? (
            <TextInput
              value={location} onChangeText={setLocation}
              placeholder="Bay 4, Rack B, Dock…" placeholderTextColor={T.faint}
              autoCapitalize="characters" autoCorrect={false}
              style={field}
            />
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
              {locations.map((l) => (
                <Pressable
                  key={l}
                  onPress={() => { setLocation(l); Haptics.selectionAsync(); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: location === l }}
                  style={{
                    minHeight: 46, justifyContent: 'center', paddingHorizontal: 16,
                    borderRadius: T.radiusSm,
                    backgroundColor: location === l ? wash(0.16) : tint(0.045),
                    borderWidth: 1,
                    borderColor: location === l ? wash(0.45) : T.rule,
                  }}
                >
                  <Text
                    style={{
                      color: location === l ? T.brandLit : T.steel,
                      fontSize: 14.5, fontWeight: '700',
                    }}
                  >
                    {l}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {locations.length > 0 && (
            <Pressable onPress={() => { setCustom((v) => !v); setLocation(''); }} hitSlop={10}>
              <Text style={{ color: T.brandLit, fontSize: 13, fontWeight: '700', marginTop: 12 }}>
                {custom ? 'Pick from the list' : 'Somewhere else'}
              </Text>
            </Pressable>
          )}
        </Rise>

        {/* ── 2 · what is in them ── */}
        {!!location && (
          <Rise delay={40} style={{ marginTop: 26 }}>
            <Eyebrow style={{ marginBottom: 11 }}>2 · What is in them</Eyebrow>
            <View style={{ flexDirection: 'row', gap: 11 }}>
              {(['full', 'empty'] as const).map((k) => (
                <Pressable
                  key={k}
                  onPress={() => { setState(k); Haptics.selectionAsync(); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: state === k }}
                  style={{
                    flex: 1, minHeight: 62, paddingVertical: 8, borderRadius: T.radiusSm,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: state === k
                      ? (k === 'full' ? wash(0.18) : tint(0.07))
                      : tint(0.04),
                    borderWidth: 1,
                    borderColor: state === k
                      ? (k === 'full' ? wash(0.5) : tint(0.22))
                      : T.rule,
                  }}
                >
                  <Text
                    style={{
                      color: state === k ? (k === 'full' ? T.brandLit : T.ink) : T.steel,
                      fontSize: 16.5, fontWeight: '800', letterSpacing: 0.3,
                    }}
                  >
                    {k.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Rise>
        )}

        {/* ── 3 · which ones ── */}
        {!!location && !!state && (
          <Rise delay={40} style={{ marginTop: 26 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 11 }}>
              <Eyebrow>3 · Which ones</Eyebrow>
              <Text style={[mono(13, '700'), { color: T.brandLit, marginLeft: 'auto' }]}>
                {codes.length}
              </Text>
            </View>

            {/* The camera opens FULL SCREEN, the same way Delivery's does.
                It used to render inline at 230px inside this ScrollView, which
                made Locate the one screen in the app where scanning happened
                in a letterbox: a smaller target to aim, the reticle squeezed
                into a band a couple of centimetres tall, and the whole thing
                able to scroll out from under the driver's thumb mid-scan.
                Same component, same props, same modal — there is one way to
                scan in this app now, and this is it. */}
            <Btn
              label="Scan with the camera"
              variant="ghost"
              style={{ marginBottom: 12 }}
              onPress={() => setScanning(true)}
            />

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TextInput
                value={typed} onChangeText={(v) => setTyped(v.toUpperCase())}
                placeholder="Or type a barcode" placeholderTextColor={T.faint}
                autoCapitalize="characters" autoCorrect={false}
                onSubmitEditing={() => { add(typed); setTyped(''); }}
                style={[field, mono(15, '600'), { flex: 1 }]}
              />
              <Btn
                label="Add" variant="ghost" style={{ width: 92 }}
                disabled={!typed.trim()}
                onPress={() => { add(typed); setTyped(''); }}
              />
            </View>

            {codes.length > 0 && (
              <Surface style={{ marginTop: 14 }}>
                {codes.map((bc, i) => {
                  const known = boot?.assets[bc];
                  return (
                    <View
                      key={bc + i}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, paddingVertical: 13,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[mono(14.5, '600'), { color: T.ink }]}>{bc}</Text>
                        <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                          {known ? (known.c ? `was out at ${known.c}` : known.p ?? 'in house') : 'not in the system'}
                        </Text>
                        {/* WHAT IT IS CHANGING FROM, NOT JUST WHAT IT IS
                            CHANGING TO.
                            The row said where the bottle had been and never
                            what state it was in, so a shelf being marked FULL
                            looked identical whether every bottle on it was
                            already full (nothing happening, probably the wrong
                            shelf) or all empty (the whole point). Legacy
                            printed `Was: X → Will be: Y` on every staged row.
                            Only drawn when it is a real change: repeating the
                            state a bottle is already in is noise on the rows
                            that need reading least. */}
                        {known && (known.f ? 'full' : 'empty') !== state && (
                          <Text style={{ color: T.amber, fontSize: 11, marginTop: 3, fontWeight: '600' }}>
                            {known.f ? 'FULL' : 'EMPTY'} → {state === 'full' ? 'FULL' : 'EMPTY'}
                          </Text>
                        )}
                      </View>
                      {!known && <Tag label="UNKNOWN" tone={T.amber} />}
                      <Pressable
                        onPress={() => setCodes((c) => c.filter((_, n) => n !== i))}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${bc}`}
                      >
                        <Icon name="x" size={ICON.md} color={T.needle} />
                      </Pressable>
                    </View>
                  );
                })}
              </Surface>
            )}
          </Rise>
        )}
      </ScrollView>

      {!!location && !!state && codes.length > 0 && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            backgroundColor: 'rgba(7,9,10,0.94)',
            borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Btn
            label={`Mark ${codes.length} ${state}`}
            sub={`at ${location}`}
            busy={busy}
            onPress={save}
          />
        </View>
      )}

      {/* Byte-for-byte the same shell Delivery uses — full-screen modal, black
          floor behind it (a Modal's own backdrop is white, and it shows for
          the whole slide-in: a white flash in a dark yard at 06:10).
          `steadyFocus` is deliberately NOT set here: Delivery photographs a
          receipt held still, while this is somebody working along a rack at
          changing distances, which is exactly the case the periodic Android
          refocus exists for. Consistent does not mean identical where the job
          genuinely differs — it means the same component and the same shell. */}
      <Modal
        visible={scanning}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScanning(false)}
      >
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <Scanner
            onCode={add}
            onClose={() => setScanning(false)}
            style={{ flex: 1 }}
          >
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 44, paddingHorizontal: 26 }}>
              <Text style={{ color: '#FFFFFF', fontSize: 14, textAlign: 'center', lineHeight: 20, opacity: 0.9 }}>
                {codes.length
                  ? `${codes.length} added · keep scanning`
                  : `Scan everything going ${state ?? ''} at ${location}.`}
              </Text>
              <Text style={{ color: '#FFFFFF', fontSize: 12.5, textAlign: 'center', lineHeight: 18, opacity: 0.6, marginTop: 6 }}>
                Tap Stop when the shelf is done.
              </Text>
            </View>
          </Scanner>
        </View>
      </Modal>
    </Screen>
  );
}
