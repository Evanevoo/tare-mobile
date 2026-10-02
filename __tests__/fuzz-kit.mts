/**
 * Shared pieces for the __tests__/fuzz-*.test.mts files. Not a test itself
 * (no `.test.` in the name, and not in the package.json chain).
 *
 * Deterministic on purpose: every fuzz file runs from a fixed default seed so
 * `npm test` is repeatable, and prints the seed it used. To explore further,
 * run one file with another seed:
 *
 *   FUZZ_SEED=12345 node --experimental-strip-types __tests__/fuzz-outbox.test.mts
 *   FUZZ_SEED=random node --experimental-strip-types __tests__/fuzz-outbox.test.mts
 *
 * FUZZ_SCALE multiplies every iteration count (default 1) for a longer soak.
 * No dependencies: fast-check is not installed in this repo, and the point of
 * the generator below is only to be small, seeded and reproducible.
 */

/** mulberry32 — tiny, fast, good enough to drive a fuzzer. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const range = (lo: number, hi: number) => lo + int(hi - lo + 1);
  const bool = (p = 0.5) => next() < p;
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)];
  return { next, int, range, bool, pick };
}
export type Rng = ReturnType<typeof prng>;

export function seedFromEnv(fallback: number): number {
  const raw = process.env.FUZZ_SEED;
  if (!raw) return fallback;
  if (raw === 'random') return (Math.random() * 2 ** 31) >>> 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n >>> 0 : fallback;
}

export const SCALE = Math.max(1, Number(process.env.FUZZ_SCALE) || 1);
export const iters = (n: number) => Math.round(n * SCALE);

/* ------------------------------------------------------------------ strings */

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUNCT = ' -_./,:;!@#$%^&*()[]{}|\\\'"`~<>?+=';
const REGEX_META = '.*+?^${}()|[]\\/';
const CONTROL = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f';
const SPACES = ['\t', '\n', '\r', ' ', ' ', '　', '​', '﻿', ' '];
const UNICODE = [
  'é', 'ß', 'ı', 'İ', 'ﬀ', 'Ω', 'Ж', '中', '１', '٣', '́', '‮', '‍',
  '😀', '👍🏽', '\ud800', '\udfff', '\u{1F9EA}', 'Å', 'ǅ', 'ﬁ',
];

/** One character from a deliberately hostile mix. */
export function messyChar(r: Rng): string {
  const roll = r.int(100);
  if (roll < 45) return r.pick(ASCII.split(''));
  if (roll < 60) return r.pick(PUNCT.split(''));
  if (roll < 68) return r.pick(REGEX_META.split(''));
  if (roll < 76) return r.pick(SPACES);
  if (roll < 84) return r.pick(CONTROL.split(''));
  return r.pick(UNICODE);
}

/** Length mostly short, sometimes long, rarely 10k. */
export function messyLen(r: Rng): number {
  const roll = r.int(1000);
  if (roll < 5) return 10_000;
  if (roll < 60) return r.range(50, 400);
  if (roll < 120) return 0;
  return r.range(1, 24);
}

export function messyString(r: Rng, len = messyLen(r)): string {
  let s = '';
  for (let i = 0; i < len; i++) s += messyChar(r);
  return s;
}

/** A string drawn from a given alphabet. */
export function fromAlphabet(r: Rng, alphabet: string, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[r.int(alphabet.length)];
  return s;
}

/** Anything at all, for "must not throw" on values typed as something narrower. */
export function anyValue(r: Rng, depth = 0): unknown {
  const roll = r.int(depth > 2 ? 9 : 12);
  switch (roll) {
    case 0: return null;
    case 1: return undefined;
    case 2: return r.bool();
    case 3: return r.pick([0, -0, 1, -1, NaN, Infinity, -Infinity, 2 ** 53, 1e308, 0.1]);
    case 4: return r.int(1e6);
    case 5: return messyString(r, r.range(0, 12));
    case 6: return '';
    case 7: return r.pick(['null', 'true', '{}', '[]', 'undefined', 'NaN', '0', '__proto__']);
    case 8: return messyString(r);
    case 9: return Array.from({ length: r.range(0, 4) }, () => anyValue(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = r.range(0, 4); i > 0; i--) o[r.pick(['a', 'user', 'email', 'id', 'x', messyString(r, 3)])] = anyValue(r, depth + 1);
      return o;
    }
  }
}

/* ------------------------------------------------------------------ harness */

export function harness(file: string, seed: number) {
  let passed = 0, failed = 0;
  const slow: string[] = [];
  const t0 = performance.now();
  console.log(`\n\x1b[1m${file}\x1b[0m  seed=${seed}  scale=${SCALE}`
    + `  (rerun: FUZZ_SEED=${seed} node --experimental-strip-types __tests__/${file})`);

  /** A property that held over N cases, or the first case that broke it. */
  const prop = (name: string, n: number, body: (i: number) => string | null | void) => {
    for (let i = 0; i < n; i++) {
      let why: string | null | void;
      try { why = body(i); } catch (e: any) { why = `threw ${e?.name ?? ''}: ${e?.message ?? e}`; }
      if (why) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m  case ${i}: ${why}`);
        return;
      }
    }
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}  (${n})`);
  };

  const ok = (name: string, c: boolean, d = '') => {
    if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    else { failed++; console.log(`  \x1b[31m✗ ${name}\x1b[0m ${d}`); }
  };

  /** Run fn, flag it if one call takes longer than limitMs (catastrophic regex, loops). */
  const timed = <T,>(label: string, fn: () => T, limitMs = 50): T => {
    let s = performance.now();
    const out = fn();
    let ms = performance.now() - s;
    if (ms > limitMs) {
      // Once more before blaming the code: a GC pause is not a backtracking regex.
      s = performance.now();
      fn();
      ms = Math.min(ms, performance.now() - s);
      if (ms > limitMs && slow.length < 20) slow.push(`${label}: ${ms.toFixed(1)} ms`);
    }
    return out;
  };

  const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

  const done = () => {
    if (slow.length) {
      failed++;
      console.log(`  \x1b[31m✗ slow calls (> limit)\x1b[0m\n    ${slow.join('\n    ')}`);
    }
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`\n${passed} passed, ${failed} failed  (${ms} ms, seed=${seed})`);
    process.exit(failed ? 1 : 0);
  };

  return { prop, ok, timed, section, done };
}

/** A short printable rendering of a fuzz input for failure messages. */
export const show = (v: unknown, max = 160): string => {
  let s: string;
  try { s = JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)) ?? String(v); }
  catch { s = String(v); }
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
};
