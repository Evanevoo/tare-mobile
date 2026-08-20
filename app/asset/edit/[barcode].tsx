import { useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStore } from '@/store';
import { updateAsset, getAsset, ApiError, type AssetDraft, type AssetRec } from '@/api';
import {
  T, Screen, Btn, Rise, Tag, mono, useBottomInset,
} from '@/ui';
import {
  Field, TextField, Chips, Choice, DateField, Note, isRealDate,
} from '@/form';
import { useAttributeOptions } from '@/attributes';

/** What a person can set from here. `rented` is not chosen, it is caused. */
type Serviceable = 'available' | 'maintenance' | 'lost';
type Status = Serviceable | 'retired';

/**
 * Correcting the record on something you are holding.
 *
 * This screen edits what the thing IS: what kind, what serial, where it sits,
 * what is in it, whether it is fit for service. It cannot move it to a
 * customer, and that is the point rather than an omission. Custody is evidence
 * — it moves when somebody scans against an order, or when somebody physically
 * puts the thing on a shelf in Locate. A dropdown that reassigns a customer
 * would let one mis-tap move a rental onto the wrong account with nothing
 * downstream any the wiser.
 *
 * So when the thing is out at a customer, the screen says so and says what to
 * do about it, which is more useful than a greyed-out field.
 *
 * Marking something lost, retired, or needing work is the one edit that
 * reaches money: a customer with an open rental on it stops being charged. The
 * server refuses the first attempt and reports how many rentals are open; the
 * driver is told plainly, and only then does it go through.
 */
export default function EditAsset() {
  const router = useRouter();
  const { barcode: raw } = useLocalSearchParams<{ barcode: string }>();
  const barcode = (raw ?? '').toUpperCase();
  const { boot, refresh } = useStore();
  const bottom = useBottomInset(24);

  // What this org already calls its gases, categories, groups and suppliers —
  // derived from the fleet on the phone, so the pickers work with no signal.
  const attrs = useAttributeOptions();

  /**
   * The record can come from two places: the phone's downloaded copy, or —
   * when the last bootstrap has never heard of this barcode — the server,
   * fetched on demand. "Not on this phone" used to be a dead end that sent
   * people to Add, where the server would then 409 them; the lookup is the
   * door out.
   */
  const cached = boot?.assets[barcode];
  const [fetched, setFetched] = useState<(AssetRec & { barcode: string }) | null>(null);
  const [looking, setLooking] = useState(false);
  const asset = cached ?? (fetched && fetched.barcode === barcode ? fetched : undefined);
  const label = boot?.org.assetLabel ?? 'asset';

  const [product, setProduct] = useState(asset?.p ?? '');
  const [serial, setSerial] = useState(asset?.sn ?? '');
  const [location, setLocation] = useState(asset?.l ?? '');
  const [full, setFull] = useState<boolean>(asset?.f === 1);
  const [status, setStatus] = useState<Status>(
    // `rented` is not a thing anyone picks — it is what being out at a
    // customer means. Editing an out asset starts from in-service.
    asset && asset.s !== 'rented' ? (asset.s as Status) : 'available',
  );
  const [requal, setRequal] = useState(asset?.rq ?? '');
  // The 017 columns plus the supplier label, same vocabulary as Add.
  const [gas, setGas] = useState(asset?.gt ?? '');
  const [category, setCategory] = useState(asset?.cat ?? '');
  const [group, setGroup] = useState(asset?.grp ?? '');
  const [desc, setDesc] = useState(asset?.ds ?? '');
  const [owner, setOwner] = useState(asset?.sup ?? '');
  /**
   * The barcode itself, editable at last. Starts as what the route was
   * opened with; a change is confirmed twice (here and on the server's
   * uniqueness check) because the whole history hangs on this string.
   */
  const [newCode, setNewCode] = useState(barcode);
  const [busy, setBusy] = useState(false);

  /** A server record arriving after first render has to land in the form. */
  function seed(a: AssetRec) {
    setProduct(a.p ?? '');
    setSerial(a.sn ?? '');
    setLocation(a.l ?? '');
    setFull(a.f === 1);
    setStatus(a.s !== 'rented' ? (a.s as Status) : 'available');
    setRequal(a.rq ?? '');
    setGas(a.gt ?? '');
    setCategory(a.cat ?? '');
    setGroup(a.grp ?? '');
    setDesc(a.ds ?? '');
    setOwner(a.sup ?? '');
    setNewCode(barcode);
  }

  async function lookup() {
    setLooking(true);
    try {
      const r = await getAsset(barcode);
      if (!r.asset) {
        Alert.alert(
          'Not on the fleet either',
          `The server has never heard of ${barcode}. If it is real, add it as a new ${label.toLowerCase()}.`,
        );
      } else {
        setFetched(r.asset);
        seed(r.asset);
      }
    } catch (e: unknown) {
      Alert.alert('Could not look it up', e instanceof Error ? e.message : 'Try again with signal.');
    } finally {
      setLooking(false);
    }
  }

  const products = useMemo(
    () => (boot?.products ?? []).map((p) => ({ key: p.code, sub: `${p.n} on fleet` })),
    [boot?.products],
  );
  const locations = useMemo(
    () => (boot?.locations ?? []).map((l) => ({ key: l })),
    [boot?.locations],
  );

  const dateOk = !requal || isRealDate(requal);
  const outAt = asset?.c ?? null;

  // Only what actually moved gets sent, so an accidental open-and-close writes
  // nothing and the audit log stays worth reading.
  const changes = useMemo(() => {
    if (!asset) return {} as Partial<AssetDraft>;
    const d: Partial<AssetDraft> = {};
    if (product.trim() !== (asset.p ?? '')) d.productCode = product.trim();
    if ((serial.trim() || null) !== (asset.sn || null)) d.serialNumber = serial.trim() || null;
    if ((location.trim() || null) !== (asset.l || null)) d.location = location.trim() || null;
    if (full !== (asset.f === 1)) d.isFull = full;
    if (status !== asset.s && !(asset.s === 'rented' && status === 'available')) d.status = status;
    if ((requal || null) !== (asset.rq || null)) d.nextRequalOn = requal || null;
    if ((gas.trim() || null) !== (asset.gt ?? null)) d.gasType = gas.trim() || null;
    if ((category.trim() || null) !== (asset.cat ?? null)) d.category = category.trim() || null;
    if ((group.trim() || null) !== (asset.grp ?? null)) d.groupName = group.trim() || null;
    if ((desc.trim() || null) !== (asset.ds ?? null)) d.description = desc.trim() || null;
    if ((owner.trim() || null) !== (asset.sup ?? null)) d.owner = owner.trim() || null;
    return d;
  }, [asset, product, serial, location, full, status, requal, gas, category, group, desc, owner]);

  /** The barcode, treated apart from the draft: it is the identity, not a field. */
  const cleanCode = newCode.replace(/\s+/g, '').toUpperCase();
  const codeChanged = !!cleanCode && cleanCode !== barcode;

  const count = Object.keys(changes).length + (codeChanged ? 1 : 0);
  const ready = count > 0 && !!product.trim() && dateOk && !!cleanCode && !busy;

  async function save(confirmCloseRentals = false, confirmBarcode = false) {
    if (!ready && !confirmCloseRentals) return;

    // The two-step for the one field everything else hangs on. Asked before
    // the request, so a fat-fingered scan-into-the-wrong-box never reaches
    // the server at all.
    if (codeChanged && !confirmBarcode) {
      Alert.alert(
        'Change the barcode?',
        `${barcode} becomes ${cleanCode}. Every scan and rental it has ever had comes with it — but any label still printed with the old number stops matching this record.`,
        [
          { text: 'Keep the old one', style: 'cancel', onPress: () => setNewCode(barcode) },
          { text: `Use ${cleanCode}`, onPress: () => { void save(confirmCloseRentals, true); } },
        ],
      );
      return;
    }

    setBusy(true);
    try {
      const r = await updateAsset(barcode, {
        ...changes,
        ...(codeChanged ? { newBarcode: cleanCode } : {}),
        confirmCloseRentals,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refresh().catch(() => {});
      Alert.alert(
        'Saved',
        [
          codeChanged ? `${barcode} is now ${cleanCode}.` : `${barcode} updated.`,
          r.closed
            ? `${r.closed} open rental${r.closed === 1 ? '' : 's'} closed — that customer stops being charged for it.`
            : null,
        ].filter(Boolean).join('\n\n'),
        [{ text: 'Done', onPress: () => router.back() }],
      );
    } catch (e: unknown) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      // The server refuses once, on purpose, so this warning can be shown with
      // a real number in it rather than a vague "this may affect billing".
      if (e instanceof ApiError && e.status === 409 && e.body?.needsConfirm) {
        Alert.alert(
          'This ends a rental',
          e.body.error,
          [
            { text: 'Leave it', style: 'cancel' },
            {
              text: 'End it and save',
              style: 'destructive',
              // confirmBarcode too — that question was already answered on
              // the way in, and asking it twice in one save reads as a loop.
              onPress: () => { void save(true, true); },
            },
          ],
        );
      } else {
        Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!asset) {
    return (
      <Screen>
        <View style={{ padding: 26, paddingTop: 60 }}>
          <Text style={{ color: T.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.6 }}>
            Not on this phone
          </Text>
          <Text style={{ color: T.faint, fontSize: 14, marginTop: 8, lineHeight: 21 }}>
            {barcode} is not in the copy this phone downloaded. It may still be on the
            fleet — added from another handset since the last sync, or under a corrected
            barcode. Ask the server before assuming it is new.
          </Text>
          <Btn
            label={looking ? 'Asking the server…' : 'Look it up'}
            busy={looking}
            style={{ marginTop: 22 }}
            onPress={() => { void lookup(); }}
          />
          <Btn
            label="Add it as new instead"
            variant="ghost"
            style={{ marginTop: 10 }}
            onPress={() => router.replace('/asset/new' as never)}
          />
        </View>
      </Screen>
    );
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
            // Clearing the transparent header is now Screen's job — it does it
            // for every screen rather than the two that noticed. This is just
            // breathing room under it.
            paddingTop: 10,
            paddingBottom: bottom + (count ? 108 : 40),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Rise>
            <Text style={[mono(25, '700'), { color: T.ink, letterSpacing: -0.5 }]}>
              {barcode}
            </Text>
            <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 6, lineHeight: 20 }}>
              Fix what is wrong on the record. Nothing here moves it to or from a customer.
            </Text>
          </Rise>

          {/* Custody, explained rather than greyed out. */}
          {!!outAt && (
            <Note
              icon="truck"
              tone={T.amber}
              text={`Out at ${outAt}. To bring it back in-house, scan it as a return against their order, or put it away in Locate.`}
              action="Open Locate"
              onAction={() => router.push('/(tabs)/warehouse' as never)}
            />
          )}

          <Rise delay={50}>
            <Field
              label="Barcode"
              hint="Editable at last — for relabelled bottles and mistyped adds. You will be asked to confirm."
            >
              <TextField
                value={newCode}
                onChangeText={(v) => setNewCode(v.replace(/\s+/g, ''))}
                placeholder={barcode}
                code
              />
            </Field>

            <Field label="What kind">
              <Chips
                options={products}
                value={product}
                onChange={setProduct}
                placeholder="Product code"
              />
            </Field>

            <Field label="Serial number">
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
                value={full ? 'full' : 'empty'}
                onChange={(v) => setFull(v === 'full')}
              />
            </Field>

            <Field label="Where it lives">
              <Chips
                options={locations}
                value={location}
                onChange={setLocation}
                placeholder="Bay 4, Rack B, Dock…"
                code={false}
              />
            </Field>

            <Field
              label="Condition"
              hint="Anything other than in service takes it off the fleet — and off any customer still being charged for it."
            >
              <Choice<Serviceable>
                options={[
                  { value: 'available', label: 'IN SERVICE' },
                  { value: 'maintenance', label: 'NEEDS WORK' },
                  { value: 'lost', label: 'LOST' },
                ]}
                value={status === 'retired' ? null : status}
                onChange={setStatus}
                tone={status === 'available' ? T.brandLit : T.amber}
              />
              {status === 'retired' && (
                <View style={{ marginTop: 11, flexDirection: 'row' }}>
                  <Tag label="RETIRED" tone={T.needle} />
                </View>
              )}
            </Field>

            <Field label="Next requalification">
              <DateField value={requal} onChange={setRequal} />
            </Field>

            {/*
              PICK, DO NOT TYPE.

              These were four text boxes, which is the wrong control for a
              value whose whole job is to match other rows: typing is how one
              gas ends up spelled four ways and no report can group by it
              again. Every answer the fleet already uses is offered here, and
              `Chips` keeps its "Something else" toggle for the genuinely new
              one — so a new gas can still arrive, it just cannot arrive by
              accident. Description stays typed: it is prose about this one
              object, not a value that has to match anything.
            */}
            <Field label="Gas type" hint="What is in it.">
              <Chips
                options={attrs.gas}
                value={gas}
                onChange={setGas}
                placeholder="Gas type — Oxygen, Acetylene…"
                freeLabel="Not on the list"
              />
            </Field>

            <Field label="Category" hint="Industrial, medical, beverage.">
              <Chips
                options={attrs.category}
                value={category}
                onChange={setCategory}
                placeholder="Category — Industrial, Medical…"
                freeLabel="Not on the list"
              />
            </Field>

            <Field label="Group" hint="How it is grouped on reports.">
              <Chips
                options={attrs.group}
                value={group}
                onChange={setGroup}
                placeholder="Group — High-Pressure, Cryo…"
                freeLabel="Not on the list"
              />
            </Field>

            <Field label="Description" hint="Optional. Anything a person needs to recognise it.">
              <TextField value={desc} onChangeText={setDesc} placeholder="Description" code={false} />
            </Field>

            <Field
              label="Belongs to"
              hint="A supplier label — WeldCor, Linde. Blank means ours. This does NOT change billing."
            >
              <Chips
                options={attrs.supplier}
                value={owner}
                onChange={setOwner}
                placeholder="Ours — leave blank"
                freeLabel="A new supplier"
              />
            </Field>

            {asset.own === 1 && (
              <Note
                icon="lock"
                text="This one belongs to the customer, so it never accrues rental. Only a manager can change that, and only from the web app."
              />
            )}
          </Rise>

          {count === 0 && (
            <Note text="Nothing has changed yet. The save button appears once something does." />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {count > 0 && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            backgroundColor: 'rgba(7,9,10,0.94)',
            borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Btn
            label={`Save ${count} change${count === 1 ? '' : 's'}`}
            sub={[...(codeChanged ? ['barcode'] : []), ...Object.keys(changes).map(prettyField)].join(' · ')}
            busy={busy}
            disabled={!ready}
            onPress={() => { void save(false); }}
          />
        </View>
      )}
    </Screen>
  );
}

/** Field names as a person would say them, for the button subtitle. */
function prettyField(k: string): string {
  switch (k) {
    case 'productCode': return 'kind';
    case 'serialNumber': return 'serial';
    case 'isFull': return 'contents';
    case 'location': return 'location';
    case 'status': return 'condition';
    case 'nextRequalOn': return 'requal';
    case 'gasType': return 'gas type';
    case 'category': return 'category';
    case 'groupName': return 'group';
    case 'description': return 'description';
    case 'owner': return 'belongs to';
    default: return k;
  }
}
