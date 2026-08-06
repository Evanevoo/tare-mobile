import { View, Text, Pressable, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { T, Screen, Surface, Btn, Dot, Eyebrow, Rise, Icon, ICON, mono, tint } from '@/ui';

/**
 * Home does one job.
 *
 * The previous version had a search box, six action tiles, a stat row and a
 * sync card competing in the first viewport — a dashboard wall, which is the
 * thing that made the old app need training. A driver opening this at 06:10
 * is doing one of two things, so the screen offers one of two things and gets
 * out of the way.
 *
 * Everything else moved somewhere it can be found on purpose: search to its
 * own screen, the queue to Activity, the rest to More.
 */
export default function Home() {
  const router = useRouter();
  const { boot, ready, online, outbox, refresh, lastSync } = useStore();
  const [busy, setBusy] = useState(false);
  const unsent = pending(outbox).length;

  if (!ready) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ActivityIndicator color={T.brandLit} />
        </View>
      </Screen>
    );
  }

  const s = boot?.stats;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={busy} tintColor={T.steel}
            onRefresh={async () => { setBusy(true); await refresh(); setBusy(false); }}
          />
        }
      >
        <Rise>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Eyebrow>{boot?.org.name ?? 'Scanified'}</Eyebrow>
              <Text
                style={{
                  color: T.ink, fontSize: 30, fontWeight: '700',
                  letterSpacing: -1.1, marginTop: 7,
                }}
              >
                {greeting()}{boot?.user.name ? `, ${boot.user.name.split(' ')[0]}` : ''}
              </Text>
            </View>
            <Pressable
              onPress={() => router.push('/search' as never)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Search customers and assets"
              style={({ pressed }) => ({
                width: 46, height: 46, borderRadius: 14, marginTop: 4,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? tint(0.09) : tint(0.05),
                borderWidth: 1, borderColor: T.rule,
              })}
            >
              <Icon name="search" size={ICON.md} color={T.steel} />
            </Pressable>
          </View>
        </Rise>

        {/* ── the one job ── */}
        <Rise delay={60} style={{ marginTop: 28 }}>
          <Btn
            label="Start a delivery"
            sub="Customer, order, then scan"
            onPress={() => router.push('/delivery' as never)}
            style={{ marginBottom: 12 }}
          />
          <Btn
            label="Warehouse"
            sub="Put away and set full or empty"
            variant="ghost"
            onPress={() => router.push('/warehouse' as never)}
          />
        </Rise>

        {/* ── are my scans safe ── */}
        <Rise delay={110} style={{ marginTop: 26 }}>
          <Pressable
            onPress={() => router.push('/activity' as never)}
            accessibilityRole="button"
            accessibilityLabel={unsent ? `${unsent} scans waiting to upload` : 'Everything is on the server'}
          >
            <Surface tint={unsent ? 'rgba(224,164,58,0.10)' : undefined}>
              <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Dot tone={online ? T.bottle : T.amber} size={9} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.ink, fontSize: 14.5, fontWeight: '700' }}>
                    {unsent
                      ? `${unsent} scan${unsent === 1 ? '' : 's'} waiting to upload`
                      : 'Everything is on the server'}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 3 }}>
                    {online ? 'Online' : 'Offline — nothing is lost'}
                    {lastSync ? ` · synced ${short(lastSync)}` : ''}
                  </Text>
                </View>
                <Icon name="chevron-right" size={ICON.md} color={T.faint} />
              </View>
            </Surface>
          </Pressable>
        </Rise>

        {/* ── the fleet, quietly ── */}
        {s && (
          <Rise delay={160} style={{ marginTop: 14 }}>
            <Surface>
              <View style={{ flexDirection: 'row' }}>
                {[
                  ['Out on rent', s.out, T.amber],
                  ['In house', s.inHouse, T.ink],
                  ['Full', s.full, T.bottle],
                ].map(([label, value, tone], i) => (
                  <View
                    key={label as string}
                    style={{
                      flex: 1, padding: 16,
                      borderLeftWidth: i ? 1 : 0, borderLeftColor: T.soft,
                    }}
                  >
                    <Text style={[mono(21, '800'), { color: tone as string }]}>
                      {(value as number).toLocaleString()}
                    </Text>
                    <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 5 }}>
                      {label as string}
                    </Text>
                  </View>
                ))}
              </View>
            </Surface>
          </Rise>
        )}
      </ScrollView>
    </Screen>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function short(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}
