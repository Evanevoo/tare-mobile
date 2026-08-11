import { View, Text, ScrollView, Pressable, Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { signOut } from '@/api';
import { T, Screen, Surface, Eyebrow, Rise, Hairline, Icon, ICON, tint } from '@/ui';

/**
 * Everything that is not one of the two jobs.
 *
 * Sign out sits alone at the bottom in its own colour. A person scrolling fast
 * should never land on it by accident, and grouping it with Settings is how
 * that happens.
 *
 * Nothing here is a dead route. If a screen is not built yet it is not listed —
 * a menu item that opens a blank page costs more trust than a missing feature.
 */
export default function More() {
  const router = useRouter();
  const { boot, email, outbox } = useStore();
  const unsent = pending(outbox).length;
  const isAdmin = boot?.user.role === 'admin' || boot?.user.role === 'owner';

  // Same fallback as Settings: the session on the phone knows the address even
  // when the console is unreachable, so this card is never empty.
  const who = boot?.user.name || email || '—';
  const sub = [boot?.user.email || email, boot?.user.role].filter(Boolean).join(' · ');

  return (
    <Screen intensity={0.7}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 44 }}>
        <Rise>
          <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1.1 }}>
            More
          </Text>
        </Rise>

        <Rise delay={50} style={{ marginTop: 22 }}>
          <Surface>
            <View style={{ padding: 18 }}>
              <Eyebrow>Signed in as</Eyebrow>
              <Text style={{ color: T.ink, fontSize: 18, fontWeight: '700', marginTop: 8 }}>
                {who}
              </Text>
              {!!sub && (
                <Text style={{ color: T.faint, fontSize: 13, marginTop: 3 }}>{sub}</Text>
              )}
              {!!boot?.org.name && (
                <Text style={{ color: T.faint, fontSize: 13, marginTop: 9 }}>
                  {boot.org.name}
                </Text>
              )}
            </View>
          </Surface>
        </Rise>

        <Rise delay={90} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Fleet</Eyebrow>
          <Surface>
            <Item
              icon="plus-circle"
              label={`Add ${(boot?.org.assetPlural ?? 'assets').toLowerCase()}`}
              hint="New stock, or something found with no record"
              onPress={() => router.push('/asset/new' as never)}
            />
            <Hairline />
            <Item
              icon="bar-chart-2" label="Analytics"
              hint="The fleet counted — works offline"
              onPress={() => router.push('/analytics' as never)}
            />
          </Surface>
        </Rise>

        <Rise delay={130} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>App</Eyebrow>
          <Surface>
            <Item
              icon="settings" label="Settings"
              hint="Sync, downloads, this phone"
              onPress={() => router.push('/settings' as never)}
            />
            <Hairline />
            <Item
              icon="upload-cloud" label="Sync"
              hint={unsent ? `${unsent} waiting to upload` : 'Everything is on the server'}
              onPress={() => router.push('/activity' as never)}
            />
            <Hairline />
            <Item
              icon="clock" label="History"
              hint="Every order the company has scanned"
              onPress={() => router.push('/history' as never)}
            />
          </Surface>
        </Rise>

        {isAdmin && (
          <Rise delay={140} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 12 }}>Admin</Eyebrow>
            <Surface>
              <Item
                icon="external-link" label="Open the console"
                hint="Verification, invoices, reports — on the web"
                onPress={() => Linking.openURL('https://scanified.com/home').catch(() => {})}
              />
            </Surface>
          </Rise>
        )}

        <Rise delay={180} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Help</Eyebrow>
          <Surface>
            <Item
              icon="mail" label="Email support"
              hint="hello@scanified.com"
              onPress={() =>
                Linking.openURL(
                  `mailto:hello@scanified.com?subject=Scanified%20app&body=%0A%0A---%0A${
                    encodeURIComponent(`${boot?.org.name ?? ''} · ${boot?.user.email ?? ''}`)}`,
                ).catch(() => {})}
            />
            <Hairline />
            {/* App Review will not approve a build whose privacy policy is only
                reachable from the store listing — a reviewer looks for it inside
                the app, and until now there was nowhere in here to point them.
                It opens on the web rather than shipping a copy in the bundle so
                the policy can be corrected without a new binary. */}
            <Item
              icon="shield" label="Privacy policy"
              hint="How Scanified handles scans and location"
              onPress={() => Linking.openURL('https://scanified.com/legal/privacy').catch(() => {})}
            />
          </Surface>
        </Rise>

        <Rise delay={220} style={{ marginTop: 30 }}>
          <Pressable
            onPress={() =>
              Alert.alert(
                'Sign out',
                unsent
                  ? `${unsent} scan${unsent === 1 ? ' is' : 's are'} still on this phone and will be lost. Sync first.`
                  : 'Everything has uploaded. You can sign out safely.',
                [
                  { text: 'Stay', style: 'cancel' },
                  {
                    text: 'Sign out',
                    style: 'destructive',
                    onPress: () => { signOut(); router.replace('/login' as never); },
                  },
                ],
              )}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            style={({ pressed }) => ({
              minHeight: 56, borderRadius: T.radiusSm,
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 1, borderColor: 'rgba(240,101,74,0.3)',
              backgroundColor: pressed ? 'rgba(240,101,74,0.10)' : 'transparent',
            })}
          >
            <Text style={{ color: T.needle, fontSize: 15.5, fontWeight: '700' }}>Sign out</Text>
          </Pressable>
        </Rise>
      </ScrollView>
    </Screen>
  );
}

function Item({
  icon, label, hint, onPress,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string; hint: string; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${hint}`}
      style={({ pressed }) => ({
        paddingHorizontal: 18, paddingVertical: 16, minHeight: 56,
        flexDirection: 'row', alignItems: 'center', gap: 14,
        backgroundColor: pressed ? tint(0.04) : 'transparent',
      })}
    >
      <Icon name={icon} size={ICON.md} color={T.steel} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: T.ink, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>{hint}</Text>
      </View>
      <Icon name="chevron-right" size={ICON.md} color={T.faint} />
    </Pressable>
  );
}
