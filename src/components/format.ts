/**
 * Shared number formatting for every metric rendered in the app.
 * All output is intended to be displayed in `var(--mono)` with tabular-nums.
 */

/**
 * Latency in milliseconds.
 * Under 10ms one decimal keeps sub-millisecond differences visible;
 * at or above 10ms the decimal is noise, so it is dropped.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '--';
  const v = ms < 0 ? 0 : ms;
  if (v < 10) return `${v.toFixed(1)}ms`;
  if (v < 10_000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

/** Requests per second. Integers below 10k, then compacted to `k`. */
export function formatRate(rps: number): string {
  if (!Number.isFinite(rps)) return '--';
  const v = rps < 0 ? 0 : rps;
  if (v < 10_000) return `${Math.round(v)}`;
  return `${(v / 1000).toFixed(1)}k`;
}

/** A 0..1 fraction rendered as a percentage with one decimal. */
export function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '--';
  const v = fraction < 0 ? 0 : fraction;
  return `${(v * 100).toFixed(1)}%`;
}
