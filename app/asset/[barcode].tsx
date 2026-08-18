import { View, Text, ScrollView, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStore } from '@/store';
import { T, Screen, Surface, Btn, Eyebrow, Tag, Rise, Hairline, mono, tint } from '@/ui';
import { whenLabel } from '@/when';
import {
  custodyChips, wasAtDetail, pendingHeadline, pendingNote, type Tone,
} from '@/pending-ship';

/**
 * One asset, everything known about it.
 *
 * Read entirely from the cached bootstrap, so it opens instantly and works in
 * a yard with no bars. The old app fetched this per lookup and showed a
 * spinner exactly when the driver could not afford one.
 */
export default function AssetDetail() {
  const { barcode } = useLocalSearchParams<{ barcode: string }>();
  const router = useRouter();
  const { boot } = useStore();

  const code = decodeURIComponent(barcode ?? '').toUpperCase();
  const a = boot?.assets[code];
  const customer = a?.c ? boot?.customers.find((c) => c.customerListId === a.c) : null;

  if (!a) {
    return (
      <Screen intensity={0.6}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={[mono(19, '700'), { color: T.ink, marginBottom: 10 }]}>{code}</Text>
          <Text style={{ color: T.faint, fontSize: 14, textAlign: 'center', lineHeight: 21 }}>
            Not on this phone.{'\n'}
            It may be new, or the list may be out of date — pull down on Home to refresh.
          </Text>
          {/* An unknown barcode in a driver's hand is usually a real thing
              nobody has recorded yet, so the useful next step is to record it. */}
          <Btn label="Add it to the fleet" style={{ marginTop: 24, minWidth: 220 }}
               onPress={() => router.replace('/asset/new' as never)} />
          <Btn label="Back" variant="ghost" style={{ marginTop: 10, minWidth: 220 }}
               onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  const requal = requalState(a.rq);

  /* Meanings to colours, in one place and at render time — the palette object
     is mutated when the theme flips, so a module-level map would hand out
     yesterday's greens on paper. See src/theme.ts. */
  const TONE: Record<Tone, string> = {
    full: T.fern, empty: T.needle, out: T.bottle, pending: T.amber, quiet: T.steel,
  };
  const provenance = wasAtDetail(a);

  return (
    <Screen intensity={0.75}>
      <ScrollView contentContainerStyle={{ paddingTop: 14, paddingHorizontal: 18, paddingBottom: 44 }}>
        <Rise>
          <Eyebrow>{boot?.org.assetLabel ?? 'Asset'}</Eyebrow>
          <Text style={[mono(30, '800'), { color: T.ink, marginTop: 8, letterSpacing: -1 }]}>
            {code}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {/* Full/empty is a shelf state. Rented, it doesn't apply — OUT
                already says everything that matters about it right now, and
                a FULL/EMPTY tag next to OUT used to claim a shelf state for
                something that isn't on a shelf. The scan loop shows both,
                because a driver holding the thing is deciding what to do with
                it; this screen is a record, and a record should not state a
                fill it cannot stand behind.

                THE THREE COLOURS ARE THE SAME THREE EVERYWHERE. Green full,
                red empty, blue out — see StateChips in app/scan.tsx for why
                each one is what it is. This screen used to draw FULL in the
                brand blue and OUT in amber, which meant blue said "full" here
                and "out" one screen away, and amber said "out" here and "we
                have never seen this barcode" there. Being out with a customer
                is the ordinary life of a cylinder, not a warning.

                AMBER IS THE FOURTH, AND IT IS NEW. A bottle scanned onto a
                truck this morning is still in house — the server deliberately
                does not move custody on a scan — and this screen used to draw
                it identically to one that has not moved since March. SCANNED
                OUT sits after IN HOUSE, never instead of it: the thing IS in
                house, and that is the surprising half that has to survive.
                Which chips appear is decided in src/pending-ship.ts, once, so
                the search rows cannot disagree with this screen. */}
            {custodyChips(a).map((chip) => (
              <Tag key={chip.label} label={chip.label} tone={TONE[chip.tone]} />
            ))}
            {a.own === 1 && <Tag label="CUSTOMER OWNED" tone={T.steel} />}
            {requal && <Tag label={requal.label} tone={requal.tone} />}
          </View>
        </Rise>

        {/* ── where it is ── */}
        <Rise delay={60} style={{ marginTop: 24 }}>
          <Surface>
            {a.c ? (
              <Pressable
                onPress={() => customer && router.push(`/customer/${customer.id}` as never)}
                accessibilityRole="button"
                accessibilityLabel={customer ? `Open customer ${customer.name}` : undefined}
                style={({ pressed }) => ({
                  padding: 18, backgroundColor: pressed ? tint(0.04) : 'transparent',
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                })}
              >
                <View style={{ flex: 1 }}>
                  <Eyebrow>With</Eyebrow>
                  <Text style={{ color: T.ink, fontSize: 18, fontWeight: '700', marginTop: 7 }}>
                    {customer?.name ?? a.c}
                  </Text>
                  <Text style={[mono(12.5, '500'), { color: T.faint, marginTop: 3 }]}>
                    {a.c}{customer?.city ? ` · ${customer.city}` : ''}
                  </Text>
                </View>
                {customer && <Text style={{ color: T.faint, fontSize: 18 }}>›</Text>}
              </Pressable>
            ) : (
              <View style={{ padding: 18 }}>
                <Eyebrow>Where</Eyebrow>
                <Text style={{ color: T.ink, fontSize: 18, fontWeight: '700', marginTop: 7 }}>
                  {a.l || 'In house'}
                </Text>
                <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 3 }}>
                  Not assigned to a customer.
                </Text>
                {/* WHERE IT CAME BACK FROM.
                    A RETURN releases the asset, so assignedCustomerId goes
                    null — correct, and it used to destroy the only answer the
                    record had to "whose was this?". A bottle on the empty rack
                    was anonymous the moment it landed. The server has kept
                    lastCustomerId all along; this screen simply never printed
                    it, which was the owner's second complaint. */}
                {provenance ? (
                  <Text style={{ color: T.steel, fontSize: 13, marginTop: 8, lineHeight: 19 }}>
                    {provenance.charAt(0).toUpperCase()}{provenance.slice(1)}.
                  </Text>
                ) : null}
              </View>
            )}
          </Surface>
        </Rise>

        {/* ── scanned out, nobody has approved it ──
            The whole point of this card: the fact that makes an in-house
            cylinder not the same as an in-house cylinder. Amber, above the
            record rather than buried in it, because a driver looking at a
            bottle that "should" be on a truck needs the answer before they
            start reading rows. */}
        {a.ps ? (
          <Rise delay={80} style={{ marginTop: 14 }}>
            <Surface tint="rgba(224,164,58,0.10)">
              <View style={{ padding: 18 }}>
                <Eyebrow>Awaiting approval</Eyebrow>
                <Text style={{
                  color: T.amber, fontSize: 17, fontWeight: '700',
                  marginTop: 8, lineHeight: 24,
                }}>
                  {pendingHeadline(a.ps)}
                </Text>
                <Text style={{ color: T.steel, fontSize: 13, marginTop: 8, lineHeight: 19 }}>
                  {pendingNote(a.ps, boot?.org.assetLabel)}
                </Text>
                <Text style={{ color: T.faint, fontSize: 12, marginTop: 8 }}>
                  Scanned {whenLabel(a.ps.at)}
                </Text>
              </View>
            </Surface>
          </Rise>
        ) : null}

        {/* ── the record ── */}
        <Rise delay={100} style={{ marginTop: 14 }}>
          <Surface>
            <Row label="Product" value={a.p ?? '—'} mono />
            <Hairline />
            <Row label="Serial number" value={a.sn ?? '—'} mono />
            <Hairline />
            <Row label="Status" value={cap(a.s)} />
            <Hairline />
            <Row label="Contents" value={a.c ? 'Rented — n/a' : a.f ? 'Full' : 'Empty'} />
            {a.l ? (
              <>
                <Hairline />
                <Row label="Last known location" value={a.l} />
              </>
            ) : null}
          </Surface>
        </Rise>

        {/* ── compliance ── */}
        {(a.rq || a.lq) && (
          <Rise delay={140} style={{ marginTop: 14 }}>
            <Surface tint={requal?.tone === T.needle ? 'rgba(240,101,74,0.10)' : undefined}>
              <View style={{ padding: 18 }}>
                <Eyebrow>Requalification</Eyebrow>
                <Text
                  style={{
                    color: requal?.tone ?? T.ink,
                    fontSize: 17, fontWeight: '700', marginTop: 8,
                  }}
                >
                  {a.rq ? `Due ${a.rq}` : 'No date on file'}
                </Text>
                {a.lq && (
                  <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 4 }}>
                    Last tested {a.lq}
                  </Text>
                )}
                {requal?.tone === T.needle && (
                  <Text style={{ color: T.needle, fontSize: 13, marginTop: 10, lineHeight: 19 }}>
                    Do not ship this one. Shipping a cylinder past its test date is a
                    regulatory violation, not a housekeeping note.
                  </Text>
                )}
              </View>
            </Surface>
          </Rise>
        )}

        <Rise delay={180} style={{ marginTop: 22 }}>
          {/* Correcting the record is an edit; moving it to a customer is a
              scan. Only the first of those belongs on this screen. */}
          <Btn
            label="Correct this record"
            variant="ghost"
            onPress={() => router.push(`/asset/edit/${encodeURIComponent(code)}` as never)}
          />
          <Btn label="Back" variant="ghost" style={{ marginTop: 10 }} onPress={() => router.back()} />
        </Rise>

        <Text
          style={{
            color: T.faint, fontSize: 11.5, textAlign: 'center',
            marginTop: 20, lineHeight: 17,
          }}
        >
          From the copy downloaded to this phone
          {boot?.syncedAt ? ` at ${new Date(boot.syncedAt).toLocaleTimeString()}` : ''}.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, mono: isMono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View
      style={{
        paddingHorizontal: 18, paddingVertical: 15,
        flexDirection: 'row', alignItems: 'center', gap: 14,
      }}
    >
      <Text style={{ color: T.faint, fontSize: 13.5, flex: 1 }}>{label}</Text>
      <Text
        style={[
          isMono ? mono(14, '600') : { fontSize: 14.5, fontWeight: '600' },
          { color: T.ink, textAlign: 'right', flexShrink: 1 },
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

/** Overdue is red, within ninety days is amber, otherwise nothing is said. */
function requalState(due: string | null) {
  if (!due) return null;
  const d = new Date(due + 'T00:00:00Z').getTime();
  if (Number.isNaN(d)) return null;
  const days = Math.floor((d - Date.now()) / 86_400_000);
  if (days < 0) return { label: 'REQUAL OVERDUE', tone: T.needle };
  if (days <= 90) return { label: `REQUAL IN ${days}D`, tone: T.amber };
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
