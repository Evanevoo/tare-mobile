import { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, FlatList, Alert, TextInput, Modal, ActivityIndicator, Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { forOrder, counts } from '@/outbox';
import { T, shipTone, Surface, Btn, Edge, Tag, mono, shadow } from '@/ui';
import { Scanner } from '@/scanner';

/**
 * The scan loop.
 *
 * Everything here is tuned for one situation: a driver holding a phone in cold
 * hands, in a yard, with no signal. Nothing blocks on the network, every scan
 * gets a distinct buzz, the mode toggle is thumb-sized, and the most recent
 * scan is always the biggest thing on screen.
 *
 * The visual work serves that rather than decorating it — the reticle tells you
 * where to point, the confirmation card flashes in the colour of what just
 * happened, and the active mode is a lit object rather than a tinted rectangle,
 * because shipping when you meant to receive is the expensive mistake.
 */
export default function Scan() {
  const router = useRouter();
  const {
    orderNumber, customerName, customerListId, mode, setMode,
    outbox, addScan, dispatch, endDelivery, boot, sync, syncing,
  } = useStore();

  const [last, setLast] = useState<{ barcode: string; kind: string } | null>(null);
  const [manual, setManual] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const cooldown = useRef<Record<string, number>>({});
  const geo = useRef<{ lat: number; lng: number; accuracyM: number | null } | null>(null);

  // The confirmation card flashes on each accepted scan. On a phone held at
  // arm's length this is read peripherally — you should not have to focus on
  // the screen to know the scan landed.
  const flash = useRef(new Animated.Value(0)).current;

  const rows = orderNumber ? forOrder(outbox, orderNumber) : [];
  const c = counts(outbox, orderNumber ?? undefined);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      geo.current = {
        lat: p.coords.latitude, lng: p.coords.longitude,
        accuracyM: p.coords.accuracy ? Math.round(p.coords.accuracy) : null,
      };
    })().catch(() => {});
  }, []);

  if (!orderNumber || !customerListId) { router.replace('/'); return null; }

  function take(raw: string) {
    const barcode = raw.trim().toUpperCase();
    if (!barcode) return;

    const now = Date.now();
    if (cooldown.current[barcode] && now - cooldown.current[barcode] < 2500) return;
    cooldown.current[barcode] = now;

    const kind = addScan(barcode, geo.current ?? undefined);
    setLast({ barcode, kind });

    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 620, useNativeDriver: false }).start();

    if (kind === 'added') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === 'unknown') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  function finish() {
    const n = c.pending;
    endDelivery();
    router.replace('/');
    if (n) sync().catch(() => {});
  }

  const banner =
    last?.kind === 'duplicate' ? { text: 'Already scanned', tone: T.steel }
    : last?.kind === 'unknown' ? { text: 'Unknown barcode — held for review', tone: T.amber }
    : last ? { text: mode === 'SHIP' ? 'Shipped out' : 'Returned in', tone: T.bottle }
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      {/* ── camera ── */}
      <View style={{ height: '36%', backgroundColor: '#000' }}>
        {/* One shared surface carries the hard-won parts: double-read
            confirm, cooldown, torch, zoom, tap-to-refocus, and the ML Kit
            still-frame fallback on builds that have it. */}
        <Scanner onCode={take} style={{ flex: 1 }} />

        {/* Scrim, so white text over a bright yard is still readable. */}
        <LinearGradient
          colors={['rgba(0,0,0,0.82)', 'rgba(0,0,0,0.34)', 'transparent']}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 54,
                   paddingHorizontal: 18, paddingBottom: 22 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable onPress={finish} hitSlop={14}>
              <Text style={{ color: '#fff', fontSize: 15.5, fontWeight: '700' }}>Done</Text>
            </Pressable>
            <View style={{ marginLeft: 14, flex: 1 }}>
              <Text numberOfLines={1} style={{ color: '#fff', fontSize: 14.5, fontWeight: '700' }}>
                {customerName}
              </Text>
              <Text style={[mono(12, '500'), { color: 'rgba(255,255,255,0.68)' }]}>
                {orderNumber}
              </Text>
            </View>
            <Pressable onPress={() => setManual(true)} hitSlop={14}>
              <Text style={{ color: T.brandLit, fontSize: 14, fontWeight: '700' }}>Type code</Text>
            </Pressable>
          </View>
        </LinearGradient>
      </View>

      {/* ── mode: the single most-pressed control on the phone ── */}
      <View style={{ flexDirection: 'row', padding: 14, gap: 11 }}>
        {(['SHIP', 'RETURN'] as const).map((m) => {
          const on = mode === m;
          const tone = shipTone(m);
          return (
            <Pressable
              key={m}
              onPress={() => { setMode(m); Haptics.selectionAsync(); }}
              style={{ flex: 1 }}
            >
              {on ? (
                <LinearGradient
                  colors={[tone, tone + 'CC']}
                  start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
                  style={[
                    { height: 66, borderRadius: T.radiusSm,
                      alignItems: 'center', justifyContent: 'center' },
                    shadow(2, tone),
                  ]}
                >
                  <Edge inset={14} opacity={0.9} />
                  <Text style={{ color: T.onBrand, fontSize: 16.5, fontWeight: '900', letterSpacing: 0.4 }}>
                    {m === 'SHIP' ? 'SHIP OUT' : 'RETURN IN'}
                  </Text>
                  <Text style={{ color: 'rgba(4,35,26,0.66)', fontSize: 11.5, marginTop: 2, fontWeight: '700' }}>
                    {m === 'SHIP' ? `${c.ship} scanned` : `${c.ret} scanned`}
                  </Text>
                </LinearGradient>
              ) : (
                <View
                  style={{
                    height: 66, borderRadius: T.radiusSm,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    borderWidth: 1, borderColor: T.rule,
                  }}
                >
                  <Text style={{ color: T.steel, fontSize: 16.5, fontWeight: '800', letterSpacing: 0.4 }}>
                    {m === 'SHIP' ? 'SHIP OUT' : 'RETURN IN'}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2, fontWeight: '600' }}>
                    {m === 'SHIP' ? `${c.ship} scanned` : `${c.ret} scanned`}
                  </Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {/* ── the last scan, large ── */}
      {banner && last && (
        <Animated.View
          style={{
            marginHorizontal: 14, marginBottom: 12, borderRadius: T.radius,
            borderWidth: 1,
            borderColor: flash.interpolate({
              inputRange: [0, 1], outputRange: [T.rule, banner.tone],
            }),
            backgroundColor: flash.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(255,255,255,0.04)', banner.tone + '2E'],
            }),
            overflow: 'hidden',
          }}
        >
          <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: banner.tone }} />
            <View style={{ flex: 1 }}>
              <Text style={[mono(21, '700'), { color: T.ink }]}>{last.barcode}</Text>
              <Text style={{ color: banner.tone, fontSize: 13, marginTop: 3, fontWeight: '700' }}>
                {banner.text}
                {boot?.assets[last.barcode] ? ` · ${boot.assets[last.barcode]}` : ''}
              </Text>
            </View>
          </View>
        </Animated.View>
      )}

      {/* ── this order so far ── */}
      <FlatList
        data={[...rows].reverse()}
        keyExtractor={(s) => s.clientId}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListEmptyComponent={
          <Text style={{ color: T.faint, fontSize: 13.5, textAlign: 'center', paddingTop: 34, lineHeight: 20 }}>
            Point the camera at a barcode.
          </Text>
        }
        renderItem={({ item }) => (
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 12,
              paddingHorizontal: 18, paddingVertical: 13,
              borderBottomWidth: 1, borderBottomColor: T.soft,
            }}
          >
            <View style={{ width: 3, height: 26, borderRadius: 2, backgroundColor: shipTone(item.mode) }} />
            <View style={{ flex: 1 }}>
              <Text style={[mono(15, '600'), { color: T.ink }]}>{item.barcode}</Text>
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
                {item.state !== 'QUEUED' ? ` · ${item.state.toLowerCase()}` : ''}
              </Text>
            </View>
            {boot && !(item.barcode in boot.assets) && <Tag label="UNKNOWN" tone={T.amber} />}
            {item.state === 'QUEUED' && (
              <Pressable
                hitSlop={12}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  dispatch({ type: 'REMOVE', clientId: item.clientId });
                }}
              >
                <Text style={{ color: T.needle, fontSize: 13, fontWeight: '700' }}>Remove</Text>
              </Pressable>
            )}
          </View>
        )}
      />

      {/* ── submit ── */}
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        <LinearGradient
          colors={['transparent', 'rgba(7,9,10,0.92)', T.zinc]}
          style={{ paddingHorizontal: 14, paddingTop: 34, paddingBottom: 34 }}
        >
          <Btn
            label={`Submit order · ${c.total}`}
            sub={c.total ? `${c.ship} out · ${c.ret} in` : undefined}
            busy={syncing}
            disabled={!c.total}
            onPress={() => {
              Alert.alert(
                'Submit order',
                `${c.ship} shipped, ${c.ret} returned on ${orderNumber}.\n\nThey upload now if you have signal, and stay safe on this phone if you do not.`,
                [{ text: 'Keep scanning', style: 'cancel' }, { text: 'Submit', onPress: finish }],
              );
            }}
          />
        </LinearGradient>
      </View>

      {/* ── manual entry ── */}
      <Modal visible={manual} transparent animationType="fade" onRequestClose={() => setManual(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(3,5,6,0.78)', justifyContent: 'center', padding: 22 }}>
          <Surface level={3}>
            <View style={{ padding: 20 }}>
              <Text style={{ color: T.ink, fontSize: 18.5, fontWeight: '700', marginBottom: 5 }}>
                Type a barcode
              </Text>
              <Text style={{ color: T.faint, fontSize: 13, marginBottom: 16, lineHeight: 19 }}>
                For a label that is scratched, painted over, or under frost.
              </Text>
              <TextInput
                value={manualCode} onChangeText={(v) => setManualCode(v.toUpperCase())}
                autoFocus autoCapitalize="characters" autoCorrect={false}
                placeholder="PW-K-041827" placeholderTextColor={T.faint}
                style={[
                  {
                    height: 54, borderRadius: T.radiusSm, paddingHorizontal: 15, color: T.ink,
                    backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: T.rule,
                  },
                  mono(18, '600'),
                ]}
                onSubmitEditing={() => { take(manualCode); setManualCode(''); setManual(false); }}
              />
              <View style={{ flexDirection: 'row', gap: 11, marginTop: 16 }}>
                <Btn
                  label="Cancel" variant="quiet" style={{ flex: 1 }}
                  onPress={() => { setManual(false); setManualCode(''); }}
                />
                <Btn
                  label="Add" style={{ flex: 1 }}
                  disabled={!manualCode.trim()}
                  onPress={() => { take(manualCode); setManualCode(''); setManual(false); }}
                />
              </View>
            </View>
          </Surface>
        </View>
      </Modal>
    </View>
  );
}
