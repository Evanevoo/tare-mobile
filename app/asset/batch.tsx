import { useMemo, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import { playScanAccept, playScanAlert } from '@/sound';
import { useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useStore } from '@/store';
import { createAssets, ApiError } from '@/api';
import {
  T, Screen, Surface, Btn, Rise, Icon, ICON, Eyebrow, mono, useBottomInset, wash,
} from '@/ui';
import {
  Field, TextField, Chips, Choice, DateField, Note, isRealDate,
} from '@/form';
import { Scanner } from '@/scanner';
import { formatNudge } from '@/formats';
import { ulid } from '@/ulid';
import {
  addRow, applyResult, describeResult, editRow, normalizeCode, removeRow, serialKey,
  toItems, whyNotReady, whyRefused,
  type BatchRow, type BulkCreateResult, type Refusal,
} from '@/batch';

/**
 * A pallet arrives.
 *
 * The screen next door adds one cylinder, and it is a form with a scanner at
 * the top of it. That is the right shape for the bottle found in a corner with
 * no record on it, and the wrong shape for forty identical ones coming off a
 * truck — the owner's words for what was missing here were "scan them all, but
 * each one will need a serial number, then save once".
 *
 * So this screen is the loop, and the form is the footnote. Per cylinder it
 * costs one scan, one typed serial, one tap; what kind, full or empty, where
 * they live and when they are next tested are asked once, at the bottom, for
 * all of them. The running count is on screen the whole time because somebody
 * doing this forty times loses their place otherwise.
 *
 * NOTHING EXISTS UNTIL SAVE. Every rule about what may join the batch lives in
 * src/batch.ts, is pure, and is tested without a phone — see
 * __tests__/batch.test.mts. This file is the camera, the keyboard and the
 * words; it owns no decisions.
 *
 * A DUPLICATE IS REFUSED OUT LOUD. Twice off the same pallet, or one that was
 * booked in yesterday and is already on the fleet: either way the driver is
 * holding that bottle, and a batch that quietly ignores the second scan looks
 * exactly like a batch that missed the read. Those two have opposite answers,
 * so the screen says which one happened and names the barcode.
 *
 * AND THE SAME FOR SERIALS, in the owner's words: "WE CANT HAVE THE SAME
 * SERIAL NUMBER TWICE, SAME AS BARCODES". The barcode is checked at the read,
 * the serial at the confirm, because that is when it exists — and a serial
 * refusal keeps the cylinder on screen rather than sending the driver back to
 * the viewfinder, since the barcode was never what was wrong.
 *
 * ANDROID IS THE PHONE THAT MATTERS HERE — the fleet's drivers carry Android
 * and the loop below is the part of the app they will spend the most time in.
 * The specifics are commented where they bite: no `adjustsFontSizeToFit`
 * anywhere (see app/scan.tsx for what that prop silently does on Android under
 * the New Architecture), every row of controls wraps because the system font
 * slider is real and drivers do turn it up, and the camera is torn down
 * whenever it is not being aimed rather than left running behind a keyboard.
 */
export default function BatchAssets() {
  const router = useRouter();
  const navigation = useNavigation();
  const { boot, refresh } = useStore();
  const bottom = useBottomInset(24);

  const [rows, setRows] = useState<BatchRow[]>([]);
  /** The one just scanned, waiting for its serial. Not in the batch yet. */
  const [pending, setPending] = useState<{ barcode: string; serial: string } | null>(null);
  const [scanning, setScanning] = useState(true);
  const [serialScanning, setSerialScanning] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [editing, setEditing] = useState<{ id: string; barcode: string; serial: string } | null>(null);

  const [product, setProduct] = useState('');
  const [location, setLocation] = useState('');
  const [full, setFull] = useState<boolean | null>(null);
  const [requal, setRequal] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkCreateResult | null>(null);
  /**
   * What this screen has already created, barcode AND serial. The downloaded
   * fleet will not know about them until the next bootstrap lands, and a driver
   * who saves thirty and carries on scanning must not be able to add one of
   * those thirty again in the meantime — nor to stamp one of their serials onto
   * a thirty-first.
   */
  const [created, setCreated] = useState<{ barcode: string; serial: string }[]>([]);

  const label = (boot?.org.assetLabel ?? 'asset').toLowerCase();
  const plural = (boot?.org.assetPlural ?? 'assets').toLowerCase();

  const products = useMemo(
    () => (boot?.products ?? []).slice(0, 14).map((p) => ({ key: p.code, sub: `${p.n} on fleet` })),
    [boot?.products],
  );
  const locations = useMemo(
    () => (boot?.locations ?? []).slice(0, 14).map((l) => ({ key: l })),
    [boot?.locations],
  );

  /**
   * Serial → the barcode wearing it, over the whole downloaded fleet.
   *
   * Built once per bootstrap rather than searched per keystroke: `assets` is
   * forty thousand records on the biggest org here, and answering "is this
   * serial taken" by scanning that map on every confirm is a visible stall in
   * the one loop that has to stay fast.
   *
   * First one wins where the fleet already contains a clash. There are 21 such
   * groups in the live database, which is exactly why the rule was added — the
   * useful answer is a barcode to go and look at, and any of them is a start.
   */
  const serialOwner = useMemo(() => {
    const by = new Map<string, string>();
    for (const [barcode, rec] of Object.entries(boot?.assets ?? {})) {
      const key = serialKey(rec?.sn);
      if (key && !by.has(key)) by.set(key, barcode);
    }
    return by;
  }, [boot?.assets]);

  const fleet = useMemo(
    () => ({
      has: (bc: string) => !!boot?.assets[bc] || created.some((c) => c.barcode === bc),
      serialHeldBy: (sn: string) => {
        const key = serialKey(sn);
        if (!key) return null;
        return serialOwner.get(key)
          ?? created.find((c) => serialKey(c.serial) === key)?.barcode
          ?? null;
      },
    }),
    [boot?.assets, created, serialOwner],
  );

  const dateOk = !requal || isRealDate(requal);
  const whyNot = whyNotReady(rows, { productCode: product, isFull: full, dateOk });

  /**
   * The same nudge the single screen shows, moved one step earlier.
   *
   * There, a barcode that does not look like the org's others is pointed at
   * while the form is being filled in. Here there is no per-cylinder form to
   * put it under, so it goes on the serial step — the one moment the driver is
   * looking at that barcode and can still drop it before it joins the list.
   * Still a warning and never a block, for the reason given in asset/new.tsx.
   */
  const nudge = pending
    ? formatNudge(pending.barcode, boot?.formats?.barcode, `${label} barcodes`)
    : null;

  /**
   * Leaving with rows in hand.
   *
   * `usePreventRemove` rather than a `beforeRemove` listener because this has
   * to cover the Android hardware back button and the native dismissal, which
   * is the way out a driver actually takes; a plain listener leaves the native
   * stack free to pop the screen anyway. It comes from the copy of
   * @react-navigation/native that arrives under expo-router — the same route
   * @react-navigation/elements takes into src/ui.tsx — rather than from a
   * direct dependency, because expo-router does not re-export it.
   */
  usePreventRemove(rows.length > 0, ({ data }) => {
    Alert.alert(
      busy ? 'Still saving' : `${rows.length} not saved`,
      busy
        ? 'The batch is going up now. Leaving will not stop it — it will just mean nobody '
          + 'sees what came back.'
        : `Nothing on this screen has been added to the fleet yet. Leave now and ${rows.length === 1 ? 'it has' : 'they have'} to be scanned again.`,
      [
        { text: 'Stay here', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => navigation.dispatch(data.action),
        },
      ],
    );
  });

  /**
   * A read off the camera.
   *
   * Deliberately NOT the Scanner's `accept` prop, which drops a code silently
   * — that is right for a wrong-shaped read and wrong for a duplicate, where
   * the whole value is in saying so. Misread rejection and the double-read
   * confirm still happen inside Scanner; this only decides whether an accepted
   * code may join this batch.
   */
  function take(raw: string) {
    const no = whyRefused(raw, rows, fleet);
    if (no) {
      setRefusal(no);
      // Same buzz and chirp as every other screen that reads a barcode — the
    // glove rule (see scan.tsx) is app-wide now, not per-screen: a gesture
    // that buzzes on one page and stays dead on another reads as broken.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Vibration.vibrate([0, 130, 90, 130]);
      playScanAlert();
      return;
    }
    setRefusal(null);
    setPending({ barcode: normalizeCode(raw), serial: '' });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Vibration.vibrate(90);
    playScanAccept();
  }

  /**
   * The row joins the list and the camera comes straight back up.
   *
   * A SERIAL CLASH LEAVES THE CYLINDER IN HAND. The barcode was cleared for
   * takeoff back at `take`; the serial is typed here, so this is the first and
   * only moment it can be checked, and the thing to do about a serial that is
   * already on another cylinder is read the collar again — which needs the
   * bottle, the barcode and the half-typed serial all still on screen. Dropping
   * back to the viewfinder would make the driver rescan a barcode that was
   * never the problem.
   */
  function confirm() {
    if (!pending) return;
    const change = addRow(rows, { id: ulid(), ...pending }, fleet);
    if (change.refused) {
      setRefusal(change.refused);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      if (change.refused.reason === 'serial-in-batch'
        || change.refused.reason === 'serial-on-fleet') return;
      // A barcode refusal here is only reachable if the same one landed in the
      // list some other way while this serial was being typed, but the answer
      // is the same as any other: say it, and do not add.
      setPending(null);
      setScanning(true);
      return;
    }
    setRows(change.rows);
    setPending(null);
    setSerialScanning(false);
    setScanning(true);
    // The row went in, so whatever was being complained about is settled.
    setRefusal(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function saveEdit() {
    if (!editing) return;
    const change = editRow(rows, editing.id, editing, fleet);
    if (change.refused) {
      setRefusal(change.refused);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setRows(change.rows);
    setEditing(null);
    setRefusal(null);
  }

  /**
   * Two taps, because there is no undo and the list is long.
   *
   * At cylinder thirty-nine an accidental delete is not a mistake anybody
   * notices; it is a bottle that quietly never gets booked in.
   */
  function drop(row: BatchRow) {
    Alert.alert(
      `Take ${row.barcode} out?`,
      'It has not been saved anywhere, so nothing else changes.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Take it out',
          style: 'destructive',
          onPress: () => {
            setRows((rs) => removeRow(rs, row.id));
            setEditing((e) => (e?.id === row.id ? null : e));
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
      ],
    );
  }

  /**
   * One save, and an honest answer.
   *
   * A partial success comes back 200 with the refusals listed, and it is
   * reported as what it is rather than as a failure: what was created leaves
   * the list, what was skipped or refused stays in it, and the panel names
   * both. The driver can press Save again on what is left without re-scanning
   * a single cylinder that already went in.
   */
  async function save() {
    if (whyNot || busy || !rows.length) return;
    setBusy(true);
    try {
      const r = await createAssets(toItems(rows), {
        productCode: product.trim(),
        location: location.trim() || null,
        isFull: full === true,
        nextRequalOn: requal || null,
        status: 'available',
      });
      setResult(r);
      // Carry the serials across too, not just the barcodes — they are on the
      // fleet the instant this returns, and the next thirty scans have to be
      // checked against them even though the bootstrap has not caught up.
      const made = new Set(r.createdBarcodes.map(normalizeCode));
      setCreated((c) => [
        ...c,
        ...rows.filter((row) => made.has(row.barcode))
          .map((row) => ({ barcode: row.barcode, serial: row.serial })),
      ]);
      setRows((rs) => applyResult(rs, r));
      setEditing(null);
      Haptics.notificationAsync(
        r.created
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      refresh().catch(() => {});
    } catch (e: unknown) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // 402 is a real state on this org as of today: read-only, so nothing can
      // be created. It is a billing answer, not a fault with the phone or the
      // scan, and saying "error 402" to a driver in a yard sends them looking
      // for the wrong problem.
      if (e instanceof ApiError && e.status === 402) {
        Alert.alert(
          'This account cannot add anything right now',
          `The office has this organisation set to read-only, so nothing was created. `
          + `Nothing is lost — all ${rows.length} are still on this phone, and Save will `
          + `work again once the account is opened back up.`,
        );
      } else {
        Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Newest first, carrying the number it was scanned as.
   *
   * The list grows downward off the screen otherwise, and the row worth seeing
   * is the one just added — it is the only confirmation that the scan landed.
   * The number comes from the position in the batch, which is what a refusal
   * says out loud ("already number 12"), so the two agree.
   */
  const numbered = useMemo(
    () => rows.map((row, i) => ({ row, n: i + 1 })).reverse(),
    [rows],
  );

  const summary = [product.trim(), full === null ? '' : full ? 'full' : 'empty', location.trim()]
    .filter(Boolean).join(' · ');

  /**
   * The record worth opening when a refusal names one that already exists.
   *
   * For a duplicate barcode that is the barcode itself. For a duplicate serial
   * it is emphatically NOT — the barcode in hand is new, and the record the
   * driver needs to look at is the cylinder already wearing that serial. A
   * clash inside the batch opens nothing: that row has not been created
   * anywhere yet, and its number is already in the sentence.
   */
  const clashRecord = refusal?.reason === 'on-fleet'
    ? refusal.barcode
    : refusal?.reason === 'serial-on-fleet'
      ? refusal.heldBy ?? null
      : null;

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 18,
            paddingTop: 10,
            paddingBottom: bottom + (rows.length ? 116 : 40),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Rise>
            <Text style={{ color: T.ink, fontSize: 29, fontWeight: '700', letterSpacing: -1 }}>
              A whole pallet
            </Text>
            <Text style={{ color: T.faint, fontSize: 14, marginTop: 5, lineHeight: 20 }}>
              Scan each one and give it its serial. What kind, where and how full are asked
              once, at the bottom. Nothing is added until you save.
            </Text>
          </Rise>

          {/* ── the loop: scan, serial, confirm, again ── */}
          <Rise delay={50}>
            <Field
              label={pending ? 'Serial number' : rows.length ? 'The next one' : 'The first one'}
              hint={pending
                ? 'Stamped on the collar. Type it — or scan it, if this fleet labels them.'
                : undefined}
              style={{ marginTop: 24 }}
            >
              {pending ? (
                <View>
                  {/* What was just read, big enough to check against the label
                      still in the driver's hand. Stepped in JS off the code's
                      own length rather than shrunk by the native prop — the
                      whole argument is in app/scan.tsx and it ends with an
                      Android floor of four dp. */}
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    flexWrap: 'wrap', rowGap: 4,
                  }}>
                    <Icon name="check-circle" size={ICON.md} color={T.bottle} />
                    <Text
                      numberOfLines={1}
                      style={[
                        mono(pending.barcode.length > 16 ? 20 : pending.barcode.length > 12 ? 24 : 28, '800'),
                        { color: T.ink, letterSpacing: -1, flexShrink: 1 },
                      ]}
                    >
                      {pending.barcode}
                    </Text>
                    <Text style={{ color: T.faint, fontSize: 12, fontWeight: '700' }}>
                      number {rows.length + 1}
                    </Text>
                  </View>

                  {serialScanning ? (
                    /* The same camera, told to hold its focus. A serial is read
                       with the phone held still against one collar, not swept
                       across a pallet, and a lens re-acquiring every second
                       spends half of it hunting — see steadyFocus in
                       src/scanner.tsx. */
                    <View style={{ marginTop: 12 }}>
                      <Scanner
                        steadyFocus
                        onCode={(c) => {
                          setPending((p) => (p ? { ...p, serial: c } : p));
                          setSerialScanning(false);
                          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        }}
                        onClose={() => setSerialScanning(false)}
                        style={{
                          height: 230, borderRadius: T.radius,
                          borderWidth: 1, borderColor: wash(0.35),
                        }}
                      />
                    </View>
                  ) : (
                    <View>
                      <View style={{ marginTop: 12 }}>
                        {/* autoFocus, and the field is mounted only in this
                            step, so the keyboard is already up by the time the
                            driver looks down at the collar. */}
                        <TextField
                          value={pending.serial}
                          onChangeText={(v) => setPending((p) => (p ? { ...p, serial: v } : p))}
                          placeholder="Serial number"
                          accessibilityLabel="Serial number"
                          autoFocus
                          returnKeyType="done"
                          onSubmitEditing={confirm}
                          code
                        />
                      </View>
                      <View style={{
                        flexDirection: 'row', gap: 10, marginTop: 10,
                        flexWrap: 'wrap', rowGap: 10,
                      }}>
                        <Pressable
                          onPress={() => setSerialScanning(true)}
                          accessibilityRole="button"
                          accessibilityLabel="Scan the serial number with the camera"
                          style={{
                            minHeight: 46, paddingHorizontal: 15, borderRadius: T.radiusSm,
                            flexDirection: 'row', alignItems: 'center', gap: 8,
                            borderWidth: 1, borderColor: wash(0.4), backgroundColor: wash(0.06),
                          }}
                        >
                          <Icon name="maximize" size={ICON.sm} color={T.brandLit} />
                          <Text style={{ color: T.brandLit, fontSize: 14, fontWeight: '700' }}>
                            Scan it
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => { setPending(null); setRefusal(null); setScanning(true); }}
                          accessibilityRole="button"
                          accessibilityLabel="Drop this one and scan another"
                          style={{ minHeight: 46, paddingHorizontal: 8, justifyContent: 'center' }}
                        >
                          <Text style={{ color: T.faint, fontSize: 14, fontWeight: '700' }}>
                            Not that one
                          </Text>
                        </Pressable>
                      </View>
                      <Btn
                        label={pending.serial.trim() ? 'Add it and scan the next' : 'Add it with no serial'}
                        sub={pending.serial.trim() ? undefined : 'some collars have nothing stamped on them'}
                        onPress={confirm}
                        style={{ marginTop: 12 }}
                      />
                    </View>
                  )}
                </View>
              ) : scanning ? (
                <Scanner
                  onCode={take}
                  onClose={() => setScanning(false)}
                  style={{
                    height: 260, borderRadius: T.radius,
                    borderWidth: 1, borderColor: wash(0.35),
                  }}
                />
              ) : (
                <Pressable
                  onPress={() => { setRefusal(null); setScanning(true); }}
                  accessibilityRole="button"
                  accessibilityLabel="Scan another barcode with the camera"
                  style={{
                    minHeight: 88, borderRadius: T.radius,
                    borderWidth: 1, borderStyle: 'dashed', borderColor: wash(0.4),
                    backgroundColor: wash(0.06),
                    alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'row', gap: 11,
                  }}
                >
                  <Icon name="maximize" size={ICON.lg} color={T.brandLit} />
                  <Text style={{ color: T.brandLit, fontSize: 16, fontWeight: '700' }}>
                    {rows.length ? 'Scan the next one' : 'Scan the first one'}
                  </Text>
                </Pressable>
              )}
            </Field>
          </Rise>

          {/* The refusal. On screen, naming the barcode, because the driver is
              holding that bottle and needs to know why it did not go in. Not
              while a row editor is open, though — there it is repeated inside
              the editor, next to the field that caused it, which is where the
              person's eyes already are. */}
          {!!refusal && !editing && (
            <Note
              icon="alert-triangle"
              tone={T.amber}
              text={refusal.says}
              action={clashRecord ? 'Open the record' : undefined}
              onAction={clashRecord
                ? () => router.push(`/asset/${encodeURIComponent(clashRecord)}` as never)
                : undefined}
            />
          )}

          {/* Not while a viewfinder is open — the camera fills that space and
              the note would sit under a live preview being aimed. */}
          {!!nudge && !serialScanning && (
            <Note icon="alert-triangle" tone={T.amber} text={`${nudge} Check the label — it will still go in.`} />
          )}

          {/* ── what is in hand ── */}
          {rows.length > 0 && (
            <View style={{ marginTop: 30 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 11 }}>
                <Text style={{ color: T.steel, fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>
                  IN THIS BATCH
                </Text>
                <Text style={[mono(14, '700'), { color: T.brandLit, marginLeft: 'auto' }]}>
                  {rows.length}
                </Text>
              </View>
              <Surface>
                {numbered.map(({ row, n }, i) => (
                  editing?.id === row.id ? (
                    <View
                      key={row.id}
                      style={{
                        paddingHorizontal: 14, paddingVertical: 12, gap: 10,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                      }}
                    >
                      <Eyebrow>Number {n}</Eyebrow>
                      <TextField
                        value={editing.barcode}
                        onChangeText={(v) => setEditing((e) => (e ? { ...e, barcode: v.replace(/\s+/g, '') } : e))}
                        placeholder="Barcode"
                        accessibilityLabel="Barcode"
                        code
                      />
                      <TextField
                        value={editing.serial}
                        onChangeText={(v) => setEditing((e) => (e ? { ...e, serial: v } : e))}
                        placeholder="Serial number"
                        accessibilityLabel="Serial number"
                        code
                      />
                      {!!refusal && (
                        <Text style={{ color: T.amber, fontSize: 13, lineHeight: 19 }}>
                          {refusal.says}
                        </Text>
                      )}
                      {/* Wraps, because both buttons keep their text and the
                          system font slider decides how wide that text is. */}
                      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', rowGap: 10 }}>
                        <Btn label="Done" onPress={saveEdit} style={{ flexGrow: 1, flexBasis: 150 }} />
                        <Btn
                          label="Cancel"
                          variant="ghost"
                          onPress={() => { setEditing(null); setRefusal(null); }}
                          style={{ flexGrow: 1, flexBasis: 120 }}
                        />
                      </View>
                    </View>
                  ) : (
                    <View
                      key={row.id}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 8,
                        paddingLeft: 14, paddingRight: 4, paddingVertical: 8, minHeight: 56,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                      }}
                    >
                      <Text style={[mono(12, '700'), { color: T.faint, minWidth: 24 }]}>{n}</Text>
                      <View style={{ flex: 1 }}>
                        <Text
                          numberOfLines={1}
                          style={[mono(row.barcode.length > 16 ? 13 : 15, '700'), { color: T.ink }]}
                        >
                          {row.barcode}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={row.serial
                            ? [mono(12, '600'), { color: T.steel, marginTop: 2 }]
                            : { color: T.faint, fontSize: 12, marginTop: 2 }}
                        >
                          {row.serial || 'no serial'}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => { setEditing({ id: row.id, barcode: row.barcode, serial: row.serial }); setRefusal(null); }}
                        accessibilityRole="button"
                        accessibilityLabel={`Correct ${row.barcode}`}
                        style={{ minHeight: 46, minWidth: 46, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Icon name="edit-2" size={ICON.sm} color={T.steel} />
                      </Pressable>
                      <Pressable
                        onPress={() => drop(row)}
                        accessibilityRole="button"
                        accessibilityLabel={`Take ${row.barcode} out of the batch`}
                        style={{ minHeight: 46, minWidth: 46, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Icon name="trash-2" size={ICON.sm} color={T.faint} />
                      </Pressable>
                    </View>
                  )
                ))}
              </Surface>
            </View>
          )}

          {/* ── what the server did with the last save ── */}
          {!!result && (
            <Rise>
              <View style={{ marginTop: 30 }}>
                <Eyebrow style={{ marginBottom: 10 }}>The last save</Eyebrow>
                <Surface tint={result.created ? wash(0.14) : undefined}>
                  <View style={{ padding: 16 }}>
                    <Text style={{ color: T.ink, fontSize: 17, fontWeight: '700', lineHeight: 24 }}>
                      {describeResult(result, label, plural)}
                    </Text>
                    {rows.length > 0 && (
                      <Text style={{ color: T.faint, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
                        What did not go in is still in the batch above. Fix it, or take it out,
                        and save again — nothing that already went in will go in twice.
                      </Text>
                    )}
                  </View>

                  {/* Already on the fleet is not an error, and the useful thing
                      to offer is the record that is already there. */}
                  {result.skipped.map((s) => (
                    <Pressable
                      key={`skip-${s.barcode}`}
                      onPress={() => router.push(`/asset/${encodeURIComponent(s.barcode)}` as never)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${s.barcode}, already on the fleet`}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, minHeight: 50,
                        borderTopWidth: 1, borderTopColor: T.soft,
                      }}
                    >
                      <Icon name="corner-up-right" size={ICON.sm} color={T.amber} />
                      <Text numberOfLines={1} style={[mono(14, '600'), { color: T.ink, flex: 1 }]}>
                        {s.barcode}
                      </Text>
                      <Text style={{ color: T.faint, fontSize: 12 }}>already there</Text>
                      <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
                    </Pressable>
                  ))}

                  {result.invalid.map((v) => (
                    <View
                      key={`bad-${v.barcode}`}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, paddingVertical: 10, minHeight: 50,
                        borderTopWidth: 1, borderTopColor: T.soft,
                      }}
                    >
                      <Icon name="x-circle" size={ICON.sm} color={T.needle} />
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={[mono(14, '600'), { color: T.ink }]}>
                          {v.barcode}
                        </Text>
                        {/* The server's own words for why. Two lines, because a
                            reason cut off mid-sentence is worse than none. */}
                        <Text numberOfLines={2} style={{ color: T.faint, fontSize: 12, marginTop: 2, lineHeight: 17 }}>
                          {v.reason}
                        </Text>
                      </View>
                    </View>
                  ))}
                </Surface>
              </View>
            </Rise>
          )}

          {/* ── asked once, for all of them ── */}
          {rows.length > 0 && (
            <Rise delay={40}>
              <Field label="What kind" hint={products.length ? 'Commonest first. The whole batch gets this.' : undefined}>
                <Chips
                  options={products}
                  value={product}
                  onChange={setProduct}
                  placeholder="Product code"
                />
              </Field>

              <Field label="What is in them">
                <Choice
                  options={[
                    { value: 'full', label: 'FULL', sub: 'ready to go out' },
                    { value: 'empty', label: 'EMPTY', sub: 'needs filling' },
                  ]}
                  value={full === null ? null : full ? 'full' : 'empty'}
                  onChange={(v) => setFull(v === 'full')}
                />
              </Field>

              <Field label="Where they live" hint="Optional. Leave it blank if they have no shelf yet.">
                <Chips
                  options={locations}
                  value={location}
                  onChange={setLocation}
                  placeholder="Bay 4, Rack B, Dock…"
                  code={false}
                />
              </Field>

              <Field label="Next requalification" hint="Optional. The date they next have to be tested.">
                <DateField value={requal} onChange={setRequal} />
              </Field>
            </Rise>
          )}

          {rows.length === 0 && !result && (
            <Note
              text={
                'Just the one? The single-cylinder screen asks for everything about it, '
                + 'including things this one does not — status, ownership, last test date.'
              }
              action={`Add one ${label} instead`}
              onAction={() => router.replace('/asset/new')}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* The count is on screen the whole time, and so is the reason Save is
          not available yet. A dead button with no explanation is how somebody
          decides the app is broken. */}
      {rows.length > 0 && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            backgroundColor: 'rgba(7,9,10,0.94)',
            borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Btn
            label={`Save ${rows.length} ${rows.length === 1 ? label : plural}`}
            sub={whyNot ?? (summary || undefined)}
            busy={busy}
            disabled={!!whyNot}
            onPress={() => { void save(); }}
          />
        </View>
      )}
    </Screen>
  );
}
