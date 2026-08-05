import { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, FlatList, Alert, TextInput, Modal, ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { forOrder, counts } from '@/outbox';
import { T, shipTone } from '@/ui';

/**
 * The scan loop.
 *
 * Everything here is tuned for one situation: a driver holding a phone in cold
 * hands, in a yard, with no signal. So — nothing blocks on the network, every
 * scan gets a distinct buzz, the mode toggle is thumb-sized, and the most
 * recent scan is always the biggest thing on screen.
 */
export default function Scan() {
  const router = useRouter();
  const {
    orderNumber, customerName, customerListId, mode, setMode,
    outbox, addScan, dispatch, endDelivery, boot, sync, syncing,
  } = useStore();

  const [perm, requestPerm] = useCameraPermissions();
  const [last, setLast] = useState<{ barcode: string; kind: string } | null>(null);
  const [manual, setManual] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const cooldown = useRef<Record<string, number>>({});
  const geo = useRef<{ lat: number; lng: number; accuracyM: number | null } | null>(null);

  const rows = orderNumber ? forOrder(outbox, orderNumber) : [];
  const c = counts(outbox, orderNumber ?? undefined);

  useEffect(() => { if (!perm?.granted) requestPerm(); }, [perm]);

  // One fix per session is enough to prove where the delivery happened.
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

    // Continuous camera fires the same code many times a second.
    const now = Date.now();
    if (cooldown.current[barcode] && now - cooldown.current[barcode] < 2500) return;
    cooldown.current[barcode] = now;

    const kind = addScan(barcode, geo.current ?? undefined);
    setLast({ barcode, kind });

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
    : last ? { text: `${mode === 'SHIP' ? 'Shipped' : 'Returned'}`, tone: T.bottle }
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      {/* ── camera ── */}
      <View style={{ height: '38%', backgroundColor: '#000' }}>
        {perm?.granted ? (
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: ['code128', 'code39', 'ean13', 'ean8', 'upc_a', 'upc_e',
                             'qr', 'pdf417', 'datamatrix', 'itf14', 'codabar'],
            }}
            onBarcodeScanned={({ data }) => take(data)}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ color: T.steel, fontSize: 14, textAlign: 'center' }}>
              Tare needs the camera to scan barcodes.
            </Text>
            <Pressable onPress={requestPerm} style={{ marginTop: 12 }}>
              <Text style={{ color: T.bottle, fontWeight: '700' }}>Allow camera</Text>
            </Pressable>
          </View>
        )}

        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          paddingTop: 52, paddingHorizontal: 16, paddingBottom: 10,
          backgroundColor: 'rgba(0,0,0,.45)', flexDirection: 'row', alignItems: 'center',
        }}>
          <Pressable onPress={finish} hitSlop={12}>
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Done</Text>
          </Pressable>
          <View style={{ marginLeft: 12, flex: 1 }}>
            <Text numberOfLines={1} style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
              {customerName}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,.65)', fontSize: 12, fontFamily: T.mono }}>
              {orderNumber}
            </Text>
          </View>
          <Pressable onPress={() => setManual(true)} hitSlop={12}>
            <Text style={{ color: '#fff', fontSize: 14 }}>Type code</Text>
          </Pressable>
        </View>
      </View>

      {/* ── mode toggle: the single most-pressed control ── */}
      <View style={{ flexDirection: 'row', padding: 12, gap: 10 }}>
        {(['SHIP', 'RETURN'] as const).map((m) => (
          <Pressable
            key={m}
            onPress={() => { setMode(m); Haptics.selectionAsync(); }}
            style={{
              flex: 1, height: 56, borderRadius: T.radius,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: mode === m ? shipTone(m) : T.face,
              borderWidth: 1, borderColor: mode === m ? shipTone(m) : T.rule,
            }}
          >
            <Text style={{
              color: mode === m ? '#0E1214' : T.steel,
              fontSize: 16, fontWeight: '800', letterSpacing: 0.4,
            }}>
              {m === 'SHIP' ? 'SHIP OUT' : 'RETURN IN'}
            </Text>
            <Text style={{
              color: mode === m ? 'rgba(14,18,20,.7)' : T.steel, fontSize: 11, marginTop: 1,
            }}>
              {m === 'SHIP' ? `${c.ship} scanned` : `${c.ret} scanned`}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── last scan, large ── */}
      {banner && last && (
        <View style={{
          marginHorizontal: 12, marginBottom: 10, padding: 14, borderRadius: T.radius,
          backgroundColor: T.face, borderLeftWidth: 3, borderLeftColor: banner.tone,
        }}>
          <Text style={{ color: T.ink, fontSize: 20, fontWeight: '700', fontFamily: T.mono }}>
            {last.barcode}
          </Text>
          <Text style={{ color: banner.tone, fontSize: 13, marginTop: 2, fontWeight: '600' }}>
            {banner.text}
            {boot?.assets[last.barcode] ? ` · ${boot.assets[last.barcode]}` : ''}
          </Text>
        </View>
      )}

      {/* ── session list ── */}
      <FlatList
        data={[...rows].reverse()}
        keyExtractor={(s) => s.clientId}
        contentContainerStyle={{ paddingBottom: 100 }}
        ListEmptyComponent={
          <Text style={{ color: T.steel, fontSize: 13, textAlign: 'center', paddingTop: 30 }}>
            Point the camera at a barcode.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 16, paddingVertical: 11,
            borderBottomWidth: 1, borderBottomColor: T.soft,
          }}>
            <View style={{ width: 3, height: 22, borderRadius: 2, backgroundColor: shipTone(item.mode) }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.ink, fontSize: 15, fontFamily: T.mono }}>{item.barcode}</Text>
              <Text style={{ color: T.steel, fontSize: 11, marginTop: 1 }}>
                {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
                {item.state !== 'QUEUED' ? ` · ${item.state.toLowerCase()}` : ''}
                {boot && !(item.barcode in boot.assets) ? ' · unknown' : ''}
              </Text>
            </View>
            {item.state === 'QUEUED' && (
              <Pressable
                hitSlop={10}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  dispatch({ type: 'REMOVE', clientId: item.clientId });
                }}
              >
                <Text style={{ color: T.needle, fontSize: 13, fontWeight: '600' }}>Remove</Text>
              </Pressable>
            )}
          </View>
        )}
      />

      {/* ── submit ── */}
      <View style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        padding: 12, paddingBottom: 30,
        backgroundColor: T.face, borderTopWidth: 1, borderTopColor: T.rule,
      }}>
        <Pressable
          disabled={!c.total || syncing}
          onPress={() => {
            Alert.alert(
              'Submit order',
              `${c.ship} shipped, ${c.ret} returned on ${orderNumber}.\n\nThey upload now if you have signal, and stay safe on this phone if you do not.`,
              [{ text: 'Keep scanning', style: 'cancel' }, { text: 'Submit', onPress: finish }],
            );
          }}
          style={{
            height: 54, borderRadius: T.radius, backgroundColor: T.bottle,
            alignItems: 'center', justifyContent: 'center', opacity: c.total ? 1 : 0.4,
          }}
        >
          {syncing
            ? <ActivityIndicator color="#fff" />
            : (
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                Submit order · {c.total}
              </Text>
            )}
        </Pressable>
      </View>

      {/* ── manual entry ── */}
      <Modal visible={manual} transparent animationType="fade" onRequestClose={() => setManual(false)}>
        <View style={{
          flex: 1, backgroundColor: 'rgba(0,0,0,.65)', justifyContent: 'center', padding: 24,
        }}>
          <View style={{ backgroundColor: T.face, borderRadius: 14, padding: 18 }}>
            <Text style={{ color: T.ink, fontSize: 17, fontWeight: '700', marginBottom: 4 }}>
              Type a barcode
            </Text>
            <Text style={{ color: T.steel, fontSize: 12.5, marginBottom: 14 }}>
              For a label that is scratched, painted over, or under frost.
            </Text>
            <TextInput
              value={manualCode} onChangeText={(v) => setManualCode(v.toUpperCase())}
              autoFocus autoCapitalize="characters" autoCorrect={false}
              placeholder="PW-K-041827" placeholderTextColor={T.steel}
              style={{
                height: 48, borderRadius: T.radius, paddingHorizontal: 14, color: T.ink,
                backgroundColor: T.zinc, borderWidth: 1, borderColor: T.rule,
                fontSize: 17, fontFamily: T.mono,
              }}
              onSubmitEditing={() => { take(manualCode); setManualCode(''); setManual(false); }}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <Pressable
                onPress={() => { setManual(false); setManualCode(''); }}
                style={{
                  flex: 1, height: 44, borderRadius: T.radius, borderWidth: 1,
                  borderColor: T.rule, alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Text style={{ color: T.steel, fontWeight: '600' }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => { take(manualCode); setManualCode(''); setManual(false); }}
                style={{
                  flex: 1, height: 44, borderRadius: T.radius, backgroundColor: T.bottle,
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Add</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
