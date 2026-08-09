import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, SectionList } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useStore } from '@/store';
import { Scanner } from '@/scanner';
import { useScanRoute, explainMiss } from '@/scan-route';
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
  const route = useScanRoute();
  const [q, setQ] = useState('');
  const [cam, setCam] = useState(false);
  const [miss, setMiss] = useState<string | null>(null);

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

  /**
   * A SCAN HERE GOES THROUGH THE SAME DECISION AS EVERY OTHER CAMERA.
   *
   * This used to look up `boot.assets[bc]` itself and drop anything that was
   * not an asset into the search box as literal text — which is the entire
   * customer half of the scan path missing. A customer card read on this
   * screen could never open an account, because the code never reached
   * `classify`: it went straight into a NAME search, which a card code cannot
   * possibly satisfy, and the screen answered "Nothing matches". "One box,
   * both kinds of thing" was the promise on this screen and only assets ever
   * kept it.
   *
   * And when nothing does match, the box now says which kind of nothing.
   */
  function onScan(raw: string) {
    setCam(false);
    const t = route(raw);
    if (!t) return;

    if (t.kind === 'text') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setQ(t.code);
      setMiss(explainMiss(raw, boot));
      return;
    }

    // route() has already opened the cylinder or the account.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setMiss(null);
  }

  return (
    <Screen intensity={0.7}>
      <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TextInput
            value={q} onChangeText={(v) => { setQ(v); setMiss(null); }}
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
          {/* Just a toggle. It used to request the camera permission itself and
              only then flip, and it silently did nothing whenever that request
              resolved without a decision — which on a second tap, after the OS
              has stopped showing the dialog, is every time. Scanner asks for
              the permission and explains itself if it is refused, the same way
              it does on the other three scan surfaces. */}
          <Pressable
            onPress={() => setCam((v) => !v)}
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

        {cam && (
          <Scanner
            onCode={onScan}
            onClose={() => setCam(false)}
            style={{
              height: 260, borderRadius: T.radius, overflow: 'hidden', marginTop: 12,
              borderWidth: 1, borderColor: T.rule,
            }}
          />
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
            {miss ? miss : term ? `Nothing matches \u201C${q.trim()}\u201D.` : 'Type a name, an account number or a barcode.'}
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
