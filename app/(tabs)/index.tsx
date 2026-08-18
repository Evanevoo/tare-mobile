import {
  View, Text, Pressable, ScrollView, RefreshControl, ActivityIndicator, Modal, Alert,
} from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending, counts } from '@/outbox';
import { useScanRoute, explainMiss } from '@/scan-route';
import { Scanner } from '@/scanner';
import {
  T, Screen, Surface, Edge, Dot, Eyebrow, Rise, Icon, ICON, mono, tint, wash,
} from '@/ui';
import { localDay, today } from '@/when';

/**
 * HOME IS A LAUNCHER AGAIN — AND IT HAS AN OPINION.
 *
 * The first version of this screen offered two buttons and argued, in a
 * comment, that a grid of tiles was "a dashboard wall — the thing that made
 * the old app need training." That is right for a product nobody has used
 * yet. It is wrong for this one: thirteen people use Scanified every day and
 * are being moved onto this, and for them the grid is not a wall to learn, it
 * is the map they already carry. Familiarity beats a cleaner taxonomy when
 * the users are known, existing, and mid-migration.
 *
 * But a straight port of the old grid would be six equally loud boxes, which
 * is a screen with no view about why you opened it. Two things fix that.
 *
 * HIERARCHY. Delivery is most of a driver's day; Analytics is a thing you
 * look at monthly. Drawing them the same size is a lie about importance. So
 * Delivery is a full-width lead card carrying today's real state, and the
 * other five sit quietly underneath.
 *
 * THE CUSTODY BAR. This is the one memorable object on the screen, and it
 * earns the boldness because it is the company's whole question in one line:
 * of everything you own, how much is out earning, how much is sitting here,
 * and how much of what is sitting here is actually ready to go. Three numbers
 * in a row cannot say that. A proportional bar says it before you read it —
 * and an empty cylinder in your own yard reading as dead grey rather than as
 * a neutral statistic is the point.
 *
 * Everything else stays quiet. The old home's notification bell is gone: it
 * sat at four thousand unread, which is what a badge becomes when clearing it
 * changes nothing. The queue card below says the one thing a driver actually
 * needs told — whether their scans reached the server — in words, and its
 * number can reach zero.
 */

/**
 * The five, in Scanified's own words. Delivery is not in this list because it
 * is not one of five — it is the reason the app is open.
 *
 * `Edit` points at search on purpose: correcting a record needs a barcode, so
 * the honest route is find-it-then-fix-it. Pointing a tile at a screen that
 * cannot render without a parameter is how you get a blank screen, and a
 * route that opens nothing costs more trust than a missing feature.
 */
const ACTIONS = [
  { key: 'add',       icon: 'plus',        label: 'Add',       hint: 'New to the fleet',     href: '/asset/new' },
  { key: 'edit',      icon: 'edit-2',      label: 'Edit',      hint: 'Correct a record',     href: '/search' },
  { key: 'locate',    icon: 'map-pin',     label: 'Locate',    hint: 'Shelf, full or empty', href: '/warehouse' },
  { key: 'history',   icon: 'clock',       label: 'History',   hint: 'What was scanned',     href: '/history' },
  { key: 'analytics', icon: 'trending-up', label: 'Analytics', hint: 'Where the fleet sits', href: '/analytics' },
] as const;

export default function Home() {
  const router = useRouter();
  const {
    boot, ready, online, outbox, refresh, lastSync, dbUnavailable,
    orderNumber, customerName, customerListId, endDelivery, sync,
  } = useStore();
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const route = useScanRoute();
  const unsent = pending(outbox).length;

  if (!ready) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ActivityIndicator color={T.brandLit} />
        </View>
      </Screen>
    );
  }

  const s = boot?.stats;

  // Today, from the outbox rather than the server, so it is still true in a
  // yard with no signal — which is where this screen is usually read.
  // LOCAL day, not the UTC one. `.slice(0, 10)` on an ISO string is the UTC
  // date, so from 6pm onwards in Saskatchewan everything scanned counted as
  // tomorrow and "today's scans" silently dropped the busiest end of the run.
  const todayLocal = today();
  const mine = outbox.scans.filter((x) => localDay(x.scannedAt) === todayLocal);
  const orders = new Set(mine.map((x) => x.orderNumber)).size;
  const todayLine = mine.length
    ? `${mine.length} scanned today · ${orders} order${orders === 1 ? '' : 's'}`
    : 'Customer, order number, then scan';

  /**
   * A DELIVERY LEFT OPEN.
   *
   * The job now survives a force-quit, but surviving is only half of it: a
   * restored job nobody is told about is the same as a lost one, because the
   * driver taps Delivery, gets the setup screen, and concludes it is gone.
   *
   * So when a job is in flight it takes over the largest object on the screen.
   * It is amber rather than brand blue on purpose — this is not the normal
   * resting state of the app, it is something with a loose end, and it should
   * read that way at a glance from a phone on a dashboard mount.
   *
   * Two ways out, because "saved until it is done, or we cancel it" is two
   * different intentions: carry on scanning, or stop. Stopping keeps every
   * scan — they are already in the outbox and already belong to that order —
   * and only clears the job, so the wording says so rather than saying
   * "cancel", which sounds like it throws the work away.
   */
  const job = !!(orderNumber && customerListId);
  const c = orderNumber ? counts(outbox, orderNumber) : null;

  function closeJob() {
    Alert.alert(
      'Put this delivery down?',
      `${c?.total ?? 0} scan${c?.total === 1 ? '' : 's'} on ${orderNumber} stay saved and still upload — this only clears it off the home screen so you can start another.`,
      [
        { text: 'Keep scanning', style: 'cancel' },
        {
          text: 'Put it down',
          onPress: () => { endDelivery(); sync().catch(() => {}); },
        },
      ],
    );
  }

  const Resume = () => (
    <Pressable
      onPress={() => router.push('/scan' as never)}
      accessibilityRole="button"
      accessibilityLabel={`Resume delivery for ${customerName}, order ${orderNumber}, ${c?.total ?? 0} scanned`}
      style={({ pressed }) => ({ opacity: pressed ? 0.88 : 1 })}
    >
      <Surface level={3} tint="rgba(224,164,58,0.16)">
        <View style={{ padding: 18, flexDirection: 'row', alignItems: 'center', gap: 15 }}>
          <View
            style={{
              width: 52, height: 52, borderRadius: 15,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: T.amber,
            }}
          >
            <Edge inset={11} opacity={0.7} />
            <Icon name="play" size={ICON.lg} color="#2A1B02" />
          </View>
          <View style={{ flex: 1 }}>
            <Eyebrow style={{ color: T.amber }}>Still open</Eyebrow>
            <Text
              numberOfLines={1}
              style={{ color: T.ink, fontSize: 19, fontWeight: '700', letterSpacing: -0.4, marginTop: 4 }}
            >
              {customerName}
            </Text>
            <Text style={[mono(12, '500'), { color: T.steel, marginTop: 3 }]}>
              {orderNumber} · {c?.total ?? 0} scanned
              {c && c.total > 0 ? ` · ${c.ship} out, ${c.ret} in` : ''}
            </Text>
          </View>
          <Icon name="arrow-right" size={ICON.md} color={T.amber} />
        </View>
        <Pressable
          onPress={closeJob}
          accessibilityRole="button"
          accessibilityLabel="Put this delivery down"
          hitSlop={8}
          style={({ pressed }) => ({
            borderTopWidth: 1, borderTopColor: T.soft,
            paddingVertical: 13, alignItems: 'center',
            backgroundColor: pressed ? tint(0.05) : 'transparent',
          })}
        >
          <Text style={{ color: T.steel, fontSize: 13, fontWeight: '600' }}>
            Put it down — scans stay saved
          </Text>
        </Pressable>
      </Surface>
    </Pressable>
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={busy} tintColor={T.steel}
            onRefresh={async () => { setBusy(true); await refresh(); setBusy(false); }}
          />
        }
      >
        {/* ── who, where, and the way out ── */}
        <Rise>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Eyebrow>{boot?.org.name ?? 'Scanified'}</Eyebrow>
              <Text
                style={{
                  color: T.ink, fontSize: 30, fontWeight: '700',
                  letterSpacing: -1.1, marginTop: 7,
                }}
              >
                {greeting()}{boot?.user.name ? `, ${boot.user.name.split(' ')[0]}` : ''}
              </Text>
            </View>
            <Pressable
              onPress={() => router.push('/settings' as never)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={({ pressed }) => ({
                width: 46, height: 46, borderRadius: 14, marginTop: 4,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? tint(0.09) : tint(0.05),
                borderWidth: 1, borderColor: T.rule,
              })}
            >
              <Icon name="settings" size={ICON.md} color={T.steel} />
            </Pressable>
          </View>
        </Rise>

        {/* ── search, and the camera that makes it a scanner ──────────────
            Tapping the field searches by name. Tapping the camera reads a
            label and goes straight to whatever it turned out to be — a
            cylinder opens its record, a customer code opens the account. */}
        <Rise delay={40} style={{ marginTop: 22 }}>
          <Surface level={1} radius={T.radiusSm}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 6 }}>
              <Pressable
                onPress={() => router.push('/search' as never)}
                accessibilityRole="search"
                accessibilityLabel="Search customers and assets"
                style={{
                  flex: 1, flexDirection: 'row', alignItems: 'center',
                  gap: 10, minHeight: 52, paddingLeft: 12,
                }}
              >
                <Icon name="search" size={ICON.md} color={T.faint} />
                <Text style={{ color: T.faint, fontSize: 15.5 }} numberOfLines={1}>
                  Search {boot?.org.assetPlural ?? 'assets'} or customers
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setScanning(true)}
                accessibilityRole="button"
                accessibilityLabel="Scan a barcode with the camera"
                style={({ pressed }) => ({
                  width: 52, height: 52, borderRadius: 11,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: pressed ? T.brandDark : T.bottle,
                })}
              >
                <Icon name="camera" size={ICON.lg} color={T.onBrand} />
              </Pressable>
            </View>
          </Surface>
        </Rise>

        {/* ── the reason the app is open ── */}
        <Rise delay={80} style={{ marginTop: 24 }}>
          {job ? <Resume /> : (
            <Pressable
              onPress={() => router.push('/delivery' as never)}
              accessibilityRole="button"
              accessibilityLabel={`Delivery. ${todayLine}`}
              style={({ pressed }) => ({ opacity: pressed ? 0.88 : 1 })}
            >
              <Surface level={3} tint={wash(0.15)}>
                <View
                  style={{
                    padding: 18, flexDirection: 'row', alignItems: 'center', gap: 15,
                  }}
                >
                  <View
                    style={{
                      width: 52, height: 52, borderRadius: 15,
                      alignItems: 'center', justifyContent: 'center',
                      backgroundColor: T.bottle,
                    }}
                  >
                    <Edge inset={11} opacity={0.7} />
                    <Icon name="truck" size={ICON.lg} color={T.onBrand} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.ink, fontSize: 21, fontWeight: '700', letterSpacing: -0.5 }}>
                      Delivery
                    </Text>
                    <Text style={{ color: T.steel, fontSize: 12.5, marginTop: 3 }}>
                      {todayLine}
                    </Text>
                  </View>
                  <Icon name="arrow-right" size={ICON.md} color={T.brandLit} />
                </View>
              </Surface>
            </Pressable>
          )}
        </Rise>

        {/* ── the other five ── */}
        <Rise delay={120} style={{ marginTop: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {ACTIONS.map((a) => (
              <Pressable
                key={a.key}
                onPress={() => router.push(a.href as never)}
                accessibilityRole="button"
                accessibilityLabel={`${a.label}. ${a.hint}`}
                style={({ pressed }) => ({
                  width: '47%', flexGrow: 1, opacity: pressed ? 0.86 : 1,
                })}
              >
                <Surface level={1} style={{ minHeight: 104 }}>
                  <View style={{ padding: 15 }}>
                    <View
                      style={{
                        width: 36, height: 36, borderRadius: 11, marginBottom: 11,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: tint(0.06),
                        borderWidth: 1, borderColor: T.rule,
                      }}
                    >
                      <Icon name={a.icon} size={ICON.md} color={T.brandLit} />
                    </View>
                    <Text style={{ color: T.ink, fontSize: 15, fontWeight: '700' }}>
                      {a.label}
                    </Text>
                    <Text
                      style={{ color: T.faint, fontSize: 11.5, marginTop: 3 }}
                      numberOfLines={1}
                    >
                      {a.hint}
                    </Text>
                  </View>
                </Surface>
              </Pressable>
            ))}
          </View>
        </Rise>

        {/* ── are my scans safe ──
            DB-UNAVAILABLE OUTRANKS EVERYTHING ELSE THIS CARD SAYS.
            "Online" and "waiting to upload" both still mean the scan itself
            is sitting somewhere safe. `dbUnavailable` means it is not — it is
            in memory only, and closing the app loses it, whether or not
            there is signal. That is a different fact from "offline" and has
            to look like one: red, not amber, and the card's own colour, not
            a status line buried inside it. */}
        <Rise delay={160} style={{ marginTop: 26 }}>
          <Pressable
            onPress={() => router.push('/activity' as never)}
            accessibilityRole="button"
            accessibilityLabel={
              dbUnavailable
                ? 'Not saving to this phone. Scans are only safe once they upload.'
                : unsent ? `${unsent} scans waiting to upload` : 'Everything is on the server'
            }
          >
            <Surface tint={
              dbUnavailable ? 'rgba(214,69,69,0.16)'
              : unsent ? 'rgba(224,164,58,0.10)'
              : undefined
            }>
              <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Dot tone={dbUnavailable ? T.needle : online ? T.bottle : T.amber} size={9} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.ink, fontSize: 14.5, fontWeight: '700' }}>
                    {dbUnavailable
                      ? 'Not saving to this phone'
                      : unsent
                        ? `${unsent} scan${unsent === 1 ? '' : 's'} waiting to upload`
                        : 'Everything is on the server'}
                  </Text>
                  <Text style={{ color: dbUnavailable ? T.needle : T.faint, fontSize: 12, marginTop: 3 }}>
                    {dbUnavailable
                      ? 'Scans only stay safe once they upload — keep the app open and get signal soon.'
                      : (online ? 'Online' : 'Offline — nothing is lost')
                        + (lastSync ? ` · synced ${short(lastSync)}` : '')}
                  </Text>
                </View>
                <Icon name="chevron-right" size={ICON.md} color={T.faint} />
              </View>
            </Surface>
          </Pressable>
        </Rise>

        {s && <Custody out={s.out} inHouse={s.inHouse} full={s.full} />}
      </ScrollView>

      {/* ── the camera, full screen ──────────────────────────────────────
          The black floor and the explicit flex are not decoration: a Modal's
          own backdrop is white and it is visible for the whole slide-in, and
          a Scanner with no height lays out at zero pixels over it. That
          combination is what "tapping scan shows a white screen" was. */}
      <Modal
        visible={scanning}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setScanning(false)}
      >
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <Scanner
            /**
             * A scan that resolves navigates and this closes behind it. A scan
             * that resolves to NOTHING used to close and leave the driver back
             * on Home with no statement at all — indistinguishable from the
             * camera never having read the label, which is why a customer card
             * that silently failed to match was never reported as a bug. Now a
             * miss says which kind of miss it was.
             */
            onCode={(code) => {
              setScanning(false);
              const t = route(code);
              if (t && t.kind === 'text') {
                Alert.alert('Nothing matched that code', explainMiss(code, boot));
              }
            }}
            onClose={() => setScanning(false)}
            cooldownMs={1200}
            style={{ flex: 1 }}
          >
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 44, paddingHorizontal: 26 }}>
              <Text style={{ color: '#FFFFFF', fontSize: 14, textAlign: 'center', lineHeight: 20, opacity: 0.9 }}>
                Read any label to open it.
              </Text>
              <Text style={{ color: '#FFFFFF', fontSize: 12.5, textAlign: 'center', lineHeight: 18, opacity: 0.6, marginTop: 6 }}>
                A cylinder opens its record. A customer code opens the account.
              </Text>
            </View>
          </Scanner>
        </View>
      </Modal>
    </Screen>
  );
}

/**
 * THE CUSTODY BAR — the one object on this screen worth remembering.
 *
 * Everything this company owns is in one of three states, and they are not
 * equally good. Out on rent is earning. Full and in house is ready to earn.
 * Empty and in house is a steel cylinder taking up floor space, which is the
 * state nobody tracks and everybody pays for. Three numbers in a row give all
 * three the same weight; a proportional bar shows the actual shape of the
 * fleet before you have read a single digit.
 *
 * The split is drawn from `out` and `inHouse` rather than from `total`,
 * because those two are what the server counts and their sum is the fleet by
 * definition — deriving the denominator from `total` instead would leave a
 * ghost segment whenever the counts disagree by a row or two. `full` is a
 * subset of what is in house, so it is clamped to it and drawn inside it.
 */
function Custody({ out, inHouse, full }: { out: number; inHouse: number; full: number }) {
  const ready = Math.min(full, inHouse);
  const empty = Math.max(0, inHouse - ready);
  const fleet = out + inHouse;
  if (fleet <= 0) return null;

  const seg = [
    { n: out,   tone: T.amber,  label: 'Out on rent', hint: 'earning' },
    { n: ready, tone: T.bottle, label: 'Full',        hint: 'ready to go' },
    { n: empty, tone: T.steel,  label: 'Empty',       hint: 'here, idle' },
  ].filter((x) => x.n > 0);

  return (
    <Rise delay={200} style={{ marginTop: 14 }}>
      <Surface>
        <View style={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 13 }}>
            <Eyebrow>The fleet</Eyebrow>
            <Text style={[mono(12, '700'), { color: T.faint, marginLeft: 'auto' }]}>
              {fleet.toLocaleString()}
            </Text>
          </View>

          {/* One bar. The gaps between segments are 2px of the panel showing
              through, which reads as machined rather than as a stacked chart. */}
          <View
            style={{
              flexDirection: 'row', height: 12, borderRadius: 6,
              overflow: 'hidden', backgroundColor: tint(0.06), gap: 2,
            }}
          >
            {seg.map((x) => (
              <View key={x.label} style={{ flex: x.n, backgroundColor: x.tone }} />
            ))}
          </View>

          <View style={{ flexDirection: 'row', marginTop: 14 }}>
            {seg.map((x, i) => (
              <View key={x.label} style={{ flex: 1, paddingLeft: i ? 12 : 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: x.tone }} />
                  <Text style={[mono(17, '800'), { color: T.ink }]}>
                    {x.n.toLocaleString()}
                  </Text>
                </View>
                <Text style={{ color: T.steel, fontSize: 11.5, marginTop: 4, fontWeight: '600' }}>
                  {x.label}
                </Text>
                <Text style={{ color: T.faint, fontSize: 10.5, marginTop: 1 }}>
                  {x.hint}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </Surface>
    </Rise>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function short(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}
