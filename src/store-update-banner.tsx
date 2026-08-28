import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { T, Surface, Icon, ICON, Rise, tint } from './ui';
import { useUpdates } from './updates';
import { useStoreUpdate, openStore } from './store-update';
import { bannerVisible, storeBannerVisible } from './update-policy';

/**
 * "There's a newer version in the [App Store / Play Store]."
 *
 * Same bar-not-modal shape as UpdateBanner, same reason: this sits above the
 * tab bar and goes away when told, rather than blocking the screen the
 * driver was already looking at.
 *
 * WHERE THIS DIFFERS FROM UpdateBanner MATTERS MORE THAN WHERE IT MATCHES.
 * That one's button restarts the app into a bundle already sitting on the
 * phone — free, instant, and nothing is lost. This one's button leaves
 * Scanified entirely and hands off to the App Store or Play Store, which
 * means a real download over the driver's own connection, on their own time.
 * Never auto-triggered, never phrased like a two-second action, and never
 * shown at all while an OTA banner could be — see storeBannerVisible's doc
 * comment for why the two never stack.
 */
export function StoreUpdateBanner({ segment }: { segment?: string | null }) {
  const otaPhase = useUpdates((s) => s.phase);
  const otaReadyId = useUpdates((s) => s.readyId);
  const otaDismissedId = useUpdates((s) => s.dismissedId);
  const available = useStoreUpdate((s) => s.available);
  const published = useStoreUpdate((s) => s.published);
  const dismissedBuild = useStoreUpdate((s) => s.dismissedBuild);
  const storeUrl = useStoreUpdate((s) => s.storeUrl);
  const dismiss = useStoreUpdate((s) => s.dismiss);
  const [opening, setOpening] = useState(false);

  const otaVisible = bannerVisible({
    phase: otaPhase, readyId: otaReadyId, dismissedId: otaDismissedId, segment,
  });

  if (!storeBannerVisible({
    available, dismissedBuild, published, otaBannerVisible: otaVisible, segment,
  })) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 14, right: 14, bottom: 96 }}
    >
      <Rise>
        <Surface level={3}>
          <View style={{ padding: 15 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
              <View style={{ paddingTop: 1 }}>
                <Icon name="download-cloud" size={ICON.md} color={T.amber} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.ink, fontSize: 15, fontWeight: '700' }}>
                  A new version is out
                </Text>
                <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 3, lineHeight: 18 }}>
                  This one has to come from the store, not from Scanified itself. Nothing
                  on this phone is touched until you install it.
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 13 }}>
              <Action label="Later" onPress={dismiss} />
              <Action
                primary
                label={opening ? 'Opening…' : 'Open the store'}
                disabled={opening || !storeUrl}
                onPress={async () => {
                  if (!storeUrl) return;
                  setOpening(true);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  try {
                    await openStore(storeUrl);
                  } finally {
                    setOpening(false);
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

function Action({
  label, onPress, primary, disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
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
      <Text style={{ color: primary ? T.onBrand : T.steel, fontSize: 14.5, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}
