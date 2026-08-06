import { useEffect, useRef } from 'react';
import {
  View, Text, Image, Pressable, Animated, Platform, StyleSheet,
  type ViewStyle, type TextStyle, type StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';

/**
 * INSTRUMENT — the handset half of the design system.
 *
 * Same language as the console: a dark base with a light in it, surfaces that
 * catch that light on their top edge, and grain over everything so the
 * gradients do not read as plastic.
 *
 * React Native gives you none of the primitives that make this easy on the web,
 * so each one is rebuilt here rather than approximated:
 *
 *   inset box-shadow  →  a 1px gradient hairline positioned at the top of the
 *                        surface. This is the single detail that separates a
 *                        panel from a coloured rectangle, and there is no
 *                        native equivalent, so it is a real element.
 *   radial-gradient   →  a pre-rendered PNG with an alpha falloff. Stacking
 *                        concentric Views bands visibly; an image does not.
 *   box-shadow        →  shadowColor/Offset/Opacity/Radius on iOS, elevation
 *                        on Android. They are not interchangeable, so shadow()
 *                        emits both and they are tuned to match.
 */

export const T = {
  // Base
  zinc: '#07090A',
  face: '#141B1E',
  panelTop: '#171E21',
  panelBot: '#0D1315',

  // Ink. Contrast measured against #141B1E, the most common surface:
  // ink 13.9:1, steel 6.6:1, faint 4.7:1. All clear AA at body size.
  ink: '#EDEFEC',
  steel: '#98A4AB',
  faint: '#7C8A91',

  // Lines
  rule: 'rgba(255,255,255,0.085)',
  soft: 'rgba(255,255,255,0.05)',
  edgeLit: 'rgba(255,255,255,0.13)',
  stamp: '#151C1F',

  // Brand
  bottle: '#3FB489',
  brandLit: '#5FD3A6',
  brandDark: '#2E9A73',
  onBrand: '#04231A',
  needle: '#F0654A',
  amber: '#E0A43A',

  radius: 16,
  radiusSm: 12,
  gap: 12,
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
} as const;

export const shipTone = (m: 'SHIP' | 'RETURN') => (m === 'SHIP' ? T.amber : T.bottle);

/** iOS and Android do not share a shadow model, so emit both and tune to match. */
export function shadow(level: 1 | 2 | 3 = 2, color = '#000'): ViewStyle {
  const cfg = {
    1: { h: 2, o: 0.34, r: 6, e: 3 },
    2: { h: 10, o: 0.46, r: 18, e: 8 },
    3: { h: 22, o: 0.6, r: 34, e: 16 },
  }[level];
  return Platform.select<ViewStyle>({
    ios: {
      shadowColor: color,
      shadowOffset: { width: 0, height: cfg.h },
      shadowOpacity: cfg.o,
      shadowRadius: cfg.r,
    },
    android: { elevation: cfg.e, shadowColor: color },
    default: {},
  })!;
}

/**
 * The light in the room.
 *
 * Two pre-rendered radial glows, keyed off the top-left and filled from the
 * lower right, plus a grain tile. Rendered once behind everything and never
 * re-rendered, so it costs one composite.
 */
export function Aurora({ intensity = 1 }: { intensity?: number }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: T.zinc }]} />
      <Image
        source={require('../assets/glow-green.png')}
        resizeMode="stretch"
        style={{
          position: 'absolute', top: -230, left: -190, width: 560, height: 520,
          opacity: 0.5 * intensity,
        }}
      />
      <Image
        source={require('../assets/glow-teal.png')}
        resizeMode="stretch"
        style={{
          position: 'absolute', top: 180, right: -220, width: 520, height: 560,
          opacity: 0.34 * intensity,
        }}
      />
      <Image
        source={require('../assets/grain.png')}
        resizeMode="repeat"
        style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
      />
    </View>
  );
}

/** The specular top edge. One pixel, and most of why a panel looks machined. */
export function Edge({ inset = 12, opacity = 1 }: { inset?: number; opacity?: number }) {
  return (
    <LinearGradient
      colors={['transparent', T.edgeLit, 'transparent']}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
      style={{
        position: 'absolute', top: 0, left: inset, right: inset, height: 1, opacity,
      }}
      pointerEvents="none"
    />
  );
}

export function Surface({
  children, style, level = 2, lit = true, radius = T.radius, tint,
}: {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  level?: 1 | 2 | 3;
  lit?: boolean;
  radius?: number;
  /** A brand-tinted surface for the one thing on screen that matters most. */
  tint?: string;
}) {
  return (
    <View style={[{ borderRadius: radius }, shadow(level), style]}>
      <LinearGradient
        colors={tint ? [tint, 'transparent'] : [T.panelTop, T.panelBot]}
        start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }}
        style={{
          borderRadius: radius,
          borderWidth: 1,
          borderColor: tint ? 'rgba(63,180,137,0.28)' : T.rule,
          overflow: 'hidden',
          backgroundColor: tint ? T.panelBot : undefined,
        }}
      >
        {lit && <Edge inset={radius * 0.7} />}
        {children}
      </LinearGradient>
    </View>
  );
}

/**
 * The primary control.
 *
 * A gradient body, a bright top edge, and a shadow in the button's own colour
 * so the light it throws matches the light it is made of. It also dips 2% on
 * press with a haptic — on a phone that is the whole of the feedback loop, and
 * a driver in gloves needs to feel that the tap registered.
 */
export function Btn({
  label, onPress, disabled, variant = 'primary', style, tone, busy, sub,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'quiet';
  style?: StyleProp<ViewStyle>;
  tone?: string;
  busy?: boolean;
  sub?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 3 }).start();

  const brand = tone ?? T.bottle;
  const lit = tone ? tone : T.brandLit;
  const isPrimary = variant === 'primary';

  const body = (
    <>
      {isPrimary && <Edge inset={16} opacity={0.9} />}
      <Text
        style={{
          color: isPrimary ? T.onBrand : variant === 'ghost' ? T.ink : T.steel,
          fontSize: 16,
          fontWeight: '700',
          letterSpacing: -0.2,
        }}
      >
        {busy ? 'Working…' : label}
      </Text>
      {sub ? (
        <Text
          style={{
            color: isPrimary ? 'rgba(4,35,26,0.66)' : T.faint,
            fontSize: 11.5, marginTop: 1, fontWeight: '600',
          }}
        >
          {sub}
        </Text>
      ) : null}
    </>
  );

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        onPress={() => {
          if (disabled || busy) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress?.();
        }}
        onPressIn={() => !disabled && spring(0.98)}
        onPressOut={() => spring(1)}
        disabled={disabled || busy}
        // 56pt: comfortably past the 44pt floor, because this gets pressed
        // with a glove on.
        style={{ opacity: disabled ? 0.38 : 1, minHeight: 56 }}
      >
        {isPrimary ? (
          <LinearGradient
            colors={[lit, brand, T.brandDark]}
            locations={[0, 0.55, 1]}
            start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
            style={[
              {
                minHeight: 56, borderRadius: T.radiusSm,
                alignItems: 'center', justifyContent: 'center',
              },
              shadow(2, brand),
            ]}
          >
            {body}
          </LinearGradient>
        ) : (
          <View
            style={{
              minHeight: 56, borderRadius: T.radiusSm,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: variant === 'ghost' ? 'rgba(255,255,255,0.055)' : 'transparent',
              borderWidth: 1,
              borderColor: variant === 'ghost' ? 'rgba(255,255,255,0.12)' : T.rule,
            }}
          >
            {body}
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** A lit status dot. The glow ring is what makes it read as an indicator. */
export function Dot({ tone, size = 8 }: { tone: string; size?: number }) {
  return (
    <View
      style={[
        {
          width: size, height: size, borderRadius: size / 2,
          backgroundColor: tone,
        },
        Platform.OS === 'ios'
          ? { shadowColor: tone, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }
          : {},
      ]}
    />
  );
}

export function Tag({ label, tone }: { label: string; tone: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
        backgroundColor: tone + '24', borderWidth: 1, borderColor: tone + '3D',
      }}
    >
      <Text style={{ color: tone, fontSize: 10.5, fontWeight: '800', letterSpacing: 0.4, fontFamily: T.mono }}>
        {label}
      </Text>
    </View>
  );
}

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      style={[
        { color: T.faint, fontSize: 10, fontWeight: '800', letterSpacing: 1.6, textTransform: 'uppercase' },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Hairline({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <LinearGradient
      colors={['transparent', T.rule, 'transparent']}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
      style={[{ height: 1 }, style]}
    />
  );
}

/** Entrance. 40ms apart, once, and never on a list that scrolls. */
export function Rise({
  children, delay = 0, style,
}: { children: React.ReactNode; delay?: number; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(v, {
      toValue: 1, duration: 420, delay, useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [delay, v]);
  return (
    <Animated.View
      style={[
        {
          opacity: v,
          transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

export const mono = (size: number, weight: TextStyle['fontWeight'] = '600'): TextStyle => ({
  fontFamily: T.mono, fontSize: size, fontWeight: weight, letterSpacing: -0.2,
});
