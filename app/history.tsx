import { View, Text, FlatList, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { T, Screen, Rise, Icon, ICON, mono, tint } from '@/ui';

/**
 * Every scan this phone has made — BY ORDER, because that is the unit of work.
 *
 * This used to be a flat list of individual beeps grouped by day, which is the
 * shape the data happens to have and not the shape anybody thinks in. A driver
 * does not remember "that bottle at 14:32"; they remember "the Acme drop this
 * morning", and the question they arrive with is about the whole of it — did
 * that order go up, was it against the right customer, why does it say six out
 * when I loaded five. A per-beep list cannot answer any of those without the
 * reader doing the grouping in their head, forty rows at a time.
 *
 * So an order is one row: who it was for, how many went out and came back, and
 * whether it has reached the server. Tapping it opens the order, where every
 * one of those things can be changed — see app/order/[orderNumber].tsx. The
 * individual scans are still all there, one level in, which is where a detail
 * belongs.
 *
 * Still reads only from the outbox, so it still works with no signal. History
 * is what THIS PHONE did; the console's Scanned Orders is what the company
 * did, and those are different questions.
 */
export default function History() {
  const router = useRouter();
  const { boot, outbox } = useStore();

  const nameBy = new Map((boot?.customers ?? []).map((c) => [c.customerListId, c.name]));

  const byOrder = new Map<string, {
    orderNumber: string; customerListId: string;
    ship: number; ret: number; pending: number; last: string;
  }>();
  for (const s of outbox.scans) {
    const g = byOrder.get(s.orderNumber) ?? {
      orderNumber: s.orderNumber, customerListId: s.customerListId,
      ship: 0, ret: 0, pending: 0, last: s.scannedAt,
    };
    if (s.mode === 'SHIP') g.ship++; else g.ret++;
    if (s.state !== 'SENT') g.pending++;
    if (s.scannedAt > g.last) g.last = s.scannedAt;
    byOrder.set(s.orderNumber, g);
  }

  // Newest activity first — the order somebody is asking about is almost
  // always the one they just finished.
  const orders = [...byOrder.values()].sort((a, b) => b.last.localeCompare(a.last));
  const unsent = outbox.scans.filter((s) => s.state !== 'SENT').length;

  return (
    <Screen intensity={0.7}>
      <View style={{ flex: 1, paddingHorizontal: 18, paddingTop: 14 }}>
        <Rise>
          <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1.1 }}>
            History
          </Text>
          <Text style={{ color: T.faint, fontSize: 13, marginTop: 4 }}>
            {orders.length} order{orders.length === 1 ? '' : 's'} on this phone
            {unsent ? ` · ${unsent} scan${unsent === 1 ? '' : 's'} not uploaded` : ' · all on the server'}
          </Text>
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
            Tap an order to change what went out, what came back, the order number
            or the customer.
          </Text>
        </Rise>

        {orders.length === 0 ? (
          <Rise delay={60} style={{ marginTop: 26 }}>
            <Text style={{ color: T.ink, fontSize: 15, fontWeight: '600' }}>Nothing scanned yet</Text>
            <Text style={{ color: T.faint, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
              The moment you scan an order, every beep lands here — even with no signal,
              even after it uploads.
            </Text>
          </Rise>
        ) : (
          <FlatList
            style={{ marginTop: 14 }}
            contentContainerStyle={{ paddingBottom: 44 }}
            data={orders}
            keyExtractor={(g) => g.orderNumber}
            ItemSeparatorComponent={() => (
              <View style={{ height: 1, backgroundColor: tint(0.05) }} />
            )}
            renderItem={({ item: g }) => (
              <Pressable
                // `as never` is this codebase's established spelling for a
                // dynamic route — typedRoutes only knows the literals it
                // generated, and every other push here does the same.
                onPress={() => router.push(`/order/${encodeURIComponent(g.orderNumber)}` as never)}
                accessibilityRole="button"
                accessibilityLabel={`Order ${g.orderNumber}, ${g.ship} out, ${g.ret} back`}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingVertical: 14, paddingHorizontal: 4,
                  backgroundColor: pressed ? tint(0.05) : 'transparent',
                  borderRadius: T.radiusSm,
                })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[mono(15.5, '700'), { color: T.ink }]} numberOfLines={1}>
                    {g.orderNumber}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 3 }} numberOfLines={1}>
                    {nameBy.get(g.customerListId) ?? g.customerListId ?? 'no customer'}
                  </Text>
                  {/* Out and back are the two numbers this whole app is about,
                      so they get their own line rather than a badge in a
                      corner. Greyed when zero: "0 back" in green reads as a
                      result, and it is the absence of one. */}
                  <View style={{ flexDirection: 'row', gap: 14, marginTop: 7 }}>
                    <Text style={[mono(12.5, '700'), { color: g.ship ? T.amber : T.faint }]}>
                      {g.ship} out
                    </Text>
                    <Text style={[mono(12.5, '700'), { color: g.ret ? T.bottle : T.faint }]}>
                      {g.ret} back
                    </Text>
                  </View>
                </View>

                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={[mono(12), { color: T.steel }]}>
                    {dayLabel(g.last.slice(0, 10))} {g.last.slice(11, 16)}
                  </Text>
                  <Text style={{
                    fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4,
                    color: g.pending ? T.amber : T.bottle,
                  }}>
                    {g.pending ? `${g.pending} ON PHONE` : 'ON SERVER'}
                  </Text>
                </View>
                <Icon name="chevron-right" size={ICON.md} color={T.faint} />
              </Pressable>
            )}
          />
        )}
      </View>
    </Screen>
  );
}

function dayLabel(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yest) return 'Yesterday';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
