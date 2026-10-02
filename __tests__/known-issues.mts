/**
 * KNOWN ISSUES FOUND BY FUZZING (1 Oct 2026) — NOT IN THE `npm test` CHAIN.
 *
 *   node --experimental-strip-types __tests__/known-issues.mts
 *
 * Each check below is a minimal, deterministic reproduction of something the
 * fuzz-*.test.mts files found and that was NOT fixed in the same change,
 * because the fix is a behaviour decision or touches more than one file. Every
 * check asserts the CORRECT behaviour, so this file fails today and is meant
 * to. When an issue is fixed, move its check into the matching test file (it
 * then guards the fix) and delete it here. When this file passes, delete it.
 *
 * K1  Same bottle counted twice after a queued correction is undone.   MEDIUM
 * K2  A server mode flip lands on every SENT row of the bottle.          LOW
 * K3  A server void of one direction drops both directions locally.      LOW
 * K4  decryptSession drops a leading U+FEFF.                             INFO
 * K5  Readers crash on wrong-typed / missing server fields.              LOW
 */
import { reduce, empty, counts, type QueuedScan, type Outbox, type Action } from '../src/outbox.ts';
import { checklist } from '../src/target-progress.ts';
import { encryptSession, decryptSession } from '../src/session-crypto.ts';
import { mergeHistory, type ServerOrder } from '../src/history.ts';
import { classify } from '../src/scan-match.ts';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${n}\x1b[0m ${d}`); }
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

let n = 0;
const scan = (mode: 'SHIP' | 'RETURN', barcode = 'B9', order = 'INV-1'): QueuedScan => ({
  clientId: `id-${n++}`, orderNumber: order, barcode, mode, customerListId: 'CUST',
  scannedAt: '2026-10-01T15:00:00.000Z', lat: null, lng: null, accuracyM: null, state: 'QUEUED',
});
const run = (acts: Action[], init: Outbox = empty) => acts.reduce(reduce, init);
const sendAll = (o: Outbox) => {
  const ids = o.scans.filter((s) => s.state === 'QUEUED').map((s) => s.clientId);
  return run([{ type: 'BEGIN_UPLOAD', clientIds: ids }, { type: 'UPLOAD_OK', clientIds: ids }], o);
};

section('K1 — SHIP (sent) → RETURN (queued) → SHIP again reads as two SHIPs   [MEDIUM]');
/*
  The driver ships B9 (it uploads in seconds), scans it again as a RETURN by
  mistake, then corrects back to SHIP. ENQUEUE compares with the latest row —
  the queued RETURN — sees the opposite direction, and rewrites it in place to
  SHIP. Now the order holds a SENT SHIP and a QUEUED SHIP for one bottle. The
  server's unique index (org, order, barcode, mode) keeps one, but the phone
  counts two: the scan screen's Ship pill and the Sales Order checklist both say
  2 — "Argon 2/2" with one bottle on the truck. TOGGLE in the review list does
  the same, and so does the UPLOADING variant (first SHIP still in flight).

  Suggested fix (outbox.ts, ENQUEUE's QUEUED branch and TOGGLE): when the row
  being corrected would take the direction of the bottle's previous row on this
  order, drop the queued row instead of rewriting it — the correction cancels.
*/
{
  const shipped = sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]));
  const wrong = run([{ type: 'ENQUEUE', scan: scan('RETURN') }], shipped);
  const back = run([{ type: 'ENQUEUE', scan: scan('SHIP') }], wrong);
  ok('ENQUEUE: one bottle shipped once counts as 1 ship', counts(back, 'INV-1').ship === 1,
    `ship=${counts(back, 'INV-1').ship} rows=${back.scans.map((s) => `${s.mode}/${s.state}`).join(',')}`);
  const rows = checklist(back, 'INV-1', () => 'ARGON', [{ productCode: 'ARGON', quantity: 2 }]);
  ok('ENQUEUE: the checklist does not read 2/2 for one bottle', rows[0].scanned === 1, `scanned=${rows[0].scanned}`);

  const toggled = run([{ type: 'TOGGLE', orderNumber: 'INV-1', barcode: 'B9', mode: 'SHIP' }], wrong);
  ok('TOGGLE: flipping the queued RETURN back counts as 1 ship', counts(toggled, 'INV-1').ship === 1,
    `ship=${counts(toggled, 'INV-1').ship}`);

  const first = run([{ type: 'ENQUEUE', scan: scan('SHIP') }]);
  const flying = run([{ type: 'BEGIN_UPLOAD', clientIds: [first.scans[0].clientId] }], first);
  const again = run([{ type: 'ENQUEUE', scan: scan('RETURN') }, { type: 'ENQUEUE', scan: scan('SHIP') }], flying);
  ok('UPLOADING variant: one pending SHIP, not two', again.scans.filter((s) => s.mode === 'SHIP').length === 1,
    again.scans.map((s) => `${s.mode}/${s.state}`).join(','));
}

section('K2 — server mode flip applied to every SENT row of the bottle   [LOW]');
/*
  B9 went out and came back on one order (SENT SHIP + SENT RETURN — the server
  allows both). The driver flips the SHIP to RETURN on the order screen. The
  server sees that a RETURN already exists and removes the SHIP (the same rule
  remote-edit.ts applies to the snapshot). serverEditToLocal passes only the
  NEW mode, and APPLY_SERVER_EDIT sets it on every SENT row of the bottle, so
  the outbox ends with two RETURNs (scan screen pill: ret 2). Same shape: a
  whole-order move onto an order that already has the bottle SENT.

  Fix needs the old mode on the action (callers in app/order/[orderNumber].tsx)
  and the remote-edit.ts "target exists → drop the source row" rule in the reducer.
*/
{
  const both = sendAll(run([{ type: 'ENQUEUE', scan: scan('RETURN') }], sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]))));
  const flipped = reduce(both, { type: 'APPLY_SERVER_EDIT', orderNumber: 'INV-1', barcode: 'B9', mode: 'RETURN' });
  const c = counts(flipped, 'INV-1');
  ok('flip SHIP→RETURN when a RETURN exists leaves one RETURN', c.ret === 1 && c.ship === 0, `ship=${c.ship} ret=${c.ret}`);
}

section('K3 — server void of one direction drops both locally   [LOW]');
/*
  Voiding the SENT SHIP of B9 (scan.tsx confirmRemoveSent, order screen
  remove()) sends { barcode, mode } to the server, which voids that one row.
  The local mirror is dispatched without the mode, and APPLY_SERVER_EDIT's
  `drop` has no mode filter, so the SENT RETURN disappears from the phone too.
  The ledger is right; the phone's counts are short one return.
*/
{
  const both = sendAll(run([{ type: 'ENQUEUE', scan: scan('RETURN') }], sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]))));
  const voided = reduce(both, { type: 'APPLY_SERVER_EDIT', orderNumber: 'INV-1', barcode: 'B9', drop: true });
  ok('voiding the SHIP keeps the RETURN', voided.scans.some((s) => s.mode === 'RETURN'),
    `left: ${voided.scans.map((s) => s.mode).join(',') || 'nothing'}`);
}

section('K4 — decryptSession drops a leading U+FEFF   [INFO]');
/*
  TextDecoder's default strips a byte-order mark, so a value starting with
  U+FEFF does not round-trip. Unreachable today (every stored value is JSON or
  base64), and the fix — new TextDecoder('utf-8', { ignoreBOM: true }) — was
  left alone because it changes the decoder the device builds every session
  with; worth doing alongside a device test.
*/
{
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  const nonce = Uint8Array.from({ length: 12 }, () => 1);
  const s = '﻿{"refresh_token":"r"}';
  ok('a leading U+FEFF survives encrypt → decrypt', decryptSession(key, encryptSession(key, nonce, s)) === s);
}

section('K5 — readers crash on wrong-typed or missing server fields   [LOW]');
/*
  The server is ours and sends these fields, and the History cache is only
  shown to its owner (so an older build's shape is refused), which is why this
  is LOW. But each of these takes down the screen that reads it rather than
  degrading: History (mergeHistory sort, appendPage key), customer-card
  classification (classify / explainMiss), and holdFor.
*/
{
  const srv = [
    { orderNumber: 'A', customerListId: 'C', customerName: 'x', ship: 1, ret: 0, voided: 0, lastScanAt: '2026-10-01', scannedBy: [] },
    { orderNumber: 'B', customerListId: 'C', customerName: 'x', ship: 1, ret: 0, voided: 0, scannedBy: [] },
    { orderNumber: 'D', customerListId: 'C', customerName: 'x', ship: 1, ret: 0, voided: 0, scannedBy: [] },
  ] as unknown as ServerOrder[];
  let threw = '';
  try { mergeHistory(srv, []); } catch (e: any) { threw = e.message; }
  ok('mergeHistory survives an order with no lastScanAt', !threw, threw);

  threw = '';
  const boot = { assets: {}, customers: [{ customerListId: null, name: 'Acme', bc: null }] } as any;
  try { classify('C1', boot); } catch (e: any) { threw = e.message; }
  ok('classify survives a customer with a null customerListId', !threw, threw);
}

console.log(`\n${passed} passed, ${failed} failed — failures here are the open known issues`);
process.exit(failed ? 1 : 0);
