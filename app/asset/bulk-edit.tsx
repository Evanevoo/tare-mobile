import { useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStore } from '@/store';
import { bulkUpdateAssets, type BulkAssetPatch } from '@/api';
import {
  T, Screen, Btn, Rise, mono, useBottomInset,
} from '@/ui';
import { Field, Chips, Choice } from '@/form';
import { useAttributeOptions } from '@/attributes';

/**
 * The same correction, applied to a stack at once.
 *
 * Deliberately narrower than editing one asset: no status, no contents, no
 * custody. Those record something true of one physical cylinder at one
 * moment — batching them would be a shortcut around a decision that has to
 * be made per-bottle. What kind, where it sits, who owns it, though, is
 * often genuinely the same across a whole pallet someone just unloaded, so
 * asking once for the group is honest rather than a corner cut.
 *
 * Only fields the person actually touches get sent — leaving everything
 * blank and hitting nothing does nothing, on purpose, rather than clearing
 * a group's product code because a screen was closed too fast.
 */
export default function BulkEditAssets() {
  const router = useRouter();
  const { barcodes: raw } = useLocalSearchParams<{ barcodes: string }>();
  const { boot, refresh } = useStore();
  const bottom = useBottomInset(24);

  const barcodes = useMemo<string[]>(() => {
    try {
      const arr = JSON.parse(raw ?? '[]');
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }, [raw]);

  const label = boot?.org.assetPlural ?? 'assets';

  const [product, setProduct] = useState('');
  const [location, setLocation] = useState('');
  const [gas, setGas] = useState('');
  const [category, setCategory] = useState('');
  const [group, setGroup] = useState('');
  const [owner, setOwner] = useState('');
  const [owned, setOwned] = useState<'unset' | 'yours' | 'theirs'>('unset');
  const [busy, setBusy] = useState(false);

  // Gas, category, group and supplier, as this fleet already spells them.
  const attrs = useAttributeOptions();

  const products = useMemo(
    () => (boot?.products ?? []).map((p) => ({ key: p.code, sub: `${p.n} on fleet` })),
    [boot?.products],
  );
  const locations = useMemo(
    () => (boot?.locations ?? []).map((l) => ({ key: l })),
    [boot?.locations],
  );

  const changes = useMemo(() => {
    const p: BulkAssetPatch = {};
    if (product.trim()) p.productCode = product.trim();
    if (location.trim()) p.location = location.trim();
    if (gas.trim()) p.gasType = gas.trim();
    if (category.trim()) p.category = category.trim();
    if (group.trim()) p.groupName = group.trim();
    if (owner.trim()) p.owner = owner.trim();
    if (owned !== 'unset') p.customerOwned = owned === 'theirs';
    return p;
  }, [product, location, gas, category, group, owner, owned]);

  const count = Object.keys(changes).length;
  const ready = count > 0 && !busy && barcodes.length > 0;

  async function save() {
    if (!ready) return;
    setBusy(true);
    try {
      const r = await bulkUpdateAssets(barcodes, changes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refresh().catch(() => {});
      Alert.alert(
        'Saved',
        [
          `${r.updated} of ${barcodes.length} ${label.toLowerCase()} updated.`,
          r.missing.length
            ? `${r.missing.length} not found on this phone: ${r.missing.slice(0, 6).join(', ')}${r.missing.length > 6 ? '…' : ''}`
            : null,
        ].filter(Boolean).join('\n\n'),
        [{ text: 'Done', onPress: () => router.back() }],
      );
    } catch (e: unknown) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!barcodes.length) {
    return (
      <Screen>
        <View style={{ padding: 26, paddingTop: 60 }}>
          <Text style={{ color: T.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.6 }}>
            Nothing selected
          </Text>
          <Text style={{ color: T.faint, fontSize: 14, marginTop: 8, lineHeight: 21 }}>
            Go back to search and pick a few {label.toLowerCase()} first.
          </Text>
          <Btn label="Back to search" style={{ marginTop: 22 }} onPress={() => router.back()} />
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
            paddingTop: 10,
            paddingBottom: bottom + (count ? 108 : 40),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Rise>
            <Text style={[mono(25, '700'), { color: T.ink, letterSpacing: -0.5 }]}>
              {barcodes.length} {label}
            </Text>
            <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 6, lineHeight: 20 }}>
              Only what you set below changes. Everything else on each record stays as it is.
            </Text>
          </Rise>

          <Rise delay={50}>
            <Field label="What kind" hint="Leave blank to leave each one's product code alone.">
              <Chips
                options={products}
                value={product}
                onChange={setProduct}
                placeholder="Product code"
              />
            </Field>

            <Field label="Where they live" hint="Leave blank to leave each one's location alone.">
              <Chips
                options={locations}
                value={location}
                onChange={setLocation}
                placeholder="Bay 4, Rack B, Dock…"
                code={false}
              />
            </Field>

            {/*
              THE TYPE FIELDS BELONG HERE MOST OF ALL.

              A pallet that arrived mislabelled is mislabelled identically on
              every bottle in it, so correcting gas type or category one
              cylinder at a time is forty repetitions of the same sentence.
              The server has accepted these on this endpoint since it was
              written; the screen simply never offered them.

              Description is deliberately still absent: it is prose about one
              object. Forty cylinders sharing one sentence is a sentence that
              describes none of them.
            */}
            <Field label="Gas type" hint="Leave blank to leave each one's gas type alone.">
              <Chips
                options={attrs.gas} value={gas} onChange={setGas}
                placeholder="Gas type" freeLabel="Not on the list"
              />
            </Field>

            <Field label="Category" hint="Leave blank to leave each one's category alone.">
              <Chips
                options={attrs.category} value={category} onChange={setCategory}
                placeholder="Category" freeLabel="Not on the list"
              />
            </Field>

            <Field label="Group" hint="Leave blank to leave each one's group alone.">
              <Chips
                options={attrs.group} value={group} onChange={setGroup}
                placeholder="Group" freeLabel="Not on the list"
              />
            </Field>

            <Field
              label="Belong to"
              hint="A supplier label. Leave blank to leave it alone — this does NOT change billing."
            >
              <Chips
                options={attrs.supplier} value={owner} onChange={setOwner}
                placeholder="Supplier" freeLabel="A new supplier"
              />
            </Field>

            <Field
              label="Who owns them"
              hint="Only a manager can set this — it decides whether these bill at all."
            >
              <Choice
                options={[
                  { value: 'unset', label: 'LEAVE AS IS' },
                  { value: 'yours', label: 'OURS', sub: 'accrues rental' },
                  { value: 'theirs', label: "CUSTOMER'S", sub: 'never bills' },
                ]}
                value={owned}
                onChange={setOwned}
              />
            </Field>
          </Rise>

          {count === 0 && (
            <Text style={{ color: T.faint, fontSize: 13, marginTop: 16, lineHeight: 19 }}>
              Nothing has changed yet. The save button appears once something does.
            </Text>
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
            label={`Save on ${barcodes.length} ${label.toLowerCase()}`}
            sub={Object.keys(changes).map(prettyField).join(' · ')}
            busy={busy}
            disabled={!ready}
            onPress={() => { void save(); }}
          />
        </View>
      )}
    </Screen>
  );
}

function prettyField(k: string): string {
  switch (k) {
    case 'productCode': return 'kind';
    case 'location': return 'location';
    case 'gasType': return 'gas type';
    case 'category': return 'category';
    case 'groupName': return 'group';
    case 'owner': return 'belongs to';
    case 'customerOwned': return 'ownership';
    default: return k;
  }
}
