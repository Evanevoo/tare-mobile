import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useStore } from '@/store';
import { retagBlockedBy, type QueuedScan } from '@/outbox';
import { decodeParam } from '@/route-param';
import { editSentScan, fetchOrderDetail, type RemoteOrder } from '@/api';
import { classify } from '@/scan-match';
import { ulid } from '@/ulid';
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
  // decodeParam, not a bare decodeURIComponent: an order number carrying a
  // literal '%' (a customer-card scan — SCANIFIED-MOBILE-7) made the bare
  // call throw fatally on first render, killing the app on every tap of
  // that order. src/route-param.ts carries the full story.
  const orderNumber = decodeParam(params.orderNumber);
  const router = useRouter();
  const bottom = useBottomInset(24);

  const { boot, outbox, dispatch, sync, refresh } = useStore();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [orderDraft, setOrderDraft] = useState(orderNumber);
  const [showRetag, setShowRetag] = useState(false);

  /**
   * WHEN THIS PHONE HAS NOTHING, ASK THE LEDGER.
   *
   * The outbox only ever has scans this phone queued or sent. Most orders in
   * History were never touched by this phone at all, so before this the
   * screen had nothing to fall back to but a dead end and a pointer to the
   * console. This fetches the order from the server the moment the outbox
   * comes up empty — the same record a manager could already reach from a
   * desk, just reachable from the truck now too, regardless of which phone
   * did the original scanning.
   */
  const [remote, setRemote] = useState<RemoteOrder | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  /**
   * THE OTHER WAY TO PICK THE WRONG CUSTOMER.
   *
   * `retagOrder` below existed for a fat-fingered order number; there was
   * nothing here for a fat-fingered customer, even though the server has
   * always accepted `action: 'customer'` (api/mobile/scan-edit) and the
   * outbox reducer has always accepted `toCustomerListId` (RETAG). A driver
   * who picked the wrong name off Delivery's list — an easy mistake between
   * two similarly named accounts on the same street — had to find someone at
   * a desk to fix it, same as before this screen let you fix an order number
   * from the truck. This closes that gap the same way: search, pick, confirm.
   */
  const [showRecustomer, setShowRecustomer] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custPick, setCustPick] = useState<{ id: string; name: string } | null>(null);

  /**
   * ADD A BOTTLE THAT NEVER WENT THROUGH THE SCAN LOOP.
   *
   * Missed on the truck, found under a seat after the delivery closed, or
   * corrected off a phone call from the customer — none of those go through
   * scan.tsx, because scan.tsx only exists while a delivery is open and this
   * order may not be. This is the same "type a barcode by hand" idea that
   * screen already has, aimed at an order that already exists instead of the
   * one currently in progress.
   */
  const [showAdd, setShowAdd] = useState(false);
  const [addCode, setAddCode] = useState('');
  const [addMode, setAddMode] = useState<'SHIP' | 'RETURN'>('SHIP');

  const rows = outbox.scans.filter((s) => s.orderNumber === orderNumber);

  useEffect(() => {
    if (rows.length || remoteStatus !== 'idle') return;
    setRemoteStatus('loading');
    fetchOrderDetail(orderNumber)
      .then((r) => { setRemote(r); setRemoteStatus('done'); })
      .catch(() => setRemoteStatus('error'));
    // Only the outbox's own emptiness and the order number decide whether to
    // ask — re-running this on every render would refetch on each keystroke
    // elsewhere on this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderNumber, rows.length]);

  /**
   * WHAT THE SCREEN ACTUALLY EDITS.
   *
   * Local rows always speak for themselves — this phone's own unsent or
   * just-sent work, and the whole point of the outbox is that nothing else
   * gets to override it. The server's copy used to fill the screen ONLY when
   * the outbox was completely silent on this order, on the assumption that
   * any local row meant this phone had done the whole order itself. Adding a
   * bottle from THIS screen breaks that assumption on purpose — a driver
   * fixing one missed bottle on an order three other phones scanned does not
   * mean this phone suddenly knows the other twenty. So the two are merged:
   * every local row, plus whatever the server has that this phone's outbox
   * does not already carry for the same barcode and direction. Fetched the
   * same as before — only asked for when the outbox starts out silent — so
   * an order this phone scanned in full still never spends a request on it.
   */
  const remoteOnly = (remote?.scans ?? [])
    .filter((s) => !rows.some((r) => r.barcode === s.barcode && r.mode === s.mode))
    .map((s) => ({
      clientId: `remote:${s.barcode}:${s.mode}`,
      orderNumber,
      barcode: s.barcode,
      mode: s.mode,
      customerListId: remote?.customerListId ?? '',
      scannedAt: s.scannedAt,
      lat: null, lng: null, accuracyM: null,
      state: 'SENT' as const,
      scannedBy: s.scannedBy,
    }));
  const effectiveRows: (QueuedScan & { scannedBy?: string | null })[] = [...rows, ...remoteOnly];

  const nameBy = new Map((boot?.customers ?? []).map((c) => [c.customerListId, c.name]));
  const listId = effectiveRows[0]?.customerListId ?? '';
  const customer = nameBy.get(listId) ?? listId ?? 'no customer';

  const custMatches = useMemo(() => {
    const n = custQuery.trim().toLowerCase();
    if (!n) return [];
    return (boot?.customers ?? [])
      .filter((c) => !c.tmp && c.customerListId !== listId && (
        c.name.toLowerCase().includes(n) || c.customerListId.toLowerCase().includes(n)
      ))
      .slice(0, 8);
  }, [boot, custQuery, listId]);

  const ship = effectiveRows.filter((s) => s.mode === 'SHIP');
  const ret = effectiveRows.filter((s) => s.mode === 'RETURN');
  const anySent = effectiveRows.some((s) => s.state === 'SENT');

  // Still waiting on the ledger's answer — only reachable once, since the
  // effect above never fires again for the same order once it leaves 'idle'.
  if (remoteStatus === 'loading' && !rows.length) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={T.brandLit} />
        </View>
      </Screen>
    );
  }

  if (!effectiveRows.length) {
    /* History lists the whole company now, so most of what it shows was
       scanned somewhere else. The outbox has neither for this order, and now
       neither does the ledger — either the server could not be reached, or
       this order genuinely has nothing on it anywhere. */
    const unreachable = remoteStatus === 'error';
    return (
      <Screen>
        <View style={{ flex: 1, padding: 22, justifyContent: 'center' }}>
          <Text style={{ color: T.ink, fontSize: 17, fontWeight: '700' }}>Nothing here to change</Text>
          <Text style={{ color: T.faint, fontSize: 14, marginTop: 8, lineHeight: 20 }}>
            {unreachable
              ? `Could not reach the server to look up ${orderNumber}. Check your signal and try again.`
              : `${orderNumber} has no scans on it — not on this phone, and not on the server.`}
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

  function flip(s: (typeof effectiveRows)[number]) {
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

  function remove(s: (typeof effectiveRows)[number]) {
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

  /**
   * ENQUEUE DIRECTLY, NOT addScan().
   *
   * addScan() on the store only ever files against whatever delivery is
   * CURRENTLY open (store.orderNumber) — it has no way to target an
   * arbitrary order, and this screen's order is almost always a different
   * one, often nobody's open delivery at all. ENQUEUE is the same action the
   * store's own addScan dispatches under the hood; this just builds the scan
   * by hand and points it at the order this screen is actually looking at.
   */
  function addBottle() {
    const barcode = addCode.trim().toUpperCase();
    if (!barcode) return;

    // Same guard scan.tsx's own take() applies: a customer card scanned by
    // reflex must not queue as a cylinder.
    const target = classify(barcode, boot);
    if (target?.kind === 'customer') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('That looks like a customer card', 'Type or scan the bottle’s own barcode, not the customer’s.');
      return;
    }

    // Already on this order in the same direction, whether this phone queued
    // it or the server already has it — nothing to add.
    const localDup = outbox.scans.some(
      (s) => s.orderNumber === orderNumber && s.barcode === barcode
        && s.mode === addMode && s.state !== 'SENT');
    const remoteDup = remote?.scans.some((s) => s.barcode === barcode && s.mode === addMode);
    if (localDup || remoteDup) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Already on this order',
        `${barcode} is already recorded as ${addMode === 'SHIP' ? 'out' : 'back'} on ${orderNumber}.`,
      );
      return;
    }

    dispatch({
      type: 'ENQUEUE',
      scan: {
        clientId: ulid(),
        orderNumber,
        barcode,
        mode: addMode,
        customerListId: listId,
        scannedAt: new Date().toISOString(),
        lat: null, lng: null, accuracyM: null,
        state: 'QUEUED',
      },
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAddCode('');
    setShowAdd(false);
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

    const queued = effectiveRows.filter((s) => s.state === 'QUEUED');
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

  /** Same shape as retagOrder above, one field over: customerListId instead of orderNumber. */
  function retagCustomer() {
    if (!custPick || custPick.id === listId) return;
    const to = custPick.id;

    const done = () => {
      setShowRecustomer(false);
      setCustPick(null);
      setCustQuery('');
    };

    const queued = effectiveRows.filter((s) => s.state === 'QUEUED');
    if (queued.length && !anySent) {
      dispatch({ type: 'RETAG', orderNumber, toCustomerListId: to });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      done();
      return;
    }

    const why = needReason();
    if (!why) return;
    onServer({ action: 'customer', orderNumber, value: to, reason: why }).then((ok) => {
      if (!ok) return;
      // Mirrors retagOrder: the server only rewrote its own SENT rows, so
      // anything still QUEUED on this phone needs the same change applied
      // locally or it stays billed to the old account until the next sync.
      if (queued.length) dispatch({ type: 'RETAG', orderNumber, toCustomerListId: to });
      done();
    });
  }

  const field = {
    minHeight: 50, borderRadius: T.radiusSm, paddingHorizontal: 14,
    color: T.ink, fontSize: 15.5,
    backgroundColor: tint(0.05), borderWidth: 1, borderColor: T.rule,
  } as const;

  const Line = ({ s }: { s: (typeof effectiveRows)[number] }) => {
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
            {s.scannedBy ? ` · ${s.scannedBy}` : ''}
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

        <Rise delay={40} style={{ marginTop: 22 }}>
          {!showAdd ? (
            <Pressable onPress={() => setShowAdd(true)} hitSlop={10}
                       accessibilityRole="button"
                       accessibilityLabel="Add a bottle to this order">
              <Text style={{ color: T.brandLit, fontSize: 13.5, fontWeight: '700' }}>
                Add a bottle
              </Text>
            </Pressable>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <Eyebrow>Add a bottle</Eyebrow>
                <Pressable onPress={() => { setShowAdd(false); setAddCode(''); }} hitSlop={12}
                           accessibilityRole="button"
                           accessibilityLabel="Cancel adding a bottle">
                  <Text style={{ color: T.faint, fontSize: 12.5, fontWeight: '700' }}>Cancel</Text>
                </Pressable>
              </View>
              <Text style={{ color: T.faint, fontSize: 11.5, marginBottom: 12, lineHeight: 16 }}>
                For one that never went through the scan loop — missed on the truck, or found
                after the fact. Typed, not scanned.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                {(['SHIP', 'RETURN'] as const).map((m) => {
                  const on = addMode === m;
                  return (
                    <Pressable
                      key={m}
                      onPress={() => { setAddMode(m); Haptics.selectionAsync(); }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={m === 'SHIP' ? 'Went out' : 'Came back'}
                      style={{
                        flex: 1, minHeight: 48, borderRadius: T.radiusSm,
                        alignItems: 'center', justifyContent: 'center',
                        borderWidth: on ? 2 : 1,
                        borderColor: on ? T.brandLit : T.rule,
                        backgroundColor: on ? tint(0.1) : 'transparent',
                      }}
                    >
                      <Text style={{
                        color: on ? T.ink : T.faint,
                        fontSize: 14, fontWeight: on ? '800' : '600',
                      }}>
                        {m === 'SHIP' ? 'Went out' : 'Came back'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={addCode} onChangeText={(v) => setAddCode(v.toUpperCase())}
                autoCapitalize="characters" autoCorrect={false}
                placeholder="PW-K-041827" placeholderTextColor={T.faint}
                style={[field, mono(15.5, '600')]}
                onSubmitEditing={addBottle}
              />
              <Btn
                label="Add"
                variant="ghost"
                style={{ marginTop: 12 }}
                disabled={busy || !addCode.trim()}
                onPress={addBottle}
              />
            </>
          )}
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
          {/* A toggle, not a one-way door. This used to only ever open —
              setShowRetag(false) appeared nowhere — so one stray tap left the
              form on screen for the rest of the visit. Wayfinding asks every
              screen to answer "how do I get out?"; the answer here is the
              same control that got you in. */}
          {!showRetag ? (
            <Pressable onPress={() => setShowRetag(true)} hitSlop={10}
                       accessibilityRole="button"
                       accessibilityLabel="Change the order number">
              <Text style={{ color: T.brandLit, fontSize: 13.5, fontWeight: '700' }}>
                Change the order number
              </Text>
            </Pressable>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <Eyebrow>Order number</Eyebrow>
                <Pressable onPress={() => { setShowRetag(false); setOrderDraft(orderNumber); }} hitSlop={12}
                           accessibilityRole="button"
                           accessibilityLabel="Cancel changing the order number">
                  <Text style={{ color: T.faint, fontSize: 12.5, fontWeight: '700' }}>Cancel</Text>
                </Pressable>
              </View>
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

        <Rise delay={40} style={{ marginTop: 26 }}>
          {!showRecustomer ? (
            <Pressable onPress={() => setShowRecustomer(true)} hitSlop={10}
                       accessibilityRole="button"
                       accessibilityLabel="Change the customer">
              <Text style={{ color: T.brandLit, fontSize: 13.5, fontWeight: '700' }}>
                Change the customer
              </Text>
            </Pressable>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <Eyebrow>Customer</Eyebrow>
                <Pressable onPress={() => { setShowRecustomer(false); setCustPick(null); setCustQuery(''); }} hitSlop={12}
                           accessibilityRole="button"
                           accessibilityLabel="Cancel changing the customer">
                  <Text style={{ color: T.faint, fontSize: 12.5, fontWeight: '700' }}>Cancel</Text>
                </Pressable>
              </View>
              {custPick ? (
                <Pressable
                  onPress={() => { setCustPick(null); setCustQuery(''); }}
                  style={[field, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
                >
                  <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '600' }}>{custPick.name}</Text>
                  <Text style={{ color: T.faint, fontSize: 12.5 }}>change</Text>
                </Pressable>
              ) : (
                <>
                  <TextInput
                    value={custQuery} onChangeText={setCustQuery}
                    placeholder="Search customers…" placeholderTextColor={T.faint}
                    autoCorrect={false} autoCapitalize="none"
                    style={field}
                  />
                  {custMatches.map((c) => (
                    <Pressable
                      key={c.customerListId}
                      onPress={() => setCustPick({ id: c.customerListId, name: c.name })}
                      style={({ pressed }) => ({
                        paddingHorizontal: 14, paddingVertical: 12,
                        borderBottomWidth: 1, borderBottomColor: T.soft,
                        backgroundColor: pressed ? tint(0.05) : 'transparent',
                      })}
                    >
                      <Text style={{ color: T.ink, fontSize: 14.5, fontWeight: '600' }}>{c.name}</Text>
                      <Text style={[mono(11.5, '500'), { color: T.faint, marginTop: 2 }]}>
                        {c.customerListId}
                      </Text>
                    </Pressable>
                  ))}
                  {custQuery.trim() && !custMatches.length && (
                    <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 8 }}>No customers match.</Text>
                  )}
                </>
              )}
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 6, lineHeight: 16 }}>
                Moves every scan on this order onto the account you pick.
              </Text>
              <Btn
                label="Move them"
                variant="ghost"
                style={{ marginTop: 12 }}
                disabled={busy || !custPick}
                onPress={retagCustomer}
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
