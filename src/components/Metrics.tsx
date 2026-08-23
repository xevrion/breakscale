import { memo, useMemo } from 'react';
import type { FailureReason, HistoryPoint, SimSnapshot } from '../sim/types';
import './Metrics.css';

/* ------------------------------------------------------------------ *
 * Chart geometry
 *
 * Every chart is two stacked SVGs sharing one box:
 *   1. a plot layer with preserveAspectRatio="none" so the polylines
 *      stretch to fill whatever width the container has, and
 *   2. an overlay layer at 1:1 scale carrying all the text.
 * That keeps labels crisp and correctly proportioned at any width,
 * which a single stretched viewBox would not.
 * ------------------------------------------------------------------ */

/** Internal coordinate space of the stretched plot layer. */
const PLOT_W = 1000;
const PLOT_H = 100;

/** Gutters, in real (unscaled) pixels. */
const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 18;

/** Trailing window the charts show. */
const WINDOW_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Scales
 * ------------------------------------------------------------------ */

/** Round `v` up to the next 1/2/5 x 10^n. Always returns > 0. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const pow = 10 ** exp;
  const frac = v / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * Pick a y-axis top and tick values for a max observed value.
 * Never returns a zero-height axis, so an all-zero series still draws a
 * sane baseline instead of collapsing or producing NaN.
 */
function axis(max: number, fallback: number): { top: number; ticks: number[] } {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  // Headroom so the peak never rides the top border.
  const top = safeMax > 0 ? niceCeil(safeMax * 1.15) : fallback;
  const step = top / 2;
  return { top, ticks: [0, step, top] };
}

/** Compact number formatting for axis labels and legends. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const a = Math.abs(v);
  if (a >= 10_000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  if (a === 0) return '0';
  return v.toFixed(2);
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return v.toFixed(0);
  return v.toFixed(1);
}

/**
 * Map history to x positions in plot space over a fixed 60s trailing
 * window anchored at the newest sample, so the traces scroll rather
 * than rescaling under the cursor.
 */
function useXScale(history: HistoryPoint[]) {
  return useMemo(() => {
    const n = history.length;
    if (n === 0) return { at: () => 0, tEnd: 0 };
    const tEnd = history[n - 1]!.t;
    const tStart = tEnd - WINDOW_MS;
    const at = (t: number) => {
      // Guard the degenerate single-point / zero-span case.
      const f = (t - tStart) / WINDOW_MS;
      return Math.max(0, Math.min(1, f)) * PLOT_W;
    };
    return { at, tEnd };
  }, [history]);
}

/**
 * Build an SVG points string. A single point is emitted twice so the
 * polyline still renders a visible mark instead of nothing.
 */
function polyline(
  history: HistoryPoint[],
  xAt: (t: number) => number,
  value: (p: HistoryPoint) => number,
  top: number,
): string {
  if (history.length === 0) return '';
  const y = (v: number) => {
    const safe = Number.isFinite(v) ? v : 0;
    return PLOT_H - (Math.max(0, Math.min(top, safe)) / top) * PLOT_H;
  };
  const pts = history.map((p) => `${xAt(p.t).toFixed(2)},${y(value(p)).toFixed(2)}`);
  if (pts.length === 1) return `${pts[0]} ${pts[0]}`;
  return pts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Chart frame: gridlines + y labels + x labels, shared by both charts
 * ------------------------------------------------------------------ */

interface FrameProps {
  ticks: number[];
  top: number;
  format: (v: number) => string;
  height: number;
}

/** The unscaled overlay: gridlines drawn in real px, plus all text. */
function Frame({ ticks, top, format, height }: FrameProps) {
  const plotH = height - PAD_T - PAD_B;
  return (
    <>
      {ticks.map((t) => {
        const y = PAD_T + plotH - (top > 0 ? (t / top) * plotH : 0);
        return (
          <g key={t}>
            <line
              className="mx-grid"
              x1={PAD_L}
              y1={y}
              x2={`calc(100% - ${PAD_R}px)`}
              y2={y}
            />
            <text className="mx-ylabel" x={PAD_L - 8} y={y} dy="0.32em" textAnchor="end">
              {format(t)}
            </text>
          </g>
        );
      })}
      <text className="mx-xlabel" x={PAD_L} y={height - 5}>
        60s ago
      </text>
      <text
        className="mx-xlabel"
        x={`calc(100% - ${PAD_R}px)`}
        y={height - 5}
        textAnchor="end"
      >
        now
      </text>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Latency chart
 * ------------------------------------------------------------------ */

const LAT_H = 128;

interface LatencyChartProps {
  history: HistoryPoint[];
  p50: number;
  p95: number;
  p99: number;
}

const LatencyChart = memo(function LatencyChart({
  history,
  p50,
  p95,
  p99,
}: LatencyChartProps) {
  const { at } = useXScale(history);

  const { top, ticks } = useMemo(() => {
    let max = 0;
    for (const p of history) if (Number.isFinite(p.p99) && p.p99 > max) max = p.p99;
    return axis(max, 100);
  }, [history]);

  const paths = useMemo(
    () => ({
      p50: polyline(history, at, (p) => p.p50, top),
      p95: polyline(history, at, (p) => p.p95, top),
      p99: polyline(history, at, (p) => p.p99, top),
    }),
    [history, at, top],
  );

  const plotH = LAT_H - PAD_T - PAD_B;

  return (
    <section className="mx-chart">
      <header className="mx-chart-head">
        <h3 className="mx-title">Latency</h3>
        <div className="mx-readout">
          <span className="mx-read mx-read-p50">
            <span className="mx-read-k">p50</span>
            <span className="mx-read-v">{fmtMs(p50)}</span>
          </span>
          <span className="mx-read mx-read-p95">
            <span className="mx-read-k">p95</span>
            <span className="mx-read-v">{fmtMs(p95)}</span>
          </span>
          <span className="mx-read mx-read-p99">
            <span className="mx-read-k">p99</span>
            <span className="mx-read-v">{fmtMs(p99)}</span>
          </span>
        </div>
      </header>

      <div className="mx-plot" style={{ height: LAT_H }}>
        {/* Stretched layer: geometry only, no text. */}
        <svg
          className="mx-layer mx-layer-scaled"
          viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          style={{
            top: PAD_T,
            height: plotH,
            left: PAD_L,
            width: `calc(100% - ${PAD_L + PAD_R}px)`,
          }}
          aria-hidden="true"
        >
          <polyline className="mx-line mx-line-p50" points={paths.p50} />
          <polyline className="mx-line mx-line-p95" points={paths.p95} />
          <polyline className="mx-line mx-line-p99" points={paths.p99} />
        </svg>

        {/* Unscaled layer: gridlines and every label. */}
        <svg className="mx-layer" aria-hidden="true">
          <Frame ticks={ticks} top={top} format={fmtMs} height={LAT_H} />
          <text className="mx-unit" x={PAD_L - 8} y={PAD_T - 2} textAnchor="end">
            ms
          </text>
        </svg>
      </div>
    </section>
  );
});

/* ------------------------------------------------------------------ *
 * Throughput chart
 *
 * The gap between offered and goodput is dropped traffic. It gets an
 * explicit filled band rather than being left for the eye to infer.
 * ------------------------------------------------------------------ */

const TP_H = 128;

interface ThroughputChartProps {
  history: HistoryPoint[];
  offered: number;
  goodput: number;
}

const ThroughputChart = memo(function ThroughputChart({
  history,
  offered,
  goodput,
}: ThroughputChartProps) {
  const { at } = useXScale(history);

  const { top, ticks } = useMemo(() => {
    let max = 0;
    for (const p of history) {
      if (Number.isFinite(p.offered) && p.offered > max) max = p.offered;
      if (Number.isFinite(p.goodput) && p.goodput > max) max = p.goodput;
    }
    return axis(max, 10);
  }, [history]);

  const { offeredPts, goodputPts, gapPts } = useMemo(() => {
    const y = (v: number) => {
      const safe = Number.isFinite(v) ? v : 0;
      return PLOT_H - (Math.max(0, Math.min(top, safe)) / top) * PLOT_H;
    };
    const o = polyline(history, at, (p) => p.offered, top);
    const g = polyline(history, at, (p) => p.goodput, top);

    // Closed band between the two lines: offered forward, goodput back.
    let gap = '';
    if (history.length > 0) {
      const fwd = history.map((p) => `${at(p.t).toFixed(2)},${y(p.offered).toFixed(2)}`);
      const rev = history
        .map((p) => `${at(p.t).toFixed(2)},${y(p.goodput).toFixed(2)}`)
        .reverse();
      if (history.length === 1) {
        // Degenerate: a single sample has no area. Skip the fill.
        gap = '';
      } else {
        gap = [...fwd, ...rev].join(' ');
      }
    }
    return { offeredPts: o, goodputPts: g, gapPts: gap };
  }, [history, at, top]);

  // Sanitize before arithmetic: a non-finite rate from the engine would
  // otherwise reach the DOM as "NaN%".
  const safeOffered = Number.isFinite(offered) ? Math.max(0, offered) : 0;
  const safeGoodput = Number.isFinite(goodput) ? Math.max(0, goodput) : 0;
  const dropped = Math.max(0, safeOffered - safeGoodput);
  const dropPct = safeOffered > 0 ? (dropped / safeOffered) * 100 : 0;
  const plotH = TP_H - PAD_T - PAD_B;

  return (
    <section className="mx-chart">
      <header className="mx-chart-head">
        <h3 className="mx-title">Throughput</h3>
        <div className="mx-readout">
          <span className="mx-read mx-read-offered">
            <span className="mx-read-k">offered</span>
            <span className="mx-read-v">{fmt(safeOffered)}</span>
          </span>
          <span className="mx-read mx-read-goodput">
            <span className="mx-read-k">goodput</span>
            <span className="mx-read-v">{fmt(safeGoodput)}</span>
          </span>
          {dropped > 0.05 && (
            <span className="mx-read mx-read-dropped">
              <span className="mx-read-k">dropped</span>
              <span className="mx-read-v">
                {fmt(dropped)}
                <span className="mx-read-sub"> · {dropPct.toFixed(0)}%</span>
              </span>
            </span>
          )}
        </div>
      </header>

      <div className="mx-plot" style={{ height: TP_H }}>
        <svg
          className="mx-layer mx-layer-scaled"
          viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          style={{
            top: PAD_T,
            height: plotH,
            left: PAD_L,
            width: `calc(100% - ${PAD_L + PAD_R}px)`,
          }}
          aria-hidden="true"
        >
          {gapPts && <polygon className="mx-gap" points={gapPts} />}
          <polyline className="mx-line mx-line-offered" points={offeredPts} />
          <polyline className="mx-line mx-line-goodput" points={goodputPts} />
        </svg>

        <svg className="mx-layer" aria-hidden="true">
          <Frame ticks={ticks} top={top} format={fmt} height={TP_H} />
          <text className="mx-unit" x={PAD_L - 8} y={PAD_T - 2} textAnchor="end">
            rps
          </text>
        </svg>
      </div>
    </section>
  );
});

/* ------------------------------------------------------------------ *
 * Failure breakdown
 * ------------------------------------------------------------------ */

const REASON_ORDER: FailureReason[] = ['error', 'shed', 'timeout', 'no-route', 'depth'];

const REASON_LABEL: Record<FailureReason, string> = {
  error: 'error',
  shed: 'shed',
  timeout: 'timeout',
  'no-route': 'no route',
  depth: 'depth',
};

interface FailureBarProps {
  failures: Record<FailureReason, number>;
}

const FailureBar = memo(function FailureBar({ failures }: FailureBarProps) {
  const parts = useMemo(() => {
    const rows = REASON_ORDER.map((reason) => {
      const raw = failures[reason];
      const count = Number.isFinite(raw) && raw > 0 ? raw : 0;
      return { reason, count };
    }).filter((r) => r.count > 0);
    const total = rows.reduce((s, r) => s + r.count, 0);
    return { rows, total };
  }, [failures]);

  return (
    <section className="mx-fail">
      <header className="mx-chart-head">
        <h3 className="mx-title">Failures</h3>
        <span className="mx-fail-total">{fmt(parts.total)}</span>
      </header>

      {parts.total === 0 ? (
        <>
          <div className="mx-fail-bar mx-fail-bar-empty" />
          <p className="mx-fail-none">No failed requests</p>
        </>
      ) : (
        <>
          <div className="mx-fail-bar">
            {parts.rows.map((r) => (
              <span
                key={r.reason}
                className={`mx-fail-seg mx-fail-${r.reason}`}
                style={{ flexGrow: r.count }}
              />
            ))}
          </div>
          <ul className="mx-fail-legend">
            {parts.rows.map((r) => (
              <li key={r.reason} className="mx-fail-item">
                <span className={`mx-swatch mx-fail-${r.reason}`} />
                <span className="mx-fail-name">{REASON_LABEL[r.reason]}</span>
                <span className="mx-fail-count">{fmt(r.count)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
});

/* ------------------------------------------------------------------ *
 * Metrics strip
 * ------------------------------------------------------------------ */

export interface MetricsProps {
  snapshot: SimSnapshot;
}

export function Metrics({ snapshot }: MetricsProps) {
  const { system, history, failuresByReason } = snapshot;

  // Only the trailing window is ever drawn; older samples are dropped
  // here so the charts stay cheap no matter how long the sim has run.
  const windowed = useMemo(() => {
    if (history.length === 0) return history;
    const tEnd = history[history.length - 1]!.t;
    const cutoff = tEnd - WINDOW_MS;
    let i = 0;
    while (i < history.length && history[i]!.t < cutoff) i += 1;
    return i === 0 ? history : history.slice(i);
  }, [history]);

  return (
    <div className="mx">
      <LatencyChart
        history={windowed}
        p50={system.p50}
        p95={system.p95}
        p99={system.p99}
      />
      <ThroughputChart
        history={windowed}
        offered={system.offeredRps}
        goodput={system.goodputRps}
      />
      <FailureBar failures={failuresByReason} />
    </div>
  );
}
