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
 * K1  (fixed 1 Oct: screens count through outbox.ts distinctScans — see
 *      __tests__/double-count.test.mts)
 * K2  A server mode flip lands on every SENT row of the bottle.          LOW
 * K3  A server void of one direction drops both directions locally.      LOW
 * K4  decryptSession drops a leading U+FEFF.                             INFO
 * K5  Readers crash on wrong-typed / missing server fields.              LOW
 */
import { reduce, empty, type QueuedScan, type Outbox, type Action } from '../src/outbox.ts';
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

section('K2 — server mode flip applied to every SENT row of the bottle   [LOW]');
/*
  B9 went out and came back on one order (SENT SHIP + SENT RETURN — the server
  allows both). The driver flips the SHIP to RETURN on the order screen. The
  server sees that a RETURN already exists and removes the SHIP (the same rule
  remote-edit.ts applies to the snapshot). serverEditToLocal passes only the
  NEW mode, and APPLY_SERVER_EDIT sets it on every SENT row of the bottle, so
  the outbox ends with two RETURN rows. Since K1's fix the screens count it once
  (distinctScans), so what is left is local rows that disagree with the ledger
  (a later edit of that bottle acts on both). Same shape: a
  whole-order move onto an order that already has the bottle SENT.

  Fix needs the old mode on the action (callers in app/order/[orderNumber].tsx)
  and the remote-edit.ts "target exists → drop the source row" rule in the reducer.
*/
{
  const both = sendAll(run([{ type: 'ENQUEUE', scan: scan('RETURN') }], sendAll(run([{ type: 'ENQUEUE', scan: scan('SHIP') }]))));
  const flipped = reduce(both, { type: 'APPLY_SERVER_EDIT', orderNumber: 'INV-1', barcode: 'B9', mode: 'RETURN' });
  const rows = flipped.scans.map((s) => s.mode);
  ok('flip SHIP→RETURN when a RETURN exists leaves one RETURN row, like the ledger', rows.join() === 'RETURN', rows.join());
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
