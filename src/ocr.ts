/**
 * ON-DEVICE TEXT RECOGNITION, AND WHY IT IS ALLOWED TO GUESS WHERE A MODEL IS NOT.
 *
 * The scanner has three tiers. The live decoder reads bars off the video
 * stream. "Snap" photographs the reticle and hands the still to ML Kit's
 * barcode decoder, which cracks labels the live pipeline cannot. This file is
 * the third tier, for the label whose bars are simply gone — scuffed, painted
 * over, frost-bitten, printed by a ribbon that ran out halfway — but whose
 * human-readable number is still printed underneath, because that is what the
 * number under a barcode is for.
 *
 * THIS REPLACED A PAID VISION-API VERSION. The first attempt at this tier sent
 * a JPEG to the server, which asked a hosted vision model to read the label.
 * It worked and it is gone, for three reasons that are not going to change:
 * it needed an API key nobody is paying for, it cost money on every single
 * tap, and it needed signal — in a yard with no bars, which is precisely where
 * a driver is standing when the barcode will not read. ML Kit text recognition
 * runs entirely on the handset: no key, no network, no per-scan cost, and it
 * works with the phone in aeroplane mode. Same vendor as the barcode module
 * already in the build.
 *
 * WHY READING THE PRINTED NUMBER IS SAFE WHERE AI BAR-DECODING IS NOT.
 * A decoder is not a guesser. It computes check digits and either resolves to
 * a value or reports nothing — a barcode decoder that fails, fails loudly. A
 * model asked to look at a picture of bars and say what they encode has no
 * such floor: it will produce a plausible, well-formed, confidently-wrong
 * number, and it will do so most eagerly on exactly the damaged label that
 * made someone reach for it. That number goes on a scan, the scan settles a
 * rental, the rental bills a customer. There is no round trip in which anyone
 * notices. OCR of printed glyphs is a different problem — the characters are
 * right there, and the failure mode is a mangled character, not an invented
 * record. But OCR is still not trusted on its own here.
 *
 * THE KNOWN-SET CHECK IS THE REAL TRUST BOUNDARY.
 * Everything above is why OCR is a reasonable thing to attempt. `matchKnown`
 * is why a mistake cannot become a billing event. Whatever ML Kit reports, a
 * candidate is only ever accepted if it is already in this org's own data —
 * an asset barcode or a customer code the phone downloaded in its bootstrap.
 * A candidate matching nothing is discarded exactly as if the camera had read
 * nothing at all. So the worst case of a misread is not a wrong cylinder on a
 * delivery; it is a driver tapping the button again. That is the whole design,
 * and weakening it — accepting a candidate because it "looks like" a barcode,
 * or because the OCR confidence was high — would put the paid version's exact
 * failure mode back with none of its cost.
 *
 * `candidatesFrom` and `matchKnown` are pure and touch nothing but `key()`, so
 * the rule that protects billing is unit-testable without a camera, a device,
 * or a native module. See __tests__/ocr.test.mts.
 */
/**
 * Imported WITH its extension, unlike everything else in src/.
 *
 * Metro resolves both spellings, but this module is also loaded directly by
 * node in __tests__/ocr.test.mts, and node reads a file containing `import`
 * as ESM — where an extensionless relative specifier is not resolved at all.
 * `./scan-match` therefore passes the bundler and the type checker and dies
 * only when the test suite runs, which is the point of having the test suite.
 * `allowImportingTsExtensions` is on via expo/tsconfig.base, so this is a
 * supported spelling and not a workaround.
 */
import { key } from './scan-match.ts';

/**
 * The native module, loaded once and lazily — the same shape as `loadMlkit()`
 * in scanner.tsx and for the same reason. Text recognition is native code that
 * only exists in an EAS dev/production build. In Expo Go the require throws,
 * and an app that crashed on import because a fallback button might one day be
 * shown would be a far worse trade than a fallback button that quietly does
 * not appear. `undefined` means "not tried yet", `null` means "tried, not
 * here" — the two must stay distinct or every call re-attempts a require that
 * is already known to fail.
 */
type Recognizer = { recognize: (uri: string) => Promise<TextResult> };
type TextResult = {
  text?: string | null;
  blocks?: { text?: string | null; lines?: { text?: string | null }[] }[] | null;
};

let recognizer: Recognizer | null | undefined;
function loadRecognizer(): Recognizer | null {
  if (recognizer !== undefined) return recognizer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-ml-kit/text-recognition');
    const api = mod?.default ?? mod;
    recognizer = typeof api?.recognize === 'function' ? api : null;
  } catch {
    recognizer = null;
  }
  return recognizer ?? null;
}

/** Whether this build can read text at all. False in Expo Go — hide the button. */
export function hasOcr(): boolean {
  return loadRecognizer() !== null;
}

/**
 * Read the printed text out of a photo.
 *
 * Returns the recognised lines rather than one blob, because a label is
 * laid out in lines and the token that matters — the number under the bars —
 * is almost always alone on one of them. Falls back to the whole-result
 * `text` when a build reports no block structure, and returns an empty array
 * rather than throwing: every caller's response to "nothing readable" and to
 * "the recogniser fell over" is identical, so there is nothing for a `catch`
 * at the call site to usefully do differently.
 */
export class OcrUnavailable extends Error {}

export async function recognizeText(uri: string): Promise<string[]> {
  const api = loadRecognizer();
  if (!api) throw new OcrUnavailable('Text reading is not in this build.');
  try {
    const result = await api.recognize(uri);
    const lines: string[] = [];
    for (const block of result?.blocks ?? []) {
      const blockLines = block?.lines ?? [];
      if (blockLines.length) {
        for (const line of blockLines) if (line?.text) lines.push(line.text);
      } else if (block?.text) {
        lines.push(block.text);
      }
    }
    if (!lines.length && result?.text) lines.push(result.text);
    return lines;
  } catch (e) {
    /**
     * THIS USED TO RETURN [] AND THAT HID THE BUG FOR A WHOLE RELEASE.
     *
     * `loadRecognizer` cannot tell whether the native side is really there:
     * the package exports a plain object whose `recognize` closes over a Proxy
     * that throws only when CALLED, so the probe passes on a build where the
     * module was never linked. Swallowing the call-time throw therefore turned
     * "this feature does not exist in your app" into "no match on file" —
     * indistinguishable, on a phone, from working correctly and finding
     * nothing. It shipped twice like that.
     *
     * So the linking failure is rethrown, distinguishable by type, and the
     * button reports it. Any other error — a corrupt JPEG, an unreadable
     * frame — is still just "nothing readable here", which is what an empty
     * array means.
     */
    const message = e instanceof Error ? e.message : String(e);
    if (/doesn't seem to be linked|not in this build|null is not an object|undefined is not an object/i.test(message)) {
      throw new OcrUnavailable('Text reading is not in this build.');
    }
    return [];
  }
}

/**
 * Every plausible code token in some recognised text, best-effort and generous.
 *
 * Generous is correct here BECAUSE of the known-set check downstream: this
 * function's job is to not miss the right token, not to decide which token is
 * right. A label carries the number, a product code, a date, a tare weight,
 * a phone number on the depot sticker — throwing all of them at the org's own
 * data and letting the data pick is strictly safer than trying to be clever
 * about which one is "the barcode", because being clever about that is a guess
 * and a lookup is not.
 *
 * Split on anything that is not code-ish, uppercase (the whole app compares
 * uppercased), and keep tokens of 3–40 characters. Below 3 is noise — stray
 * glyphs, "KG", "LB", the "A" of a logo — and would only ever collide with
 * real data by accident. Above 40 is a run-on of a whole line the recogniser
 * failed to break, not an identifier anyone printed. Hyphen and asterisk
 * survive because the codes in this system genuinely contain them — a customer
 * card prints as `*%800006D2-1614971550A*` — and treating a hyphen as a
 * separator would tear that code into two halves, neither of which is anything.
 * The punctuation is not what gets compared (see `matchKnown`); it just has to
 * stay attached long enough for the token to survive as one token.
 *
 * Order is preserved and duplicates dropped, so "first candidate that is known
 * wins" downstream means "highest on the label", which is the closest thing to
 * intent available once the picture has been taken.
 */
export function candidatesFrom(text: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text) {
    if (!line) continue;
    for (const raw of line.toUpperCase().split(/[^A-Z0-9\-*]+/)) {
      if (raw.length < 3 || raw.length > 40) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/**
 * THE TRUST BOUNDARY. The org's own stored code that a candidate turned out to
 * be, or null.
 *
 * `known` is built from the phone's own bootstrap — asset barcodes, customer
 * account numbers and the codes printed on customer cards, uppercased.
 * Nothing else is ever accepted. A caller holding an empty set therefore
 * accepts nothing, which is exactly right for a phone that has never synced:
 * with no data to check against there is no way to tell a correct read from an
 * invented one, and the safe answer to that is no.
 *
 * BOTH SIDES GO THROUGH key(), FOR THE REASON scan-match.ts ALREADY GIVES.
 * An exact string compare only worked for codes with no decoration, which
 * quietly excluded the single most common thing a driver photographs: a
 * customer card. WeldCor prints Code 39 wrapped in asterisks with a `%`
 * prefix — `*%800006D2-1614971550A*` — and OCR hands that back sliced at the
 * `%` as `800006D2-1614971550A*`, which is byte-identical to neither the
 * stored card code nor the account number. `key()` strips both sides down to
 * the alphanumeric payload, so whatever the printer added and whatever the
 * recogniser mangled around it cancels out without this file having to know
 * any tenant's format. This is the same reduction the live scan path uses;
 * inventing a second, subtly different one here is how two code paths start
 * disagreeing about who gets billed.
 *
 * WHAT COMES BACK IS THE STORED SPELLING, NOT WHAT THE CAMERA SAW. The screens
 * hand an accepted code straight to `classify()`, so returning the OCR token
 * would make this path's success depend on that token surviving a second
 * lookup it was never guaranteed to pass. Returning the entry the org actually
 * stores means the code is by construction one `classify` can resolve.
 *
 * A REDUCED MATCH IS REFUSED WHEN IT IS AMBIGUOUS. Discarding punctuation is
 * what makes this work across printers, and it also means `AB-123` and `AB123`
 * collapse to one key. Where two genuinely different stored codes land on the
 * same key there is no honest way to choose, and picking whichever was
 * enumerated first is exactly how a cylinder ends up on the wrong account —
 * so that key resolves to nothing at all. `classify` refuses the identical
 * case for the identical reason. A byte-identical hit is checked first and is
 * never ambiguous, because that precise string is stored against one entry.
 */
export function matchKnown(candidates: string[], known: Set<string>): string | null {
  if (!known.size) return null;

  // Reduced key -> the one stored code that reduces to it, or null where two
  // different stored codes collide there and neither may be chosen.
  const byKey = new Map<string, string | null>();
  for (const entry of known) {
    const k = key(entry);
    if (!k) continue;                       // pure punctuation carries nothing
    if (byKey.has(k)) byKey.set(k, null);
    else byKey.set(k, entry);
  }

  for (const c of candidates) {
    if (known.has(c)) return c;             // exact: nothing further to decide
    const k = key(c);
    if (!k) continue;
    const hit = byKey.get(k);
    if (hit) return hit;                    // null (ambiguous) falls through
  }
  return null;
}
