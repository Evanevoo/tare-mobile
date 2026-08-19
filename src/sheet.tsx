import { useEffect } from 'react';
import { BackHandler, Platform, StyleSheet, View, type ViewStyle } from 'react-native';

/**
 * A FULL-SCREEN SHEET THAT IS NOT A PLATFORM DIALOG.
 *
 * WHY THIS EXISTS. React Native's `Modal` is, on Android, a real dialog window
 * that the OS owns. Setting `visible={false}` does not close it — it schedules
 * a React re-render which then ASKS Android to dismiss it, and the slide-out
 * runs about 300ms after that. Navigating inside that window orphans the
 * dialog: it stays on top, empty, swallowing every touch. That is the grey
 * frozen screen, and it was reported five times between 18 and 19 Aug 2026,
 * costing at least one real delivery.
 *
 * It was "fixed" three times by waiting longer before navigating — 0ms, then
 * 150ms, then 350ms. Every one of those is a guess about how long somebody
 * else's animation takes on hardware we do not own, and every one of them came
 * back. The number was never the problem.
 *
 * This is an ordinary View in the screen's own tree. There is no second
 * window, nothing for the OS to own, and nothing to orphan — so a caller can
 * dismiss it and navigate in the same breath and the question of timing does
 * not arise. `elevation` and `zIndex` put it above the screen's own content on
 * both platforms.
 *
 * WHAT IS GIVEN UP. The slide-in animation, and on a tab screen the tab bar
 * stays visible behind the sheet unless the caller hides it. Both are worth
 * it: an animation is not worth a frozen app, and the tab bar is one prop.
 */
export function Sheet({
  visible,
  onRequestClose,
  background = '#000',
  style,
  children,
}: {
  visible: boolean;
  /** Android back button. Handled here so no caller can forget it — Modal got
   *  this for free via onRequestClose, and losing it silently would trap a
   *  driver inside a sheet with no way out but force-quit. */
  onRequestClose: () => void;
  /**
   * Modal's own backdrop is white, and it showed for the whole slide-in before
   * the camera's first frame arrived — a white flash in a dark cab at 06:10.
   * Black is the default here for that reason.
   */
  background?: string;
  style?: ViewStyle;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!visible || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onRequestClose]);

  if (!visible) return null;

  return (
    <View
      style={[
        StyleSheet.absoluteFillObject,
        { backgroundColor: background, zIndex: 100, elevation: 24 },
        style,
      ]}
    >
      {children}
    </View>
  );
}
