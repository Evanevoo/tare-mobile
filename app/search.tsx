import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, SectionList } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useStore } from '@/store';
import { T, Screen, Surface, Eyebrow, Tag, Icon, ICON, mono, tint, wash } from '@/ui';
import type { AssetRec, CustomerRec } from '@/api';

/**
 * One row shape for both kinds of result.
 *
 * SectionList wants a single item type, and the alternative — casting the
 * callbacks and hoping — is how a rename three months from now becomes a
 * runtime crash instead of a type error.
 */
type Hit =
  | { kind: 'asset'; key: string; bc: string; a: AssetRec }
  | { kind: 'customer'; key: string; c: CustomerRec };

/**
 * One box, both kinds of thing.
 *
 * A person holding a cylinder and a person looking up an account are doing the
 * same action — "find this" — and should not have to tell the app which kind
 * of thing it is first. Results are sectioned, so the answer is still
 * unambiguous once it arrives.
 *
 * The camera is here rather than on Home because scanning to look something up
 * is a search, not a delivery. Pointing it at a label jumps straight to the
 * asset when there is exactly one match, which is the whole point.
 */
export default function Search() {
  const router = useRouter();
  const { boot } = useStore();
  const [q, setQ] = useState('');
  const [cam, setCam] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();

  const term = q.trim().toLowerCase();

  const sections = useMemo((): { title: string; data: Hit[] }[] => {
    if (!term || !boot) return [];

    const customers: Hit[] = boot.customers
      .filter((c) => c.name.toLowerCase().includes(term) ||
                     c.customerListId.toLowerCase().includes(term) ||
                     (c.city ?? '').toLowerCase().includes(term))
      .slice(0, 25)
      .map((c) => ({ kind: 'customer', key: `c:${c.id}`, c }));

    const assets: Hit[] = Object.entries(boot.assets)
      .filter(([bc, a]) => bc.toLowerCase().includes(term) ||
                           (a.sn ?? '').toLowerCase().includes(term) ||
                           (a.p ?? '').toLowerCase() === term)
      .slice(0, 25)
      .map(([bc, a]) => ({ kind: 'asset', key: `a:${bc}`, bc, a }));

    return [
      ...(assets.length ? [{ title: boot.org.assetPlural, data: assets }] : []),
      ...(customers.length ? [{ title: 'Customers', data: customers }] : []),
    ];
  }, [term, boot]);

  function onScan(raw: string) {
    const bc = raw.trim().toUpperCase();
    if (!bc || !boot) return;
    setCam(false);
    if (boot.assets[bc]) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(`/asset/${encodeURIComponent(bc)}` as never);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setQ(bc);
    }
  }

  return (
    <Screen intensity={0.7}>
      <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TextInput
            value={q} onChangeText={setQ}
            placeholder={`Customer, barcode or serial…`}
            placeholderTextColor={T.faint}
            autoCorrect={false} autoCapitalize="none" autoFocus
            style={{
              flex: 1, height: 54, borderRadius: T.radiusSm, paddingHorizontal: 16,
              color: T.ink, fontSize: 16,
              backgroundColor: tint(0.05),
              borderWidth: 1, borderColor: term ? wash(0.4) : T.rule,
            }}
          />
          <Pressable
            onPress={async () => {
              if (!perm?.granted) { const r = await requestPerm(); if (!r.granted) return; }
              setCam((v) => !v);
            }}
            accessibilityRole="button"
            accessibilityLabel={cam ? 'Close the camera' : 'Scan a barcode to search'}
            style={{
              width: 54, height: 54, borderRadius: T.radiusSm,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: cam ? wash(0.16) : tint(0.05),
              borderWidth: 1, borderColor: cam ? wash(0.45) : T.rule,
            }}
          >
            <Icon name={cam ? 'x' : 'camera'} size={ICON.md} color={cam ? T.brandLit : T.steel} />
          </Pressable>
        </View>

        {cam && perm?.granted && (
          <View
            style={{
              height: 200, borderRadius: T.radius, overflow: 'hidden', marginTop: 12,
              borderWidth: 1, borderColor: T.rule,
            }}
          >
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ['code128', 'code39', 'ean13', 'ean8', 'upc_a', 'qr', 'datamatrix'],
              }}
              onBarcodeScanned={({ data }) => onScan(data)}
            />
          </View>
        )}
      </View>

      <SectionList<Hit, { title: string; data: Hit[] }>
        sections={sections}
        keyExtractor={(item) => item.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 40 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text
            style={{
              color: T.faint, fontSize: 13.5, textAlign: 'center',
              paddingTop: 40, paddingHorizontal: 40, lineHeight: 20,
            }}
          >
            {term ? `Nothing matches \u201C${q.trim()}\u201D.` : 'Type a name, an account number or a barcode.'}
          </Text>
        }
        renderSectionHeader={({ section }) => (
          <Eyebrow style={{ marginTop: 20, marginBottom: 10 }}>{section.title}</Eyebrow>
        )}
        renderItem={({ item }) =>
          item.kind === 'customer' ? (
            <Pressable
              onPress={() => router.push(`/customer/${item.c.id}` as never)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, marginBottom: 8 })}
            >
              <Surface>
                <View style={{ padding: 15, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '600' }}>{item.c.name}</Text>
                    <Text style={[mono(12, '500'), { color: T.faint, marginTop: 2 }]}>
                      {item.c.customerListId}{item.c.city ? ` \u00B7 ${item.c.city}` : ''}
                    </Text>
                  </View>
                  {item.c.held > 0 && <Tag label={`${item.c.held} out`} tone={T.bottle} />}
                  <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
                </View>
              </Surface>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => router.push(`/asset/${encodeURIComponent(item.bc)}` as never)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, marginBottom: 8 })}
            >
              <Surface>
                <View style={{ padding: 15, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[mono(15, '600'), { color: T.ink }]}>{item.bc}</Text>
                    <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>
                      {item.a.p ?? 'unknown type'}
                      {item.a.c ? ` \u00B7 out at ${item.a.c}` : ' \u00B7 in house'}
                    </Text>
                  </View>
                  <Tag label={item.a.f ? 'FULL' : 'EMPTY'} tone={item.a.f ? T.bottle : T.faint} />
                  <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
                </View>
              </Surface>
            </Pressable>
          )
        }
      />
    </Screen>
  );
}
