import { useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending, counts } from '@/outbox';
import { signOut } from '@/api';
import { T } from '@/ui';

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
        <ActivityIndicator color={T.bottle} />
      </View>
    );
  }

  const canStart = picked && order.trim().length >= 3;

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      {/* status strip */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 16, paddingVertical: 10,
        backgroundColor: T.face, borderBottomWidth: 1, borderBottomColor: T.rule,
      }}>
        <View style={{
          width: 8, height: 8, borderRadius: 4,
          backgroundColor: online ? T.bottle : T.needle,
        }} />
        <Text style={{ color: T.steel, fontSize: 12 }}>
          {online ? 'Online' : 'Offline — scans are saved on this phone'}
        </Text>
        <Pressable onPress={() => router.push('/queue')} style={{ marginLeft: 'auto' }}>
          <Text style={{
            color: pendingCount ? T.needle : T.steel, fontSize: 12, fontWeight: '700',
          }}>
            {pendingCount ? `${pendingCount} to sync` : 'Synced'}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={customers}
        keyExtractor={(c) => c.customerListId}
        refreshControl={
          <RefreshControl refreshing={busy} tintColor={T.steel}
            onRefresh={async () => { setBusy(true); await refresh(); setBusy(false); }} />
        }
        ListHeaderComponent={
          <View style={{ padding: 16, paddingBottom: 4 }}>
            <Text style={{ color: T.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 }}>
              New delivery
            </Text>
            <Text style={{ color: T.steel, fontSize: 13, marginTop: 2, marginBottom: 16 }}>
              {boot?.org.name ?? 'Tare'} · {boot?.user.name ?? ''}
            </Text>

            <Text style={{
              color: T.steel, fontSize: 10, fontWeight: '700',
              letterSpacing: 1.1, marginBottom: 6,
            }}>
              1 · CUSTOMER
            </Text>
            {picked ? (
              <Pressable
                onPress={() => setPicked(null)}
                style={{
                  padding: 14, borderRadius: T.radius, backgroundColor: T.face,
                  borderWidth: 1, borderColor: T.bottle, marginBottom: 18,
                }}
              >
                <Text style={{ color: T.ink, fontSize: 16, fontWeight: '600' }}>{picked.name}</Text>
                <Text style={{ color: T.steel, fontSize: 12, marginTop: 2 }}>
                  {picked.id} · tap to change
                </Text>
              </Pressable>
            ) : (
              <TextInput
                value={q} onChangeText={setQ}
                placeholder="Search customers…" placeholderTextColor={T.steel}
                autoCorrect={false}
                style={{
                  height: 46, borderRadius: T.radius, paddingHorizontal: 14, marginBottom: 10,
                  color: T.ink, backgroundColor: T.face, borderWidth: 1, borderColor: T.rule,
                  fontSize: 15,
                }}
              />
            )}

            {picked && (
              <>
                <Text style={{
                  color: T.steel, fontSize: 10, fontWeight: '700',
                  letterSpacing: 1.1, marginBottom: 6,
                }}>
                  2 · ORDER NUMBER
                </Text>
                <TextInput
                  value={order} onChangeText={(v) => setOrder(v.toUpperCase())}
                  placeholder="INV-9001" placeholderTextColor={T.steel}
                  autoCapitalize="characters" autoCorrect={false}
                  style={{
                    height: 46, borderRadius: T.radius, paddingHorizontal: 14,
                    color: T.ink, backgroundColor: T.face, borderWidth: 1, borderColor: T.rule,
                    fontSize: 16, fontFamily: T.mono, letterSpacing: 0.5,
                  }}
                />

                <Pressable
                  disabled={!canStart}
                  onPress={() => {
                    startDelivery(picked.id, picked.name, order.trim());
                    router.push('/scan');
                  }}
                  style={{
                    height: 52, borderRadius: T.radius, backgroundColor: T.bottle,
                    alignItems: 'center', justifyContent: 'center', marginTop: 16,
                    opacity: canStart ? 1 : 0.4,
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                    Start scanning
                  </Text>
                </Pressable>
              </>
            )}

            {!picked && customers.length === 0 && (
              <Text style={{ color: T.steel, fontSize: 13, paddingVertical: 24, textAlign: 'center' }}>
                {boot ? 'No customers match.' : 'No customer list on this phone yet. Pull down to download it.'}
              </Text>
            )}
          </View>
        }
        renderItem={({ item }) => picked ? null : (
          <Pressable
            onPress={() => { setPicked({ id: item.customerListId, name: item.name }); setQ(''); }}
            style={{
              paddingHorizontal: 16, paddingVertical: 13,
              borderBottomWidth: 1, borderBottomColor: T.soft,
            }}
          >
            <Text style={{ color: T.ink, fontSize: 15, fontWeight: '500' }}>{item.name}</Text>
            <Text style={{ color: T.steel, fontSize: 12, marginTop: 1, fontFamily: T.mono }}>
              {item.customerListId}{item.city ? ` · ${item.city}` : ''}
            </Text>
          </Pressable>
        )}
        ListFooterComponent={
          <Pressable onPress={signOut} style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ color: T.steel, fontSize: 13 }}>Sign out</Text>
            {lastSync && (
              <Text style={{ color: T.steel, fontSize: 11, marginTop: 6 }}>
                Last sync {new Date(lastSync).toLocaleString()}
              </Text>
            )}
          </Pressable>
        }
      />
    </View>
  );
}
