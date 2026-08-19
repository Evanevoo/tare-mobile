import { useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, Alert, Modal } from 'react-native';
import { Scanner } from '@/scanner';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { signOut, API_URL } from '@/api';
import { APP_LOCK_KEY } from '@/guard';
import { hasNativeModule } from '@/notifications';
import { T, Screen, Surface, Btn, Eyebrow, Rise, Hairline, Icon, ICON, mono, tint } from '@/ui';
import { useTheme, type Pref } from '@/theme';
import { useUpdates, APP_VERSION, UPDATES_ENABLED, runningBundle } from '@/updates';
import { statusLine } from '@/update-policy';

/**
 * Settings, kept short on purpose.
 *
 * Everything a driver can usefully change, and nothing they cannot. The
 * dangerous action is at the bottom, separated, in its own colour — a person
 * scrolling fast should never land on Sign out by accident.
 */
export default function Settings() {
  const router = useRouter();
  const { boot, email, outbox, lastSync, online, refresh, dispatch } = useStore();
  const unsent = pending(outbox).length;

  // Who you are should never be a blank card. `boot` needs the server; `email`
  // is on the phone. Falling back through both means the worst case is an
  // address with no display name rather than nothing at all.
  // Same test More uses. The scanner trial is a diagnostic, not a driver
  // feature: a row that opens a benchmark is noise on a delivery run.
  const isAdmin = boot?.user.role === 'admin' || boot?.user.role === 'owner';

  /**
   * The live scanner trial. Deliberately holds its reads in component state
   * and nowhere else — not the outbox, not the cache, not the server. Closing
   * the sheet forgets them, which is the correct behaviour for a diagnostic
   * and the reason this is safe to hand to somebody mid-shift.
   */
  const [testing, setTesting] = useState(false);
  const [reads, setReads] = useState<{ code: string; at: number; known: string | null }[]>([]);

  const who = boot?.user.name || email || '—';
  const sub = [boot?.user.email || email, boot?.user.role].filter(Boolean).join(' · ');

  return (
    <Screen intensity={0.7}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 44 }}>
        <Rise>
          <Text style={{ color: T.ink, fontSize: 29, fontWeight: '700', letterSpacing: -1 }}>
            Settings
          </Text>
        </Rise>

        <Rise delay={60} style={{ marginTop: 24 }}>
          <Surface>
            <View style={{ padding: 18 }}>
              <Eyebrow>Signed in as</Eyebrow>
              <Text style={{ color: T.ink, fontSize: 18, fontWeight: '700', marginTop: 8 }}>
                {who}
              </Text>
              {!!sub && (
                <Text style={{ color: T.faint, fontSize: 13, marginTop: 3 }}>{sub}</Text>
              )}
              <Text style={{ color: T.faint, fontSize: 13, marginTop: 10 }}>
                {boot?.org.name ?? (online ? 'Loading your company…' : 'Offline — company details will load when you have signal')}
              </Text>
            </View>
          </Surface>
        </Rise>

        <Rise delay={90} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Screen</Eyebrow>
          <ThemePicker />
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
            Dark holds up in a cold shop at six in the morning. Light is the one that
            stays readable outside in full sun.
          </Text>
        </Rise>

        <Rise delay={110} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Security</Eyebrow>
          <LockToggle />
        </Rise>

        <Rise delay={130} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>This phone</Eyebrow>
          <Surface>
            <Row label="Connection" value={online ? 'Online' : 'Offline'} />
            <Hairline />
            <Row label="Waiting to upload" value={String(unsent)} mono />
            <Hairline />
            <Row
              label="Last sync"
              value={lastSync ? new Date(lastSync).toLocaleString() : 'never'}
            />
            <Hairline />
            <Row label="Downloaded" value={`${(boot?.stats?.total ?? 0).toLocaleString()} on file`} mono />
            <Hairline />
            <Row label="Server" value={API_URL.replace(/^https?:\/\//, '')} mono />
          </Surface>
        </Rise>

        <Rise delay={140} style={{ marginTop: 22 }}>
          <Btn
            label="Download the latest list"
            variant="ghost"
            onPress={async () => {
              await refresh();
              Alert.alert('Up to date', 'Customers and barcodes have been refreshed on this phone.');
            }}
          />
          <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
            Do this before you leave the yard. Everything you need to work a shift with no
            signal is on the phone after it finishes.
          </Text>
        </Rise>

        <Rise delay={160} style={{ marginTop: 22 }}>
          <Eyebrow style={{ marginBottom: 12 }}>This app</Eyebrow>
          <UpdateCard />
        </Rise>

        {isAdmin && (
          <Rise delay={170} style={{ marginTop: 22 }}>
            <Eyebrow style={{ marginBottom: 12 }}>Lab</Eyebrow>
            <Surface>
              <Nav
                icon="target"
                label="Scanner test"
                hint="Photograph a label and give the same photo to both decoders"
                onPress={() => router.push('/scanx-test' as never)}
              />
              <Hairline />
              {/*
                THE LIVE ONE. Same camera, same reticle, same decode path the
                delivery loop uses — the sheet below is a copy of Delivery's,
                deliberately, so what is tested here is what drivers actually
                run. The difference is that nothing is written: no order, no
                outbox row, no customer. Scan a rack of bottles as fast as you
                like and the ledger never hears about it.
              */}
              <Nav
                icon="target"
                label="Live scanner test"
                hint="Scan for real, see what it reads, save nothing"
                onPress={() => { setReads([]); setTesting(true); }}
              />
            </Surface>
            <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
              A new barcode decoder is being trialled. This reads one photo with the scanner
              the app ships today and with the new one, and keeps score. It changes nothing
              about how scanning works everywhere else.
            </Text>
          </Rise>
        )}

        <Rise delay={180} style={{ marginTop: 26 }}>
          <Eyebrow style={{ marginBottom: 12 }}>Careful</Eyebrow>
          <Surface>
            <Danger
              label="Clear uploaded scans"
              hint="Removes the ones already on the server. Nothing waiting is touched."
              onPress={() => dispatch({ type: 'CLEAR_SENT' })}
            />
            <Hairline />
            <Danger
              label="Sign out"
              hint={unsent ? `${unsent} scan${unsent === 1 ? '' : 's'} have not uploaded yet.` : 'Everything is on the server.'}
              tone={T.needle}
              onPress={() => {
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
                      // Clear the phone before dropping the session — see
                      // store.handOver. Both sign-out paths must do this, or
                      // the one that does not becomes the bug.
                      onPress: async () => {
                        await useStore.getState().handOver();
                        await signOut();
                        router.replace('/login');
                      },
                    },
                  ],
                );
              }}
            />
          </Surface>
        </Rise>
      </ScrollView>

      {/*
        LIVE SCANNER TRIAL — a deliberate copy of Delivery's scanning sheet.
        Same Modal shape, same fullScreen presentation, same black floor for
        the same reason (a Modal's own backdrop is white, and it is visible
        for the whole slide-in before the camera's first frame arrives — a
        white flash in a dark cab at 06:10).

        Copied rather than shared because the point is to test what drivers
        run: if this diverged from Delivery, a clean result here would prove
        nothing about the screen that matters.

        NOT `steadyFocus`. Delivery's setup fields read a printed receipt held
        still; this is for sweeping a rack of cylinders, which is the scan
        loop's case, so it gets the scan loop's periodic refocus.

        Nothing here navigates, so no afterModalClose is needed — see
        src/nav.ts for why that would matter if it did.
      */}
      <Modal
        visible={testing}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setTesting(false)}
      >
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <Scanner
            onCode={(code) => {
              const known = boot?.assets?.[code];
              setReads((prev) => [
                { code, at: Date.now(), known: known ? (known.p || known.gt || 'on the fleet') : null },
                ...prev,
              ].slice(0, 50));
            }}
            onClose={() => setTesting(false)}
            style={{ flex: 1 }}
          >
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 40, paddingHorizontal: 22 }}>
              <Text style={{ color: '#fff', fontSize: 13.5, textAlign: 'center', opacity: 0.9, marginBottom: 10 }}>
                {reads.length
                  ? `${reads.length} read${reads.length === 1 ? '' : 's'} — nothing is being saved`
                  : 'Scan anything. Nothing is saved.'}
              </Text>
              {reads.slice(0, 3).map((r) => (
                <View
                  key={`${r.code}-${r.at}`}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10,
                    paddingHorizontal: 12, paddingVertical: 9, marginTop: 6,
                  }}
                >
                  <Text style={[mono(15, '700'), { color: '#fff', flexShrink: 1 }]} numberOfLines={1}>
                    {r.code}
                  </Text>
                  <Text style={{ color: r.known ? T.bottle : T.amber, fontSize: 12, fontWeight: '700' }}>
                    {r.known ?? 'not on the fleet'}
                  </Text>
                </View>
              ))}
            </View>
          </Scanner>
        </View>
      </Modal>
    </Screen>
  );
}

/**
 * The version, what it is running, and a button that asks.
 *
 * The banner already offers a restart when there is something to restart into,
 * so this exists for the two moments the banner cannot cover. One: a driver on
 * the phone to the office being asked "what version are you on" — before this,
 * the only answer was the store listing, which is the version they installed
 * and not necessarily the JavaScript they are running. Two: somebody who has
 * just been told a fix is out and does not want to wait fifteen minutes for
 * the app to notice.
 *
 * `Bundle` is the line that earns its place. "1.2.0 · as installed" and
 * "1.2.0 · updated 12/08/2026" are the same version number and completely
 * different code, and knowing which one is in the truck is the difference
 * between debugging a fix and re-shipping it.
 */
function UpdateCard() {
  const phase = useUpdates((s) => s.phase);
  const error = useUpdates((s) => s.error);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const working = phase === 'checking' || phase === 'downloading';
  const ready = phase === 'ready';

  return (
    <>
      <Surface>
        <Row label="Version" value={APP_VERSION} mono />
        <Hairline />
        <Row label="Running" value={runningBundle()} />
        <Hairline />
        <Row label="Updates" value={statusLine(phase, { enabled: UPDATES_ENABLED, error })} />
      </Surface>

      <Btn
        label={ready ? 'Restart to finish updating' : 'Check for updates'}
        variant={ready ? 'primary' : 'ghost'}
        busy={working}
        disabled={working}
        style={{ marginTop: 12 }}
        onPress={async () => {
          if (ready) { await install(); return; }

          const result = await check({ manual: true });
          if (result === 'ready') {
            Alert.alert(
              'A new version is ready',
              'It is already downloaded. Restarting takes a couple of seconds and '
              + 'nothing on this phone is lost.',
              [
                { text: 'Later', style: 'cancel' },
                { text: 'Restart now', onPress: () => { install().catch(() => {}); } },
              ],
            );
          } else if (result === 'error') {
            Alert.alert('Could not check', useUpdates.getState().error
              ?? 'The update server could not be reached. Try again on better signal.');
          } else if (!UPDATES_ENABLED) {
            // Only reachable on a dev build, and saying so is kinder than the
            // silence that "skipped" would otherwise produce.
            Alert.alert('Updates are off',
              'This build was installed from a development machine, so it does not '
              + 'take over-the-air updates.');
          } else {
            Alert.alert('Up to date', `This phone is running the newest version (${APP_VERSION}).`);
          }
        }}
      />
      <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
        Fixes arrive on their own and the app tells you when one is waiting. This is here
        for when you have been told there is one and do not want to wait.
      </Text>
    </>
  );
}

/**
 * Three choices, not a switch. "Match my phone" is a real answer and a two-way
 * toggle throws it away silently the first time a driver taps it. Segments are
 * 44pt tall and labelled, because this gets used with gloves on.
 */
function ThemePicker() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  const items: Array<[Pref, string, keyof typeof ICON | 'sun' | 'moon' | 'smartphone']> = [
    ['light', 'Light', 'sun'],
    ['system', 'Match phone', 'smartphone'],
    ['dark', 'Dark', 'moon'],
  ];
  return (
    <Surface>
      <View style={{ flexDirection: 'row', padding: 6, gap: 6 }}>
        {items.map(([value, label, icon]) => {
          const on = pref === value;
          return (
            <Pressable
              key={value}
              onPress={() => setPref(value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={label}
              style={({ pressed }) => ({
                flex: 1, minHeight: 46, borderRadius: T.radiusSm,
                alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8,
                backgroundColor: on
                  ? T.stamp
                  : pressed ? T.soft : 'transparent',
                borderWidth: 1,
                borderColor: on ? T.rule : 'transparent',
              })}
            >
              <Icon name={icon as any} size={ICON.md} color={on ? T.bottle : T.faint} />
              <Text style={{
                color: on ? T.ink : T.faint,
                fontSize: 11.5, fontWeight: on ? '700' : '600',
              }}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Surface>
  );
}

/**
 * The app lock, opt-in and honest about its edges.
 *
 * Turning it ON asks the hardware first: a phone with no biometrics enrolled
 * gets an explanation instead of a toggle that would either lie or lock the
 * driver out. On builds older than 220 the module itself is absent, and the
 * same explanation covers it. No password is stored either way — this locks
 * OPENING the app, nothing more, which is exactly what a phone left in a
 * truck cab needs.
 */
function LockToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(APP_LOCK_KEY).then((v) => setOn(v === '1')).catch(() => {});
  }, []);

  async function flip() {
    if (on) {
      setOn(false);
      await AsyncStorage.setItem(APP_LOCK_KEY, '0').catch(() => {});
      return;
    }
    try {
      // See notifications.ts: importing an absent native module is fatal
      // under Metro even inside try/catch. Probe before importing.
      if (!hasNativeModule('ExpoLocalAuthentication')) {
        Alert.alert(
          'Not in this version yet',
          'The lock needs an app update from the store — it will work after the next install.',
        );
        return;
      }
      const LA = await import('expo-local-authentication');
      const [hw, enrolled] = await Promise.all([LA.hasHardwareAsync(), LA.isEnrolledAsync()]);
      if (!hw || !enrolled) {
        Alert.alert(
          'Nothing to lock with',
          'This phone has no fingerprint or face set up. Add one in the phone’s own settings first.',
        );
        return;
      }
      const r = await LA.authenticateAsync({ promptMessage: 'Confirm to turn the lock on' });
      if (!r.success) return;
      setOn(true);
      await AsyncStorage.setItem(APP_LOCK_KEY, '1').catch(() => {});
    } catch {
      Alert.alert(
        'Not in this version yet',
        'The lock needs an app update from the store — it will work after the next install.',
      );
    }
  }

  return (
    <>
      <Surface>
        <Pressable
          onPress={() => { void flip(); }}
          accessibilityRole="switch"
          accessibilityState={{ checked: on }}
          accessibilityLabel="Require fingerprint or face to open Scanified"
          style={({ pressed }) => ({
            paddingHorizontal: 18, paddingVertical: 16, minHeight: 56,
            flexDirection: 'row', alignItems: 'center', gap: 14,
            backgroundColor: pressed ? tint(0.04) : 'transparent',
          })}
        >
          <Icon name="lock" size={ICON.md} color={on ? T.bottle : T.steel} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.ink, fontSize: 15, fontWeight: '600' }}>
              Require fingerprint to open
            </Text>
            <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }}>
              {on ? 'On — asked on open and after 5 minutes away.' : 'Off'}
            </Text>
          </View>
          <View style={{
            width: 46, height: 28, borderRadius: 14, padding: 3,
            backgroundColor: on ? T.bottle : tint(0.12),
            alignItems: on ? 'flex-end' : 'flex-start', justifyContent: 'center',
          }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' }} />
          </View>
        </Pressable>
      </Surface>
      <Text style={{ color: T.faint, fontSize: 12, marginTop: 11, lineHeight: 18 }}>
        No password is ever stored on this phone. This locks opening the app — scans,
        customers and the queue stay behind it.
      </Text>
    </>
  );
}

function Row({ label, value, mono: isMono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 15, flexDirection: 'row', gap: 14 }}>
      <Text style={{ color: T.faint, fontSize: 13.5, flex: 1 }}>{label}</Text>
      <Text
        style={[
          isMono ? mono(14, '600') : { fontSize: 14.5, fontWeight: '600' },
          { color: T.ink, textAlign: 'right', flexShrink: 1 },
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function Danger({
  label, hint, onPress, tone = T.steel,
}: { label: string; hint: string; onPress: () => void; tone?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${hint}`}
      style={({ pressed }) => ({
        paddingHorizontal: 18, paddingVertical: 16, minHeight: 56,
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: pressed ? tint(0.04) : 'transparent',
      })}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: tone, fontSize: 15, fontWeight: '700' }}>{label}</Text>
        <Text style={{ color: T.faint, fontSize: 12, marginTop: 3, lineHeight: 17 }}>{hint}</Text>
      </View>
      <Icon name="chevron-right" size={ICON.md} color={T.faint} />
    </Pressable>
  );
}

function Nav({
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
