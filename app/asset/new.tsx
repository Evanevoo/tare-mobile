import { useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { createAsset, ApiError, type AssetDraft } from '@/api';
import {
  T, Screen, Surface, Btn, Rise, Icon, ICON, mono, useBottomInset,
} from '@/ui';
import {
  Field, TextField, Chips, Choice, DateField, Note, isRealDate,
} from '@/form';

/**
 * Adding something to the fleet.
 *
 * Two situations produce this screen, and they look nothing alike. A pallet of
 * forty arrives at the yard, identical except for their barcodes. Or a driver
 * finds one bottle in a corner with no record on it. The screen has to be good
 * at both, which means the form must not be the thing you interact with forty
 * times — the scanner is.
 *
 * So: the barcode leads. Everything else is remembered from the last one saved
 * and stays put between saves, so the fortieth cylinder off a pallet costs one
 * scan and one tap. The tally at the bottom is there because a person doing
 * that forty times needs to see the pile growing or they will lose their place.
 *
 * The other job this screen does is refuse gracefully. A barcode that already
 * exists is checked against the offline copy before anything is typed, and the
 * answer is an offer to open the existing record — not a form filled out for
 * nothing and rejected at the end.
 */
export default function NewAsset() {
  const router = useRouter();
  const { boot, refresh } = useStore();
  const bottom = useBottomInset(24);

  const [barcode, setBarcode] = useState('');
  const [serial, setSerial] = useState('');
  const [product, setProduct] = useState('');
  const [location, setLocation] = useState('');
  const [full, setFull] = useState<boolean | null>(null);
  const [requal, setRequal] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const [perm, requestPerm] = useCameraPermissions();

  // The camera fires continuously while pointed at a label; without this the
  // same code lands twenty times a second.
  const lastSeen = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  const label = boot?.org.assetLabel ?? 'asset';
  const products = useMemo(
    () => (boot?.products ?? []).slice(0, 14).map((p) => ({ key: p.code, sub: `${p.n} on fleet` })),
    [boot?.products],
  );
  const locations = useMemo(
    () => (boot?.locations ?? []).slice(0, 14).map((l) => ({ key: l })),
    [boot?.locations],
  );

  const existing = barcode ? boot?.assets[barcode] : undefined;
  const dateOk = !requal || isRealDate(requal);
  const ready = !!barcode && !existing && !!product.trim() && full !== null && dateOk;

  function take(raw: string) {
    const bc = raw.replace(/\s+/g, '').trim().toUpperCase();
    if (!bc) return;

    const now = Date.now();
    if (lastSeen.current.code === bc && now - lastSeen.current.at < 2000) return;
    lastSeen.current = { code: bc, at: now };

    setBarcode(bc);
    setScanning(false);
    Haptics.notificationAsync(
      boot?.assets[bc]
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Success,
    );
  }

  async function save() {
    if (!ready || busy) return;
    setBusy(true);

    const draft: AssetDraft = {
      productCode: product.trim(),
      serialNumber: serial.trim() || null,
      location: location.trim() || null,
      isFull: full === true,
      nextRequalOn: requal || null,
      status: 'available',
    };

    try {
      await createAsset(barcode, draft);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setAdded((a) => [barcode, ...a]);

      // Everything that describes the batch stays. Only what identifies the
      // individual thing is cleared, and the scanner reopens — because the
      // next one is already in the driver's other hand.
      setBarcode('');
      setSerial('');
      refresh().catch(() => {});
      if (perm?.granted) setScanning(true);
    } catch (e: unknown) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (e instanceof ApiError && e.status === 409 && e.body?.existing) {
        const bc = barcode;
        Alert.alert(
          'Already on the fleet',
          `${bc} exists${e.body.outAtCustomer ? ' and is out at a customer' : ''}. Nothing was changed.`,
          [
            { text: 'Keep adding', style: 'cancel', onPress: () => setBarcode('') },
            { text: 'Open it', onPress: () => router.push(`/asset/${encodeURIComponent(bc)}` as never) },
          ],
        );
      } else {
        Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function openCamera() {
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) {
        Alert.alert(
          'Camera is off',
          'Scanning needs the camera. You can still type barcodes in by hand.',
        );
        return;
      }
    }
    setScanning(true);
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 18,
            paddingTop: 8,
            paddingBottom: bottom + (ready ? 108 : 40),
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Rise>
            <Text style={{ color: T.ink, fontSize: 29, fontWeight: '700', letterSpacing: -1 }}>
              Add {added.length ? 'another' : `a ${label.toLowerCase()}`}
            </Text>
            <Text style={{ color: T.faint, fontSize: 13.5, marginTop: 5, lineHeight: 20 }}>
              It goes on the fleet in-house. Sending it to a customer is a scan against
              their order, not a form.
            </Text>
          </Rise>

          {/* ── the barcode leads ── */}
          <Rise delay={50}>
            <Field label="Barcode" style={{ marginTop: 24 }}>
              {scanning && perm?.granted ? (
                <View
                  style={{
                    height: 260,
                    borderRadius: T.radius,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: 'rgba(63,180,137,0.35)',
                  }}
                >
                  <CameraView
                    style={{ flex: 1 }}
                    facing="back"
                    barcodeScannerSettings={{
                      barcodeTypes: ['code128', 'code39', 'ean13', 'ean8', 'upc_a', 'qr', 'datamatrix'],
                    }}
                    onBarcodeScanned={({ data }) => take(data)}
                  />
                  {/* A frame, so the driver knows where to hold it. */}
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute', left: 34, right: 34, top: 84, bottom: 84,
                      borderWidth: 2, borderColor: 'rgba(63,180,137,0.7)', borderRadius: 10,
                    }}
                  />
                  <Pressable
                    onPress={() => setScanning(false)}
                    accessibilityRole="button"
                    style={{
                      position: 'absolute', right: 10, top: 10,
                      paddingHorizontal: 15, minHeight: 38, borderRadius: 10,
                      backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13.5 }}>Stop</Text>
                  </Pressable>
                </View>
              ) : (
                <View>
                  <Pressable
                    onPress={openCamera}
                    accessibilityRole="button"
                    accessibilityLabel="Scan a barcode with the camera"
                    style={{
                      minHeight: 88,
                      borderRadius: T.radius,
                      borderWidth: 1,
                      borderStyle: 'dashed',
                      borderColor: 'rgba(63,180,137,0.4)',
                      backgroundColor: 'rgba(63,180,137,0.06)',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 11,
                    }}
                  >
                    <Icon name="maximize" size={ICON.lg} color={T.brandLit} />
                    <Text style={{ color: T.brandLit, fontSize: 15.5, fontWeight: '700' }}>
                      Scan the label
                    </Text>
                  </Pressable>

                  <View style={{ marginTop: 10 }}>
                    <TextField
                      value={barcode}
                      onChangeText={(v) => setBarcode(v.replace(/\s+/g, ''))}
                      placeholder="or type it in"
                      code
                    />
                  </View>
                </View>
              )}
            </Field>
          </Rise>

          {/* The one thing this screen must never do: let somebody fill out a
              whole form for a barcode that already exists. */}
          {!!existing && (
            <Note
              icon="alert-triangle"
              tone={T.amber}
              text={
                `${barcode} is already on the fleet` +
                (existing.c ? `, out at ${existing.c}.` : `${existing.l ? `, at ${existing.l}.` : '.'}`) +
                ' Nothing here will be saved.'
              }
              action="Open the record"
              onAction={() => router.push(`/asset/${encodeURIComponent(barcode)}` as never)}
            />
          )}

          {/* ── the rest only matters once the barcode is new ── */}
          {!!barcode && !existing && (
            <Rise delay={40}>
              <Field
                label="What kind"
                hint={products.length ? 'Commonest first.' : undefined}
              >
                <Chips
                  options={products}
                  value={product}
                  onChange={setProduct}
                  placeholder="Product code"
                />
              </Field>

              <Field label="Serial number" hint="Optional — stamped on the collar, if there is one.">
                <TextField
                  value={serial}
                  onChangeText={setSerial}
                  placeholder="Leave blank if there is none"
                  code
                />
              </Field>

              <Field label="What is in it">
                <Choice
                  options={[
                    { value: 'full', label: 'FULL', sub: 'ready to go out' },
                    { value: 'empty', label: 'EMPTY', sub: 'needs filling' },
                  ]}
                  value={full === null ? null : full ? 'full' : 'empty'}
                  onChange={(v) => setFull(v === 'full')}
                />
              </Field>

              <Field label="Where it lives" hint="Optional. Leave it blank if it has no shelf yet.">
                <Chips
                  options={locations}
                  value={location}
                  onChange={setLocation}
                  placeholder="Bay 4, Rack B, Dock…"
                  code={false}
                />
              </Field>

              <Field
                label="Next requalification"
                hint="Optional. The date it next has to be tested."
              >
                <DateField value={requal} onChange={setRequal} />
              </Field>
            </Rise>
          )}

          {/* ── what has gone in so far ── */}
          {added.length > 0 && (
            <Rise delay={40}>
              <View style={{ marginTop: 30 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 11 }}>
                  <Text style={{ color: T.steel, fontSize: 12.5, fontWeight: '700', letterSpacing: 0.6 }}>
                    ADDED THIS SESSION
                  </Text>
                  <Text style={[mono(13, '700'), { color: T.brandLit, marginLeft: 'auto' }]}>
                    {added.length}
                  </Text>
                </View>
                <Surface>
                  {added.slice(0, 12).map((bc, i) => (
                    <Pressable
                      key={bc}
                      onPress={() => router.push(`/asset/${encodeURIComponent(bc)}` as never)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${bc}`}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingHorizontal: 16, minHeight: 48,
                        borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                      }}
                    >
                      <Icon name="check" size={ICON.sm} color={T.bottle} />
                      <Text style={[mono(14.5, '600'), { color: T.ink, flex: 1 }]}>{bc}</Text>
                      <Icon name="chevron-right" size={ICON.sm} color={T.faint} />
                    </Pressable>
                  ))}
                </Surface>
                {added.length > 12 && (
                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 10 }}>
                    and {added.length - 12} more.
                  </Text>
                )}
              </View>
            </Rise>
          )}

          {!barcode && (
            <Note
              text={
                `Scanning the same pallet over and over? What kind, where, and full or ` +
                `empty all stay put between saves — only the barcode clears.`
              }
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {ready && (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom,
            backgroundColor: 'rgba(7,9,10,0.94)',
            borderTopWidth: 1, borderTopColor: T.rule,
          }}
        >
          <Btn
            label={`Add ${barcode}`}
            sub={[product.trim(), full ? 'full' : 'empty', location.trim()].filter(Boolean).join(' · ')}
            busy={busy}
            onPress={save}
          />
        </View>
      )}
    </Screen>
  );
}
