import { withDeadline, boundedFetch, DeadlineError } from '../src/deadline.ts';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? ` — ${d}` : ''}`); }
};
const section = (t: string) => console.log(`\x1b[1m${t}\x1b[0m`);
const never = () => new Promise<never>(() => {});

section('withDeadline — a wait that never settles fails instead of hanging (order 79642, 23 Sep 2026)');
{
  let err: unknown = null;
  const t0 = Date.now();
  try { await withDeadline(never(), 50, 'Sending scans'); } catch (e) { err = e; }
  ok('rejects', err instanceof DeadlineError);
  ok('on time, not for ever', Date.now() - t0 < 1000);
  ok('says nothing is lost', String((err as Error)?.message).includes('Nothing is lost'));
}
{
  ok('a fast answer passes through', (await withDeadline(Promise.resolve(7), 1000, 'x')) === 7);
  let err: unknown = null;
  try { await withDeadline(Promise.reject(new Error('refused')), 1000, 'x'); } catch (e) { err = e; }
  ok('a real error is not replaced by the deadline', (err as Error)?.message === 'refused');
}

section('boundedFetch — a token refresh on a dead socket is aborted');
{
  let sawSignal: AbortSignal | null = null;
  const hang = ((_: any, init: any) => {
    sawSignal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as unknown as typeof fetch;
  let err: unknown = null;
  try { await boundedFetch(50, hang)('https://x', {}); } catch (e) { err = e; }
  ok('aborts after the limit', (err as Error)?.message === 'aborted' && !!sawSignal && (sawSignal as AbortSignal).aborted);
}
{
  const outer = new AbortController();
  let inner: AbortSignal | null = null;
  const capture = ((_: any, init: any) => { inner = init.signal; return new Promise(() => {}); }) as unknown as typeof fetch;
  void boundedFetch(10_000, capture)('https://x', { signal: outer.signal });
  outer.abort();
  ok("the caller's own abort still works", !!inner && (inner as AbortSignal).aborted);
}

section('wired where the hang was');
{
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
  ok('supabase client fetch is bounded', /global: \{ fetch: boundedFetch\(\d+_000\) \}/.test(api));
  ok('authHeader getSession is bounded', /withDeadline\(supabase\.auth\.getSession\(\)/.test(api));
  ok('the whole send step is bounded', /withDeadline\(postScans\(chunk\)/.test(store));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
