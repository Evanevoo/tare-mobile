import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { fetchHistory, HISTORY_PAGE } from '@/api';
import { cacheGet, cacheSet } from '@/db';
import {
  appendPage, mergeHistory, offlineNotice,
  type CachedHistory, type ServerOrder,
} from '@/history';
import { T, Screen, Rise, Icon, ICON, mono, tint } from '@/ui';
import { Note } from '@/form';
import { whenLabel } from '@/when';

/**
 * WHAT THE COMPANY SCANNED — not what this handset happens to remember.
 *
 * The owner's words were that history was disappearing. It was not: every scan
 * is on the server and none of them are voided. This screen was built entirely
 * out of the outbox, and its own doc comment said so — "History is what THIS
 * PHONE did" — so a reinstall, a spare handset or a new build opened on an
 * empty list. Nothing had gone anywhere; the screen simply could not see it.
 *
 * So the list comes down from the server, newest first, and what this phone
 * has not managed to upload yet is merged into it and marked. The merge itself
 * is in src/history.ts, pure and tested, because that is where the mistakes
 * would live: one order drawn as two rows, or a scan counted once by the
 * server and once again by the phone.
 *
 * BOUNDED TO THE LAST 24 HOURS, ON PURPOSE — Evan's own instruction. The
 * server (api/mobile/history) only groups scans from the rolling last day, so
 * this is deliberately not a full ledger a driver can scroll back through
 * forever; "Show older orders" below only reaches as far back as that window
 * goes and then stops, which is correct, not a bug. Anything further back
 * lives in the console's Scanned Orders page.
 *
 * IT STILL WORKS WITH NO SIGNAL, WHICH IS THE POINT. A yard with no bars is
 * the ordinary case, not the edge case. The last page that arrived is kept on
 * disk, shown when the fetch fails, and labelled with when it came down — the
 * screen never claims to be current when it is not, and it never puts a status
 * code in front of a driver.
 */
export default function History() {
  const router = useRouter();
  const { boot, outbox, email } = useStore();

  /** The server's page, as far as it has been scrolled. */
  const [orders, setOrders] = useState<ServerOrder[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  /** When what is on screen came down. Null means it never has. */
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paging, setPaging] = useState(false);

  /** A driver who backs out mid-fetch must not land a setState on a dead screen. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /**
   * The first page, and the same call again on a pull.
   *
   * A failure is not reported as a failure. What was already on screen — the
   * cache, or the page from before the truck went under the bridge — stays
   * exactly where it is, and the notice at the top says when it came down.
   */
  const load = useCallback(async (pull: boolean) => {
    if (pull) setRefreshing(true);
    try {
      const page = await fetchHistory({ limit: HISTORY_PAGE });
      if (!alive.current) return;
      const fresh: CachedHistory = {
        orders: page.orders ?? [],
        nextBefore: page.nextBefore ?? null,
        fetchedAt: new Date().toISOString(),
      };
      setOrders(fresh.orders);
      setNextBefore(fresh.nextBefore);
      setFetchedAt(fresh.fetchedAt);
      setOffline(false);
      // Only the newest page is kept. Older pages are a scroll, not a shift's
      // work, and a driver reopening the app wants the top of the list.
      cacheSet('history', fresh).catch(() => {});
    } catch {
      if (alive.current) setOffline(true);
    } finally {
      if (alive.current) { setRefreshing(false); setLoading(false); }
    }
  }, []);

  /**
   * What was on disk goes up first, then the network is asked.
   *
   * In that order deliberately: the driver sees a list in the time it takes to
   * read SQLite rather than watching a spinner decide whether there is signal.
   * If the fetch lands, it replaces this; if it does not, this is what stays.
   */
  useEffect(() => {
    let live = true;
    (async () => {
      const cached = await cacheGet<CachedHistory>('history');
      if (live && cached && Array.isArray(cached.orders)) {
        setOrders(cached.orders);
        setNextBefore(cached.nextBefore ?? null);
        setFetchedAt(cached.fetchedAt ?? null);
      }
      if (live) await load(false);
    })();
    return () => { live = false; };
  }, [load]);

  /** The next page down, asked for when the driver reaches the bottom. */
  const more = useCallback(async () => {
    if (paging || refreshing || !nextBefore) return;
    setPaging(true);
    try {
      const page = await fetchHistory({ limit: HISTORY_PAGE, before: nextBefore });
      if (!alive.current) return;
      // appendPage rather than a spread: `before` is a timestamp, so an order
      // scanned while the driver was scrolling can come back on both sides of
      // a page boundary, and the same order twice reads as a doubled delivery.
      setOrders((have) => appendPage(have, page.orders ?? []));
      setNextBefore(page.nextBefore ?? null);
      setOffline(false);
    } catch {
      if (alive.current) setOffline(true);
    } finally {
      if (alive.current) setPaging(false);
    }
  }, [nextBefore, paging, refreshing]);

  const names = useMemo(
    () => new Map((boot?.customers ?? []).map((c) => [c.customerListId, c.name] as const)),
    [boot?.customers],
  );

  const rows = useMemo(
    () => mergeHistory(orders, outbox.scans, { names, me: boot?.user?.name || email }),
    [orders, outbox.scans, names, boot?.user?.name, email],
  );

  const unsent = outbox.scans.filter((s) => s.state !== 'SENT').length;

  const header = (
    <Rise>
      <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1 }}>
        History
      </Text>
      <Text style={{ color: T.faint, fontSize: 13, marginTop: 4 }}>
        {rows.length} order{rows.length === 1 ? '' : 's'} · last 24 hours, everybody
        {unsent ? ` · ${unsent} scan${unsent === 1 ? '' : 's'} still on this phone` : ''}
      </Text>
      <Text style={{ color: T.faint, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
        The whole company&apos;s scans from the last 24 hours, with anything this phone
        has not uploaded merged in and marked. Tap one to change what went out, what came
        back, the order number or the customer.
      </Text>
      {offline && <Note icon="wifi-off" tone={T.amber} text={offlineNotice(fetchedAt)} />}
    </Rise>
  );

  /**
   * The bottom of the list.
   *
   * onEndReached does the paging, and this button does it again by hand —
   * onEndReached is not reliably fired on a short list or after a fast fling
   * on Android, and a driver who cannot reach last Tuesday concludes last
   * Tuesday is gone. It is one full-width control, so nothing to wrap.
   */
  const footer = (
    <View style={{ paddingVertical: 22, alignItems: 'center' }}>
      {paging ? (
        <ActivityIndicator color={T.brandLit} />
      ) : nextBefore ? (
        <Pressable
          onPress={() => { void more(); }}
          accessibilityRole="button"
          accessibilityLabel="Show older orders"
          style={{
            minHeight: 48, paddingHorizontal: 18, justifyContent: 'center',
            borderRadius: T.radiusSm, borderWidth: 1, borderColor: tint(0.12),
            backgroundColor: tint(0.05),
          }}
        >
          <Text style={{ color: T.brandLit, fontSize: 14, fontWeight: '700' }}>
            Show older orders
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  const emptyState = (
    <View style={{ marginTop: 26 }}>
      {loading ? (
        <ActivityIndicator color={T.brandLit} />
      ) : (
        <>
          <Text style={{ color: T.ink, fontSize: 15, fontWeight: '600' }}>
            Nothing scanned yet
          </Text>
          <Text style={{ color: T.faint, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
            The moment anybody in the company scans an order it lands here. What this phone
            scans shows up straight away, signal or not.
          </Text>
        </>
      )}
    </View>
  );

  return (
    <Screen intensity={0.7}>
      <View style={{ flex: 1, paddingHorizontal: 18, paddingTop: 14 }}>
        <FlatList
          data={rows}
          keyExtractor={(g) => g.orderNumber}
          ListHeaderComponent={header}
          ListEmptyComponent={emptyState}
          ListFooterComponent={rows.length ? footer : null}
          contentContainerStyle={{ paddingBottom: 44 }}
          onEndReached={() => { void more(); }}
          onEndReachedThreshold={0.6}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: tint(0.05) }} />
          )}
          refreshControl={
            /* Every colour spelled out. Android draws this in its own theme
               otherwise — a dark arrow on a white disc, which on this screen
               is a white dot nobody can see is spinning — and it ignores
               tintColor entirely, which is the prop iOS reads. Both, or it is
               invisible on the phones the drivers actually carry. */
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { void load(true); }}
              tintColor={T.brandLit}
              colors={[T.brandLit]}
              progressBackgroundColor={T.panelBot}
            />
          }
          renderItem={({ item: g }) => {
            /* Three states, and the difference matters to somebody deciding
               whether to go back out to the truck. Not uploaded is work this
               phone is still holding; on-this-phone-only is an order the
               server has not sent us — usually because it is older than the
               page in hand — and neither is "on the server". */
            const badge = g.pending
              ? { text: `${g.pending} NOT UPLOADED`, tone: T.amber }
              : g.onlyOnPhone
                ? { text: 'ON THIS PHONE ONLY', tone: T.steel }
                : { text: 'ON SERVER', tone: T.bottle };

            return (
              <Pressable
                // `as never` is this codebase's established spelling for a
                // dynamic route — typedRoutes only knows the literals it
                // generated, and every other push here does the same.
                onPress={() => router.push(`/order/${encodeURIComponent(g.orderNumber)}` as never)}
                accessibilityRole="button"
                accessibilityLabel={`Order ${g.orderNumber}, ${g.ship} out, ${g.ret} back, ${badge.text.toLowerCase()}`}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingVertical: 14, paddingHorizontal: 4,
                  backgroundColor: pressed ? tint(0.05) : 'transparent',
                  borderRadius: T.radiusSm,
                })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[mono(16, '700'), { color: T.ink }]} numberOfLines={1}>
                    {g.orderNumber}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 13, marginTop: 3 }} numberOfLines={1}>
                    {g.customerName || 'no customer'}
                  </Text>
                  {/* Out and back are the two numbers this whole app is about,
                      so they get their own line rather than a badge in a
                      corner. Greyed when zero: "0 back" in green reads as a
                      result, and it is the absence of one. Wrapped, because
                      the system font slider is real and drivers turn it up. */}
                  <View style={{
                    flexDirection: 'row', gap: 14, marginTop: 7,
                    flexWrap: 'wrap', rowGap: 4,
                  }}>
                    <Text style={[mono(13, '700'), { color: g.ship ? T.amber : T.faint }]}>
                      {g.ship} out
                    </Text>
                    <Text style={[mono(13, '700'), { color: g.ret ? T.bottle : T.faint }]}>
                      {g.ret} back
                    </Text>
                    {g.voided > 0 && (
                      <Text style={[mono(13, '700'), { color: T.faint }]}>
                        {g.voided} withdrawn
                      </Text>
                    )}
                  </View>
                  {/* Who else worked it. The one thing a list built from this
                      handset's outbox could never say. */}
                  {g.scannedBy.length > 0 && (
                    <Text style={{ color: T.faint, fontSize: 12, marginTop: 4 }} numberOfLines={1}>
                      {g.scannedBy.join(', ')}
                    </Text>
                  )}
                </View>

                <View style={{ alignItems: 'flex-end', gap: 4, maxWidth: 128 }}>
                  {/* Local time. Slicing the ISO string printed UTC, which in
                      Saskatchewan is six hours off every day of the year. */}
                  <Text style={[mono(12), { color: T.steel }]}>
                    {whenLabel(g.lastScanAt)}
                  </Text>
                  <Text style={{
                    fontSize: 11, fontWeight: '700', letterSpacing: 0,
                    textAlign: 'right', color: badge.tone,
                  }}>
                    {badge.text}
                  </Text>
                </View>
                <Icon name="chevron-right" size={ICON.md} color={T.faint} />
              </Pressable>
            );
          }}
        />
      </View>
    </Screen>
  );
}
