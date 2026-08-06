import { View, Text, ScrollView } from 'react-native';
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
 */
export default function Analytics() {
  const { boot, lastSync } = useStore();

  const rows = Object.values(boot?.assets ?? {});
  const total = rows.length;
  const out = rows.filter((a) => a.c).length;
  const full = rows.filter((a) => a.f).length;

  // Per product: how many, and how many are out earning.
  const byProduct = new Map<string, { total: number; out: number }>();
  for (const a of rows) {
    const code = a.p ?? '(no product)';
    const p = byProduct.get(code) ?? { total: 0, out: 0 };
    p.total += 1;
    if (a.c) p.out += 1;
    byProduct.set(code, p);
  }
  const products = [...byProduct.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .sort((x, y) => y.total - x.total)
    .slice(0, 30);

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
              <Stat v={String(full)} l="full" />
              <VRule />
              <Stat v={String(boot?.stats?.customers ?? boot?.customers?.length ?? 0)} l="customers" />
            </View>
          </Surface>
        </Rise>

        <Rise delay={110} style={{ marginTop: 24 }}>
          <Eyebrow style={{ marginBottom: 12 }}>By product — biggest first</Eyebrow>
          <Surface>
            <View style={{ padding: 18, gap: 14 }}>
              {products.length === 0 && (
                <Text style={{ color: T.faint, fontSize: 13 }}>Nothing in the fleet yet.</Text>
              )}
              {products.map((p) => (
                <View key={p.code}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                    <Text style={{ color: T.ink, fontSize: 13.5, fontWeight: '600', flex: 1 }} numberOfLines={1}>
                      {p.code}
                    </Text>
                    <Text style={{ color: T.steel, fontSize: 12.5, fontVariant: ['tabular-nums'] }}>
                      {p.out} out · {p.total} total
                    </Text>
                  </View>
                  {/* One bar, two truths: the lit span is out earning, the dim
                      remainder is sitting in the yard. */}
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: tint(0.08), marginTop: 6, overflow: 'hidden' }}>
                    <View style={{
                      height: 6, borderRadius: 3, backgroundColor: T.amber,
                      width: `${p.total ? Math.max(2, Math.round((p.out / p.total) * 100)) : 0}%`,
                    }} />
                  </View>
                </View>
              ))}
            </View>
          </Surface>
        </Rise>
      </ScrollView>
    </Screen>
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
