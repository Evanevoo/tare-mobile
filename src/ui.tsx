import { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, Pressable, Animated, Platform, StyleSheet, AccessibilityInfo,
  type ViewStyle, type TextStyle, type StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { DARK, LIGHT } from '@/theme';

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

/**
 * The palette is mutable on purpose. Every screen reads `T.zinc` inline at
 * render, so swapping the object's contents and remounting the tree (the root
 * does both, in applyPalette below) re-themes the whole app without a single
 * screen knowing a theme exists. The measurements live in theme.ts.
 */
export const T = {
  ...DARK,
  radius: 16,
  radiusSm: 12,
  gap: 12,
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
};

/** Called by the root before it renders, never during a frame. */
export function applyPalette(mode: 'light' | 'dark') {
  Object.assign(T, mode === 'light' ? LIGHT : DARK);
}

/**
 * A wash of the room's own light — white over a dark floor, ink over paper.
 * Every "slightly raised" surface in the app is one of these. Hardcoding
 * rgba(255,255,255,…) is how a dark app looks broken the first time somebody
 * turns the lights on: the lift simply disappears.
 */
export const tint = (a: number) =>
  (T.statusBar === 'dark' ? `rgba(16,23,26,${a})` : `rgba(255,255,255,${a})`);

/** The same idea in the brand's colour, for a selected chip or segment. */
export const wash = (a: number, hex: string = T.bottle) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const shipTone = (m: 'SHIP' | 'RETURN') => (m === 'SHIP' ? T.amber : T.bottle);

/** iOS and Android do not share a shadow model, so emit both and tune to match. */
export function shadow(level: 1 | 2 | 3 = 2, color?: string): ViewStyle {
  // On paper the same opacities read as soot, so the light palette both tints
  // the shadow and thins it.
  const paper = T.statusBar === 'dark';
  const cfg = {
    1: { h: 2, o: paper ? 0.10 : 0.34, r: 6, e: 3 },
    2: { h: 10, o: paper ? 0.13 : 0.46, r: 18, e: 8 },
    3: { h: 22, o: paper ? 0.17 : 0.6, r: 34, e: 16 },
  }[level];
  color = color ?? T.shadowInk;
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
      {/* On paper these read as stains rather than light, so the palette turns
          them most of the way down and leaves a tint of the brand behind. */}
      <Image
        source={require('../assets/glow-green.png')}
        resizeMode="stretch"
        style={{
          position: 'absolute', top: -230, left: -190, width: 560, height: 520,
          opacity: 0.5 * intensity * T.glow,
        }}
      />
      <Image
        source={require('../assets/glow-teal.png')}
        resizeMode="stretch"
        style={{
          position: 'absolute', top: 180, right: -220, width: 520, height: 560,
          opacity: 0.34 * intensity * T.glow,
        }}
      />
      <Image
        source={require('../assets/grain.png')}
        resizeMode="repeat"
        style={[StyleSheet.absoluteFill, { opacity: 0.5 * T.glow }]}
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
        accessibilityRole="button"
        accessibilityLabel={sub ? `${label}. ${sub}` : label}
        accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
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
              backgroundColor: variant === 'ghost' ? tint(0.055) : 'transparent',
              borderWidth: 1,
              borderColor: variant === 'ghost' ? tint(0.12) : T.rule,
            }}
          >
            {body}
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Icons are vectors, never glyphs.
 *
 * The first pass used Unicode symbols — the kind of thing that looks fine in an
 * editor and renders as an empty box on somebody's Android. A vector set scales,
 * themes, and is the same shape on every handset in the fleet.
 *
 * Sizes are tokens rather than numbers at the call site, because mixing 20, 24
 * and 28 across screens is one of the loudest tells of an unfinished app.
 */
export const ICON = { sm: 16, md: 20, lg: 24, xl: 30 } as const;

export function Icon({
  name, size = ICON.md, color = T.steel,
}: {
  name: React.ComponentProps<typeof Feather>['name'];
  size?: number;
  color?: string;
}) {
  return <Feather name={name} size={size} color={color} />;
}

/**
 * Every screen starts here.
 *
 * Carries the light, and — more importantly — the safe area. Hard-coded top
 * padding is right on exactly one phone; on anything with a Dynamic Island the
 * first line of the header ends up underneath it.
 */
export function Screen({
  children, intensity = 1, pad = 0,
}: { children: React.ReactNode; intensity?: number; pad?: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      <Aurora intensity={intensity} />
      <View style={{ flex: 1, paddingTop: insets.top + pad }}>{children}</View>
    </View>
  );
}

export function useBottomInset(extra = 0) {
  const insets = useSafeAreaInsets();
  return insets.bottom + extra;
}

/**
 * Whether the person has asked the system to calm things down. Honoured by
 * every entrance in this file — a driver who turned this on in Accessibility
 * did it for a reason.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduced(v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return reduced;
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
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) { v.setValue(1); return; }
    const a = Animated.timing(v, {
      toValue: 1, duration: 420, delay, useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [delay, v, reduced]);
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
