// Exact hypergeometric probabilities. Population N, K successes in it, n cards drawn without replacement.

const logFact: number[] = [0];
function lf(n: number): number {
  for (let i = logFact.length; i <= n; i++) logFact.push(logFact[i - 1]! + Math.log(i));
  return logFact[n]!;
}
const logChoose = (n: number, k: number) => (k < 0 || k > n ? -Infinity : lf(n) - lf(k) - lf(n - k));

/** P(X = k) */
export function hypergeomPmf(N: number, K: number, n: number, k: number): number {
  if (k < Math.max(0, n - (N - K)) || k > Math.min(K, n)) return 0;
  return Math.exp(logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n));
}

/** P(X >= k): the chance of drawing at least k of the K successes in n cards. */
export function hypergeomAtLeast(N: number, K: number, n: number, k: number): number {
  if (k <= 0) return 1;
  let p = 0;
  for (let i = k; i <= Math.min(K, n); i++) p += hypergeomPmf(N, K, n, i);
  return Math.min(1, p);
}

/** Smallest K (sources) in an N-card deck with P(at least k among n cards seen) >= target, or null if even K = N isn't enough. */
export function minSources(N: number, n: number, k: number, target: number): number | null {
  for (let K = k; K <= N; K++) if (hypergeomAtLeast(N, K, n, k) >= target) return K;
  return null;
}
