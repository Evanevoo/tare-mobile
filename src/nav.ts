/**
 * NAVIGATING OUT FROM UNDER AN OPEN MODAL, ON ANDROID.
 *
 * Three separate bug reports on 19 Aug 2026 — a grey frozen screen, a black
 * frozen screen, and a grey one again on a completely different screen — all
 * turned out to be the same mistake made in four places.
 *
 * On Android a React Native `Modal` is not a view in the tree. It is a real
 * platform dialog window that the OS owns. `setVisible(false)` does not close
 * it: it schedules a React re-render, which then asks Android to dismiss the
 * window, and that takes a frame. If the screen underneath is torn down or
 * replaced inside that frame — which is exactly what happens when the same
 * handler closes a modal and calls `router.push`/`replace` — the dialog window
 * is orphaned. It stays on top of the app, renders as a flat grey or black
 * sheet, and swallows every touch. The only way out is force-closing the app,
 * and on the delivery screen that used to take the shift's scans with it.
 *
 * iOS never shows this, because there a Modal is an ordinary view in the
 * hierarchy and unmounting its owner unmounts it too. Evan confirmed the
 * symptom is Android-only, which is the fingerprint of exactly this.
 *
 * So: close the modal, let the frame pass, THEN navigate. One helper rather
 * than a delay open-coded at four call sites, because the next person to add a
 * scanner modal will otherwise reintroduce it — and because when a fifth case
 * turns up, this is the single place to lengthen the wait.
 *
 * 150ms, not a bare requestAnimationFrame: what is being waited on is native
 * dialog teardown plus, usually, a camera release, not a JS paint. A driver
 * cannot perceive it, and the failure it prevents costs a phone call from a
 * yard.
 */
export function afterModalClose(go: () => void): void {
  setTimeout(go, 150);
}

/** How long the app waits, exported so a caller can match it if it must. */
export const MODAL_TEARDOWN_MS = 150;
