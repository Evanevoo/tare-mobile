import { useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useStore } from '@/store';
import { T, Screen, Surface, Eyebrow, Rise, Hairline, tint } from '@/ui';

/**
 * The fleet, counted — entirely from the phone's own cache.
 *
 * A yard supervisor leaning on a truck wants four numbers and a ranking, not
 * a dashboard. Everything here comes off the bootstrap already on the device,
 * so it answers instantly and in a yard with no bars. "As of last sync" is
 * printed rather than implied, because a number with no timestamp gets
 * trusted exactly once.
 *
 * The "Where" row answers the actual question that sends someone walking to
 * the other yard: not "how many do we own" but "is one sitting here, full,
 * right now." Available means in-house AND full — an empty one on the shelf
 * is real stock but is not a yes to a customer asking for one today.
 */
export default function Analytics() {
  const { boot, lastSync } = useStore();
  const [loc, setLoc] = useState<string | null>(null);

  const rows = Object.values(boot?.assets ?? {});
  const total = rows.length;
  const out = rows.filter((a) => a.c).length;
  const availableNow = rows.filter((a) => !a.c && a.f === 1).length;

  // Places worth offering as a filter — in-house stock only, since "where" is
  // meaningless for something out with a customer.
  const placeCounts = new Map<string, number>();
  for (const a of rows) {
    if (a.c || !a.l) continue;
    placeCounts.set(a.l, (placeCounts.get(a.l) ?? 0) + 1);
  }
  const places = [...placeCounts.entries()].sort((x, y) => y[1] - x[1]);

  // Per product, at the selected place (or everywhere): what's actually
  // ready to hand over right now, what's on the shelf but needs the fill
  // plant first, and what's out earning. "Out" ignores the place filter —
  // a cylinder at a customer does not have a yard, so filtering it by one
  // would just make it vanish from a filtered list for the wrong reason.
  const byProduct = new Map<string, { avail: number; needsFill: number; out: number }>();
  for (const a of rows) {
    const code = a.p ?? '(no product)';
    const row = byProduct.get(code) ?? { avail: 0, needsFill: 0, out: 0 };
    if (a.c) {
      row.out += 1;
    } else if (!loc || a.l === loc) {
      if (a.f === 1) row.avail += 1; else row.needsFill += 1;
    }
    byProduct.set(code, row);
  }
  const products = [...byProduct.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .filter((p) => p.avail + p.needsFill + p.out > 0)
    .sort((x, y) => y.avail - x.avail || (y.avail + y.needsFill) - (x.avail + x.needsFill) || x.code.localeCompare(y.code))
    .slice(0, 40);

  const pct = total ? Math.round((out / total) * 100) : 0;
  const plural = (boot?.org.assetPlural ?? 'assets').toLowerCase();

  return (
    <Screen intensity={0.7}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 44 }}>
        <Rise>
          <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1.1 }}>
            Analytics
          </Text>
          <Text style={{ color: T.faint, fontSize: 13, marginTop: 4 }}>
            {lastSync ? `As of last sync · ${new Date(lastSync).toLocaleString()}` : 'Not synced yet'}
          </Text>
        </Rise>

        <Rise delay={50} style={{ marginTop: 22 }}>
          <Surface>
            <View style={{ flexDirection: 'row' }}>
              <Stat v={String(total)} l={`${plural} in fleet`} />
              <VRule />
              <Stat v={String(out)} l="out with customers" tone={T.amber} />
              <VRule />
              <Stat v={String(total - out)} l="in house" tone={T.bottle} />
            </View>
            <Hairline />
            <View style={{ flexDirection: 'row' }}>
              <Stat v={`${pct}%`} l="of the fleet earning" />
              <VRule />
              <Stat v={String(availableNow)} l="available now" tone={T.bottle} />
              <VRule />
              <Stat v={String(boot?.stats?.customers ?? boot?.customers?.length ?? 0)} l="customers" />
            </View>
          </Surface>
        </Rise>

        {places.length > 0 && (
          <Rise delay={80} style={{ marginTop: 24 }}>
            <Eyebrow style={{ marginBottom: 10 }}>Where</Eyebrow>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Chip label="All places" on={loc === null} onPress={() => setLoc(null)} />
                {places.map(([name, n]) => (
                  <Chip key={name} label={`${name} · ${n}`} on={loc === name} onPress={() => setLoc(loc === name ? null : name)} />
                ))}
              </View>
            </ScrollView>
          </Rise>
        )}

        <Rise delay={110} style={{ marginTop: 24 }}>
          <Eyebrow style={{ marginBottom: 12 }}>
            {loc ? `By product — available at ${loc} first` : 'By product — available first'}
          </Eyebrow>
          <Surface>
            <View style={{ padding: 18, gap: 16 }}>
              {products.length === 0 && (
                <Text style={{ color: T.faint, fontSize: 13 }}>
                  {loc ? `Nothing on record at ${loc}.` : 'Nothing in the fleet yet.'}
                </Text>
              )}
              {products.map((p) => (
                <View key={p.code}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                    <Text style={{ color: T.ink, fontSize: 13.5, fontWeight: '600', flex: 1 }} numberOfLines={1}>
                      {p.code}
                    </Text>
                    <Text style={{
                      fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'],
                      color: p.avail > 0 ? T.bottle : T.faint,
                    }}>
                      {p.avail} available
                    </Text>
                  </View>
                  <Text style={{ color: T.steel, fontSize: 11.5, marginTop: 2 }}>
                    {p.out} out · {p.needsFill} need fill
                  </Text>
                </View>
              ))}
            </View>
          </Surface>
        </Rise>
      </ScrollView>
    </Screen>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  /**
   * The only control on this screen, and it had missed four rules at once:
   * 34pt tall against a 44pt floor, no hitSlop to make up the difference, no
   * pressed feedback of any kind, and nothing announced to a screen reader —
   * the selected range was carried by a background colour alone.
   *
   * Every sibling pattern in the app already does this correctly; this one
   * was written quickly and never revisited. `selected` is the part that
   * matters most: without it VoiceOver reads four identical buttons and gives
   * no way to tell which range is showing.
   */
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Show ${label}`}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => ({
        minHeight: 44, paddingHorizontal: 13, paddingVertical: 6, borderRadius: 10,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: on
          ? (pressed ? T.brandDark : T.bottle)
          : (pressed ? tint(0.11) : tint(0.05)),
        borderWidth: on ? 0 : 1, borderColor: T.rule,
      })}
    >
      <Text style={{ color: on ? T.onBrand : T.steel, fontSize: 12.5, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Stat({ v, l, tone }: { v: string; l: string; tone?: string }) {
  return (
    <View style={{ flex: 1, paddingVertical: 16, paddingHorizontal: 14 }}>
      <Text style={{ color: tone ?? T.ink, fontSize: 24, fontWeight: '700', letterSpacing: -0.8, fontVariant: ['tabular-nums'] }}>
        {v}
      </Text>
      <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 3 }}>{l}</Text>
    </View>
  );
}

function VRule() {
  return <View style={{ width: 1, backgroundColor: tint(0.07) }} />;
}
