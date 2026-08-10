import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useStore } from '@/store';
import { retagBlockedBy } from '@/outbox';
import { editSentScan } from '@/api';
import {
  T, Screen, Surface, Btn, Eyebrow, Tag, Rise, Icon, ICON, mono, useBottomInset, tint,
} from '@/ui';

/**
 * ONE ORDER, EDITABLE, FROM THE TRUCK.
 *
 * History lists orders; this is what opens when you tap one. Everything a
 * driver can get wrong in a yard is changeable here: which bottles went out,
 * which came back, the order number they were scanned against, and the
 * customer.
 *
 * TWO KINDS OF ROW, AND THE DIFFERENCE IS NOT COSMETIC.
 *
 * A scan still sitting in this phone's outbox is local state. Changing it is
 * instant, works with no signal, and nobody else has seen it — so it is
 * changed silently and no reason is asked for. There is nothing to explain
 * yet, because nothing has been asserted to anyone.
 *
 * A scan that has synced is in the ledger. It may already have reconciled
 * against an invoice; it may be about to bill somebody. Changing it needs
 * signal, needs the manager role, and needs a reason — the same reason box
 * the console demands, for the same reason: it is printed next to the change
 * in the dispute packet the customer reads. The server enforces all three
 * (api/mobile/scan-edit); this screen just makes the difference visible so
 * nobody is surprised by a refusal.
 *
 * That split is why the rows are labelled ON PHONE and ON SERVER rather than
 * some tidier single status. It is the one distinction that changes what you
 * are allowed to do.
 */
export default function OrderEdit() {
  const params = useLocalSearchParams<{ orderNumber: string }>();
  const orderNumber = decodeURIComponent(String(params.orderNumber ?? ''));
  const router = useRouter();
  const bottom = useBottomInset(24);

  const { boot, outbox, dispatch, sync, refresh } = useStore();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [orderDraft, setOrderDraft] = useState(orderNumber);
  const [showRetag, setShowRetag] = useState(false);

  const rows = outbox.scans.filter((s) => s.orderNumber === orderNumber);
  const nameBy = new Map((boot?.customers ?? []).map((c) => [c.customerListId, c.name]));
  const listId = rows[0]?.customerListId ?? '';
  const customer = nameBy.get(listId) ?? listId ?? 'no customer';

  const ship = rows.filter((s) => s.mode === 'SHIP');
  const ret = rows.filter((s) => s.mode === 'RETURN');
  const anySent = rows.some((s) => s.state === 'SENT');

  if (!rows.length) {
    return (
      <Screen>
        <View style={{ flex: 1, padding: 22, justifyContent: 'center' }}>
          <Text style={{ color: T.ink, fontSize: 17, fontWeight: '700' }}>Nothing here to change</Text>
          {/* History lists the whole company now, so most of what it shows was
              scanned somewhere else. This screen edits the outbox and the
              scans this handset sent, and it has neither for this order —
              which is a fact about this phone, not about the order. */}
          <Text style={{ color: T.faint, fontSize: 14, marginTop: 8, lineHeight: 20 }}>
            {orderNumber} was scanned on another handset, so none of it is on this one.
            What went out and what came back are on the console, and so is the way to
            correct them.
          </Text>
          <Btn label="Back to history" variant="ghost" style={{ marginTop: 22 }}
               onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  /** A sent scan needs a reason before the server will look at it. */
  function needReason(): string | null {
    const r = reason.trim();
    if (r.length >= 3) return r;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      'Say why first',
      'This scan is already on the server. The reason is printed next to the change on the customer’s dispute packet, so it cannot be blank.',
    );
    return null;
  }

  /** Returns whether the server took it, so callers can stop on failure. */
  async function onServer(body: Parameters<typeof editSentScan>[0]): Promise<boolean> {
    setBusy(true);
    try {
      const r = await editSentScan(body);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      /**
       * MIRROR THE CHANGE ONTO THE LOCAL COPY.
       *
       * `refresh()` only refetches the bootstrap — it does not touch the
       * outbox, and History is built entirely from the outbox. Without this
       * the server has the new value and the phone shows the old one for
       * ever: flip a sent bottle to RETURN, get "Saved", and watch the row
       * still read "out" after a restart, because the outbox is persisted to
       * SQLite. The phone is not the source of truth here, but it is the
       * screen the driver is looking at.
       */
      dispatch({ type: 'APPLY_SERVER_EDIT', ...serverEditToLocal(body) });
      await refresh().catch(() => {});
      Alert.alert('Saved', r.message);
      return true;
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not change it', e?.message ?? 'Try again when you have signal.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The server call, expressed as what it means to this phone's own copy. */
  function serverEditToLocal(body: Parameters<typeof editSentScan>[0]) {
    switch (body.action) {
      case 'mode':
        return { orderNumber: body.orderNumber, barcode: body.barcode, mode: body.value as 'SHIP' | 'RETURN' };
      case 'void':
        return { orderNumber: body.orderNumber, barcode: body.barcode, drop: true };
      case 'order':
        return { orderNumber: body.orderNumber, toOrderNumber: body.value };
      case 'customer':
        return { orderNumber: body.orderNumber, toCustomerListId: body.value };
      default:
        return { orderNumber: body.orderNumber };
    }
  }

  function flip(s: (typeof rows)[number]) {
    const to = s.mode === 'SHIP' ? 'RETURN' : 'SHIP';
    if (s.state === 'QUEUED') {
      dispatch({ type: 'TOGGLE', orderNumber, barcode: s.barcode, mode: to });
      Haptics.selectionAsync();
      return;
    }
    const why = needReason();
    if (!why) return;
    onServer({ action: 'mode', orderNumber, barcode: s.barcode, mode: s.mode, value: to, reason: why });
  }

  function remove(s: (typeof rows)[number]) {
    if (s.state === 'QUEUED') {
      dispatch({ type: 'REMOVE', clientId: s.clientId });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    const why = needReason();
    if (!why) return;
    Alert.alert(
      `Remove ${s.barcode}?`,
      'It stays on the record as withdrawn, with your reason, and stops counting on this order.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: () => onServer({
            action: 'void', orderNumber, barcode: s.barcode, mode: s.mode, reason: why,
          }),
        },
      ],
    );
  }

  function retagOrder() {
    const to = orderDraft.trim().toUpperCase();
    if (!to || to === orderNumber) return;

    // ASKED BEFORE, NOT INFERRED AFTER. The previous version dispatched and
    // then guessed from the resulting state whether the move had been
    // refused — a guess that was true in every case including the refusal,
    // so the refusal path was dead code and forty bottles could stay on the
    // wrong order behind a success haptic.
    const blocker = retagBlockedBy(outbox, orderNumber, to);
    if (blocker) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Cannot move it there',
        `${blocker} is already on ${to} on this phone. Sort that order out first.`,
      );
      return;
    }

    const queued = rows.filter((s) => s.state === 'QUEUED');
    if (queued.length && !anySent) {
      dispatch({ type: 'RETAG', orderNumber, toOrderNumber: to });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/order/${encodeURIComponent(to)}` as never);
      return;
    }

    const why = needReason();
    if (!why) return;
    // Only navigate if the server actually took it. `onServer` swallows its
    // error to show an alert, so a bare .then() used to march the driver to an
    // empty new-order screen straight after "Could not change it".
    onServer({ action: 'order', orderNumber, value: to, reason: why }).then((ok) => {
      if (!ok) return;
      // The scans that had not gone up yet are still local and still carry the
      // old number — the server only moved its own rows. Without this the
      // order ends up split across two numbers.
      if (queued.length) dispatch({ type: 'RETAG', orderNumber, toOrderNumber: to });
      router.replace(`/order/${encodeURIComponent(to)}` as never);
    });
  }

  const field = {
    height: 50, borderRadius: T.radiusSm, paddingHorizontal: 14,
    color: T.ink, fontSize: 15.5,
    backgroundColor: tint(0.05), borderWidth: 1, borderColor: T.rule,
  } as const;

  const Line = ({ s }: { s: (typeof rows)[number] }) => {
    const known = boot?.assets[s.barcode];
    return (
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingHorizontal: 15, paddingVertical: 12,
        borderTopWidth: 1, borderTopColor: T.soft,
      }}>
        <View style={{ flex: 1 }}>
          <Text style={[mono(14.5, '600'), { color: T.ink }]}>{s.barcode}</Text>
          <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
            {known?.p ?? 'not in the system'} · {s.state === 'SENT' ? 'on server' : 'on phone'}
          </Text>
        </View>
        {!known && <Tag label="UNKNOWN" tone={T.amber} />}
        <Pressable onPress={() => flip(s)} hitSlop={10} disabled={busy}
                   accessibilityRole="button"
                   accessibilityLabel={`Change ${s.barcode} to ${s.mode === 'SHIP' ? 'came back' : 'went out'}`}>
          <Text style={{ color: T.brandLit, fontSize: 12.5, fontWeight: '700' }}>
            {s.mode === 'SHIP' ? '→ back' : '→ out'}
          </Text>
        </Pressable>
        <Pressable onPress={() => remove(s)} hitSlop={10} disabled={busy}
                   accessibilityRole="button" accessibilityLabel={`Remove ${s.barcode}`}>
          <Icon name="x" size={ICON.md} color={T.needle} />
        </Pressable>
      </View>
    );
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: bottom + 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ marginBottom: 10 }}>
          <Text style={{ color: T.faint, fontSize: 13 }}>← History</Text>
        </Pressable>

        <Rise>
          <Text style={[mono(27, '700'), { color: T.ink, letterSpacing: -0.6 }]}>{orderNumber}</Text>
          <Text style={{ color: T.faint, fontSize: 14, marginTop: 5 }}>{customer}</Text>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 10 }}>
            <Text style={[mono(13.5, '700'), { color: ship.length ? T.amber : T.faint }]}>
              {ship.length} out
            </Text>
            <Text style={[mono(13.5, '700'), { color: ret.length ? T.bottle : T.faint }]}>
              {ret.length} back
            </Text>
          </View>
        </Rise>

        {/* The reason box only exists when there is something on the server to
            justify. A driver fixing a load they have not uploaded yet should
            not be asked to explain themselves to a customer who has not been
            told anything. */}
        {anySent && (
          <Rise delay={50} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 9 }}>Why</Eyebrow>
            <TextInput
              value={reason} onChangeText={setReason}
              placeholder="Scanned against the wrong order — checked with the yard."
              placeholderTextColor={T.faint}
              style={[field, { height: 56 }]}
              multiline
            />
            <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 6, lineHeight: 16 }}>
              Needed for anything already on the server. The customer sees this next
              to the change.
            </Text>
          </Rise>
        )}

        {ship.length > 0 && (
          <Rise delay={40} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 9 }}>Went out · {ship.length}</Eyebrow>
            <Surface>{ship.map((s) => <Line key={s.clientId} s={s} />)}</Surface>
          </Rise>
        )}

        {ret.length > 0 && (
          <Rise delay={40} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 9 }}>Came back · {ret.length}</Eyebrow>
            <Surface>{ret.map((s) => <Line key={s.clientId} s={s} />)}</Surface>
          </Rise>
        )}

        <Rise delay={40} style={{ marginTop: 26 }}>
          {!showRetag ? (
            <Pressable onPress={() => setShowRetag(true)} hitSlop={10}>
              <Text style={{ color: T.brandLit, fontSize: 13.5, fontWeight: '700' }}>
                Change the order number
              </Text>
            </Pressable>
          ) : (
            <>
              <Eyebrow style={{ marginBottom: 9 }}>Order number</Eyebrow>
              <TextInput
                value={orderDraft} onChangeText={(v) => setOrderDraft(v.toUpperCase())}
                autoCapitalize="characters" autoCorrect={false}
                style={[field, mono(15.5, '600')]}
              />
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 6, lineHeight: 16 }}>
                Moves every scan on this order, not just one.
              </Text>
              <Btn
                label="Move them"
                variant="ghost"
                style={{ marginTop: 12 }}
                disabled={busy || !orderDraft.trim() || orderDraft.trim().toUpperCase() === orderNumber}
                onPress={retagOrder}
              />
            </>
          )}
        </Rise>

        {rows.some((s) => s.state !== 'SENT') && (
          <Rise delay={40} style={{ marginTop: 26 }}>
            <Btn label="Upload this phone's scans" variant="ghost" busy={busy}
                 onPress={() => { setBusy(true); sync().finally(() => setBusy(false)); }} />
          </Rise>
        )}

        {busy && (
          <View style={{ marginTop: 18, alignItems: 'center' }}>
            <ActivityIndicator color={T.brandLit} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
