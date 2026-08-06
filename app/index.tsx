import { useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { signOut } from '@/api';
import { T, Aurora, Surface, Btn, Dot, Eyebrow, Rise, mono } from '@/ui';

export default function Home() {
  const router = useRouter();
  const { boot, ready, online, outbox, refresh, startDelivery, lastSync } = useStore();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [order, setOrder] = useState('');
  const [busy, setBusy] = useState(false);

  const pendingCount = pending(outbox).length;

  const customers = useMemo(() => {
    const all = boot?.customers ?? [];
    if (!q.trim()) return all.slice(0, 60);
    const n = q.toLowerCase();
    return all.filter(
      (c) => c.name.toLowerCase().includes(n) ||
             c.customerListId.toLowerCase().includes(n) ||
             (c.city ?? '').toLowerCase().includes(n),
    ).slice(0, 60);
  }, [boot, q]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: T.zinc, justifyContent: 'center' }}>
        <Aurora />
        <ActivityIndicator color={T.brandLit} />
      </View>
    );
  }

  const canStart = !!picked && order.trim().length >= 3;

  const field = {
    height: 52, borderRadius: T.radiusSm, paddingHorizontal: 15,
    color: T.ink, fontSize: 16,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1, borderColor: T.rule,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      <Aurora />

      {/* ── connection strip ─────────────────────────────────────────────
          Always the first thing on screen, because a driver's first question
          is never "what is this app" — it is "are my scans safe". */}
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 9,
          paddingHorizontal: 18, paddingVertical: 12,
          borderBottomWidth: 1, borderBottomColor: T.soft,
          backgroundColor: 'rgba(255,255,255,0.02)',
        }}
      >
        <Dot tone={online ? T.bottle : T.amber} />
        <Text style={{ color: online ? T.steel : T.amber, fontSize: 12.5, flex: 1 }}>
          {online ? 'Online' : 'Offline — scans are saved on this phone'}
        </Text>
        <Pressable onPress={() => router.push('/queue')} hitSlop={12}>
          <Text
            style={{
              color: pendingCount ? T.amber : T.faint,
              fontSize: 12.5, fontWeight: '700',
            }}
          >
            {pendingCount ? `${pendingCount} to sync →` : 'All synced'}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={picked ? [] : customers}
        keyExtractor={(c) => c.customerListId}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={busy} tintColor={T.steel}
            onRefresh={async () => { setBusy(true); await refresh(); setBusy(false); }}
          />
        }
        ListHeaderComponent={
          <View style={{ padding: 18, paddingBottom: 6 }}>
            <Rise>
              <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1 }}>
                New delivery
              </Text>
              <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 4, marginBottom: 22 }}>
                {boot?.org.name ?? 'Scanified'} · {boot?.user.name ?? ''}
              </Text>
            </Rise>

            <Rise delay={70}>
              <Eyebrow style={{ marginBottom: 9 }}>1 · Customer</Eyebrow>
              {picked ? (
                <Pressable onPress={() => setPicked(null)}>
                  <Surface tint="rgba(63,180,137,0.13)" style={{ marginBottom: 22 }}>
                    <View style={{ padding: 16 }}>
                      <Text style={{ color: T.ink, fontSize: 17, fontWeight: '700' }}>
                        {picked.name}
                      </Text>
                      <Text style={[mono(12, '500'), { color: T.faint, marginTop: 3 }]}>
                        {picked.id} · tap to change
                      </Text>
                    </View>
                  </Surface>
                </Pressable>
              ) : (
                <TextInput
                  value={q} onChangeText={setQ}
                  placeholder="Search customers…" placeholderTextColor={T.faint}
                  autoCorrect={false} autoCapitalize="none"
                  style={[field, { marginBottom: 12 }]}
                />
              )}
            </Rise>

            {picked && (
              <Rise delay={40}>
                <Eyebrow style={{ marginBottom: 9 }}>2 · Order number</Eyebrow>
                <TextInput
                  value={order} onChangeText={(v) => setOrder(v.toUpperCase())}
                  placeholder="INV-9001" placeholderTextColor={T.faint}
                  autoCapitalize="characters" autoCorrect={false}
                  style={[field, mono(17, '600'), { color: T.ink }]}
                />

                <Btn
                  label="Start scanning"
                  style={{ marginTop: 20 }}
                  disabled={!canStart}
                  onPress={() => {
                    startDelivery(picked.id, picked.name, order.trim());
                    router.push('/scan');
                  }}
                />
                <Text
                  style={{
                    color: T.faint, fontSize: 12, textAlign: 'center',
                    marginTop: 14, lineHeight: 18,
                  }}
                >
                  Every scan is stamped with the time, your name and where you were.
                </Text>
              </Rise>
            )}

            {!picked && customers.length === 0 && (
              <Text
                style={{
                  color: T.faint, fontSize: 13.5, paddingVertical: 28,
                  textAlign: 'center', lineHeight: 20,
                }}
              >
                {boot
                  ? 'No customers match.'
                  : 'No customer list on this phone yet.\nPull down to download it.'}
              </Text>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => { setPicked({ id: item.customerListId, name: item.name }); setQ(''); }}
            style={({ pressed }) => ({
              paddingHorizontal: 18, paddingVertical: 15,
              borderBottomWidth: 1, borderBottomColor: T.soft,
              backgroundColor: pressed ? 'rgba(255,255,255,0.045)' : 'transparent',
            })}
          >
            <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '600' }}>{item.name}</Text>
            <Text style={[mono(12, '500'), { color: T.faint, marginTop: 2 }]}>
              {item.customerListId}{item.city ? ` · ${item.city}` : ''}
            </Text>
          </Pressable>
        )}
        ListFooterComponent={
          <Pressable onPress={signOut} style={{ padding: 28, alignItems: 'center' }}>
            <Text style={{ color: T.faint, fontSize: 13.5, fontWeight: '600' }}>Sign out</Text>
            {lastSync && (
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 7 }}>
                Last sync {new Date(lastSync).toLocaleString()}
              </Text>
            )}
          </Pressable>
        }
      />
    </View>
  );
}
