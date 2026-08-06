import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { T, Screen, Surface, Btn, Eyebrow, Rise, Tag, mono } from '@/ui';

/**
 * Delivery setup: who, and against what document.
 *
 * Kept separate from the scan loop because these are two different jobs done
 * at two different moments — this one happens in the cab before the door
 * opens, and getting the order number wrong here is what makes an invoice
 * unexplainable three weeks later.
 */
export default function Delivery() {
  const router = useRouter();
  const { boot, startDelivery } = useStore();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [order, setOrder] = useState('');

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

  const canStart = !!picked && order.trim().length >= 3;

  const field = {
    height: 52, borderRadius: T.radiusSm, paddingHorizontal: 15,
    color: T.ink, fontSize: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: T.rule,
  } as const;

  return (
    <Screen>
      <FlatList
        data={picked ? [] : customers}
        keyExtractor={(c) => c.customerListId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 44, paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 18 }}>
            <Rise>
              <Eyebrow style={{ marginBottom: 10 }}>1 · Customer</Eyebrow>
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
                <Eyebrow style={{ marginBottom: 10 }}>2 · Order number</Eyebrow>
                <TextInput
                  value={order} onChangeText={(v) => setOrder(v.toUpperCase())}
                  placeholder="INV-9001" placeholderTextColor={T.faint}
                  autoCapitalize="characters" autoCorrect={false} autoFocus
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
                  : 'No customer list on this phone yet.\nPull down on Home to download it.'}
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
              backgroundColor: pressed ? 'rgba(255,255,255,0.05)' : 'transparent',
              flexDirection: 'row', alignItems: 'center', gap: 10,
            })}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '600' }}>{item.name}</Text>
              <Text style={[mono(12, '500'), { color: T.faint, marginTop: 2 }]}>
                {item.customerListId}{item.city ? ` · ${item.city}` : ''}
              </Text>
            </View>
            {item.held > 0 && <Tag label={`${item.held} out`} tone={T.bottle} />}
          </Pressable>
        )}
      />
    </Screen>
  );
}
