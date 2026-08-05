/**
 * ULID — a sortable, collision-resistant id minted on the handset.
 *
 * The scan happens offline, so the device has to name it. Two properties
 * matter: ids minted in the same millisecond must stay distinct and ordered
 * (a driver scanning fast produces several per tick), and the id must encode
 * its own timestamp so the queue sorts correctly without a separate column.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

const randomChar = () => Math.floor(Math.random() * ENCODING.length);

function encodeTime(now: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

/** Increment the random block in place, so same-millisecond ids stay ordered. */
function bumpRandom(rand: number[]): number[] {
  const out = [...rand];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 31) { out[i]++; return out; }
    out[i] = 0;
  }
  return Array.from({ length: RAND_LEN }, randomChar); // overflow: reseed
}

export function ulid(seedTime?: number): string {
  const now = seedTime ?? Date.now();
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = Array.from({ length: RAND_LEN }, randomChar);
  }
  return encodeTime(now) + lastRandom.map((i) => ENCODING[i]).join('');
}

export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) t = t * 32 + ENCODING.indexOf(ch);
  return t;
}
