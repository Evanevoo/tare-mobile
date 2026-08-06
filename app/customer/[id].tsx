import { useMemo } from 'react';
import { View, Text, ScrollView, Pressable, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useStore } from '@/store';
import { T, Screen, Surface, Btn, Eyebrow, Tag, Rise, Hairline, mono } from '@/ui';

/**
 * A customer and what they are holding.
 *
 * The list is derived on the phone from the same cached bootstrap the scan
 * loop uses, so it is exactly what the app believes — no second source that
 * can disagree with the one the driver is scanning against.
 */
export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { boot } = useStore();

  const customer = boot?.customers.find((c) => c.id === id);

  const held = useMemo(() => {
    if (!boot || !customer) return [];
    return Object.entries(boot.assets)
      .filter(([, a]) => a.c === customer.customerListId)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [boot, customer]);

  if (!customer) {
    return (
      <Screen intensity={0.6}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: T.faint, fontSize: 14, textAlign: 'center', lineHeight: 21 }}>
            That customer is not on this phone.{'\n'}Pull down on Home to refresh the list.
          </Text>
          <Btn label="Back" variant="ghost" style={{ marginTop: 24, minWidth: 160 }}
               onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  const address = [customer.address, customer.city, customer.region, customer.postal]
    .filter(Boolean).join(', ');

  return (
    <Screen intensity={0.75}>
      <ScrollView contentContainerStyle={{ paddingTop: 44, paddingHorizontal: 18, paddingBottom: 44 }}>
        <Rise>
          <Eyebrow>Customer</Eyebrow>
          <Text
            style={{
              color: T.ink, fontSize: 27, fontWeight: '700',
              letterSpacing: -0.9, marginTop: 8,
            }}
          >
            {customer.name}
          </Text>
          <Text style={[mono(13, '500'), { color: T.faint, marginTop: 5 }]}>
            {customer.customerListId}
          </Text>
        </Rise>

        {/* ── on hand ── */}
        <Rise delay={60} style={{ marginTop: 22 }}>
          <Surface tint={held.length ? 'rgba(224,164,58,0.09)' : undefined}>
            <View style={{ padding: 18 }}>
              <Eyebrow>On hand right now</Eyebrow>
              <Text
                style={[
                  mono(42, '800'),
                  { color: held.length ? T.amber : T.ink, marginTop: 8, letterSpacing: -2 },
                ]}
              >
                {held.length}
              </Text>
              <Text style={{ color: T.steel, fontSize: 13, marginTop: 2 }}>
                {(boot?.org.assetPlural ?? 'assets').toLowerCase()} out at this account
              </Text>
            </View>
          </Surface>
        </Rise>

        {/* ── contact ── */}
        {(address || customer.phone || customer.email || customer.contact) && (
          <Rise delay={100} style={{ marginTop: 14 }}>
            <Surface>
              {customer.contact ? (
                <><Row label="Contact" value={customer.contact} /><Hairline /></>
              ) : null}
              {address ? (
                <><Row label="Address" value={address} /><Hairline /></>
              ) : null}
              {customer.phone ? (
                <>
                  <Pressable onPress={() => Linking.openURL(`tel:${customer.phone}`)}>
                    <Row label="Phone" value={customer.phone} action />
                  </Pressable>
                  <Hairline />
                </>
              ) : null}
              {customer.email ? (
                <Pressable onPress={() => Linking.openURL(`mailto:${customer.email}`)}>
                  <Row label="Email" value={customer.email} action />
                </Pressable>
              ) : null}
            </Surface>
          </Rise>
        )}

        {/* ── what they hold ── */}
        <Rise delay={140} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>
            {held.length ? `Holding ${held.length}` : 'Holding nothing'}
          </Eyebrow>

          {held.length === 0 ? (
            <Surface>
              <Text
                style={{
                  color: T.faint, fontSize: 13.5, padding: 22,
                  textAlign: 'center', lineHeight: 20,
                }}
              >
                Nothing of yours is at this account.
              </Text>
            </Surface>
          ) : (
            <Surface>
              {held.map(([bc, a], i) => (
                <Pressable
                  key={bc}
                  onPress={() => router.push(`/asset/${encodeURIComponent(bc)}` as never)}
                  style={({ pressed }) => ({
                    paddingHorizontal: 16, paddingVertical: 14,
                    borderTopWidth: i ? 1 : 0, borderTopColor: T.soft,
                    backgroundColor: pressed ? 'rgba(255,255,255,0.05)' : 'transparent',
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                  })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[mono(15, '600'), { color: T.ink }]}>{bc}</Text>
                    <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>
                      {a.p ?? 'unknown type'}
                    </Text>
                  </View>
                  <Tag label={a.f ? 'FULL' : 'EMPTY'} tone={a.f ? T.bottle : T.faint} />
                </Pressable>
              ))}
            </Surface>
          )}
        </Rise>

        <Btn
          label="Back" variant="quiet" style={{ marginTop: 22 }}
          onPress={() => router.back()}
        />
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, action }: { label: string; value: string; action?: boolean }) {
  return (
    <View
      style={{
        paddingHorizontal: 18, paddingVertical: 15,
        flexDirection: 'row', alignItems: 'center', gap: 14,
      }}
    >
      <Text style={{ color: T.faint, fontSize: 13.5, flex: 1 }}>{label}</Text>
      <Text
        style={{
          color: action ? T.brandLit : T.ink, fontSize: 14.5, fontWeight: '600',
          textAlign: 'right', flexShrink: 1,
        }}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}
