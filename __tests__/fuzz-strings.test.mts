/**
 * node --experimental-strip-types __tests__/fuzz-strings.test.mts
 *
 * Seeded fuzzing of everything that reads a barcode, a typed code or a label
 * off the server: src/formats.ts (the org's number rules), the code
 * normalisers in batch.ts / scan-match.ts / history.ts, OCR candidate picking
 * (ocr.ts), the hold notice (hold.ts) and displayLogin (who.ts).
 *
 * Inputs are hostile on purpose: control characters, lone surrogates, emoji,
 * right-to-left marks, every regex metacharacter, and strings up to 10,000
 * characters. Every call is timed; one taking more than 50 ms fails the run
 * (that is what catastrophic regex backtracking looks like).
 */
import { matchesFormat, formatExample, formatNudge, barcodeRefusal } from '../src/formats.ts';
import { normalizeCode, serialKey, whyRefused, addRow, editRow, removeRow, applyResult, type BatchRow } from '../src/batch.ts';
import { key, classify, explainMiss } from '../src/scan-match.ts';
import { orderKey } from '../src/history.ts';
import { candidatesFrom, matchKnown } from '../src/ocr.ts';
import { holdNotice, holdFor } from '../src/hold.ts';
import { displayLogin, CREW_DOMAIN } from '../src/who.ts';
import { decodeParam } from '../src/route-param.ts';
import { prng, seedFromEnv, harness, iters, messyString, fromAlphabet, show, type Rng } from './fuzz-kit.mts';

const SEED = seedFromEnv(0xba5c0de);
const h = harness('fuzz-strings.test.mts', SEED);
const r = prng(SEED);

const LITERALS = '-./ S0123XYZ()[]{}^$|?+\\_:';
const DIGITS = '0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A rule an office manager might write: tokens and literal characters. */
function genAlt(rr: Rng): string {
  const n = rr.range(1, 12);
  let s = '';
  for (let i = 0; i < n; i++) s += rr.bool(0.7) ? rr.pick(['#', 'A', 'a', '*']) : rr.pick(LITERALS.split(''));
  return s.trim() || '#';
}

/** A value that fits `alt` by construction. */
function fitting(rr: Rng, alt: string): string {
  let v = '';
  for (const ch of alt.trim()) {
    if (ch === '#') v += rr.pick(DIGITS.split(''));
    else if (ch === 'A' || ch === 'a') v += rr.pick(LETTERS.split(''));
    else if (ch === '*') v += rr.pick((DIGITS + LETTERS).split(''));
    else v += rr.bool() ? ch.toLowerCase() : ch.toUpperCase();
  }
  return v;
}

const anyPattern = (rr: Rng): string | null | undefined => {
  const k = rr.int(10);
  if (k === 0) return null;
  if (k === 1) return undefined;
  if (k === 2) return messyString(rr);
  if (k === 3) return rr.pick(['', ' ', ',', ', ,', ',,,', '\t,\n']);
  return Array.from({ length: rr.range(1, 4) }, () => (rr.bool(0.85) ? genAlt(rr) : messyString(rr, rr.range(0, 8)))).join(rr.pick([',', ', ', ' ,']));
};

h.section('matchesFormat / formatExample / formatNudge / barcodeRefusal — never throw, never slow');
h.prop('random values against random patterns', iters(6000), () => {
  const v = messyString(r);
  const p = anyPattern(r);
  const m = h.timed(`matchesFormat(${v.length} chars, ${show(p, 40)})`, () => matchesFormat(v, p));
  if (typeof m !== 'boolean') return `non-boolean ${m}`;
  const eg = h.timed('formatExample', () => formatExample(p));
  if (typeof eg !== 'string') return 'example not a string';
  for (const typing of [true, false]) {
    const n = h.timed('formatNudge', () => formatNudge(v, p, 'barcodes', typing));
    if (n !== null && (typeof n !== 'string' || /undefined|null|NaN/.test(n.replace(v, '')))) return `bad nudge ${show(n)}`;
  }
  const refusal = h.timed('barcodeRefusal', () => barcodeRefusal(v, p, false));
  if (refusal !== null && /undefined|NaN/.test(refusal)) return `bad refusal ${show(refusal)}`;
  if (barcodeRefusal(v, p, true) !== null) return 'a known barcode was refused';
  // The refusal says exactly what matchesFormat says, for a non-blank value.
  if (v.trim() && (refusal === null) !== matchesFormat(v.trim(), p)) return `refusal disagrees with matchesFormat for ${show(v)} / ${show(p)}`;
  return null;
});

h.prop('a rule with no alternatives accepts everything', iters(2000), () => {
  const p = r.pick(['', ' ', ',', ' , ,', null, undefined, '　', '﻿, ']);
  const v = messyString(r);
  if (!matchesFormat(v, p)) return `rejected ${show(v)} under ${show(p)}`;
  if (barcodeRefusal(v, p, false) !== null) return 'refused under no rule';
  if (formatNudge(v, p, 'x', false) !== null) return 'nudged under no rule';
  return null;
});

h.prop('a value built to fit any alternative matches (padded, any case, among others)', iters(8000), () => {
  const alts = Array.from({ length: r.range(1, 4) }, () => genAlt(r));
  const which = r.pick(alts);
  const v = (r.bool(0.3) ? '  ' : '') + fitting(r, which) + (r.bool(0.3) ? '\t' : '');
  const p = alts.join(',');
  if (!matchesFormat(v, p)) return `${show(v)} should fit ${show(p)}`;
  if (barcodeRefusal(v, p, false) !== null) return `refused a fitting code ${show(v)} for ${show(p)}`;
  if (formatNudge(v, p, 'x', false) !== null) return 'nudged a fitting code';
  return null;
});

h.prop('a value whose length fits no alternative never matches', iters(8000), () => {
  const p = anyPattern(r);
  const lens = new Set((p ?? '').split(',').map((a) => a.trim().length).filter((n) => n > 0));
  if (!lens.size) return null;
  const v = messyString(r).trim();
  if (lens.has(v.length) || !v) return null;
  if (matchesFormat(v, p)) return `${show(v)} (len ${v.length}) matched ${show(p)} (lens ${[...lens]})`;
  return null;
});

h.prop('metacharacters in a rule are literal ("1.2" does not take "1x2")', iters(4000), () => {
  const meta = r.pick('.()[]{}^$|?+\\'.split(''));
  const alt = `${fromAlphabet(r, '0123', r.range(0, 3))}${meta}${fromAlphabet(r, '0123', r.range(0, 3))}`;
  if (!matchesFormat(alt, alt)) return `${show(alt)} does not match itself`;
  const swapped = alt.replace(meta, 'x');
  if (matchesFormat(swapped, alt)) return `${show(swapped)} matched rule ${show(alt)}`;
  return null;
});

h.prop('a digit slot refuses a letter, a letter slot refuses a digit', iters(4000), () => {
  const alt = fromAlphabet(r, '#A', r.range(1, 10));
  const v = fitting(r, alt).split('');
  const i = r.int(v.length);
  v[i] = alt[i] === '#' ? r.pick(LETTERS.split('')) : r.pick(DIGITS.split(''));
  if (matchesFormat(v.join(''), alt)) return `${show(v.join(''))} matched ${alt}`;
  return null;
});

h.prop('the example shown for a rule is accepted by that rule', iters(6000), () => {
  const p = r.bool(0.8) ? Array.from({ length: r.range(1, 3) }, () => genAlt(r)).join(', ') : messyString(r, r.range(0, 30));
  const eg = formatExample(p);
  if (!eg) return null;
  if (!matchesFormat(eg, p)) return `example ${show(eg)} does not fit its own rule ${show(p)}`;
  return null;
});

h.prop('typing grace: quiet below the shortest alternative while typing, speaks once settled', iters(4000), () => {
  const alt = genAlt(r);
  const shortest = alt.trim().length;
  if (shortest < 2) return null;
  const v = fitting(r, alt).slice(0, r.range(1, shortest - 1)).trim();
  if (!v) return null;
  if (formatNudge(v, alt, 'orders', true) !== null) return `nudged mid-typing ${show(v)} for ${show(alt)}`;
  if (formatNudge(v, alt, 'orders', false) === null) return `a too-short settled value ${show(v)} passed ${show(alt)}`;
  return null;
});

h.section('Normalisers — idempotent, total, never slow');
h.prop('normalizeCode / serialKey / key / orderKey are idempotent and never throw', iters(8000), () => {
  const x = messyString(r);
  const n1 = h.timed('normalizeCode', () => normalizeCode(x));
  if (normalizeCode(n1) !== n1) return `normalizeCode not idempotent on ${show(x)}`;
  if (/\s/.test(n1)) return `normalizeCode left whitespace in ${show(n1)}`;
  const s1 = serialKey(x);
  if (s1 !== null && (serialKey(s1) !== s1 || s1 !== s1.trim())) return `serialKey not idempotent on ${show(x)}`;
  if (s1 === null && x.trim()) return `serialKey dropped a non-blank serial ${show(x)}`;
  const k1 = key(x);
  if (key(k1) !== k1 || !/^[A-Z0-9]*$/.test(k1)) return `key() bad on ${show(x)} -> ${show(k1)}`;
  const o1 = orderKey(x);
  if (orderKey(o1) !== o1) return `orderKey not idempotent on ${show(x)}`;
  if (serialKey(null) !== null || serialKey(undefined) !== null) return 'serialKey(null) not null';
  return null;
});

h.prop('decodeParam always returns a string', iters(2000), () => {
  const raw = r.pick([undefined, messyString(r), [], [messyString(r)], [undefined as unknown as string], ['a', 'b']]);
  const out = decodeParam(raw as string | string[] | undefined);
  if (typeof out !== 'string') return `got ${typeof out}`;
  if (out === 'undefined') return `${show(raw)} decoded to the word "undefined"`;
  return null;
});

h.section('Batch add — the 500-row list');
h.prop('rows stay unique by barcode and by serial, whatever is typed', iters(1500), () => {
  let rows: BatchRow[] = [];
  const fleet = {
    has: (b: string) => b === 'ON-FLEET',
    serialHeldBy: (s: string) => (s === 'SN-TAKEN' ? 'OTHER-BC' : null),
  };
  const code = () => r.pick(['b1', ' B1 ', 'B 1', 'b2', 'ON-FLEET', '', '  ', messyString(r, r.range(0, 6))]);
  const serial = () => r.pick(['', ' ', 'sn1', 'SN1 ', 'sn-taken', 'sn2', messyString(r, r.range(0, 5))]);
  for (let i = 0; i < r.range(1, 40); i++) {
    const k = r.int(10);
    if (k < 6) {
      const c = addRow(rows, { id: `r${i}`, barcode: code(), serial: serial() }, fleet);
      if (c.refused && c.rows !== rows) return 'refused but rows changed';
      rows = c.rows;
    } else if (k < 8 && rows.length) {
      const c = editRow(rows, r.pick(rows).id, r.bool() ? { barcode: code() } : { serial: serial() }, fleet);
      if (c.refused && c.rows !== rows) return 'edit refused but rows changed';
      rows = c.rows;
    } else if (k < 9 && rows.length) {
      rows = removeRow(rows, r.pick(rows).id);
    } else if (rows.length) {
      rows = applyResult(rows, { created: 0, createdBarcodes: [r.pick(rows).barcode.toLowerCase()], skipped: [], invalid: [] });
    }
    const bcs = rows.map((x) => x.barcode);
    if (new Set(bcs).size !== bcs.length) return `duplicate barcode in batch: ${show(bcs)}`;
    if (bcs.some((b) => !b || b !== normalizeCode(b))) return `blank or unnormalised barcode: ${show(bcs)}`;
    if (bcs.includes('ON-FLEET')) return 'a fleet barcode got into the batch';
    const sks = rows.map((x) => serialKey(x.serial)).filter((s) => s !== null);
    if (new Set(sks).size !== sks.length) return `duplicate serial in batch: ${show(sks)}`;
    if (sks.includes('SN-TAKEN')) return 'a serial held on the fleet got into the batch';
    if (rows.length && whyRefused(rows[0].barcode, rows, fleet)?.reason !== 'in-batch') return 'whyRefused missed an in-batch code';
  }
  return null;
});

h.section('Scan classification and OCR candidates');
{
  const boot = (rr: Rng) => ({
    assets: Object.fromEntries(Array.from({ length: rr.range(0, 6) }, () => [fromAlphabet(rr, 'AB12-', rr.range(1, 4)), { p: 'P' }])),
    customers: Array.from({ length: rr.range(0, 6) }, (_, i) => ({
      customerListId: rr.pick(['C-1', 'c1', 'C 2', '*C3*', messyString(rr, 3)]) + (rr.bool() ? '' : String(i)),
      name: `Cust ${i}`,
      bc: rr.bool(0.6) ? rr.pick(['*C-1*', 'c1', '*C3*', 'AB', messyString(rr, 4)]) : null,
    })),
    org: { assetLabel: 'cylinder' },
  }) as any;

  h.prop('classify / explainMiss never throw; an asset hit is a real asset; a customer hit is unambiguous', iters(6000), () => {
    const b = r.bool(0.1) ? null : boot(r);
    const raw = r.bool(0.5) ? messyString(r) : r.pick([...Object.keys(b?.assets ?? {}), 'c1', ' *c-1* ', 'C3', 'ab', '']);
    const t = h.timed('classify', () => classify(raw, b));
    h.timed('explainMiss', () => explainMiss(raw, b));
    if (!t) return raw.trim() ? `null for non-blank ${show(raw)}` : null;
    if (t.kind === 'asset' && !b?.assets?.[t.barcode]) return `asset ${t.barcode} not in the fleet`;
    if (t.kind === 'customer') {
      const c = b.customers.filter((x: any) => x.customerListId === t.id);
      if (!c.length) return `customer ${t.id} not on the phone`;
      const up = raw.trim().toUpperCase();
      const exact = b.customers.filter((x: any) => x.bc && x.bc.toUpperCase() === up);
      const loose = b.customers.filter((x: any) => (x.bc && key(x.bc) === key(up)));
      if (!exact.length && loose.length > 1) return `picked one of ${loose.length} customers sharing a card code`;
    }
    return null;
  });

  h.prop('candidatesFrom: 3-40 chars of [A-Z0-9-*], no repeats; matchKnown answers from the known set', iters(4000), () => {
    const lines = Array.from({ length: r.range(0, 6) }, () => (r.bool(0.1) ? '' : messyString(r)));
    const c = h.timed('candidatesFrom', () => candidatesFrom(lines));
    if (new Set(c).size !== c.length) return 'repeated candidate';
    const badC = c.find((x) => x.length < 3 || x.length > 40 || !/^[A-Z0-9*-]+$/.test(x));
    if (badC !== undefined) return `bad candidate ${show(badC)}`;
    const known = new Set(Array.from({ length: r.range(0, 6) }, () => (r.bool(0.5) && c.length ? r.pick(c) : messyString(r, r.range(0, 8)))));
    const m = h.timed('matchKnown', () => matchKnown(c, known));
    if (m !== null && !known.has(m)) return `matchKnown answered ${show(m)}, not in the known set`;
    const exact = c.find((x) => known.has(x));
    if (exact !== undefined && m === null) return `exact candidate ${show(exact)} not matched`;
    return null;
  });
}

h.section('Hold notice, login display');
h.prop('holdNotice: null for blank, label is the trimmed text, never throws on any type', iters(6000), () => {
  const raw: unknown = r.bool(0.8) ? messyString(r) : r.pick([null, undefined, 0, 1, {}, [], true, 'Hard Hold', ' do not SELL ', 'Soft Hold']);
  const n = h.timed('holdNotice', () => holdNotice(raw as string));
  if (typeof raw !== 'string' || !raw.trim()) return n === null ? null : `notice for ${show(raw)}`;
  if (!n) return `no notice for ${show(raw)}`;
  if (n.label !== raw.trim()) return 'label is not the trimmed text';
  const k = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (n.severe !== (k.includes('hard') || k.includes('donotsell') || k.includes('dontsell'))) return 'severity wrong';
  if (holdFor([{ customerListId: 'X', hold: raw }], 'X')?.label !== n.label) return 'holdFor disagrees';
  if (holdFor(null, 'X') !== null || holdFor([], '') !== null) return 'holdFor invented a hold';
  return null;
});

h.prop('displayLogin strips exactly the crew domain, and nothing else', iters(8000), () => {
  const user = r.bool(0.7) ? fromAlphabet(r, 'abc.t_-1', r.range(0, 8)) : messyString(r);
  const dom = r.pick([CREW_DOMAIN, CREW_DOMAIN.toUpperCase(), 'crew.scanified.co', 'example.com', `${CREW_DOMAIN}.evil.com`, `x${CREW_DOMAIN}`]);
  const raw: unknown = r.bool(0.9) ? `${r.bool(0.2) ? ' ' : ''}${user}@${dom}` : r.pick([null, undefined, '', 42]);
  const out = h.timed('displayLogin', () => displayLogin(raw as string));
  if (typeof out !== 'string') return 'not a string';
  const e = String(raw ?? '').trim();
  const tail = `@${CREW_DOMAIN}`;
  const crew = e.toLowerCase().endsWith(tail) && e.length > tail.length;
  // lastIndexOf: "a@crew.scanified.com@crew.scanified.com" -> "a@crew.scanified.com", which is right.
  const expected = crew ? e.slice(0, e.length - tail.length) : e;
  if (out !== expected) return `${show(raw)} -> ${show(out)}, expected ${show(expected)}`;
  return null;
});

h.done();
