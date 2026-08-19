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
 * A delay rather than a bare requestAnimationFrame: what is being waited on is
 * a native dialog animating out plus, usually, a camera release — not a JS
 * paint. A driver cannot perceive it, and the failure it prevents costs a
 * phone call from a yard.
 */

/**
 * 150ms WAS NOT ENOUGH, AND THE REASON IS THE ANIMATION.
 *
 * The first version of this waited 150ms and the grey screen came back on the
 * very next delivery. The number was picked to cover "a frame or two of native
 * teardown", which was the wrong model. Every one of these sheets is declared
 * `animationType="slide"`, and a slide-out on Android runs for roughly 300ms.
 * Navigating at 150ms lands squarely IN the dismiss animation — the dialog
 * window is still on screen and still owns the touch surface, so tearing its
 * owner down orphans it exactly as if nothing had been awaited at all.
 *
 * 350ms clears the animation with margin. It is not a guess dressed up as a
 * fix: the failure mode is specifically "navigated before the window was
 * gone", and the window is gone when its animation ends.
 *
 * This is a delay, and a delay is a weaker guarantee than an event. React
 * Native's Modal exposes `onDismiss` only on iOS — which is the platform that
 * never had this bug — so on Android there is nothing to await. If this ever
 * fails again, the answer is not a longer number: it is to stop navigating out
 * from under a Modal at all, and render these sheets as ordinary absolutely-
 * positioned views inside the screen instead. That is a bigger change and it
 * is what to reach for next.
 */
export function afterModalClose(go: () => void): void {
  setTimeout(go, MODAL_TEARDOWN_MS);
}

/**
 * How long the app waits. Must exceed the Modal's slide animation (~300ms on
 * Android), not merely a frame or two of teardown.
 */
export const MODAL_TEARDOWN_MS = 350;
