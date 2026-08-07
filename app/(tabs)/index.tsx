import {
  View, Text, Pressable, ScrollView, RefreshControl, ActivityIndicator, Modal,
} from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { useScanRoute } from '@/scan-route';
import { Scanner } from '@/scanner';
import {
  T, Screen, Surface, Dot, Eyebrow, Rise, Icon, ICON, mono, tint, wash,
} from '@/ui';

/**
 * HOME IS A LAUNCHER AGAIN.
 *
 * The previous version of this screen offered two buttons and argued, in a
 * comment, that a grid of tiles was "a dashboard wall — the thing that made
 * the old app need training." That reasoning is sound for a product nobody
 * has used yet. It is wrong for this one.
 *
 * Thirteen people use Scanified every day and are being moved onto this app.
 * For them the grid is not a wall to learn, it is the map they already have,
 * and the six words on it are the six words they already read. Familiarity
 * beats a cleaner taxonomy when the users are known, existing, and mid-
 * migration. So the grid comes back — in this app's language rather than the
 * old pastel-on-lavender, which is the part that was worth leaving behind.
 *
 * Four things are deliberately not copied from the old home:
 *
 *   THE CAMERA IS IN THE SEARCH BAR and actually scans. It reads a label and
 *   opens whatever the label turned out to be. In the old app the equivalent
 *   button was the most-pressed control on the phone, and here it had been
 *   demoted to an icon that only opened a text field.
 *
 *   NO BELL. The old one carries four thousand unread, which is what a badge
 *   becomes when nothing depends on clearing it. The queue card below says
 *   the one thing a driver actually needs told — whether their scans reached
 *   the server — in words, and its number can reach zero.
 *
 *   TILES HAVE A HINT LINE. "Edit" on its own is the reason somebody taps it
 *   to find out what it does.
 *
 *   ONE TILE IS LIT. Six equally loud tiles is the wall. One lit and five
 *   quiet is a screen with an opinion about why you opened it.
 */

/**
 * The six, in Scanified's own words and Scanified's own order.
 *
 * `Edit` points at search on purpose: correcting a record needs a barcode, so
 * the honest route is find-it-then-fix-it. Pointing a tile at a screen that
 * cannot render without a parameter is how you get a blank screen, and a
 * route that opens nothing costs more trust than a missing feature.
 */
const ACTIONS = [
  { key: 'delivery',  icon: 'truck',       label: 'Delivery',  hint: 'Customer, order, scan', href: '/delivery',  lead: true },
  { key: 'add',       icon: 'plus',        label: 'Add',       hint: 'New to the fleet',      href: '/asset/new', lead: false },
  { key: 'edit',      icon: 'edit-2',      label: 'Edit',      hint: 'Correct a record',      href: '/search',    lead: false },
  { key: 'locate',    icon: 'map-pin',     label: 'Locate',    hint: 'Shelf, full or empty',  href: '/warehouse', lead: false },
  { key: 'history',   icon: 'clock',       label: 'History',   hint: 'What was scanned',      href: '/history',   lead: false },
  { key: 'analytics', icon: 'trending-up', label: 'Analytics', hint: 'Where the fleet sits',  href: '/analytics', lead: false },
] as const;

export default function Home() {
  const router = useRouter();
  const { boot, ready, online, outbox, refresh, lastSync } = useStore();
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
                  gap: 10, height: 52, paddingLeft: 12,
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

        {/* ── the six ── */}
        <Rise delay={80} style={{ marginTop: 24 }}>
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
                <Surface
                  level={a.lead ? 2 : 1}
                  tint={a.lead ? wash(0.13) : undefined}
                  style={{ minHeight: 108 }}
                >
                  <View style={{ padding: 15 }}>
                    <View
                      style={{
                        width: 38, height: 38, borderRadius: 11, marginBottom: 12,
                        alignItems: 'center', justifyContent: 'center',
                        backgroundColor: a.lead ? T.bottle : tint(0.06),
                        borderWidth: a.lead ? 0 : 1, borderColor: T.rule,
                      }}
                    >
                      <Icon
                        name={a.icon}
                        size={ICON.md}
                        color={a.lead ? T.onBrand : T.brandLit}
                      />
                    </View>
                    <Text style={{ color: T.ink, fontSize: 15.5, fontWeight: '700' }}>
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

        {/* ── are my scans safe ── */}
        <Rise delay={130} style={{ marginTop: 26 }}>
          <Pressable
            onPress={() => router.push('/activity' as never)}
            accessibilityRole="button"
            accessibilityLabel={unsent ? `${unsent} scans waiting to upload` : 'Everything is on the server'}
          >
            <Surface tint={unsent ? 'rgba(224,164,58,0.10)' : undefined}>
              <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Dot tone={online ? T.bottle : T.amber} size={9} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.ink, fontSize: 14.5, fontWeight: '700' }}>
                    {unsent
                      ? `${unsent} scan${unsent === 1 ? '' : 's'} waiting to upload`
                      : 'Everything is on the server'}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 3 }}>
                    {online ? 'Online' : 'Offline — nothing is lost'}
                    {lastSync ? ` · synced ${short(lastSync)}` : ''}
                  </Text>
                </View>
                <Icon name="chevron-right" size={ICON.md} color={T.faint} />
              </View>
            </Surface>
          </Pressable>
        </Rise>

        {/* ── the fleet, quietly ── */}
        {s && (
          <Rise delay={170} style={{ marginTop: 14 }}>
            <Surface>
              <View style={{ flexDirection: 'row' }}>
                {[
                  ['Out on rent', s.out, T.amber],
                  ['In house', s.inHouse, T.ink],
                  ['Full', s.full, T.bottle],
                ].map(([label, value, tone], i) => (
                  <View
                    key={label as string}
                    style={{
                      flex: 1, padding: 16,
                      borderLeftWidth: i ? 1 : 0, borderLeftColor: T.soft,
                    }}
                  >
                    <Text style={[mono(21, '800'), { color: tone as string }]}>
                      {(value as number).toLocaleString()}
                    </Text>
                    <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 5 }}>
                      {label as string}
                    </Text>
                  </View>
                ))}
              </View>
            </Surface>
          </Rise>
        )}
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
            onCode={(code) => { setScanning(false); route(code); }}
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
