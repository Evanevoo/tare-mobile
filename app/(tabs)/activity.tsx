import { useMemo, useState } from 'react';
import { View, Text, Pressable, SectionList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { T, Screen, Surface, Btn, Dot, Eyebrow, Tag, Rise, Icon, ICON, mono } from '@/ui';

/**
 * Activity: what this phone is holding, and what it has sent.
 *
 * Two segments rather than two screens, because a driver checking "did my work
 * land" does not know or care whether the answer is in the outbox or in the
 * history — they want one place that answers it.
 *
 * Waiting is first and is the default, because that is the anxious question.
 */
type Seg = 'waiting' | 'sent';

export default function Activity() {
  const router = useRouter();
  const { outbox, sync, syncing, online, lastError, lastSync, dispatch, refresh } = useStore();
  const [seg, setSeg] = useState<Seg>('waiting');
  const [busy, setBusy] = useState(false);

  const unsent = pending(outbox);
  const sent = outbox.scans.filter((s) => s.state === 'SENT');
  const rows = seg === 'waiting' ? unsent : sent;

  // Grouped by order, because an order is the unit a person thinks in and the
  // unit the console reconciles against.
  const sections = useMemo(() => {
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.orderNumber, [...(by.get(r.orderNumber) ?? []), r]);
    return [...by.entries()]
      .map(([title, data]) => ({ title, data }))
      .sort((a, b) => b.title.localeCompare(a.title));
  }, [rows]);

  return (
    <Screen intensity={0.7}>
      <SectionList
        sections={sections}
        keyExtractor={(s) => s.clientId}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={busy} tintColor={T.steel}
            onRefresh={async () => { setBusy(true); await refresh(); setBusy(false); }}
          />
        }
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
            <Rise>
              <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1.1 }}>
                Activity
              </Text>
            </Rise>

            <Rise delay={50} style={{ marginTop: 20 }}>
              <Surface tint={unsent.length ? 'rgba(224,164,58,0.10)' : undefined}>
                <View style={{ padding: 18 }}>
                  <Eyebrow>Waiting on this phone</Eyebrow>
                  <Text
                    style={[
                      mono(46, '800'),
                      { color: unsent.length ? T.amber : T.ink, marginTop: 9, letterSpacing: -2.2 },
                    ]}
                  >
                    {unsent.length}
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 12 }}>
                    <Dot tone={online ? T.bottle : T.needle} />
                    <Text style={{ color: T.faint, fontSize: 12.5 }}>
                      {online ? 'Connected' : 'No connection — nothing is lost'}
                      {lastSync ? ` · last sync ${new Date(lastSync).toLocaleTimeString()}` : ''}
                    </Text>
                  </View>

                  {lastError && (
                    <View
                      style={{
                        marginTop: 14, padding: 12, borderRadius: T.radiusSm,
                        backgroundColor: 'rgba(240,101,74,0.10)',
                        borderWidth: 1, borderColor: 'rgba(240,101,74,0.26)',
                      }}
                    >
                      <Text style={{ color: T.needle, fontSize: 13, lineHeight: 19 }}>{lastError}</Text>
                    </View>
                  )}

                  <Btn
                    label={unsent.length ? `Sync ${unsent.length}` : 'Nothing to sync'}
                    style={{ marginTop: 16 }}
                    busy={syncing}
                    disabled={!unsent.length}
                    onPress={() => sync()}
                  />
                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 12, lineHeight: 18 }}>
                    Syncing twice is safe. The server matches on order, barcode and direction, so a
                    repeat upload posts nothing new.
                  </Text>
                </View>
              </Surface>
            </Rise>

            {/* ── segments ── */}
            <Rise delay={100} style={{ flexDirection: 'row', gap: 9, marginTop: 22, marginBottom: 6 }}>
              {(['waiting', 'sent'] as const).map((k) => (
                <Pressable
                  key={k}
                  onPress={() => setSeg(k)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: seg === k }}
                  style={{
                    minHeight: 44, justifyContent: 'center', paddingHorizontal: 18,
                    borderRadius: T.radiusSm,
                    backgroundColor: seg === k ? 'rgba(63,180,137,0.16)' : 'rgba(255,255,255,0.04)',
                    borderWidth: 1,
                    borderColor: seg === k ? 'rgba(63,180,137,0.45)' : T.rule,
                  }}
                >
                  <Text
                    style={{
                      color: seg === k ? T.brandLit : T.steel,
                      fontSize: 14, fontWeight: '700',
                    }}
                  >
                    {k === 'waiting' ? `Waiting ${unsent.length}` : `Sent ${sent.length}`}
                  </Text>
                </Pressable>
              ))}

              {seg === 'sent' && sent.length > 0 && (
                <Pressable
                  onPress={() => dispatch({ type: 'CLEAR_SENT' })}
                  hitSlop={10}
                  style={{ marginLeft: 'auto', justifyContent: 'center' }}
                  accessibilityRole="button"
                  accessibilityLabel={`Clear ${sent.length} uploaded scans`}
                >
                  <Text style={{ color: T.faint, fontSize: 13, fontWeight: '600' }}>Clear</Text>
                </Pressable>
              )}
            </Rise>
          </View>
        }
        ListEmptyComponent={
          <Text
            style={{
              color: T.faint, fontSize: 13.5, textAlign: 'center',
              paddingTop: 26, paddingHorizontal: 44, lineHeight: 20,
            }}
          >
            {seg === 'waiting'
              ? 'Nothing waiting. Every scan has reached the server.'
              : 'Nothing sent from this phone yet.'}
          </Text>
        }
        renderSectionHeader={({ section }) => (
          <View
            style={{
              paddingHorizontal: 18, paddingTop: 18, paddingBottom: 8,
              flexDirection: 'row', alignItems: 'center', gap: 10,
            }}
          >
            <Text style={[mono(13, '700'), { color: T.ink }]}>{section.title}</Text>
            <Text style={{ color: T.faint, fontSize: 12 }}>
              {section.data.length} scan{section.data.length === 1 ? '' : 's'}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/asset/${encodeURIComponent(item.barcode)}` as never)}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 12,
              paddingHorizontal: 18, paddingVertical: 13,
              borderBottomWidth: 1, borderBottomColor: T.soft,
              opacity: item.state === 'SENT' ? 0.55 : 1,
              backgroundColor: pressed ? 'rgba(255,255,255,0.04)' : 'transparent',
            })}
          >
            <View
              style={{
                width: 3, height: 26, borderRadius: 2,
                backgroundColor: item.mode === 'SHIP' ? T.amber : T.bottle,
              }}
            />
            <View style={{ flex: 1 }}>
              <Text style={[mono(14.5, '600'), { color: T.ink }]}>{item.barcode}</Text>
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
                {' · '}{new Date(item.scannedAt).toLocaleTimeString()}
              </Text>
            </View>
            <Tag
              label={item.state}
              tone={item.state === 'SENT' ? T.bottle : item.state === 'UPLOADING' ? T.amber : T.faint}
            />
            <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
          </Pressable>
        )}
      />
    </Screen>
  );
}
