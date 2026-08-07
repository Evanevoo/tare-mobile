import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { Scanner } from '@/scanner';
import { useScanRoute } from '@/scan-route';
import { T, Screen, Surface, Btn, Eyebrow, Rise, Tag, mono, tint } from '@/ui';

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
  const route = useScanRoute();
  const { boot, startDelivery } = useStore();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [order, setOrder] = useState('');
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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

  /**
   * One camera for both fields, because a driver holding a phone in one hand
   * does not want to choose which kind of code they are about to read. What
   * the code IS decides where it goes:
   *
   *   a barcode already in the fleet → they scanned a bottle by reflex before
   *       setting the job up. Show them the bottle rather than swallowing it —
   *       nine times in ten that is what they wanted to look at anyway, and
   *       the tenth time they press back and carry on.
   *   a code matching a customer account → fill in the customer
   *   anything else → it is the document number
   *
   * The order matters. Asset first, because a mis-scanned cylinder landing
   * silently in the order-number field is precisely the error that makes an
   * invoice unexplainable later — the failure this screen exists to prevent.
   */
  function handleCode(code: string) {
    const t = route(code);
    if (!t) return;
    setScanning(false);

    // An asset was already pushed by route() — the driver is looking at the
    // cylinder now, and nothing on this screen should change underneath them.
    if (t.kind === 'asset') return;

    if (t.kind === 'customer') {
      setPicked({ id: t.id, name: t.name });
      setQ('');
      setNote(`Customer set from scan — ${t.name}`);
      return;
    }

    setOrder(t.code);
    setNote(
      picked
        ? `Order number set from scan — ${t.code}`
        : `Read ${t.code} as the order number. Pick the customer first if that is wrong.`,
    );
  }

  const canStart = !!picked && order.trim().length >= 3;

  const field = {
    height: 52, borderRadius: T.radiusSm, paddingHorizontal: 15,
    color: T.ink, fontSize: 16,
    backgroundColor: tint(0.05),
    borderWidth: 1, borderColor: T.rule,
  } as const;

  /** Sits inside a field the way Show/Hide does on the sign-in screen. */
  const ScanBtn = () => (
    <Pressable
      onPress={() => { setNote(null); setScanning(true); }}
      hitSlop={12}
      style={{ position: 'absolute', right: 13, top: 0, height: 52, justifyContent: 'center' }}
    >
      <Text style={[mono(12, '700'), { color: T.brandLit, letterSpacing: 0.6 }]}>SCAN</Text>
    </Pressable>
  );

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
                <View style={{ marginBottom: 12 }}>
                  <TextInput
                    value={q} onChangeText={setQ}
                    placeholder="Search or scan a customer…" placeholderTextColor={T.faint}
                    autoCorrect={false} autoCapitalize="none"
                    style={[field, { paddingRight: 62 }]}
                  />
                  <ScanBtn />
                </View>
              )}
            </Rise>

            {note && (
              <Pressable onPress={() => setNote(null)}>
                <View
                  style={{
                    marginBottom: 16, padding: 12, borderRadius: T.radiusSm,
                    backgroundColor: 'rgba(63,180,137,0.10)',
                    borderWidth: 1, borderColor: 'rgba(63,180,137,0.24)',
                  }}
                >
                  <Text style={{ color: T.brandLit, fontSize: 13, lineHeight: 19 }}>{note}</Text>
                </View>
              </Pressable>
            )}

            {picked && (
              <Rise delay={40}>
                <Eyebrow style={{ marginBottom: 10 }}>2 · Order number</Eyebrow>
                <View>
                  <TextInput
                    value={order} onChangeText={(v) => setOrder(v.toUpperCase())}
                    placeholder="INV-9001" placeholderTextColor={T.faint}
                    autoCapitalize="characters" autoCorrect={false} autoFocus
                    style={[field, mono(17, '600'), { color: T.ink, paddingRight: 62 }]}
                  />
                  <ScanBtn />
                </View>
                <Btn
                  label="Start scanning"
                  style={{ marginTop: 20 }}
                  disabled={!canStart}
                  onPress={() => {
                    startDelivery(picked.id, picked.name, order.trim());
                    router.push('/scan' as never);
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
              backgroundColor: pressed ? tint(0.05) : 'transparent',
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

      <Modal
        visible={scanning}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScanning(false)}
      >
        {/* The black floor is not decoration. A Modal's own backdrop is white,
            and it is visible for the whole slide-in before the camera's first
            frame arrives — a white flash in a dark cab at 06:10. */}
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <Scanner
            onCode={handleCode}
            onClose={() => setScanning(false)}
            cooldownMs={1200}
            style={{ flex: 1 }}
          >
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 44, paddingHorizontal: 26 }}>
              <Text
                style={{
                  color: '#FFFFFF', fontSize: 14, textAlign: 'center',
                  lineHeight: 20, opacity: 0.9,
                }}
              >
                Read the order number or the customer code.
              </Text>
              <Text
                style={{
                  color: '#FFFFFF', fontSize: 12.5, textAlign: 'center',
                  lineHeight: 18, opacity: 0.6, marginTop: 6,
                }}
              >
                Scan a cylinder here and it opens that cylinder instead.
              </Text>
            </View>
          </Scanner>
        </View>
      </Modal>
    </Screen>
  );
}
