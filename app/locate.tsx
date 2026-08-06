import { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { postFill } from '@/api';
import {
  T, Screen, Surface, Btn, Eyebrow, Tag, Rise, Icon, ICON, mono, useBottomInset,
} from '@/ui';

/**
 * Locate — the yard half of the day.
 *
 * A delivery is customer plus order. This is neither: it is a person at a
 * shelf saying "these forty are here, and they are full". Nothing bills.
 *
 * The one thing the old app did silently and this does out loud: putting a
 * bottle away in-house takes it off a customer's balance, and if a rental was
 * open it has to be closed or they keep paying for something on your shelf.
 * The count of closed rentals comes back and is shown, because ending twelve
 * rentals with one tap is not something to find out about later.
 */
export default function Locate() {
  const router = useRouter();
  const { boot, refresh } = useStore();
  const bottom = useBottomInset(24);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [location, setLocation] = useState('');
  const [custom, setCustom] = useState(false);
  const [state, setState] = useState<'full' | 'empty' | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);

  const locations = boot?.locations ?? [];

  function add(raw: string) {
    const bc = raw.trim().toUpperCase();
    if (!bc) return;
    if (codes.includes(bc)) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); return; }

    const known = boot?.assets[bc];
    // A bottle still out at a customer is the interesting case: marking it
    // here is what ends that rental, so it is called out rather than accepted
    // in silence.
    if (state === 'full' && known?.c) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Still out at a customer',
        `${bc} is on ${known.c}'s account. Adding it here brings it back in-house and ends that rental.`,
        [
          { text: 'Skip', style: 'cancel' },
          { text: 'Add anyway', onPress: () => setCodes((c) => [...c, bc]) },
        ],
      );
      return;
    }

    Haptics.notificationAsync(
      known ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    setCodes((c) => [...c, bc]);
  }

  async function save() {
    if (!location || !state || !codes.length) return;
    setBusy(true);
    try {
      const r = await postFill(location, state, codes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refresh().catch(() => {});
      Alert.alert(
        'Saved',
        [
          `${r.updated} marked ${state} at ${location}.`,
          r.closed ? `${r.closed} open rental${r.closed === 1 ? '' : 's'} closed — those customers stop being charged.` : null,
          r.unknown.length ? `${r.unknown.length} not in the system: ${r.unknown.slice(0, 5).join(', ')}${r.unknown.length > 5 ? '…' : ''}` : null,
        ].filter(Boolean).join('\n\n'),
        [{ text: 'Done', onPress: () => router.replace('/') }],
      );
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not save', e?.message ?? 'Try again when you have signal.');
    } finally {
      setBusy(false);
    }
  }

  const field = {
    height: 52, borderRadius: T.radiusSm, paddingHorizontal: 15,
    color: T.ink, fontSize: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: T.rule,
  } as const;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 44, paddingBottom: bottom + 90 }}
        keyboardShouldPersistTaps="handled"
      >
        <Rise>
          <Text style={{ color: T.ink, fontSize: 29, fontWeight: '700', letterSpacing: -1 }}>
            Locate
          </Text>
          <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 5, lineHeight: 20 }}>
            Put things away and set what is in them. No order, no customer — this is
            housekeeping, and it does not bill.
          </Text>
        </Rise>

        {/* ── 1 · where ── */}
        <Rise delay={60} style={{ marginTop: 26 }}>
          <Eyebrow style={{ marginBottom: 11 }}>1 · Where</Eyebrow>
          {custom || locations.length === 0 ? (
            <TextInput
              value={location} onChangeText={setLocation}
              placeholder="Bay 4, Rack B, Dock…" placeholderTextColor={T.faint}
              autoCapitalize="characters" autoCorrect={false}
              style={field}
            />
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
              {locations.map((l) => (
                <Pressable
                  key={l}
                  onPress={() => { setLocation(l); Haptics.selectionAsync(); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: location === l }}
                  style={{
                    minHeight: 46, justifyContent: 'center', paddingHorizontal: 16,
                    borderRadius: T.radiusSm,
                    backgroundColor: location === l ? 'rgba(63,180,137,0.16)' : 'rgba(255,255,255,0.045)',
                    borderWidth: 1,
                    borderColor: location === l ? 'rgba(63,180,137,0.45)' : T.rule,
                  }}
                >
                  <Text
                    style={{
                      color: location === l ? T.brandLit : T.steel,
                      fontSize: 14.5, fontWeight: '700',
                    }}
                  >
                    {l}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {locations.length > 0 && (
            <Pressable onPress={() => { setCustom((v) => !v); setLocation(''); }} hitSlop={10}>
              <Text style={{ color: T.brandLit, fontSize: 13, fontWeight: '700', marginTop: 12 }}>
                {custom ? 'Pick from the list' : 'Somewhere else'}
              </Text>
            </Pressable>
          )}
        </Rise>

        {/* ── 2 · what is in them ── */}
        {!!location && (
          <Rise delay={40} style={{ marginTop: 26 }}>
            <Eyebrow style={{ marginBottom: 11 }}>2 · What is in them</Eyebrow>
            <View style={{ flexDirection: 'row', gap: 11 }}>
              {(['full', 'empty'] as const).map((k) => (
                <Pressable
                  key={k}
                  onPress={() => { setState(k); Haptics.selectionAsync(); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: state === k }}
                  style={{
                    flex: 1, height: 62, borderRadius: T.radiusSm,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: state === k
                      ? (k === 'full' ? 'rgba(63,180,137,0.18)' : 'rgba(255,255,255,0.07)')
                      : 'rgba(255,255,255,0.04)',
                    borderWidth: 1,
                    borderColor: state === k
                      ? (k === 'full' ? 'rgba(63,180,137,0.5)' : 'rgba(255,255,255,0.22)')
                      : T.rule,
                  }}
                >
                  <Text
                    style={{
                      color: state === k ? (k === 'full' ? T.brandLit : T.ink) : T.steel,
                      fontSize: 16.5, fontWeight: '800', letterSpacing: 0.3,
                    }}
                  >
                    {k.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Rise>
        )}

        {/* ── 3 · which ones ── */}
        {!!location && !!state && (
          <Rise delay={40} style={{ marginTop: 26 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 11 }}>
              <Eyebrow>3 · Which ones</Eyebrow>
              <Text style={[mono(13, '700'), { color: T.brandLit, marginLeft: 'auto' }]}>
                {codes.length}
              </Text>
            </View>

            {scanning && perm?.granted ? (
              <View
                style={{
                  height: 230, borderRadius: T.radius, overflow: 'hidden',
                  borderWidth: 1, borderColor: T.rule, marginBottom: 12,
                }}
              >
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{
                    barcodeTypes: ['code128', 'code39', 'ean13', 'ean8', 'upc_a', 'qr', 'datamatrix'],
                  }}
                  onBarcodeScanned={({ data }) => add(data)}
                />
                <Pressable
                  onPress={() => setScanning(false)}
                  style={{
                    position: 'absolute', right: 10, top: 10,
                    paddingHorizontal: 14, height: 36, borderRadius: 10,
                    backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13.5 }}>Stop</Text>
                </Pressable>
              </View>
            ) : (
              <Btn
                label="Scan with the camera"
                variant="ghost"
                style={{ marginBottom: 12 }}
                onPress={async () => {
                  if (!perm?.granted) { const r = await requestPerm(); if (!r.granted) return; }
                  setScanning(true);
                }}
              />
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TextInput
                value={typed} onChangeText={(v) => setTyped(v.toUpperCase())}
                placeholder="Or type a barcode" placeholderTextColor={T.faint}
                autoCapitalize="characters" autoCorrect={false}
                onSubmitEditing={() => { add(typed); setTyped(''); }}
                style={[field, mono(15, '600'), { flex: 1 }]}
              />
              <Btn
                label="Add" variant="ghost" style={{ width: 92 }}
                disabled={!typed.trim()}
                onPress={() => { add(typed); setTyped(''); }}
              />
            </View>

            {codes.length > 0 && (
              <Surface style={{ marginTop: 14 }}>
                {codes.map((bc, i) => {
                  const known = boot?.assets[bc];
                  return (
                    <View
                      key={bc + i}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, paddingVertical: 13,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[mono(14.5, '600'), { color: T.ink }]}>{bc}</Text>
                        <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                          {known ? (known.c ? `was out at ${known.c}` : known.p ?? 'in house') : 'not in the system'}
                        </Text>
                      </View>
                      {!known && <Tag label="UNKNOWN" tone={T.amber} />}
                      <Pressable
                        onPress={() => setCodes((c) => c.filter((_, n) => n !== i))}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${bc}`}
                      >
                        <Icon name="x" size={ICON.md} color={T.needle} />
                      </Pressable>
                    </View>
                  );
                })}
              </Surface>
            )}
          </Rise>
        )}
      </ScrollView>

      {!!location && !!state && codes.length > 0 && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            backgroundColor: 'rgba(7,9,10,0.94)',
            borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Btn
            label={`Mark ${codes.length} ${state}`}
            sub={`at ${location}`}
            busy={busy}
            onPress={save}
          />
        </View>
      )}
    </Screen>
  );
}
