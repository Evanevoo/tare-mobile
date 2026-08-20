import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleProp, ViewStyle, TextStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { T, Eyebrow, Icon, ICON, mono, tint, wash } from '@/ui';

/**
 * Form parts, shared by Add and Edit so the two screens cannot drift.
 *
 * Everything here assumes a person outdoors, one-handed, wearing gloves, in
 * daylight. That has consequences: nothing is smaller than 46pt, no control
 * depends on a long press, and no value is ever entered twice when the app
 * already knows it.
 *
 * The recurring idea is the chip row. A yard has maybe eleven product codes
 * and nine shelves, and every one of them is already in the data. Offering
 * those as chips — commonest first, with a marked escape hatch — is the
 * difference between a fleet with one `20LB` and a fleet with `20LB`, `20 LB`
 * and `20lb` priced as three separate things.
 */

export const fieldStyle = {
  minHeight: 52,
  borderRadius: T.radiusSm,
  paddingHorizontal: 15,
  paddingVertical: 13,
  color: T.ink,
  fontSize: 16,
  backgroundColor: tint(0.05),
  borderWidth: 1,
  borderColor: T.rule,
} as const;

export function Field({
  label, hint, children, style,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ marginTop: 22 }, style]}>
      <Eyebrow style={{ marginBottom: hint ? 4 : 10 }}>{label}</Eyebrow>
      {!!hint && (
        <Text style={{ color: T.faint, fontSize: 12.5, lineHeight: 18, marginBottom: 10 }}>
          {hint}
        </Text>
      )}
      {children}
    </View>
  );
}

export function TextField({
  value, onChangeText, placeholder, code, ...rest
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  /** Render as a code: monospaced, uppercase, no autocorrect. */
  code?: boolean;
} & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'onChangeText' | 'placeholder' | 'style'>) {
  return (
    <TextInput
      value={value}
      onChangeText={code ? (v) => onChangeText(v.toUpperCase()) : onChangeText}
      placeholder={placeholder}
      placeholderTextColor={T.faint}
      autoCapitalize={code ? 'characters' : 'words'}
      autoCorrect={false}
      style={[fieldStyle, code ? mono(15.5, '600') : null]}
      {...rest}
    />
  );
}

/**
 * Pick one of what already exists, or type something new.
 *
 * The escape hatch is deliberately a separate, quieter action rather than a
 * text box sitting open next to the chips: a box invites typing, and typing is
 * how the list fragments. Once the list is empty there is nothing to pick, so
 * the box opens on its own and the toggle disappears.
 */
export function Chips({
  options, value, onChange, placeholder, code = true, freeLabel = 'Something else',
}: {
  options: { key: string; sub?: string }[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  code?: boolean;
  freeLabel?: string;
}) {
  const known = useMemo(() => new Set(options.map((o) => o.key)), [options]);
  // Opens typed if the current value is not one of the offered options — which
  // is the case on Edit whenever the record predates the list.
  const [free, setFree] = useState(() => !options.length || (!!value && !known.has(value)));
  const [q, setQ] = useState('');

  /*
    A VALUE THAT ARRIVES LATE STILL HAS TO BE VISIBLE.

    The line above runs once, at mount, which was fine while every caller had
    its value in hand by then. It is not fine now: Edit seeds the form from a
    server lookup when the barcode is not in the phone's copy of the fleet, so
    the record lands AFTER this component mounted. If that value is not one of
    the chips, list mode has no chip to light up and the field reads as empty —
    the screen would be showing "no gas type" over a cylinder that has one, and
    saving would then clear it.
  */
  useEffect(() => {
    if (value && !known.has(value)) setFree(true);
  }, [value, known]);

  /**
   * A LONG LIST GETS A SEARCH BOX; A SHORT ONE DOES NOT.
   *
   * Callers used to hand this component `.slice(0, 14)` and the rest of the
   * org's products and locations simply did not exist on the phone. For
   * WeldCor that was invisible — they have fewer than fourteen of each. For
   * the next customer up it is a silent data-entry bug: the picker looks
   * complete, offers the wrong answers, and the free-text escape hatch
   * quietly fragments the list with near-duplicates of options that were
   * there all along, fifteenth in the array.
   *
   * So the ceiling moves from the CALLER to here, and stops being a ceiling:
   * past `LONG` options a filter box appears and every option is reachable
   * by typing. Under it, nothing changes — a search box over six chips is
   * furniture, and this screen is used in gloves.
   *
   * The current selection is always kept in view even when it does not match
   * the filter, because a picker that hides what you already chose reads as
   * having lost it.
   */
  const LONG = 12;
  const searchable = options.length > LONG;
  const shown = useMemo(() => {
    if (!searchable) return options;
    const needle = q.trim().toUpperCase();
    const hits = needle
      ? options.filter((o) =>
          o.key.toUpperCase().includes(needle) || (o.sub ?? '').toUpperCase().includes(needle))
      : options;
    const head = hits.slice(0, LONG);
    if (value && !head.some((o) => o.key === value)) {
      const sel = options.find((o) => o.key === value);
      if (sel) return [sel, ...head.slice(0, LONG - 1)];
    }
    return head;
  }, [options, q, value, searchable]);

  if (free) {
    return (
      <View>
        <TextField value={value} onChangeText={onChange} placeholder={placeholder} code={code} />
        {options.length > 0 && (
          <Toggle label="Pick from the list" onPress={() => { setFree(false); onChange(''); }} />
        )}
      </View>
    );
  }

  return (
    <View>
      {searchable && (
        <View style={{ marginBottom: 10 }}>
          <TextField
            value={q}
            onChangeText={setQ}
            placeholder={`Search ${options.length}…`}
            code={false}
            autoCapitalize="characters"
          />
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
        {shown.map((o) => {
          const on = value === o.key;
          return (
            <Pressable
              key={o.key}
              onPress={() => { onChange(o.key); Haptics.selectionAsync(); }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.sub ? `${o.key}, ${o.sub}` : o.key}
              style={{
                minHeight: 46,
                justifyContent: 'center',
                paddingHorizontal: 15,
                paddingVertical: 8,
                borderRadius: T.radiusSm,
                backgroundColor: on ? wash(0.16) : tint(0.045),
                borderWidth: 1,
                borderColor: on ? wash(0.45) : T.rule,
              }}
            >
              <Text
                style={[
                  code ? mono(14, '700') : { fontSize: 14.5, fontWeight: '700' },
                  { color: on ? T.brandLit : T.steel },
                ]}
              >
                {o.key}
              </Text>
              {!!o.sub && (
                <Text style={{ color: T.faint, fontSize: 10.5, marginTop: 2 }}>{o.sub}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      {/* Without this, filtering to nothing looks identical to an org with no
          products configured — and the answer to each is different. */}
      {searchable && shown.length === 0 && (
        <Text style={{ color: T.faint, fontSize: 12.5, marginTop: 4 }}>
          Nothing matches “{q.trim()}”. Clear the box to see all {options.length}, or use “{freeLabel}”.
        </Text>
      )}
      <Toggle label={freeLabel} onPress={() => { setFree(true); onChange(''); }} />
    </View>
  );
}

function Toggle({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={12} accessibilityRole="button" style={{ minHeight: 30, justifyContent: 'center' }}>
      <Text style={{ color: T.brandLit, fontSize: 13, fontWeight: '700', marginTop: 10 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A segmented control. Two or three options, never more — this is a thumb. */
export function Choice<V extends string>({
  options, value, onChange, tone = T.brandLit,
}: {
  options: { value: V; label: string; sub?: string }[];
  value: V | null;
  onChange: (v: V) => void;
  tone?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 9 }}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => { onChange(o.value); Haptics.selectionAsync(); }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              minHeight: 58,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 6,
              paddingVertical: 10,
              borderRadius: T.radiusSm,
              backgroundColor: on ? withAlpha(tone, 0.16) : tint(0.04),
              borderWidth: 1,
              borderColor: on ? withAlpha(tone, 0.5) : T.rule,
            }}
          >
            <Text
              style={{
                color: on ? tone : T.steel,
                fontSize: 14.5,
                fontWeight: '800',
                letterSpacing: 0.2,
                textAlign: 'center',
              }}
            >
              {o.label}
            </Text>
            {!!o.sub && (
              <Text style={{ color: T.faint, fontSize: 10.5, marginTop: 3, textAlign: 'center' }}>
                {o.sub}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A date, typed as digits.
 *
 * No wheel picker. Requalification runs five and ten years out, and spinning a
 * wheel sixty clicks into 2036 in a yard is worse than typing eight digits.
 * The dashes are inserted as you go, and the common intervals are one tap —
 * which is what actually gets used, because these dates are almost always
 * "today plus the cycle".
 */
export function DateField({
  value, onChange, quick = [1, 5, 10],
}: {
  value: string;
  onChange: (v: string) => void;
  quick?: number[];
}) {
  const bad = value.length === 10 && !isRealDate(value);

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={(v) => onChange(maskDate(v))}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={T.faint}
        keyboardType="number-pad"
        maxLength={10}
        accessibilityLabel="Date, year month day"
        style={[
          fieldStyle,
          mono(15.5, '600'),
          bad ? { borderColor: 'rgba(240,101,74,0.5)' } : null,
        ]}
      />
      {bad && (
        <Text style={{ color: T.needle, fontSize: 12.5, marginTop: 7 }}>
          There is no such day. Check the month and the day.
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {quick.map((y) => (
          <Pressable
            key={y}
            onPress={() => { onChange(yearsFromToday(y)); Haptics.selectionAsync(); }}
            accessibilityRole="button"
            style={{
              minHeight: 40, justifyContent: 'center', paddingHorizontal: 13,
              borderRadius: T.radiusSm, borderWidth: 1, borderColor: T.rule,
              backgroundColor: tint(0.04),
            }}
          >
            <Text style={{ color: T.steel, fontSize: 13, fontWeight: '700' }}>+{y} yr</Text>
          </Pressable>
        ))}
        {!!value && (
          <Pressable
            onPress={() => onChange('')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear date"
            style={{
              minHeight: 40, justifyContent: 'center', paddingHorizontal: 13,
              borderRadius: T.radiusSm,
            }}
          >
            <Text style={{ color: T.faint, fontSize: 13, fontWeight: '700' }}>Clear</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** A line that explains a rule rather than reporting a failure. */
export function Note({
  text, action, onAction, tone = T.steel, icon = 'info',
}: {
  text: string;
  action?: string;
  onAction?: () => void;
  tone?: string;
  icon?: React.ComponentProps<typeof Icon>['name'];
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 11,
        marginTop: 16,
        padding: 14,
        borderRadius: T.radiusSm,
        backgroundColor: tint(0.035),
        borderWidth: 1,
        borderColor: T.rule,
      }}
    >
      <View style={{ marginTop: 2 }}>
        <Icon name={icon} size={ICON.sm} color={tone} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: T.steel, fontSize: 13, lineHeight: 19 }}>{text}</Text>
        {!!action && (
          <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" style={{ minHeight: 32, justifyContent: 'center' }}>
            <Text style={{ color: T.brandLit, fontSize: 13, fontWeight: '700', marginTop: 6 }}>
              {action}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

export function maskDate(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}

/**
 * A real day, not merely eight digits.
 *
 * `new Date('2026-02-30')` rolls forward to March 2nd rather than failing, so
 * round-tripping is the only honest check.
 */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function yearsFromToday(y: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + y);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** #rrggbb → rgba(). The tokens are hex; the selected states need alpha. */
export function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const STATUS_LABEL: Record<string, string> = {
  available: 'In service',
  rented: 'Out',
  maintenance: 'Needs work',
  lost: 'Lost',
  retired: 'Retired',
};
