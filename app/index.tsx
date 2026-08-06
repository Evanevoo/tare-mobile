import { useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { T, Screen, Surface, Dot, Eyebrow, Rise, Tag, Icon, ICON, mono, shadow } from '@/ui';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Home is the hub, not a customer list.
 *
 * A driver arrives here between every other task, so it answers three
 * questions in order of how often they are asked: are my scans safe, what is
 * this thing in my hand, and what am I doing next. Search is one box across
 * both customers and barcodes because a person holding a bottle should not
 * have to tell the app which kind of thing they are looking for.
 */

type Glyph = React.ComponentProps<typeof Icon>['name'];

const ACTIONS: { key: string; label: string; hint: string; href: string; icon: Glyph; tone?: string }[] = [
  { key: 'delivery', label: 'Delivery', hint: 'Ship out · return in', href: '/delivery', icon: 'truck', tone: T.bottle },
  { key: 'locate', label: 'Locate', hint: 'Put away · fill', href: '/locate', icon: 'map-pin' },
  { key: 'add', label: 'Add', hint: 'Register new', href: '/add', icon: 'plus-circle' },
  { key: 'edit', label: 'Edit', hint: 'Fix a record', href: '/edit', icon: 'edit-3' },
  { key: 'history', label: 'History', hint: 'Last 24 hours', href: '/history', icon: 'rotate-ccw' },
  { key: 'analytics', label: 'Analytics', hint: 'How the fleet moves', href: '/analytics', icon: 'bar-chart-2' },
];

export default function Home() {
  const router = useRouter();
  const { boot, ready, online, outbox, refresh, lastSync } = useStore();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const pendingCount = pending(outbox).length;
  const term = q.trim().toLowerCase();

  const hits = useMemo(() => {
    if (!term || !boot) return null;

    const customers = boot.customers.filter(
      (c) => c.name.toLowerCase().includes(term) ||
             c.customerListId.toLowerCase().includes(term) ||
             (c.city ?? '').toLowerCase().includes(term),
    ).slice(0, 12);

    // Barcodes are matched on prefix as well as substring, because a partial
    // read off a damaged label almost always keeps the front of the code.
    const assets = Object.entries(boot.assets)
      .filter(([bc, a]) =>
        bc.toLowerCase().includes(term) ||
        (a.sn ?? '').toLowerCase().includes(term) ||
        (a.p ?? '').toLowerCase() === term)
      .slice(0, 12);

    return { customers, assets };
  }, [term, boot]);

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
        contentContainerStyle={{ paddingBottom: 44 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={busy} tintColor={T.steel}
            onRefresh={async () => { setBusy(true); await refresh(); setBusy(false); }}
          />
        }
      >
        {/* ── header ── */}
        <View style={{ paddingTop: 12, paddingHorizontal: 18, paddingBottom: 6 }}>
          <Rise>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Eyebrow>{boot?.org.name ?? 'Scanified'}</Eyebrow>
                <Text
                  style={{
                    color: T.ink, fontSize: 29, fontWeight: '700',
                    letterSpacing: -1, marginTop: 6,
                  }}
                >
                  {greeting()}{boot?.user.name ? `, ${boot.user.name.split(' ')[0]}` : ''}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <IconBtn
                  glyph="bell"
                  label={pendingCount ? `Sync, ${pendingCount} waiting` : 'Sync'}
                  badge={pendingCount}
                  onPress={() => router.push('/queue' as never)}
                />
                <IconBtn glyph="settings" label="Settings" onPress={() => router.push('/settings' as never)} />
              </View>
            </View>
          </Rise>
        </View>

        {/* ── are my scans safe ── */}
        <Rise delay={50} style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          <Pressable onPress={() => router.push('/queue' as never)}>
            <Surface tint={pendingCount ? 'rgba(224,164,58,0.10)' : undefined}>
              <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Dot tone={online ? T.bottle : T.amber} size={9} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.ink, fontSize: 14.5, fontWeight: '700' }}>
                    {pendingCount
                      ? `${pendingCount} scan${pendingCount === 1 ? '' : 's'} waiting to upload`
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

        {/* ── search ── */}
        <Rise delay={90} style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          <TextInput
            value={q} onChangeText={setQ}
            placeholder={`Search customers or ${boot?.org.assetPlural?.toLowerCase() ?? 'assets'}…`}
            placeholderTextColor={T.faint}
            autoCorrect={false} autoCapitalize="none"
            style={{
              height: 54, borderRadius: T.radiusSm, paddingHorizontal: 16,
              color: T.ink, fontSize: 16,
              backgroundColor: 'rgba(255,255,255,0.05)',
              borderWidth: 1, borderColor: term ? 'rgba(63,180,137,0.4)' : T.rule,
            }}
          />
        </Rise>

        {/* ── results, or the hub ── */}
        {hits ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 18 }}>
            {hits.customers.length === 0 && hits.assets.length === 0 && (
              <Text style={{ color: T.faint, fontSize: 13.5, textAlign: 'center', paddingVertical: 34 }}>
                Nothing matches “{q.trim()}”.
              </Text>
            )}

            {hits.customers.length > 0 && (
              <>
                <Eyebrow style={{ marginBottom: 10 }}>Customers</Eyebrow>
                <Surface style={{ marginBottom: 18 }}>
                  {hits.customers.map((c, i) => (
                    <Pressable
                      key={c.id}
                      onPress={() => router.push(`/customer/${c.id}` as never)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 16, paddingVertical: 14,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                        backgroundColor: pressed ? 'rgba(255,255,255,0.05)' : 'transparent',
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                      })}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '600' }}>{c.name}</Text>
                        <Text style={[mono(12, '500'), { color: T.faint, marginTop: 2 }]}>
                          {c.customerListId}{c.city ? ` · ${c.city}` : ''}
                        </Text>
                      </View>
                      {c.held > 0 && <Tag label={`${c.held} out`} tone={T.bottle} />}
                    </Pressable>
                  ))}
                </Surface>
              </>
            )}

            {hits.assets.length > 0 && (
              <>
                <Eyebrow style={{ marginBottom: 10 }}>
                  {boot?.org.assetPlural ?? 'Assets'}
                </Eyebrow>
                <Surface style={{ marginBottom: 18 }}>
                  {hits.assets.map(([bc, a], i) => (
                    <Pressable
                      key={bc}
                      onPress={() => router.push(`/asset/${encodeURIComponent(bc)}` as never)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 16, paddingVertical: 14,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                        backgroundColor: pressed ? 'rgba(255,255,255,0.05)' : 'transparent',
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                      })}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[mono(15, '600'), { color: T.ink }]}>{bc}</Text>
                        <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>
                          {a.p ?? 'unknown type'}{a.c ? ` · out at ${a.c}` : ' · in house'}
                        </Text>
                      </View>
                      <Tag label={a.f ? 'FULL' : 'EMPTY'} tone={a.f ? T.bottle : T.faint} />
                    </Pressable>
                  ))}
                </Surface>
              </>
            )}
          </View>
        ) : (
          <>
            {/* ── the fleet, at a glance ── */}
            {s && (
              <Rise delay={130} style={{ paddingHorizontal: 18, paddingTop: 18 }}>
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
                        <Text style={[mono(22, '800'), { color: tone as string }]}>
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

            {/* ── what am I doing next ── */}
            <Rise delay={170} style={{ paddingHorizontal: 18, paddingTop: 22 }}>
              <Eyebrow style={{ marginBottom: 12 }}>Do</Eyebrow>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 11 }}>
                {ACTIONS.map((a) => (
                  <Pressable
                    key={a.key}
                    onPress={() => router.push(a.href as never)}
                    accessibilityRole="button"
                    accessibilityLabel={`${a.label}. ${a.hint}`}
                    style={{ width: '47.6%' }}
                  >
                    {({ pressed }) => (
                      <View
                        style={[
                          {
                            borderRadius: T.radius, overflow: 'hidden',
                            borderWidth: 1,
                            borderColor: a.tone ? 'rgba(63,180,137,0.3)' : T.rule,
                            opacity: pressed ? 0.82 : 1,
                          },
                          shadow(1),
                        ]}
                      >
                        <LinearGradient
                          colors={
                            a.tone
                              ? ['rgba(63,180,137,0.16)', 'rgba(63,180,137,0.03)']
                              : [T.panelTop, T.panelBot]
                          }
                          start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }}
                          style={{ padding: 16, minHeight: 108, justifyContent: 'space-between' }}
                        >
                          <Icon
                            name={a.icon}
                            size={ICON.lg}
                            color={a.tone ? T.brandLit : T.steel}
                          />
                          <View>
                            <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '700' }}>
                              {a.label}
                            </Text>
                            <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 3 }}>
                              {a.hint}
                            </Text>
                          </View>
                        </LinearGradient>
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            </Rise>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function IconBtn({
  glyph, onPress, badge = 0, label,
}: { glyph: Glyph; onPress: () => void; badge?: number; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {({ pressed }) => (
        <View
          style={{
            width: 44, height: 44, borderRadius: 13,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: pressed ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.05)',
            borderWidth: 1, borderColor: T.rule,
          }}
        >
          <Icon name={glyph} size={ICON.md} color={T.steel} />
          {badge > 0 && (
            <View
              style={{
                position: 'absolute', top: -4, right: -4,
                minWidth: 19, height: 19, borderRadius: 10, paddingHorizontal: 5,
                backgroundColor: T.amber, alignItems: 'center', justifyContent: 'center',
                borderWidth: 2, borderColor: T.zinc,
              }}
            >
              <Text style={{ color: T.onBrand, fontSize: 10.5, fontWeight: '800' }}>
                {badge > 99 ? '99+' : badge}
              </Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function short(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}
