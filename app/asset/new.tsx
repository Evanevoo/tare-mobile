import { useMemo, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import { playScanAccept, playScanAlert } from '@/sound';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { createAsset, ApiError, type AssetDraft } from '@/api';
import { T, Screen, Surface, Btn, Rise, Icon, ICON, mono, useBottomInset, wash } from '@/ui';
import {
  Field, TextField, Chips, Choice, DateField, Note, isRealDate,
} from '@/form';
import { Scanner } from '@/scanner';
import { formatNudge } from '@/formats';
import { useAttributeOptions } from '@/attributes';

/**
 * Adding something to the fleet.
 *
 * Two situations produce this screen, and they look nothing alike. A pallet of
 * forty arrives at the yard, identical except for their barcodes. Or a driver
 * finds one bottle in a corner with no record on it. The screen has to be good
 * at both, which means the form must not be the thing you interact with forty
 * times — the scanner is.
 *
 * So: the barcode leads. Everything else is remembered from the last one saved
 * and stays put between saves, so the fortieth cylinder off a pallet costs one
 * scan and one tap. The tally at the bottom is there because a person doing
 * that forty times needs to see the pile growing or they will lose their place.
 *
 * The other job this screen does is refuse gracefully. A barcode that already
 * exists is checked against the offline copy before anything is typed, and the
 * answer is an offer to open the existing record — not a form filled out for
 * nothing and rejected at the end.
 */
export default function NewAsset() {
  const router = useRouter();
  const { boot, refresh } = useStore();
  const bottom = useBottomInset(24);

  const [barcode, setBarcode] = useState('');
  const [serial, setSerial] = useState('');
  const [product, setProduct] = useState('');
  const [location, setLocation] = useState('');
  const [full, setFull] = useState<boolean | null>(null);
  const [requal, setRequal] = useState('');
  // The descriptive columns 017 restored, plus the supplier label. Pallet
  // facts — they stay put between saves like everything else shared.
  const [gas, setGas] = useState('');
  const [category, setCategory] = useState('');
  const [group, setGroup] = useState('');
  const [desc, setDesc] = useState('');
  const [owner, setOwner] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  const label = boot?.org.assetLabel ?? 'asset';
  const products = useMemo(
    // No truncation here any more — Chips filters a long list with a search
    // box rather than the caller silently hiding everything past the 14th.
    () => (boot?.products ?? []).map((p) => ({ key: p.code, sub: `${p.n} on fleet` })),
    [boot?.products],
  );
  const locations = useMemo(
    () => (boot?.locations ?? []).map((l) => ({ key: l })),
    [boot?.locations],
  );

  // Gas, category, group and supplier, as this fleet already spells them.
  const attrs = useAttributeOptions();
  const typeFilled = !!boot?.types?.some((t) => t.code === product);

  const existing = barcode ? boot?.assets[barcode] : undefined;

  /**
   * Legacy's one-pick rule: choosing the product code fills gas type,
   * category, group and description together from the catalogue the server
   * ships (`types`, learned from previous writes). Overwrites what was there
   * — the pick IS the statement — and everything stays editable after.
   */
  function pickProduct(code: string) {
    setProduct(code);
    const t = boot?.types?.find((x) => x.code === code);
    if (t) {
      setGas(t.gasType ?? '');
      setCategory(t.category ?? '');
      setGroup(t.groupName ?? '');
      setDesc(t.description ?? '');
    }
  }

  /** The quota, pre-warned. The server still enforces it — this is courtesy. */
  const limit = boot?.limits?.maxAssets ?? null;
  const atLimit = limit !== null && (boot?.stats.total ?? 0) + added.length >= limit;

  /**
   * A barcode that does not look like the fleet's other barcodes.
   *
   * This catches the one that matters most: a driver adding a bottle and
   * reading a digit wrong off a worn label, or scanning the wrong symbol on a
   * receipt entirely. It stays a warning rather than a block because the
   * moment a fleet buys a batch from a supplier who prints differently, a gate
   * here would stop the yard working and nobody in the yard can change the
   * setting — but the odd one out is still worth pointing at.
   */
  const barcodeNudge = existing
    ? null
    : formatNudge(barcode, boot?.formats?.barcode, `${label.toLowerCase()} barcodes`);

  const dateOk = !requal || isRealDate(requal);
  const ready = !!barcode && !existing && !!product.trim() && full !== null && dateOk;

  // Dedupe and misread-rejection live inside Scanner; this only lands the
  // accepted value in the form.
  function take(bc: string) {
    setBarcode(bc);
    setScanning(false);
    // Same buzz and chirp as every other screen that reads a barcode — the
    // glove rule (see scan.tsx) is app-wide now, not per-screen: a gesture
    // that buzzes on one page and stays dead on another reads as broken.
    const known = !!boot?.assets[bc];
    Haptics.notificationAsync(
      known ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
    );
    if (known) { Vibration.vibrate([0, 130, 90, 130]); playScanAlert(); }
    else { Vibration.vibrate(90); playScanAccept(); }
  }

  async function save() {
    if (!ready || busy) return;
    setBusy(true);

    const draft: AssetDraft = {
      productCode: product.trim(),
      serialNumber: serial.trim() || null,
      location: location.trim() || null,
      isFull: full === true,
      nextRequalOn: requal || null,
      status: 'available',
      gasType: gas.trim() || null,
      category: category.trim() || null,
      groupName: group.trim() || null,
      description: desc.trim() || null,
      owner: owner.trim() || null,
    };

    try {
      await createAsset(barcode, draft);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setAdded((a) => [barcode, ...a]);

      // Everything that describes the batch stays. Only what identifies the
      // individual thing is cleared, and the scanner reopens — because the
      // next one is already in the driver's other hand.
      setBarcode('');
      setSerial('');
      refresh().catch(() => {});
      setScanning(true);
    } catch (e: unknown) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (e instanceof ApiError && e.status === 409 && e.body?.conflictOn === 'quota') {
        // The record was fine; the ACCOUNT is full. Different problem,
        // different person fixes it — the server's message already says so.
        Alert.alert('Account at its limit', e.message);
      } else if (e instanceof ApiError && e.status === 409 && e.body?.existing) {
        const bc = barcode;
        Alert.alert(
          'Already on the fleet',
          `${bc} exists${e.body.outAtCustomer ? ' and is out at a customer' : ''}. Nothing was changed.`,
          [
            { text: 'Keep adding', style: 'cancel', onPress: () => setBarcode('') },
            { text: 'Open it', onPress: () => router.push(`/asset/${encodeURIComponent(bc)}` as never) },
          ],
        );
      } else {
        Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.');
      }
    } finally {
      setBusy(false);
    }
  }


  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 18,
            // Clearing the transparent header is now Screen's job, and doing
            // it here as well pushed the first field a header's height too far
            // down. This is just breathing room under it.
            paddingTop: 10,
            paddingBottom: bottom + (ready ? 108 : 40),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Rise>
            <Text style={{ color: T.ink, fontSize: 29, fontWeight: '700', letterSpacing: -1 }}>
              Add {added.length ? 'another' : `a ${label.toLowerCase()}`}
            </Text>
            <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 5, lineHeight: 20 }}>
              It goes on the fleet in-house. Sending it to a customer is a scan against
              their order, not a form.
            </Text>
          </Rise>

          {/* The account is full. Said BEFORE forty barcodes are scanned, not
              after — the server will refuse anyway; this saves the walk. */}
          {atLimit && (
            <Note
              icon="alert-triangle"
              tone={T.amber}
              text={`This account is at its limit of ${limit!.toLocaleString()} ${boot?.org.assetPlural?.toLowerCase() ?? 'assets'}. New ones will be refused until the office raises it.`}
            />
          )}

          {/* ── the barcode leads ── */}
          <Rise delay={50}>
            <Field label="Barcode" style={{ marginTop: 24 }}>
              {scanning ? (
                /* The same camera, told to hold its focus. This is one
                   barcode at a time, phone held over the label on a pallet
                   or a single found bottle — never a sweep across a rack —
                   which is exactly the case steadyFocus exists for (see
                   asset/batch.tsx and src/scanner.tsx). Left at the default
                   before this, the periodic Android refocus fought the read
                   it was trying to make: the same "autofocus never settles,
                   just blurry" complaint reported against this screen. */
                <Scanner
                  onCode={take}
                  onClose={() => setScanning(false)}
                  steadyFocus
                  style={{
                    height: 260, borderRadius: T.radius,
                    borderWidth: 1, borderColor: wash(0.35),
                  }}
                />
              ) : (
                <View>
                  <Pressable
                    onPress={() => setScanning(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Scan a barcode with the camera"
                    style={{
                      minHeight: 88,
                      borderRadius: T.radius,
                      borderWidth: 1,
                      borderStyle: 'dashed',
                      borderColor: wash(0.4),
                      backgroundColor: wash(0.06),
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 11,
                    }}
                  >
                    <Icon name="maximize" size={ICON.lg} color={T.brandLit} />
                    <Text style={{ color: T.brandLit, fontSize: 15.5, fontWeight: '700' }}>
                      Scan the label
                    </Text>
                  </Pressable>

                  <View style={{ marginTop: 10 }}>
                    <TextField
                      value={barcode}
                      onChangeText={(v) => setBarcode(v.replace(/\s+/g, ''))}
                      placeholder="or type it in"
                      code
                    />
                  </View>
                </View>
              )}
            </Field>
          </Rise>

          {/* The one thing this screen must never do: let somebody fill out a
              whole form for a barcode that already exists. */}
          {!!existing && (
            <Note
              icon="alert-triangle"
              tone={T.amber}
              text={
                `${barcode} is already on the fleet` +
                (existing.c ? `, out at ${existing.c}.` : `${existing.l ? `, at ${existing.l}.` : '.'}`) +
                ' Nothing here will be saved.'
              }
              action="Open the record"
              onAction={() => router.push(`/asset/${encodeURIComponent(barcode)}` as never)}
            />
          )}

          {/* Not while the viewfinder is open — the camera fills this space and
              the note would sit under a live preview the driver is aiming. */}
          {!scanning && !!barcodeNudge && (
            <Note icon="alert-triangle" tone={T.amber} text={`${barcodeNudge} Check the label — it will still save.`} />
          )}

          {/* ── the rest only matters once the barcode is new ── */}
          {!!barcode && !existing && (
            <Rise delay={40}>
              <Field
                label="What kind"
                hint={products.length ? 'Commonest first.' : undefined}
              >
                <Chips
                  options={products}
                  value={product}
                  onChange={pickProduct}
                  placeholder="Product code"
                />
              </Field>

              <Field label="Serial number" hint="Optional — stamped on the collar, if there is one.">
                <TextField
                  value={serial}
                  onChangeText={setSerial}
                  placeholder="Leave blank if there is none"
                  code
                />
              </Field>

              <Field label="What is in it">
                <Choice
                  options={[
                    { value: 'full', label: 'FULL', sub: 'ready to go out' },
                    { value: 'empty', label: 'EMPTY', sub: 'needs filling' },
                  ]}
                  value={full === null ? null : full ? 'full' : 'empty'}
                  onChange={(v) => setFull(v === 'full')}
                />
              </Field>

              <Field label="Where it lives" hint="Optional. Leave it blank if it has no shelf yet.">
                <Chips
                  options={locations}
                  value={location}
                  onChange={setLocation}
                  placeholder="Bay 4, Rack B, Dock…"
                  code={false}
                />
              </Field>

              <Field
                label="Next requalification"
                hint="Optional. The date it next has to be tested."
              >
                <DateField value={requal} onChange={setRequal} />
              </Field>

              {/*
                One pick above fills these together; they stay editable because
                an individual cylinder is allowed to disagree with its
                catalogue entry. All optional, all pallet facts — they hold
                their values between saves.

                PICKED FROM WHAT THE FLEET ALREADY SAYS, NOT TYPED.

                These were text boxes, and a text box is how a column that
                exists to be grouped by gets four spellings of argon in it.
                Every value already on the fleet is a chip; `Chips` keeps its
                escape hatch for the genuinely new one, so a first-of-its-kind
                cylinder is still addable — it just cannot be added by
                mistyping one that exists. Description stays a box: it is prose
                about one object, not a value that has to match.
              */}
              <Field
                label="Gas type"
                hint={typeFilled ? 'Filled from the product code — change it if this one differs.' : 'What is in it.'}
              >
                <Chips
                  options={attrs.gas} value={gas} onChange={setGas}
                  placeholder="Gas type — Oxygen, Acetylene…" freeLabel="Not on the list"
                />
              </Field>

              <Field label="Category" hint="Industrial, medical, beverage.">
                <Chips
                  options={attrs.category} value={category} onChange={setCategory}
                  placeholder="Category — Industrial, Medical…" freeLabel="Not on the list"
                />
              </Field>

              <Field label="Group" hint="How it is grouped on reports.">
                <Chips
                  options={attrs.group} value={group} onChange={setGroup}
                  placeholder="Group — High-Pressure, Cryo…" freeLabel="Not on the list"
                />
              </Field>

              <Field label="Description" hint="Optional. What a new hire should know.">
                <TextField
                  value={desc} onChangeText={setDesc} code={false}
                  placeholder="Description — what a new hire should know"
                />
              </Field>

              <Field
                label="Belongs to"
                hint="Optional. A supplier label — WeldCor, Linde. This does NOT change billing."
              >
                <Chips
                  options={attrs.supplier} value={owner} onChange={setOwner}
                  placeholder="Ours — leave blank" freeLabel="A new supplier"
                />
              </Field>
            </Rise>
          )}

          {/* ── what has gone in so far ── */}
          {added.length > 0 && (
            <Rise delay={40}>
              <View style={{ marginTop: 30 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 11 }}>
                  <Text style={{ color: T.steel, fontSize: 12.5, fontWeight: '700', letterSpacing: 0.6 }}>
                    ADDED THIS SESSION
                  </Text>
                  <Text style={[mono(13, '700'), { color: T.brandLit, marginLeft: 'auto' }]}>
                    {added.length}
                  </Text>
                </View>
                <Surface>
                  {added.slice(0, 12).map((bc, i) => (
                    <Pressable
                      key={bc}
                      onPress={() => router.push(`/asset/${encodeURIComponent(bc)}` as never)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${bc}`}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, minHeight: 48,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                      }}
                    >
                      <Icon name="check" size={ICON.sm} color={T.bottle} />
                      <Text style={[mono(14.5, '600'), { color: T.ink, flex: 1 }]}>{bc}</Text>
                      <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
                    </Pressable>
                  ))}
                </Surface>
                {added.length > 12 && (
                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 10 }}>
                    and {added.length - 12} more.
                  </Text>
                )}
              </View>
            </Rise>
          )}

          {/* The way through to the batch screen, offered where the pallet is
              already being talked about. This screen keeps the shared fields
              between saves, which is enough for a pallet with no serials on
              it; the moment each cylinder needs its own serial typed, one save
              per bottle is the wrong shape and the other screen is the right
              one. Everything here still works exactly as it did. */}
          {!barcode && (
            <Note
              text={
                `Scanning the same pallet over and over? What kind, where, and full or ` +
                `empty all stay put between saves — only the barcode clears. If every one ` +
                `of them needs its own serial number, do the whole pallet in one go instead.`
              }
              action="Add a whole pallet"
              onAction={() => router.push('/asset/batch')}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {ready && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            backgroundColor: 'rgba(7,9,10,0.94)',
            borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Btn
            label={`Add ${barcode}`}
            sub={[product.trim(), full ? 'full' : 'empty', location.trim()].filter(Boolean).join(' · ')}
            busy={busy}
            onPress={save}
          />
        </View>
      )}
    </Screen>
  );
}
