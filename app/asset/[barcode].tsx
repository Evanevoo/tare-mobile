import { View, Text, ScrollView, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStore } from '@/store';
import { T, Screen, Surface, Btn, Eyebrow, Tag, Rise, Hairline, mono, tint } from '@/ui';

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

  return (
    <Screen intensity={0.75}>
      <ScrollView contentContainerStyle={{ paddingTop: 14, paddingHorizontal: 18, paddingBottom: 44 }}>
        <Rise>
          <Eyebrow>{boot?.org.assetLabel ?? 'Asset'}</Eyebrow>
          <Text style={[mono(30, '800'), { color: T.ink, marginTop: 8, letterSpacing: -1 }]}>
            {code}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Tag label={a.f ? 'FULL' : 'EMPTY'} tone={a.f ? T.bottle : T.faint} />
            <Tag label={a.c ? 'OUT' : 'IN HOUSE'} tone={a.c ? T.amber : T.steel} />
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
              </View>
            )}
          </Surface>
        </Rise>

        {/* ── the record ── */}
        <Rise delay={100} style={{ marginTop: 14 }}>
          <Surface>
            <Row label="Product" value={a.p ?? '—'} mono />
            <Hairline />
            <Row label="Serial number" value={a.sn ?? '—'} mono />
            <Hairline />
            <Row label="Status" value={cap(a.s)} />
            <Hairline />
            <Row label="Contents" value={a.f ? 'Full' : 'Empty'} />
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
