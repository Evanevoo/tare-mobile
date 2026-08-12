import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { T, Surface, Icon, ICON, Rise, tint } from './ui';
import { useUpdates } from './updates';
import { usePendingCount } from './store';
import { bannerVisible, restartHint } from './update-policy';

/**
 * "There is a new version. Restart when you are ready."
 *
 * A bar, not a modal. A modal would be the easy build and the wrong one: it
 * arrives without warning, covers whatever the driver was reading, and the
 * only way past it is to answer a question they did not ask. This sits above
 * the tab bar where a thumb already lives, waits, and goes away when told.
 *
 * NOTHING HERE RESTARTS THE APP ON ITS OWN. The bundle is already downloaded
 * by the time this renders, so a driver who ignores it entirely still gets the
 * fix the next time the phone is closed and reopened. The banner only buys
 * back the days between now and then, and it is not worth interrupting a
 * delivery to buy them.
 */
export function UpdateBanner({ segment }: { segment?: string | null }) {
  const phase = useUpdates((s) => s.phase);
  const readyId = useUpdates((s) => s.readyId);
  const dismissedId = useUpdates((s) => s.dismissedId);
  const install = useUpdates((s) => s.install);
  const dismiss = useUpdates((s) => s.dismiss);
  const unsent = usePendingCount();
  const [busy, setBusy] = useState(false);

  if (!bannerVisible({ phase, readyId, dismissedId, segment })) return null;

  return (
    <View
      // box-none, or this container swallows every tap on the screen behind it
      // — including the tab bar, which is two centimetres below.
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 14, right: 14,
        // The tab bar is 88 tall (see the tabs layout, which already includes
        // the home-indicator padding in that number). This clears it with a
        // little air, and the banner is only ever rendered over the tabs, so
        // there is no other case to get right.
        bottom: 96,
      }}
    >
      <Rise>
        {/* No `tint`: the tinted variant starts its gradient in a brand colour,
            which on paper is a dark wash across a white card. The accent here
            is the icon and the primary button, and those are palette-correct in
            both themes. */}
        <Surface level={3}>
          <View style={{ padding: 15 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <View style={{ paddingTop: 1 }}>
                <Icon name="download-cloud" size={ICON.md} color={T.brandLit} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.ink, fontSize: 15, fontWeight: '700' }}>
                  A new version is ready
                </Text>
                <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 3, lineHeight: 18 }}>
                  {restartHint(unsent)}
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 13 }}>
              <Action
                label="Later"
                onPress={dismiss}
                accessibilityHint="Keeps this version until the app is next opened fresh"
              />
              <Action
                primary
                label={busy ? 'Restarting…' : 'Restart now'}
                disabled={busy}
                onPress={async () => {
                  setBusy(true);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  try {
                    await install();
                  } catch {
                    // reloadAsync only rejects if the update cannot be applied
                    // at all. Re-enable the button rather than leaving a dead
                    // "Restarting…" on screen forever.
                    setBusy(false);
                  }
                }}
              />
            </View>
          </View>
        </Surface>
      </Rise>
    </View>
  );
}

/**
 * 44pt tall, both of them, and both labelled.
 *
 * Later is not a small grey × in the corner. A driver in gloves who cannot hit
 * the dismiss target hits the one next to it instead, and the one next to it
 * restarts the app.
 */
function Action({
  label, onPress, primary, disabled, accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        flex: 1, minHeight: 44, borderRadius: T.radiusSm,
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.6 : 1,
        backgroundColor: primary
          ? (pressed ? T.bottle : T.brandLit)
          : (pressed ? tint(0.06) : 'transparent'),
        borderWidth: 1,
        borderColor: primary ? 'transparent' : T.rule,
      })}
    >
      <Text style={{
        color: primary ? T.onBrand : T.steel,
        fontSize: 14.5, fontWeight: '700',
      }}>
        {label}
      </Text>
    </Pressable>
  );
}
