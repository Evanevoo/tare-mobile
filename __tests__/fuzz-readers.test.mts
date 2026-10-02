/**
 * node --experimental-strip-types __tests__/fuzz-readers.test.mts
 *
 * Seeded fuzzing of the pure code that reads what the server (or an older
 * build's cache) sent: History merging and paging (history.ts), the Sales
 * Order checklist (target-progress.ts), custody wording (pending-ship.ts),
 * the Locate interlock (interlock.ts), server edits mirrored onto the order
 * snapshot (remote-edit.ts), scan classification against a bootstrap with
 * missing fields (scan-match.ts), and the hold lookup (hold.ts).
 *
 * Two levels: payloads shaped like the server's types must give the right
 * answer; payloads with fields missing or of the wrong type (an older server,
 * an older cache) must not crash the screen that reads them.
 */
import { mergeHistory, appendPage, orderKey, offlineNotice, type ServerOrder, type LocalScan } from '../src/history.ts';
import { checklist, isComplete } from '../src/target-progress.ts';
import { reduce, empty, type QueuedScan, type Outbox } from '../src/outbox.ts';
import {
  custodyChips, listChips, wasAt, wasAtDetail, custodyLine, custodyCaption, pendingHeadline, pendingNote,
} from '../src/pending-ship.ts';
import { hasLocalReturn, locateWarning } from '../src/interlock.ts';
import { applyEditToRemote } from '../src/remote-edit.ts';
import { classify, explainMiss } from '../src/scan-match.ts';
import { holdFor } from '../src/hold.ts';
import { prng, seedFromEnv, harness, iters, messyString, anyValue, show, type Rng } from './fuzz-kit.mts';

const SEED = seedFromEnv(0x4ead3e5);
const h = harness('fuzz-readers.test.mts', SEED);
const r = prng(SEED);

const ORDERS = ['INV-1', 'inv-1', ' INV-1 ', 'INV-2', 'S100', 's100'];
const iso = (rr: Rng) => new Date(1_780_000_000_000 + rr.int(5e9)).toISOString();

/* ------------------------------------------------------------ history */

const serverOrder = (rr: Rng): ServerOrder => ({
  orderNumber: rr.pick(ORDERS), customerListId: rr.pick(['C1', 'C2', '']), customerName: rr.pick(['', 'Acme', 'Borealis']),
  ship: rr.int(20), ret: rr.int(20), voided: rr.int(3), lastScanAt: iso(rr), scannedBy: rr.bool(0.9) ? ['mike'] : (undefined as unknown as string[]),
});
const localScan = (rr: Rng): LocalScan => ({
  orderNumber: rr.pick(ORDERS), customerListId: rr.pick(['C1', 'C2']), mode: rr.bool() ? 'SHIP' : 'RETURN',
  scannedAt: iso(rr), state: rr.pick(['QUEUED', 'UPLOADING', 'SENT'] as const),
});

h.section('History — well-formed payloads');
h.prop('one row per order, newest first, local counts added exactly once', iters(4000), () => {
  const server = Array.from({ length: r.range(0, 8) }, () => serverOrder(r));
  const scans = Array.from({ length: r.range(0, 12) }, () => localScan(r));
  const rows = h.timed('mergeHistory', () => mergeHistory(server, scans, { me: r.bool() ? 'mike' : null, names: new Map([['C1', 'Acme']]) }));
  const keys = rows.map((x) => orderKey(x.orderNumber));
  if (new Set(keys).size !== keys.length) return `two rows for one order: ${show(keys)}`;
  for (let i = 1; i < rows.length; i++) if (rows[i - 1].lastScanAt < rows[i].lastScanAt) return 'not newest first';
  for (const row of rows) {
    const k = orderKey(row.orderNumber);
    const mine = scans.filter((s) => orderKey(s.orderNumber) === k);
    const srv = server.find((o) => orderKey(o.orderNumber) === k);
    const unsent = mine.filter((s) => s.state !== 'SENT');
    if (row.pending !== unsent.length) return `pending ${row.pending} != ${unsent.length} for ${k}`;
    const counted = srv ? unsent : mine;
    const ship = (srv?.ship ?? 0) + counted.filter((s) => s.mode === 'SHIP').length;
    const ret = (srv?.ret ?? 0) + counted.filter((s) => s.mode === 'RETURN').length;
    if (row.ship !== ship || row.ret !== ret) return `counts for ${k}: ${row.ship}/${row.ret}, expected ${ship}/${ret}`;
    if (row.onlyOnPhone !== !srv) return 'onlyOnPhone wrong';
    if (!Array.isArray(row.scannedBy)) return 'scannedBy not an array';
  }
  return null;
});

h.prop('appendPage never repeats an order and keeps what it had', iters(4000), () => {
  const have = appendPage([], Array.from({ length: r.range(0, 6) }, () => serverOrder(r)));
  const next = Array.from({ length: r.range(0, 6) }, () => serverOrder(r));
  const out = appendPage(have, next);
  const keys = out.map((o) => orderKey(o.orderNumber));
  if (new Set(keys).size !== keys.length) return 'repeated order after paging';
  if (out.slice(0, have.length).some((o, i) => o !== have[i])) return 'paging dropped or reordered what it had';
  return null;
});

h.prop('offlineNotice is always a sentence', iters(2000), () => {
  const t = offlineNotice(r.pick([null, '', iso(r), messyString(r, 10)]));
  return /undefined|NaN/.test(t) ? `notice ${show(t)}` : null;
});

/* ------------------------------------------------------------ checklist */

h.section('Sales Order checklist');
h.prop('targets keep their order; SHIP scans of a product count once each; extras appear at target 0', iters(4000), () => {
  const products = ['ARGON', 'OXY', 'CO2', 'MIX'];
  const productOf = new Map<string, string | null>([['B1', 'ARGON'], ['B2', 'ARGON'], ['B3', 'OXY'], ['B4', 'CO2'], ['B5', null], ['B6', 'MIX']]);
  const codes = [...new Set(Array.from({ length: r.range(0, 4) }, () => r.pick(products)))];
  const target = codes.map((p) => ({ productCode: p, quantity: r.int(4) }));
  let o: Outbox = empty;
  for (let i = 0; i < r.range(0, 15); i++) {
    const scan: QueuedScan = {
      clientId: `c${i}`, orderNumber: r.pick(['O1', 'O2']), barcode: r.pick([...productOf.keys(), 'NOPE']),
      mode: r.bool(0.7) ? 'SHIP' : 'RETURN', customerListId: 'C', scannedAt: iso(r), lat: null, lng: null, accuracyM: null, state: 'QUEUED',
    };
    o = reduce(o, { type: 'ENQUEUE', scan });
  }
  const rows = checklist(o, 'O1', (b) => productOf.get(b), target);
  if (rows.slice(0, target.length).some((x, i) => x.productCode !== target[i].productCode || x.target !== target[i].quantity)) return 'target rows reordered or changed';
  const ships = o.scans.filter((s) => s.orderNumber === 'O1' && s.mode === 'SHIP' && productOf.get(s.barcode));
  if (rows.reduce((n, x) => n + x.scanned, 0) !== ships.length) return 'scanned total != SHIP scans with a product';
  if (rows.slice(target.length).some((x) => x.target !== 0 || codes.includes(x.productCode))) return 'extra row wrong';
  if (isComplete(rows) !== (rows.length > 0 && rows.every((x) => x.scanned >= x.target))) return 'isComplete wrong';
  if (isComplete([])) return 'empty checklist reads complete';
  return null;
});

/* ------------------------------------------------------------ custody wording */

h.section('Custody wording, Locate interlock');
h.prop('pending-ship / interlock: total on messy fields, never "undefined" or "null" on screen', iters(8000), () => {
  const str = () => r.pick<string | null | undefined>([null, undefined, '', ' ', 'Acme Gas', messyString(r, 6)]);
  const ps = r.bool(0.4) ? { o: r.pick(['78825', '', 'S100']), n: str() as string, at: iso(r), doc: r.pick([0, 1] as const) } : r.pick([null, undefined]);
  const a = { c: str() ?? null, f: r.pick([0, 1] as const), ps, lc: str(), rt: str() };
  const texts = [
    ...custodyChips(a).map((c) => c.label), ...listChips(a).map((c) => c.label),
    wasAt(a), wasAtDetail(a), custodyLine(a), custodyCaption(a),
    ...(ps ? [pendingHeadline(ps), pendingNote(ps, str() as string)] : []),
  ];
  const bad = texts.find((t) => typeof t !== 'string' || /\bundefined\b|\bnull\b/.test(t.replace(String(a.c), '').replace(String(ps?.n), '')));
  if (bad !== undefined) return `screen text ${show(bad)} for ${show(a)}`;
  if (a.c && custodyChips(a)[0].tone !== 'out') return 'an asset out at a customer is not OUT';
  const asset = r.bool(0.1) ? null : { c: str(), or: r.pick([undefined, 0, 1] as const), rp: r.pick([undefined, 0, 1] as const) };
  const scans = Array.from({ length: r.range(0, 4) }, () => ({ barcode: r.pick(['B1', 'B2']), mode: r.pick(['SHIP', 'RETURN', 'return']) }));
  const local = hasLocalReturn(scans, 'B1');
  if (local !== scans.some((s) => s.barcode === 'B1' && s.mode === 'RETURN')) return 'hasLocalReturn wrong';
  const w = locateWarning(asset as any, local);
  if (!['none', 'not-returned', 'return-pending'].includes(w)) return `warning ${w}`;
  if (!asset?.c && w !== 'none') return 'warned about an asset on nobody\'s account';
  if (asset?.c && asset.or !== 0 && !local && asset.rp !== 1 && w !== 'not-returned') return 'missed the loud case';
  return null;
});

/* ------------------------------------------------------------ remote edits */

h.section('Server edits on the order snapshot');
h.prop('applyEditToRemote keeps (barcode, mode) unique and never invents a scan', iters(8000), () => {
  const pairs = new Map<string, { barcode: string; mode: 'SHIP' | 'RETURN' }>();
  for (let i = 0; i < r.range(0, 6); i++) {
    const s = { barcode: r.pick(['B1', 'B2', 'B3']), mode: r.pick(['SHIP', 'RETURN'] as const) };
    pairs.set(`${s.barcode}/${s.mode}`, s); // the server's unique key
  }
  const remote = r.bool(0.05) ? null : { orderNumber: 'O1', customerListId: r.pick([null, 'C1']), scans: [...pairs.values()] };
  const action = r.pick(['mode', 'void', 'order', 'customer', 'other', '']);
  const from = r.pick(['SHIP', 'RETURN'] as const);
  const edit = {
    action, barcode: r.bool(0.9) ? r.pick(['B1', 'B2', 'B3', 'B9']) : undefined,
    mode: r.bool(0.8) ? from : undefined,
    value: action === 'mode' ? (from === 'SHIP' ? 'RETURN' : 'SHIP') : r.pick([undefined, '', 'C2', 'O2']),
  };
  const out = h.timed('applyEditToRemote', () => applyEditToRemote(remote, edit));
  if (!remote) return out === remote ? null : 'null snapshot changed';
  if (!out) return 'snapshot lost';
  const keys = out.scans.map((s) => `${s.barcode}/${s.mode}`);
  if (new Set(keys).size !== keys.length) return `duplicate (barcode, mode) after ${show(edit)}: ${show(keys)}`;
  if (out.scans.length > remote.scans.length) return 'a scan appeared';
  if (action === 'void' && edit.barcode && out.scans.some((s) => s.barcode === edit.barcode && (!edit.mode || s.mode === edit.mode))) return 'void left the scan';
  if (action === 'void' && edit.barcode && edit.mode
    && out.scans.length !== remote.scans.filter((s) => !(s.barcode === edit.barcode && s.mode === edit.mode)).length) return 'void took more than the one scan';
  return null;
});

/* ------------------------------------------------------------ malformed payloads */

h.section('Payloads with missing or wrong-typed fields (older server, older cache)');
{
  const crashes = new Map<string, string>();
  const note = (where: string, e: any, input: unknown) => {
    if (!crashes.has(where)) crashes.set(where, `${e?.name}: ${e?.message} on ${show(input, 200)}`);
  };
  const mangle = <T extends object>(o: T): T => {
    const out: any = { ...o };
    for (const k of Object.keys(out)) {
      const roll = r.int(10);
      if (roll === 0) delete out[k];
      else if (roll === 1) out[k] = anyValue(r);
    }
    return out;
  };
  for (let i = 0; i < iters(6000); i++) {
    const server = Array.from({ length: r.range(0, 4) }, () => mangle(serverOrder(r)));
    const scans = Array.from({ length: r.range(0, 4) }, () => mangle(localScan(r)));
    try { mergeHistory(server, scans); } catch (e) { note('mergeHistory', e, server); }
    try { appendPage(server.slice(0, 2), server.slice(1)); } catch (e) { note('appendPage', e, server); }
    const boot: any = r.bool(0.1) ? anyValue(r) : {
      assets: r.bool(0.9) ? { B1: { p: 'X' } } : anyValue(r),
      customers: r.bool(0.9) ? Array.from({ length: r.range(0, 3) }, () => mangle({ customerListId: 'C1', name: 'Acme', bc: '*C1*' })) : anyValue(r),
      org: r.bool(0.9) ? { assetLabel: 'cylinder' } : anyValue(r),
    };
    const raw = r.pick(['B1', 'c1', '*C1*', messyString(r, 6)]);
    try { classify(raw, boot); } catch (e) { note('classify', e, boot); }
    try { explainMiss(raw, boot); } catch (e) { note('explainMiss', e, boot); }
    try { holdFor(boot?.customers, 'C1'); } catch (e) { note('holdFor', e, boot?.customers); }
  }
  // K5 (fixed 1 Oct 2026): every one of these used to throw here. None may now.
  for (const [where, why] of crashes) console.log(`    ${where} throws on a malformed payload — ${why}`);
  h.ok('no reader crashes on a malformed payload', crashes.size === 0, [...crashes.keys()].join(', '));
}

h.done();
