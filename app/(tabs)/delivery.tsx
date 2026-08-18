import { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { Scanner } from '@/scanner';
import { useScanRoute, explainMiss } from '@/scan-route';
import { classify } from '@/scan-match';
import { formatExample, formatNudge } from '@/formats';
import { T, Screen, Surface, Btn, Eyebrow, Rise, Tag, mono, tint, wash } from '@/ui';

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
  // A customer code read HERE fills the field below; it does not send the
  // driver off to that customer's screen in the middle of setting a job up.
  const route = useScanRoute({ customerScreen: false });
  const { boot, startDelivery } = useStore();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [order, setOrder] = useState('');
  /**
   * WHICH FIELD ASKED FOR THE CAMERA.
   *
   * This screen has two SCAN buttons — one beside the customer search, one
   * beside the order number — and until now both set the same boolean and the
   * same handler asked the same open question of whatever came back: what
   * could this code be? So a driver who tapped SCAN on the order-number field,
   * while holding a receipt that carries the customer's code an inch from the
   * order number's, could have the customer picked out from under them. The
   * decoder reads the whole frame and always has; it does not know which
   * barcode on the page was meant.
   *
   * But the app does know, because the driver just told it by choosing a
   * button, and it was throwing that away. Carrying the intent instead of a
   * boolean is the entire fix, and it is worth more than the position filter:
   * it works on both platforms, it needs no `bounds`, and most of this fleet's
   * labels are Code 39, which on iOS reports no bounds at all.
   */
  const [scanning, setScanning] = useState<null | 'customer' | 'order'>(null);
  const [note, setNote] = useState<string | null>(null);
  /** What the camera saw and declined to use, so refusing is never silent. */
  const [stray, setStray] = useState<string | null>(null);

  const customers = useMemo(() => {
    const all = boot?.customers ?? [];
    // The holding account is always a legitimate pick — a walk-in has no
    // account number to search by — so it stays pinned above whatever the
    // search narrows down to, rather than getting filtered out by a query
    // that was never about them.
    const holding = all.filter((c) => c.tmp);
    const rest = q.trim()
      ? all.filter((c) => {
          const n = q.toLowerCase();
          return !c.tmp && (
            c.name.toLowerCase().includes(n) ||
            c.customerListId.toLowerCase().includes(n) ||
            (c.city ?? '').toLowerCase().includes(n)
          );
        })
      : all.filter((c) => !c.tmp).slice(0, 60 - holding.length);
    return [...holding, ...rest];
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
  /**
   * WHAT THIS FIELD IS WILLING TO READ.
   *
   * Handed to the Scanner, which calls it before a code is ever accepted, so a
   * refusal costs nothing and the camera simply keeps looking. That is the
   * right shape for the actual situation: the driver is holding one piece of
   * paper with two barcodes on it and does not want to be told off, they want
   * the app to take the one they asked for. Point it at the receipt, and the
   * customer's code is passed over until the order number comes into view.
   *
   * Only the order-number field narrows anything. Scanning from the customer
   * field stays exactly as open as it was — the driver there genuinely may be
   * holding a card, a receipt, or a cylinder, and this screen's whole job at
   * that point is to work out which.
   */
  const acceptHere = useCallback((code: string) => {
    if (scanning !== 'order') return true;
    const t = classify(code, boot);
    if (!t || t.kind === 'text') return true;

    // Setting the same string again is a no-op in React, so this is safe to
    // call from a callback that fires several times a second.
    setStray(
      t.kind === 'customer'
        ? `Skipped ${t.name} — that is a customer code, not an order number.`
        : `Skipped ${t.barcode} — that is a cylinder, not an order number.`,
    );
    return false;
  }, [scanning, boot]);

  function handleCode(code: string) {
    const t = route(code);
    if (!t) return;
    setScanning(null);

    // An asset was already pushed by route() — the driver is looking at the
    // cylinder now, and nothing on this screen should change underneath them.
    if (t.kind === 'asset') return;

    if (t.kind === 'customer') {
      setPicked({ id: t.id, name: t.name });
      setQ('');
      setNote(`Customer set from scan — ${t.name}`);
      return;
    }

    /**
     * A CODE THAT MATCHED NOTHING SAYS SO, AND SAYS WHY.
     *
     * This branch used to read "Read X as the order number", which is true and
     * useless: it is also exactly what the screen says when a customer card is
     * scanned and silently fails to resolve. A driver holding a card that the
     * app has quietly demoted to an order number has no way to tell that from
     * the app working as intended, so nobody reports it — and when somebody
     * finally does, there is nothing on the screen to report.
     *
     * `explainMiss` costs one line of text and separates the three cases that
     * were rendered identically: an unknown code, a customer list downloaded
     * without card codes on it, and a code that matched several customers and
     * was therefore refused.
     */
    setOrder(t.code);
    setNote(
      picked
        ? `Order number set from scan — ${t.code}`
        : `${explainMiss(t.code, boot)} Put in the order-number field — pick the customer first if that is wrong.`,
    );
  }

  const canStart = !!picked && order.trim().length >= 3;

  /**
   * "That does not look like one of yours."
   *
   * The console has had a place to write down what an order number looks like
   * since the beginning, and the bootstrap has always shipped it — the handset
   * simply never read it, so a driver could type anything and find out it was
   * wrong when the invoice would not reconcile. This is the whole of the
   * enforcement: a line of text. It never blocks Start scanning, because a
   * real order number the office has not written a rule for yet is far more
   * common than a typo, and a driver in a yard cannot edit the org's settings.
   */
  const orderPattern = boot?.formats?.orderNumber;
  const orderNudge = formatNudge(order, orderPattern, 'order numbers');
  const orderHint = formatExample(orderPattern);

  /**
   * "NO RULE" AND "NO DOWNLOAD" ARE NOT THE SAME THING, and rendering them the
   * same way is why a missing nudge could not be explained from the field.
   *
   * An org that has never written its number rules down must see nothing —
   * `matchesFormat` accepts everything against an empty pattern on purpose,
   * because a warning under every field on day one teaches people to ignore
   * warnings. But a handset whose bootstrap carries no `formats` KEY AT ALL is
   * a different animal: that phone is holding a download from before the rules
   * shipped, and the silence is a stale cache rather than a policy. The two
   * were indistinguishable on screen and identical in behaviour, so "the nudge
   * never appears" had no diagnosis and no fix.
   *
   * `formats` present but empty → still silent, exactly as designed. `formats`
   * absent while a bootstrap is otherwise loaded → one quiet grey line saying
   * so. It is never amber and it never touches Start scanning.
   */
  const rulesMissing = !!boot && !boot.formats;

  const field = {
    minHeight: 52, borderRadius: T.radiusSm, paddingHorizontal: 15,
    color: T.ink, fontSize: 16,
    backgroundColor: tint(0.05),
    borderWidth: 1, borderColor: T.rule,
  } as const;

  /**
   * Sits inside a field the way Show/Hide does on the sign-in screen.
   *
   * `intent` is not decoration. It is the field saying what it is asking for,
   * and it is the only place in the app that knows.
   */
  const ScanBtn = ({ intent }: { intent: 'customer' | 'order' }) => (
    <Pressable
      onPress={() => { setNote(null); setStray(null); setScanning(intent); }}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={intent === 'customer' ? 'Scan a customer card' : 'Scan the order number'}
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
                <Pressable
                  onPress={() => setPicked(null)}
                  accessibilityRole="button"
                  accessibilityLabel={`Customer ${picked.name}. Tap to change`}
                >
                  <Surface tint={wash(0.13)} style={{ marginBottom: 22 }}>
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
                  <ScanBtn intent="customer" />
                </View>
              )}
            </Rise>

            {note && (
              <Pressable
                onPress={() => setNote(null)}
                accessibilityRole="button"
                accessibilityLabel={`${note}. Tap to dismiss`}
              >
                <View
                  style={{
                    marginBottom: 16, padding: 12, borderRadius: T.radiusSm,
                    backgroundColor: wash(0.10),
                    borderWidth: 1, borderColor: wash(0.24),
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
                    placeholder={orderHint || 'INV-9001'} placeholderTextColor={T.faint}
                    autoCapitalize="characters" autoCorrect={false} autoFocus
                    style={[
                      field, mono(17, '600'),
                      { color: T.ink, paddingRight: 62 },
                      orderNudge ? { borderColor: T.amber } : null,
                    ]}
                  />
                  <ScanBtn intent="order" />
                </View>
                {orderNudge ? (
                  <Text style={{ color: T.amber, fontSize: 12.5, lineHeight: 18, marginTop: 7 }}>
                    {orderNudge}
                  </Text>
                ) : rulesMissing ? (
                  <Text style={{ color: T.faint, fontSize: 12, lineHeight: 18, marginTop: 7 }}>
                    No number rules on this phone yet — pull down on Home to refresh, and
                    order numbers will be checked against your own.
                  </Text>
                ) : null}
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
            accessibilityRole="button"
            accessibilityLabel={`Pick ${item.name}`}
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
                {item.tmp ? 'no account number yet' : item.customerListId}
                {item.city ? ` · ${item.city}` : ''}
              </Text>
            </View>
            {item.tmp
              ? <Tag label="HOLDING" tone={T.amber} />
              : item.held > 0 && <Tag label={`${item.held} out`} tone={T.bottle} />}
          </Pressable>
        )}
      />

      <Modal
        visible={scanning !== null}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScanning(null)}
      >
        {/* The black floor is not decoration. A Modal's own backdrop is white,
            and it is visible for the whole slide-in before the camera's first
            frame arrives — a white flash in a dark cab at 06:10. */}
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <Scanner
            onCode={handleCode}
            accept={acceptHere}
            onClose={() => setScanning(null)}
            cooldownMs={1200}
            // Reading a printed receipt held still, not sweeping a pallet. The
            // periodic Android refocus makes this case worse, not better — the
            // legacy app disabled it here for exactly this reason.
            steadyFocus
            style={{ flex: 1 }}
          >
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 44, paddingHorizontal: 26 }}>
              {/* The instruction is the field's, not the screen's. Telling a
                  driver aiming at an order number that they may also scan a
                  customer code is how the wrong barcode gets read on purpose. */}
              <Text
                style={{
                  color: '#FFFFFF', fontSize: 14, textAlign: 'center',
                  lineHeight: 20, opacity: 0.9,
                }}
              >
                {scanning === 'order'
                  ? 'Read the order number.'
                  : 'Read the order number or the customer code.'}
              </Text>
              <Text
                style={{
                  color: '#FFFFFF', fontSize: 12.5, textAlign: 'center',
                  lineHeight: 18, opacity: 0.6, marginTop: 6,
                }}
              >
                {scanning === 'order'
                  ? 'Customer codes and cylinders on the same page are passed over.'
                  : 'Scan a cylinder here and it opens that cylinder instead.'}
              </Text>
              {/* Amber, and only while something is actually being refused. A
                  camera that has quietly decided to ignore what it can see is
                  indistinguishable from one that is not working. */}
              {stray && scanning === 'order' ? (
                <Text
                  style={{
                    color: T.amber, fontSize: 12.5, textAlign: 'center',
                    lineHeight: 18, marginTop: 10, fontWeight: '700',
                  }}
                >
                  {stray}
                </Text>
              ) : null}
            </View>
          </Scanner>
        </View>
      </Modal>
    </Screen>
  );
}
