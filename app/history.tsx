import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import {
  fetchHistory, fetchFillHistory, HISTORY_PAGE, type FillHistoryEntry,
} from '@/api';
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
/** A run of Locate saves that happened together: same shelf, same state,
    same person, no more than a couple of minutes apart. Legacy batched its
    fill history this way and it is the right grain — a driver puts away a
    STACK, and forty identical rows is a list, not an answer. */
interface LocateBatch {
  key: string;
  location: string;
  state: string;
  filledBy: string | null;
  at: string;
  barcodes: string[];
  /** was → is, when every bottle in the run agreed on the "was". */
  from: string | null;
}

function batchLocate(entries: FillHistoryEntry[]): LocateBatch[] {
  const out: LocateBatch[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    const close = last
      && last.location === e.location
      && last.state === e.state
      && last.filledBy === e.filledBy
      && Math.abs(+new Date(last.at) - +new Date(e.filledAt)) < 120_000;
    if (close) {
      last.barcodes.push(e.barcode);
      if (last.from !== (e.previousState ?? null)) last.from = null;
    } else {
      out.push({
        key: e.id,
        location: e.location,
        state: e.state,
        filledBy: e.filledBy,
        at: e.filledAt,
        barcodes: [e.barcode],
        from: e.previousState ?? null,
      });
    }
  }
  return out;
}

interface CachedFills {
  entries: FillHistoryEntry[];
  before: string | null;
  fetchedAt: string | null;
}

export default function History() {
  const router = useRouter();
  const { boot, outbox, email } = useStore();

  /** Which half of the day: deliveries, or the yard. */
  const [mode, setMode] = useState<'orders' | 'locate'>('orders');

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

  /** ── the Locate half: same cache-then-network shape, its own cursor ── */
  const [fills, setFills] = useState<FillHistoryEntry[]>([]);
  const [fillBefore, setFillBefore] = useState<string | null>(null);
  const [fillFetchedAt, setFillFetchedAt] = useState<string | null>(null);
  const [fillLoaded, setFillLoaded] = useState(false);
  const [fillPaging, setFillPaging] = useState(false);

  const loadFills = useCallback(async (pull: boolean) => {
    if (pull) setRefreshing(true);
    try {
      const page = await fetchFillHistory({ limit: 50 });
      if (!alive.current) return;
      const fresh: CachedFills = {
        entries: page.entries ?? [],
        before: page.before ?? null,
        fetchedAt: new Date().toISOString(),
      };
      setFills(fresh.entries);
      setFillBefore(fresh.before);
      setFillFetchedAt(fresh.fetchedAt);
      setOffline(false);
      cacheSet('fill-history', fresh).catch(() => {});
    } catch {
      if (alive.current) setOffline(true);
    } finally {
      if (alive.current) { setRefreshing(false); setFillLoaded(true); }
    }
  }, []);

  /** Lazily, on the first switch — most opens never leave Orders, and the
      yard tab should not cost every open a second request. */
  useEffect(() => {
    if (mode !== 'locate' || fillLoaded) return;
    let live = true;
    (async () => {
      const cached = await cacheGet<CachedFills>('fill-history');
      if (live && cached && Array.isArray(cached.entries)) {
        setFills(cached.entries);
        setFillBefore(cached.before ?? null);
        setFillFetchedAt(cached.fetchedAt ?? null);
      }
      if (live) await loadFills(false);
    })();
    return () => { live = false; };
  }, [mode, fillLoaded, loadFills]);

  const moreFills = useCallback(async () => {
    if (fillPaging || refreshing || !fillBefore) return;
    setFillPaging(true);
    try {
      const page = await fetchFillHistory({ limit: 50, before: fillBefore });
      if (!alive.current) return;
      // Same duplicate rule as orders: a timestamp cursor can hand back a row
      // already on screen if one landed mid-scroll.
      setFills((have) => {
        const seen = new Set(have.map((e) => e.id));
        return [...have, ...(page.entries ?? []).filter((e) => !seen.has(e.id))];
      });
      setFillBefore(page.before ?? null);
      setOffline(false);
    } catch {
      if (alive.current) setOffline(true);
    } finally {
      if (alive.current) setFillPaging(false);
    }
  }, [fillBefore, fillPaging, refreshing]);

  const locateRows = useMemo(() => batchLocate(fills), [fills]);

  const names = useMemo(
    () => new Map((boot?.customers ?? []).map((c) => [c.customerListId, c.name] as const)),
    [boot?.customers],
  );

  const rows = useMemo(
    () => mergeHistory(orders, outbox.scans, { names, me: boot?.user?.name || email }),
    [orders, outbox.scans, names, boot?.user?.name, email],
  );

  const unsent = outbox.scans.filter((s) => s.state !== 'SENT').length;

  /** The two halves of the day, as a segmented control under the title. */
  const segment = (
    <View style={{
      flexDirection: 'row', gap: 8, marginTop: 14,
      flexWrap: 'wrap', rowGap: 8,
    }}>
      {([['orders', 'Orders'], ['locate', 'Locate']] as const).map(([m, lab]) => {
        const on = mode === m;
        return (
          <Pressable
            key={m}
            onPress={() => setMode(m)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Show ${lab.toLowerCase()} history`}
            style={{
              minHeight: 40, paddingHorizontal: 18, justifyContent: 'center',
              borderRadius: T.radiusSm, borderWidth: 1,
              borderColor: on ? T.brandLit : tint(0.12),
              backgroundColor: on ? tint(0.1) : 'transparent',
            }}
          >
            <Text style={{ color: on ? T.brandLit : T.faint, fontSize: 14, fontWeight: '700' }}>
              {lab}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  const header = (
    <Rise>
      <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1 }}>
        History
      </Text>
      {segment}
      {mode === 'orders' ? (
        <>
          <Text style={{ color: T.faint, fontSize: 13, marginTop: 12 }}>
            {rows.length} order{rows.length === 1 ? '' : 's'} · last 24 hours, everybody
            {unsent ? ` · ${unsent} scan${unsent === 1 ? '' : 's'} still on this phone` : ''}
          </Text>
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 6, lineHeight: 17 }}>
            The whole company&apos;s scans from the last 24 hours, with anything this phone
            has not uploaded merged in and marked. Tap one to change what went out, what came
            back, the order number or the customer.
          </Text>
        </>
      ) : (
        <Text style={{ color: T.faint, fontSize: 12, marginTop: 12, lineHeight: 17 }}>
          Every Locate save, everybody, newest first — what was put where, full or empty,
          and what it was before. Tap a barcode to open the record.
        </Text>
      )}
      {offline && (
        <Note icon="wifi-off" tone={T.amber}
              text={offlineNotice(mode === 'orders' ? fetchedAt : fillFetchedAt)} />
      )}
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
        {mode === 'orders' ? (
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
        ) : (
        <FlatList
          data={locateRows}
          keyExtractor={(b) => b.key}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View style={{ marginTop: 26 }}>
              {!fillLoaded ? (
                <ActivityIndicator color={T.brandLit} />
              ) : (
                <>
                  <Text style={{ color: T.ink, fontSize: 15, fontWeight: '600' }}>
                    Nothing put away yet
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
                    The moment anybody saves a shelf in Locate it lands here — where it went,
                    full or empty, and what it was before.
                  </Text>
                </>
              )}
            </View>
          }
          ListFooterComponent={locateRows.length ? (
            <View style={{ paddingVertical: 22, alignItems: 'center' }}>
              {fillPaging ? (
                <ActivityIndicator color={T.brandLit} />
              ) : fillBefore ? (
                <Pressable
                  onPress={() => { void moreFills(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Show older Locate saves"
                  style={{
                    minHeight: 48, paddingHorizontal: 18, justifyContent: 'center',
                    borderRadius: T.radiusSm, borderWidth: 1, borderColor: tint(0.12),
                    backgroundColor: tint(0.05),
                  }}
                >
                  <Text style={{ color: T.brandLit, fontSize: 14, fontWeight: '700' }}>
                    Show older saves
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          contentContainerStyle={{ paddingBottom: 44 }}
          onEndReached={() => { void moreFills(); }}
          onEndReachedThreshold={0.6}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: tint(0.05) }} />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { void loadFills(true); }}
              tintColor={T.brandLit}
              colors={[T.brandLit]}
              progressBackgroundColor={T.panelBot}
            />
          }
          renderItem={({ item: b }) => (
            <View style={{ paddingVertical: 14, paddingHorizontal: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '700', flexShrink: 1 }}>
                  {b.barcodes.length === 1 ? '1 put away' : `${b.barcodes.length} put away`} · {b.location}
                </Text>
                <Text style={[mono(12), { color: T.steel, marginLeft: 'auto' }]}>
                  {whenLabel(b.at)}
                </Text>
              </View>
              <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 3 }}>
                {b.from && b.from !== b.state ? `${b.from} → ${b.state}` : b.state}
                {b.filledBy ? ` · by ${b.filledBy}` : ''}
              </Text>
              {/* The barcodes themselves, tappable. Capped on screen —
                  a forty-bottle stack is a count, not a reading list. */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap', rowGap: 8 }}>
                {b.barcodes.slice(0, 8).map((bc) => (
                  <Pressable
                    key={bc}
                    onPress={() => router.push(`/asset/${encodeURIComponent(bc)}` as never)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${bc}`}
                    hitSlop={4}
                    style={({ pressed }) => ({
                      minHeight: 44, paddingHorizontal: 12, justifyContent: 'center',
                      borderRadius: T.radiusSm, borderWidth: 1, borderColor: tint(0.12),
                      backgroundColor: pressed ? tint(0.06) : 'transparent',
                    })}
                  >
                    <Text style={[mono(12.5, '600'), { color: T.steel }]}>{bc}</Text>
                  </Pressable>
                ))}
                {b.barcodes.length > 8 && (
                  <Text style={{ color: T.faint, fontSize: 12, alignSelf: 'center' }}>
                    +{b.barcodes.length - 8} more
                  </Text>
                )}
              </View>
            </View>
          )}
        />
        )}
      </View>
    </Screen>
  );
}
