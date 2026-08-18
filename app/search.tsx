import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, SectionList } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import { playScanAlert } from '@/sound';
import { useStore } from '@/store';
import { Scanner } from '@/scanner';
import { useScanRoute, explainMiss } from '@/scan-route';
import { T, Screen, Surface, Eyebrow, Tag, Icon, ICON, mono, tint, wash, useBottomInset } from '@/ui';
import { listChips, custodyCaption, type Tone } from '@/pending-ship';
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
  const bottom = useBottomInset(24);
  const [q, setQ] = useState('');
  const [cam, setCam] = useState(false);
  const [miss, setMiss] = useState<string | null>(null);

  /**
   * SELECT MODE — the entry point for bulk edit.
   *
   * A `Set` of barcodes, not asset objects: it is the same identity the bulk
   * edit screen and the server both key on, so there is nothing to translate
   * at the boundary. Customers are never selectable here — bulk edit changes
   * what a thing IS (type, location, owner), which is not a question a
   * customer row has an answer to.
   */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelected(bc: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(bc)) next.delete(bc); else next.add(bc);
      return next;
    });
  }

  function exitSelect() {
    setSelecting(false);
    setSelected(new Set());
  }

  const term = q.trim().toLowerCase();

  /* THE SAME FOUR MEANINGS, THE SAME FOUR COLOURS, AS THE ASSET SCREEN.
     This row used to draw OUT in amber and FULL in the brand blue, while
     app/asset/[barcode].tsx drew OUT in blue and FULL in green — so blue meant
     "full" on one screen and "out" on the next. That was survivable while
     amber meant nothing else. It is not survivable now: amber is what a
     cylinder scanned out and not yet approved is drawn in, and having it also
     mean "out at a customer" here would make the new state unreadable in the
     one place a driver skims. Built at render time because the palette object
     is mutated when the theme flips. */
  const TONE: Record<Tone, string> = {
    full: T.fern, empty: T.needle, out: T.bottle, pending: T.amber, quiet: T.steel,
  };

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
      // Same buzz and chirp as every other screen that reads a barcode — the
    // glove rule (see scan.tsx) is app-wide now, not per-screen: a gesture
    // that buzzes on one page and stays dead on another reads as broken.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Vibration.vibrate([0, 130, 90, 130]);
      playScanAlert();
      setQ(t.code);
      setMiss(explainMiss(raw, boot));
      return;
    }

    // route() has already opened the cylinder or the account — and already
    // buzzed and chirped for it (scan-route.ts), so nothing fires twice here.
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
              flex: 1, minHeight: 54, borderRadius: T.radiusSm, paddingHorizontal: 16,
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
          {/* Select mode — a second way to say "these, together" beyond
              tapping one thing into an edit screen. Its own toggle rather
              than a long-press, because a long-press has no visible
              affordance and this way the option is always in view. */}
          <Pressable
            onPress={() => (selecting ? exitSelect() : setSelecting(true))}
            accessibilityRole="button"
            accessibilityLabel={selecting ? 'Cancel selecting' : `Select multiple ${boot?.org.assetPlural ?? 'assets'} to edit`}
            style={{
              width: 54, height: 54, borderRadius: T.radiusSm,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: selecting ? wash(0.16) : tint(0.05),
              borderWidth: 1, borderColor: selecting ? wash(0.45) : T.rule,
            }}
          >
            <Icon name={selecting ? 'x' : 'check-square'} size={ICON.md} color={selecting ? T.brandLit : T.steel} />
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
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingBottom: selecting && selected.size > 0 ? bottom + 70 : 40,
        }}
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
              onPress={() =>
                selecting
                  ? toggleSelected(item.bc)
                  : router.push(`/asset/${encodeURIComponent(item.bc)}` as never)
              }
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, marginBottom: 8 })}
            >
              <Surface>
                <View style={{ padding: 15, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  {/* Selecting swaps the destination-affordance (chevron) for a
                      participation-affordance (checkbox) — the row still says
                      what it is, it just answers a different question while
                      this mode is on. */}
                  {selecting && (
                    <View
                      style={{
                        width: 22, height: 22, borderRadius: 6,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: selected.has(item.bc) ? T.brandLit : 'transparent',
                        borderWidth: selected.has(item.bc) ? 0 : 1.5,
                        borderColor: selected.has(item.bc) ? T.brandLit : T.rule,
                      }}
                    >
                      {selected.has(item.bc) && <Icon name="check" size={14} color={T.onBrand} />}
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[mono(15, '600'), { color: T.ink }]}>{item.bc}</Text>
                    <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>
                      {item.a.p ?? 'unknown type'}
                      {/* "in house \u00B7 scanned to POW City on 78089", or "in house
                          \u00B7 was at Howlett Construction". This row used to say the
                          same two words for a bottle that left this morning and
                          one that has not moved since March, which is the whole
                          complaint. Worded in src/pending-ship.ts so this row
                          and the asset screen cannot drift apart. */}
                      {` \u00B7 ${custodyCaption(item.a)}`}
                    </Text>
                  </View>
                  {!selecting && (
                    <>
                      {/* Full/empty is a shelf state; the line above already says
                          "out at <account>" for anything rented, so the tag only
                          adds a fill-state claim for what's actually in house.

                          Which chips a list row gets is decided in
                          src/pending-ship.ts, not here, so a second list
                          cannot quietly answer it differently.

                          The container wraps. Android exposes a font-size
                          slider and drivers turn it up, and a two-chip row that
                          cannot wrap runs off the card instead of moving down
                          a line — the same fault already fixed on scan.tsx. */}
                      <View style={{
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
                        gap: 6, flexWrap: 'wrap', rowGap: 4, flexShrink: 1,
                      }}>
                        {listChips(item.a).map((chip) => (
                          <Tag key={chip.label} label={chip.label} tone={TONE[chip.tone]} />
                        ))}
                      </View>
                      <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
                    </>
                  )}
                </View>
              </Surface>
            </Pressable>
          )
        }
      />

      {/* Selection bar — appears once there's something to act on, not the
          instant select mode turns on, so an empty "Edit 0" is never on
          screen to tap. */}
      {selecting && selected.size > 0 && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            flexDirection: 'row', alignItems: 'center', gap: 12,
            backgroundColor: 'rgba(7,9,10,0.94)', borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Text style={{ color: T.ink, fontSize: 14, fontWeight: '600', flex: 1 }}>
            {selected.size} selected
          </Text>
          <Pressable onPress={exitSelect} style={{ paddingVertical: 10, paddingHorizontal: 14 }}>
            <Text style={{ color: T.faint, fontSize: 14.5, fontWeight: '600' }}>Clear</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              const barcodes = [...selected];
              exitSelect();
              router.push({
                pathname: '/asset/bulk-edit' as never,
                params: { barcodes: JSON.stringify(barcodes) },
              } as never);
            }}
            style={{
              paddingVertical: 12, paddingHorizontal: 20, borderRadius: T.radiusSm,
              backgroundColor: T.brandLit,
            }}
          >
            <Text style={{ color: T.onBrand, fontSize: 14.5, fontWeight: '700' }}>
              Edit {selected.size}
            </Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}
