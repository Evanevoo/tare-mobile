/**
 * The offline outbox — one queue, one state machine.
 *
 * Scanified had four overlapping queues and a comment file about sync bugs.
 * This is the whole thing: scans go in, they come out exactly once, and a
 * dropped upload rolls back rather than vanishing.
 *
 * Kept pure and dependency-free so it runs under plain node in tests. The
 * SQLite layer in db.ts is a persistence shim around this, nothing more.
 */

export type Mode = 'SHIP' | 'RETURN';
export type ScanState = 'QUEUED' | 'UPLOADING' | 'SENT';

export interface QueuedScan {
  clientId: string;        // ULID, minted on the device
  orderNumber: string;
  barcode: string;
  mode: Mode;
  customerListId: string;
  scannedAt: string;       // ISO
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  state: ScanState;
}

export interface Outbox {
  scans: QueuedScan[];
}

export type Action =
  | { type: 'ENQUEUE'; scan: QueuedScan }
  | { type: 'TOGGLE'; orderNumber: string; barcode: string; mode: Mode }
  | { type: 'REMOVE'; clientId: string }
  | { type: 'BEGIN_UPLOAD'; clientIds: string[] }
  | { type: 'UPLOAD_OK'; clientIds: string[] }
  | { type: 'UPLOAD_FAILED'; clientIds: string[] }
  | { type: 'CLEAR_SENT' };

export const empty: Outbox = { scans: [] };

/** A scan is identified by what the server dedupes on, not by its clientId. */
const sameScan = (a: QueuedScan, orderNumber: string, barcode: string) =>
  a.orderNumber === orderNumber && a.barcode === barcode;

export function reduce(state: Outbox, action: Action): Outbox {
  switch (action.type) {
    case 'ENQUEUE': {
      const { scan } = action;
      const existing = state.scans.find((s) => sameScan(s, scan.orderNumber, scan.barcode));

      // Already queued in the same direction — a double beep, not a second unit.
      if (existing && existing.mode === scan.mode) return state;

      // Same bottle, opposite direction: the driver corrected themselves.
      // Replace rather than stack, but only while it is still ours to change.
      if (existing && existing.state === 'QUEUED') {
        return {
          scans: state.scans.map((s) =>
            s.clientId === existing.clientId ? { ...scan, clientId: existing.clientId } : s),
        };
      }

      return { scans: [...state.scans, scan] };
    }

    case 'TOGGLE': {
      const hit = state.scans.find(
        (s) => sameScan(s, action.orderNumber, action.barcode) && s.state === 'QUEUED');
      if (!hit) return state;
      return {
        scans: state.scans.map((s) =>
          s.clientId === hit.clientId ? { ...s, mode: action.mode } : s),
      };
    }

    case 'REMOVE':
      return {
        scans: state.scans.filter(
          (s) => !(s.clientId === action.clientId && s.state === 'QUEUED')),
      };

    case 'BEGIN_UPLOAD': {
      const ids = new Set(action.clientIds);
      return {
        scans: state.scans.map((s) =>
          ids.has(s.clientId) && s.state === 'QUEUED' ? { ...s, state: 'UPLOADING' } : s),
      };
    }

    case 'UPLOAD_OK': {
      const ids = new Set(action.clientIds);
      return {
        scans: state.scans.map((s) =>
          ids.has(s.clientId) ? { ...s, state: 'SENT' } : s),
      };
    }

    // The truck drove under a bridge. Nothing is lost — it goes back in line.
    case 'UPLOAD_FAILED': {
      const ids = new Set(action.clientIds);
      return {
        scans: state.scans.map((s) =>
          ids.has(s.clientId) && s.state === 'UPLOADING' ? { ...s, state: 'QUEUED' } : s),
      };
    }

    case 'CLEAR_SENT':
      return { scans: state.scans.filter((s) => s.state !== 'SENT') };

    default:
      return state;
  }
}

export const pending = (o: Outbox) => o.scans.filter((s) => s.state !== 'SENT');
export const queued = (o: Outbox) => o.scans.filter((s) => s.state === 'QUEUED');
export const inFlight = (o: Outbox) => o.scans.filter((s) => s.state === 'UPLOADING');

export function forOrder(o: Outbox, orderNumber: string) {
  return o.scans.filter((s) => s.orderNumber === orderNumber);
}

export function counts(o: Outbox, orderNumber?: string) {
  const rows = orderNumber ? forOrder(o, orderNumber) : o.scans;
  return {
    ship: rows.filter((s) => s.mode === 'SHIP').length,
    ret: rows.filter((s) => s.mode === 'RETURN').length,
    pending: rows.filter((s) => s.state !== 'SENT').length,
    total: rows.length,
  };
}

/** The wire shape POST /api/scans expects. */
export const toWire = (s: QueuedScan) => ({
  orderNumber: s.orderNumber,
  barcode: s.barcode,
  mode: s.mode,
  customerListId: s.customerListId,
  scannedAt: s.scannedAt,
  lat: s.lat,
  lng: s.lng,
  accuracyM: s.accuracyM,
});
