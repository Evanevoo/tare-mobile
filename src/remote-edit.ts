/**
 * THE SERVER SNAPSHOT, AFTER THIS PHONE HAS EDITED THE SERVER.
 *
 * The order editor draws from two places: this phone's outbox, and one
 * fetch of what the ledger says. That fetch happens exactly once per visit
 * to the screen — the effect guards on `remoteStatus !== 'idle'` — because
 * an order this phone scanned in full should never spend a request on it.
 *
 * Fine, until the driver edits a row that is already on the server. The edit
 * is mirrored onto the outbox (`APPLY_SERVER_EDIT`) so the local copy is
 * right. Nothing mirrored it onto the snapshot, so the snapshot went on
 * describing a row the server no longer had.
 *
 * That matters because of the key the merge dedupes on. A server row is
 * suppressed when a local row matches it on BARCODE AND MODE — which is the
 * right key, since AssetScan is unique on (org, order, barcode, mode) and a
 * bottle really can go out and come back on one visit. But `mode` is the one
 * field a flip changes. Flip a sent bottle and the local row becomes
 * (X, RETURN) while the stale snapshot still holds (X, SHIP): the keys stop
 * matching, the server row stops being suppressed, and the same cylinder
 * renders under both "Went out" and "Came back", each labelled "on server".
 *
 * So the act of editing a row is what broke the key that was hiding its
 * duplicate. Flipping did not move a bottle, it cloned one.
 *
 * Mirrored rather than refetched on purpose. This app is written for the last
 * bar of signal; a refetch after every edit is a request the driver may not
 * have, and one that fails leaves the screen wrong with no way back except
 * navigating out. The edit is already known here — applying it is arithmetic,
 * not a question for the network.
 */

export interface RemoteScanLike {
  barcode: string;
  mode: 'SHIP' | 'RETURN';
}

export interface RemoteOrderLike<S extends RemoteScanLike> {
  orderNumber: string;
  customerListId: string | null;
  scans: S[];
}

/** The edit, as `editSentScan` describes it. */
export interface ServerEdit {
  action: 'mode' | 'void' | 'order' | 'customer' | string;
  barcode?: string;
  /** For 'mode': the mode the row had BEFORE the edit — how it is found. */
  mode?: 'SHIP' | 'RETURN';
  /** For 'mode': the new mode. For 'order'/'customer': the new value. */
  value?: string;
}

export function applyEditToRemote<S extends RemoteScanLike>(
  remote: RemoteOrderLike<S> | null,
  edit: ServerEdit,
): RemoteOrderLike<S> | null {
  if (!remote) return remote;
  const bc = edit.barcode;

  switch (edit.action) {
    case 'mode': {
      if (!bc || !edit.mode || !edit.value) return remote;
      const to = edit.value as 'SHIP' | 'RETURN';
      // A row in the target direction may already exist — a bottle that went
      // out and came back. Flipping onto it must not mint a second copy of a
      // pair the server keeps unique, so the old row is dropped instead.
      const targetExists = remote.scans.some((s) => s.barcode === bc && s.mode === to);
      const scans = targetExists
        ? remote.scans.filter((s) => !(s.barcode === bc && s.mode === edit.mode))
        : remote.scans.map((s) =>
            s.barcode === bc && s.mode === edit.mode ? { ...s, mode: to } : s);
      return { ...remote, scans };
    }

    case 'void': {
      if (!bc) return remote;
      // Withdrawn rows stop counting on the order, so they leave the snapshot.
      // Without a mode the void takes every direction for that barcode, which
      // is what the caller means when it does not name one.
      return {
        ...remote,
        scans: remote.scans.filter((s) =>
          !(s.barcode === bc && (edit.mode ? s.mode === edit.mode : true))),
      };
    }

    case 'order': {
      // The scan belongs to a different order now — it is not on this one.
      if (!bc) return remote;
      return { ...remote, scans: remote.scans.filter((s) => s.barcode !== bc) };
    }

    case 'customer':
      return edit.value ? { ...remote, customerListId: edit.value } : remote;

    default:
      return remote;
  }
}
