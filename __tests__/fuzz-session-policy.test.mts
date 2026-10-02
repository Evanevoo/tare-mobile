/**
 * node --experimental-strip-types __tests__/fuzz-session-policy.test.mts
 *
 * Seeded fuzzing of the small decision functions that run on every launch,
 * every sign-in and every tick of a timer:
 *
 *   offline-session.ts  parseStoredSession (random, truncated, huge, deep JSON),
 *                       sessionVerdict, verdictForEvent
 *   cache-owner.ts      ownerVerdict, ownedBy
 *   session-crypto.ts   decryptSession on garbage; encrypt/decrypt round trip
 *   update-policy.ts    shouldCheck, shouldCheckStore, bannerVisible,
 *                       storeBuildIsNewer, storeBannerVisible,
 *                       storeCheckWorthReporting — with hostile clocks
 *   deadline.ts         withDeadline / boundedFetch settle exactly once
 *   ulid.ts, when.ts, zoom-pref.ts, reticle.ts, locate-draft.ts
 */
import { parseStoredSession, sessionVerdict, verdictForEvent, type SessionCheck } from '../src/offline-session.ts';
import { ownerVerdict, ownedBy } from '../src/cache-owner.ts';
import { encryptSession, decryptSession } from '../src/session-crypto.ts';
import {
  shouldCheck, shouldCheckStore, bannerVisible, storeBuildIsNewer, storeBannerVisible,
  storeCheckWorthReporting, restartHint, statusLine, type Phase,
} from '../src/update-policy.ts';
import { withDeadline, boundedFetch, DeadlineError } from '../src/deadline.ts';
import { ulid, ulidTime } from '../src/ulid.ts';
import { localTime, localDay, dayLabel, whenLabel } from '../src/when.ts';
import { parseZoom, nextZoom, zoomLabel, ZOOM_STEPS } from '../src/zoom-pref.ts';
import { withinReticle } from '../src/reticle.ts';
import { locateDraftAction } from '../src/locate-draft.ts';
import { prng, seedFromEnv, harness, iters, messyString, anyValue, show, type Rng } from './fuzz-kit.mts';

const SEED = seedFromEnv(0x0ff11e);
const h = harness('fuzz-session-policy.test.mts', SEED);
const r = prng(SEED);

/* ------------------------------------------------------------ stored session */

h.section('parseStoredSession — garbage is never a session');
{
  const valid = (rr: Rng) => {
    const inner = {
      access_token: messyString(rr, 8), refresh_token: `rt-${rr.int(1e6)}`, expires_at: rr.int(2e9),
      user: { id: `u-${rr.int(99)}`, email: rr.bool(0.8) ? 'mike.t@crew.scanified.com' : messyString(rr, 6) },
    };
    return JSON.stringify(rr.bool(0.3) ? { currentSession: inner, expiresAt: 1 } : inner);
  };
  const hasRefresh = (v: unknown): boolean => {
    const o = v as any;
    const s = o?.currentSession ?? o;
    return typeof s?.refresh_token === 'string' && s.refresh_token.length > 0;
  };

  h.prop('random strings and JSON values: null unless a non-empty string refresh_token is present', iters(10000), () => {
    const k = r.int(5);
    const raw = k === 0 ? messyString(r)
      : k === 1 ? JSON.stringify(anyValue(r)) ?? 'undefined'
      : k === 2 ? (() => { const v = valid(r); return v.slice(0, r.int(v.length)); })() // truncated
      : k === 3 ? JSON.stringify({ refresh_token: anyValue(r), user: anyValue(r), currentSession: r.bool(0.3) ? anyValue(r) : undefined })
      : valid(r);
    const out = h.timed('parseStoredSession', () => parseStoredSession(raw));
    let parsed: unknown, isJson = true;
    try { parsed = JSON.parse(raw); } catch { isJson = false; }
    if (!isJson && out !== null) return `signed in from non-JSON ${show(raw)}`;
    if (isJson && (out !== null) !== hasRefresh(parsed)) return `verdict ${show(out)} for ${show(raw)}`;
    if (out && !(out.email === null || typeof out.email === 'string')) return 'email not string|null';
    if (out && !(out.id === null || typeof out.id === 'string')) return 'id not string|null';
    return null;
  });

  h.ok('a 5 MB blob and 200,000-deep nesting are refused, not thrown', (() => {
    const huge = JSON.stringify({ refresh_token: '', pad: 'x'.repeat(5_000_000) });
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    const deepObj = '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000);
    return h.timed('huge', () => parseStoredSession(huge), 2000) === null
      && h.timed('deep', () => parseStoredSession(deep), 2000) === null
      && h.timed('deepObj', () => parseStoredSession(deepObj), 2000) === null
      && parseStoredSession(null) === null && parseStoredSession('') === null;
  })());
}

h.section('sessionVerdict / verdictForEvent');
{
  const check = (rr: Rng): SessionCheck => (rr.bool(0.3)
    ? { kind: 'slow' }
    : { kind: 'done', hasSession: rr.bool(), errorName: rr.pick([null, 'AuthRetryableFetchError', 'AuthApiError', 'AuthSessionMissingError', 'TypeError', '', messyString(rr, 5)]) });

  h.prop('nothing stored and no live session is always signed out', iters(5000), () => {
    const c = check(r);
    const stored = r.bool();
    const v = sessionVerdict(c, stored);
    if (v !== 'in' && v !== 'out') return `verdict ${v}`;
    const live = c.kind === 'done' && c.hasSession;
    if (live && v !== 'in') return 'a live session was signed out';
    if (!live && !stored && v !== 'out') return `signed in with nothing stored: ${show(c)}`;
    if (!live && stored && c.kind === 'done' && c.errorName !== 'AuthRetryableFetchError' && v !== 'out')
      return `a refusal (${c.errorName}) kept the driver in`;
    // The full launch path: a stored blob that is garbage never signs anyone in.
    const blob = messyString(r);
    const v2 = sessionVerdict(c, parseStoredSession(blob) !== null);
    if (!live && v2 === 'in' && parseStoredSession(blob) === null) return 'garbage blob signed in';
    return null;
  });

  h.prop('auth events: SIGNED_OUT always out, INITIAL_SESSION never decides, nothing else signs out', iters(5000), () => {
    const ev = r.pick(['SIGNED_OUT', 'INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY', '', messyString(r, 8)]);
    const has = r.bool();
    const v = verdictForEvent(ev, has);
    if (ev === 'SIGNED_OUT') return v === 'out' ? null : `SIGNED_OUT -> ${v}`;
    if (ev === 'INITIAL_SESSION') return v === null ? null : `INITIAL_SESSION -> ${v}`;
    if (v === 'out') return `${show(ev)} signed out`;
    if (v === 'in' && !has) return `${show(ev)} signed in without a session`;
    return null;
  });
}

h.section('Cache owner');
h.prop('ownerVerdict wipes exactly when both are known and differ (case/space-blind); ownedBy is stricter', iters(10000), () => {
  const pool = ['mike@x.com', ' MIKE@X.COM ', 'jane@x.com', '', ' ', null, undefined, messyString(r, 6)];
  const a = r.pick(pool), b = r.pick(pool);
  const n = (s: string | null | undefined) => s?.trim().toLowerCase() || null;
  const v = ownerVerdict(a, b);
  const expect = n(a) && n(b) && n(a) !== n(b) ? 'wipe' : 'keep';
  if (v !== expect) return `ownerVerdict(${show(a)}, ${show(b)}) = ${v}`;
  if (ownerVerdict(b, a) !== v) return 'not symmetric';
  const cached = r.bool(0.9) ? { owner: a, page: 1 } : null;
  const got = ownedBy(cached, b);
  const shouldShow = !!cached && !!n(b) && n(cached.owner) === n(b);
  if ((got !== null) !== shouldShow) return `ownedBy(${show(cached)}, ${show(b)}) = ${show(got)}`;
  if (got !== null && got !== cached) return 'ownedBy returned a different object';
  return null;
});

h.section('Session encryption');
{
  const key = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 255);
  h.prop('round trip for any well-formed string; garbage throws an ordinary Error, fast', iters(3000), () => {
    const s = messyString(r);
    // A leading U+FEFF round-trips too since 1 Oct 2026 (K4, ignoreBOM in
    // session-crypto.ts); before that TextDecoder ate it.
    if ((s as any).isWellFormed?.() !== false) {
      const nonce = Uint8Array.from({ length: 12 }, () => r.int(256));
      const enc = encryptSession(key, nonce, s);
      if (decryptSession(key, enc) !== s) return `round trip lost ${show(s)}`;
    }
    const garbage = r.pick([
      messyString(r), 'v2:', 'v2::', 'v2:zz:zz', `v2:${'00'.repeat(12)}:${'ab'.repeat(r.int(40))}`,
      `v2:${'0'.repeat(r.int(30))}:${'f'.repeat(r.int(80))}`, 'v1:00:00', 'v2:00:00:00',
    ]);
    try {
      h.timed('decryptSession', () => decryptSession(key, garbage));
      return `garbage decrypted: ${show(garbage)}`;
    } catch (e) {
      if (!(e instanceof Error)) return `threw a non-Error ${show(e)}`;
    }
    return null;
  });
}

/* ------------------------------------------------------------ update policy */

h.section('Update policy — hostile clocks');
{
  const PHASES: Phase[] = ['idle', 'checking', 'downloading', 'ready', 'error'];
  const clock = (rr: Rng) => rr.pick([0, -1, 1, 1_790_000_000_000, -1_790_000_000_000, 2 ** 53, -(2 ** 53), Number.MAX_VALUE,
    Infinity, -Infinity, NaN, rr.int(1e13), -rr.int(1e13), rr.next() * 1e6]);
  const findings = new Set<string>();

  h.prop('shouldCheck never asks when disabled, offline or busy; always asks first time; clock going back is due', iters(20000), () => {
    const o = {
      enabled: r.bool(0.8), online: r.bool(0.8), phase: r.pick(PHASES),
      lastCheckAt: r.bool(0.2) ? null : clock(r), lastFailed: r.bool(0.3) ? r.bool() : undefined,
      now: clock(r), intervalMs: r.bool(0.3) ? clock(r) : undefined,
    };
    const v = h.timed('shouldCheck', () => shouldCheck(o));
    if (typeof v !== 'boolean') return `non-boolean ${v}`;
    if (v && (!o.enabled || !o.online || o.phase === 'checking' || o.phase === 'downloading' || o.phase === 'ready'))
      return `asked while not allowed: ${show(o)}`;
    const allowed = o.enabled && o.online && (o.phase === 'idle' || o.phase === 'error');
    if (allowed && o.lastCheckAt === null && !v) return 'did not ask on first run';
    if (allowed && o.lastCheckAt !== null && Number.isFinite(o.now) && Number.isFinite(o.lastCheckAt)
      && o.now - o.lastCheckAt < 0 && !v) return `clock moved back and it stopped asking: ${show(o)}`;
    if (allowed && o.lastCheckAt !== null && Number.isNaN(o.now - o.lastCheckAt)) findings.add('shouldCheck: a NaN gap (NaN or ±Infinity clock) never asks again');
    const s = h.timed('shouldCheckStore', () => shouldCheckStore({ online: o.online, checking: r.bool(0.3), lastCheckAt: o.lastCheckAt, now: o.now, intervalMs: o.intervalMs }));
    if (typeof s !== 'boolean') return 'store non-boolean';
    if (s && !o.online) return 'store check while offline';
    return null;
  });
  for (const f of findings) console.log(`    note: ${f} (unreachable: lastCheckAt is always Date.now())`);

  h.prop('banners: only on the tabs, only when ready/available, a dismissed one stays dismissed, OTA wins', iters(20000), () => {
    const ids = [null, 'u1', 'u2', ''];
    const o = { phase: r.pick(PHASES), readyId: r.pick(ids), dismissedId: r.pick(ids), segment: r.pick([undefined, null, '(tabs)', 'scan', '(auth)', '', messyString(r, 4)]) };
    const b = bannerVisible(o);
    if (b && (o.phase !== 'ready' || o.segment !== '(tabs)')) return `OTA banner off the tabs or not ready: ${show(o)}`;
    if (b && o.readyId !== null && o.readyId === o.dismissedId) return 'dismissed OTA banner came back';
    const builds = [null, 0, 1, 235, 236, NaN, -1, Infinity];
    const so = { available: r.bool(), dismissedBuild: r.pick(builds), published: r.pick(builds), otaBannerVisible: b, segment: o.segment };
    const sb = storeBannerVisible(so);
    if (sb && (b || !so.available || o.segment !== '(tabs)')) return `store banner shown wrongly: ${show(so)}`;
    if (sb && so.published !== null && so.published === so.dismissedBuild) return 'dismissed store banner came back';
    return null;
  });

  h.prop('storeBuildIsNewer is strictly greater-than, and never both ways', iters(20000), () => {
    const v = () => r.pick<number | null>([null, 0, -0, 1, 235, 236, NaN, Infinity, -Infinity, r.int(1000), r.next() * 1000, -r.int(10)]);
    const a = v(), b = v();
    const n = storeBuildIsNewer(a, b);
    const expect = a !== null && b !== null && b > a;
    if (n !== expect) return `storeBuildIsNewer(${a}, ${b}) = ${n}`;
    if (n && storeBuildIsNewer(b, a)) return 'newer both ways';
    if (a !== null && storeBuildIsNewer(a, a)) return 'equal build reported newer';
    return null;
  });

  h.prop('storeCheckWorthReporting: total on any thrown value; offline and aborts are not news', iters(10000), () => {
    const k = r.int(6);
    const e: unknown = k === 0 ? anyValue(r)
      : k === 1 ? new TypeError(r.pick(['Network request failed', 'network request timed out', 'NETWORK REQUEST FAILED']))
      : k === 2 ? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      : k === 3 ? new TypeError(messyString(r))
      : k === 4 ? { name: anyValue(r), message: anyValue(r) }
      : Object.create(null);
    const v = h.timed('storeCheckWorthReporting', () => storeCheckWorthReporting(e));
    if (typeof v !== 'boolean') return 'non-boolean';
    if (k === 1 && v) return `offline reported: ${show((e as Error).message)}`;
    if (k === 2 && v) return 'abort reported';
    return null;
  });

  h.prop('restartHint / statusLine are always a sentence', iters(5000), () => {
    const n = r.range(-5, 5000);
    const t = restartHint(n);
    if (!t || /undefined|NaN/.test(t)) return `restartHint(${n}) = ${show(t)}`;
    if (n === 1 && !/1 unsent scan /.test(t)) return 'singular wrong';
    const s = statusLine(r.pick(PHASES), { enabled: r.bool(), error: r.pick([null, undefined, '', 'boom']) });
    if (!s || /undefined/.test(s)) return `statusLine ${show(s)}`;
    return null;
  });
}

/* ------------------------------------------------------------ deadline */

h.section('withDeadline / boundedFetch — settle exactly once');
{
  type Plan = { ms: number; settleAt: number | null; reject: boolean };
  const plans: Plan[] = Array.from({ length: iters(400) }, () => ({
    ms: r.range(0, 40),
    settleAt: r.bool(0.2) ? null : r.range(0, 40),
    reject: r.bool(0.3),
  }));
  let wrong: string | null = null;
  let settled = 0;
  await Promise.all(plans.map(async (p, i) => {
    let calls = 0;
    const work = new Promise<string>((res, rej) => {
      if (p.settleAt === null) return; // never answers — a dead socket
      setTimeout(() => (p.reject ? rej(new Error(`work ${i} failed`)) : res(`ok ${i}`)), p.settleAt);
    });
    let outcome: string;
    try { outcome = await withDeadline(work, p.ms, `step ${i}`); calls++; }
    catch (e: any) { outcome = e instanceof DeadlineError ? 'deadline' : `rejected:${e?.message}`; calls++; }
    settled++;
    if (calls !== 1) wrong ??= `plan ${i} settled ${calls} times`;
    // Only judge the clear cases; a tie within the timer's granularity can go either way.
    if (p.settleAt === null && outcome !== 'deadline') wrong ??= `plan ${show(p)} -> ${outcome}`;
    if (p.settleAt !== null && p.settleAt + 15 < p.ms) {
      const want = p.reject ? `rejected:work ${i} failed` : `ok ${i}`;
      if (outcome !== want) wrong ??= `plan ${show(p)} -> ${outcome}, wanted ${want}`;
    }
    if (p.settleAt !== null && p.ms + 15 < p.settleAt && outcome !== 'deadline') wrong ??= `plan ${show(p)} -> ${outcome}, wanted deadline`;
  }));
  h.ok(`withDeadline settles once, with the right answer  (${settled})`, !wrong && settled === plans.length, wrong ?? '');

  // boundedFetch: a fake fetch that only ever ends by abort or by answering.
  let fwrong: string | null = null;
  let fdone = 0;
  const fplans = Array.from({ length: iters(200) }, () => ({ ms: r.range(1, 30), answerAt: r.bool(0.3) ? null : r.range(0, 30), outer: r.pick([null, 'pre', 'later']) }));
  await Promise.all(fplans.map(async (p) => {
    let aborted = false;
    const base = ((_u: unknown, init: any) => new Promise((res, rej) => {
      const sig: AbortSignal = init.signal;
      const onAbort = () => { aborted = true; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      if (sig.aborted) return onAbort();
      sig.addEventListener('abort', onAbort, { once: true });
      if (p.answerAt !== null) setTimeout(() => res('body'), p.answerAt);
    })) as unknown as typeof fetch;
    const ctl = new AbortController();
    if (p.outer === 'pre') ctl.abort();
    if (p.outer === 'later') setTimeout(() => ctl.abort(), 5);
    const f = boundedFetch(p.ms, base);
    let got: string;
    try { got = String(await f('https://invalid.example/never-called', { signal: ctl.signal })); }
    catch (e: any) { got = e?.name; }
    fdone++;
    if (p.outer === 'pre' && got !== 'AbortError') fwrong ??= `pre-aborted signal ignored: ${show(p)} -> ${got}`;
    if (p.answerAt === null && p.outer === null && got !== 'AbortError') fwrong ??= `never-answering fetch did not time out: ${show(p)}`;
    if (got === 'AbortError' && !aborted) fwrong ??= 'AbortError without abort';
  }));
  h.ok(`boundedFetch always ends, honours the caller's signal  (${fdone})`, !fwrong && fdone === fplans.length, fwrong ?? '');
  // The fake work above schedules its own timers (≤ 40 ms); let those run out,
  // then nothing of withDeadline's or boundedFetch's may still be pending.
  await new Promise((res) => setTimeout(res, 80));
  const timers = (process as any).getActiveResourcesInfo?.().filter((x: string) => x === 'Timeout').length ?? 0;
  h.ok('no timer left running after everything settled', timers === 0, `${timers} timers`);
}

/* ------------------------------------------------------------ small helpers */

h.section('ULID, time labels, zoom, reticle, locate draft');
h.prop('ulid: 26 Crockford chars, time round-trips, monotonic within a millisecond', iters(3000), () => {
  const t = r.int(2 ** 40) * (r.bool(0.1) ? 0 : 1);
  const ids = Array.from({ length: r.range(1, 50) }, () => ulid(t));
  for (let i = 0; i < ids.length; i++) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ids[i])) return `bad ulid ${ids[i]}`;
    if (ulidTime(ids[i]) !== t) return `time ${t} came back as ${ulidTime(ids[i])}`;
    if (i && !(ids[i] > ids[i - 1])) return `not monotonic at ${t}`;
  }
  return null;
});

h.prop('when.ts: any string in, a string out; never "NaN"', iters(6000), () => {
  const iso = r.pick([messyString(r, r.range(0, 30)), new Date(r.int(4e12) - 1e12).toISOString(), '2026-02-30T25:61:00Z', '', 'Invalid Date', '1e999']);
  for (const f of [localTime, localDay, dayLabel, whenLabel]) {
    const out = h.timed(f.name, () => f(iso));
    if (typeof out !== 'string' || /NaN|undefined|Invalid/.test(out)) return `${f.name}(${show(iso)}) = ${show(out)}`;
  }
  return null;
});

h.prop('zoom preference: anything stored parses to a real step; next cycles through all three', iters(3000), () => {
  const raw = r.pick([null, undefined, '', '0', '0.15', '0.3', '0.30', ' 0.15 ', 'NaN', '1e-1', messyString(r, 5)]);
  const z = parseZoom(raw);
  if (!(ZOOM_STEPS as readonly number[]).includes(z)) return `parseZoom(${show(raw)}) = ${z}`;
  if (nextZoom(nextZoom(nextZoom(z))) !== z) return 'nextZoom is not a 3-cycle';
  if (!zoomLabel(z).endsWith('×')) return 'label';
  const junk = r.pick([NaN, -1, 7, Infinity, 0.2]);
  if (!(ZOOM_STEPS as readonly number[]).includes(nextZoom(junk))) return `nextZoom(${junk}) off the steps`;
  return null;
});

h.prop('withinReticle: never throws; garbage geometry fails open (accepts)', iters(10000), () => {
  const n = () => r.pick<unknown>([undefined, null, NaN, Infinity, -Infinity, -5, 0, r.next() * 1000, '12', {}]);
  const bounds = r.bool(0.1) ? r.pick([null, undefined, {}]) : { origin: r.bool(0.1) ? null : { x: n(), y: n() }, size: r.bool(0.1) ? null : { width: n(), height: n() } };
  const view = { width: n(), height: n() } as { width: number; height: number };
  const v = h.timed('withinReticle', () => withinReticle(bounds as any, view));
  if (typeof v !== 'boolean') return 'non-boolean';
  const fin = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const b = bounds as any;
  const bad = !fin(view.width) || !fin(view.height) || view.width <= 0 || view.height <= 0
    || !fin(b?.origin?.x) || !fin(b?.origin?.y) || !fin(b?.size?.width) || !fin(b?.size?.height)
    || b.size.width <= 0 || b.size.height <= 0;
  if (bad && !v) return `garbage geometry refused a read: ${show({ bounds, view })}`;
  return null;
});

h.prop('locateDraftAction: no codes or stale is discard; fresh with codes is ask', iters(6000), () => {
  const now = r.int(2e12);
  const fresh = r.range(1, 1e8);
  const at = r.pick([undefined, null, now, now - fresh, now - fresh + 1, now - r.int(2 * fresh), now + r.int(1e6)]) as number | undefined;
  const draft = r.bool(0.1) ? r.pick([null, undefined]) : { location: 'A', custom: false, state: null, codes: Array.from({ length: r.range(0, 3) }, () => 'B'), at };
  const v = locateDraftAction(draft, now, fresh);
  const expect = !draft?.codes.length ? 'discard' : (draft.at != null && now - draft.at >= fresh ? 'discard' : 'ask');
  return v === expect ? null : `${show(draft)} now=${now} fresh=${fresh} -> ${v}`;
});

h.done();
