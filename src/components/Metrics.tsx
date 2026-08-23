import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { FailureReason, HistoryPoint, SimSnapshot } from '../sim/types';
import {
  formatCompact,
  formatMs,
  formatRate,
  healthOfLatency,
  type Health,
} from './format';
import './Metrics.css';

/* ------------------------------------------------------------------ *
 * Chart geometry
 *
 * Every chart is two stacked SVGs sharing one box:
 *   1. a plot layer with preserveAspectRatio="none" so the polylines
 *      stretch to fill whatever width the container has, and
 *   2. an overlay layer at 1:1 scale carrying all the text.
 *
 * This is why labels stay crisp at any width: text never lives in the
 * stretched coordinate space, so it can never be smeared by it.
 *
 * The overlay needs to know its real pixel width to place a right-edge
 * label. It is measured with a ResizeObserver, NOT with calc() — calc()
 * is invalid in SVG geometry presentation attributes and silently
 * resolves to 0, which is what threw the old `now` label 726px out of
 * position while the identical calc() on a <line x2> happened to work.
 * ------------------------------------------------------------------ */

/** Internal coordinate space of the stretched plot layer. */
const PLOT_W = 1000;
const PLOT_H = 100;

/** Gutters, in real (unscaled) pixels. */
const PAD_L = 40; // widest tick `1.2k` at 12px mono is ~29px, + 4 gap + 7 margin
const PAD_R = 16; // enough that the right-edge `NOW` sits fully inside the box
const PAD_T = 16; // air above the topmost tick
const PAD_B = 28; // 10px x-labels + baseline offset + clearance

/** Total height of a plot box. Plot area = 176 - 16 - 28 = 132px. */
const CHART_H = 176;

/** Trailing window the charts show. */
const WINDOW_MS = 60_000;

/** Width assumed before the first ResizeObserver callback lands. */
const FALLBACK_W = 320;

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

/** Five ticks at 0, 25, 50, 75, 100% of the axis top. */
function ticksFor(top: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
}

/**
 * A y-axis top that rises immediately but falls only reluctantly.
 *
 * Without this the axis rescales under the student's cursor mid-drag and
 * the whole trace appears to jump — one of the biggest contributors to
 * the "unfinished" read. An increase applies at once; a decrease waits
 * until the observed max has stayed below half the current top for a
 * continuous 5 seconds.
 */
function useStickyAxis(max: number, fallback: number): { top: number; ticks: number[] } {
  const [top, setTop] = useState(fallback);
  // When the value first dropped below half of `top`. null = not low.
  const lowSince = useRef<number | null>(null);

  const target = useMemo(() => {
    const safe = Number.isFinite(max) && max > 0 ? max : 0;
    return safe > 0 ? niceCeil(safe * 1.15) : fallback;
  }, [max, fallback]);

  useEffect(() => {
    const now = performance.now();

    if (target > top) {
      lowSince.current = null;
      setTop(target);
      return;
    }
    if (target >= top) {
      lowSince.current = null;
      return;
    }

    // target < top: only shrink after a sustained quiet period, and only
    // when it has fallen well below — not for a 5% dip.
    if (target > top / 2) {
      lowSince.current = null;
      return;
    }
    if (lowSince.current === null) {
      lowSince.current = now;
      return;
    }
    if (now - lowSince.current >= 5000) {
      lowSince.current = null;
      setTop(target);
    }
  }, [target, top]);

  return useMemo(() => ({ top, ticks: ticksFor(top) }), [top]);
}

/**
 * Map history to x positions in plot space over a fixed 60s trailing
 * window anchored at the newest sample, so traces scroll rather than
 * rescaling under the cursor.
 */
function useXScale(history: HistoryPoint[]) {
  return useMemo(() => {
    const n = history.length;
    if (n === 0) return { at: () => 0 };
    const tEnd = history[n - 1]!.t;
    const tStart = tEnd - WINDOW_MS;
    const at = (t: number) => {
      const f = (t - tStart) / WINDOW_MS;
      return Math.max(0, Math.min(1, f)) * PLOT_W;
    };
    return { at };
  }, [history]);
}

/** Project a value into plot-space y. `top` is guaranteed > 0 by niceCeil. */
function yOf(v: number, top: number): number {
  const safe = Number.isFinite(v) ? v : 0;
  const denom = top > 0 ? top : 1;
  return PLOT_H - (Math.max(0, Math.min(denom, safe)) / denom) * PLOT_H;
}

/**
 * Build an SVG points string. A single sample is emitted twice so the
 * polyline still renders a visible mark rather than nothing at all.
 */
function polyline(
  history: HistoryPoint[],
  xAt: (t: number) => number,
  value: (p: HistoryPoint) => number,
  top: number,
): string {
  if (history.length === 0) return '';
  const pts = history.map(
    (p) => `${xAt(p.t).toFixed(2)},${yOf(value(p), top).toFixed(2)}`,
  );
  if (pts.length === 1) return `${pts[0]} ${pts[0]}`;
  return pts.join(' ');
}

/** Measure a node's content-box width in real pixels. */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(FALLBACK_W);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Seed synchronously so the first paint is not at the fallback width.
    const initial = el.clientWidth;
    if (initial > 0) setW(initial);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = entry.contentRect.width;
        if (next > 0) setW(next);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, w };
}

/* ------------------------------------------------------------------ *
 * Shared chart chrome
 * ------------------------------------------------------------------ */

interface ChartHeadProps {
  /** Eyebrow, e.g. "LATENCY · MS". Uppercase, T1. */
  caption: string;
  /** The single T5 readout on the right. */
  value: string;
  tone?: Health;
  /** Optional secondary figure, e.g. "DROPPED 42 rps". */
  extra?: React.ReactNode;
}

function ChartHead({ caption, value, tone = 'ok', extra }: ChartHeadProps) {
  return (
    <header className="mx-head">
      <span className="label mx-eyebrow">{caption}</span>
      <span className="mx-head-right">
        {extra}
        <span className={`num num-lg mx-readout ${toneClass(tone)}`}>{value}</span>
      </span>
    </header>
  );
}

function toneClass(h: Health): string {
  return h === 'ok' ? '' : h === 'warn' ? 'is-warn' : 'is-danger';
}

interface FrameProps {
  ticks: number[];
  top: number;
  format: (v: number) => string;
  /** Measured pixel width of the overlay. */
  w: number;
  /** True when there is not enough data to draw a trace. */
  empty: boolean;
}

/**
 * The unscaled overlay: gridlines, the emphasized zero line, y tick
 * labels, x tick stubs and the two x captions. Every geometry attribute
 * here is a number — no calc(), ever.
 */
const Frame = memo(function Frame({ ticks, top, format, w, empty }: FrameProps) {
  const plotH = CHART_H - PAD_T - PAD_B;
  const right = Math.max(PAD_L + 1, w - PAD_R);
  const baseY = PAD_T + plotH;

  // Four x ticks: -60s, -40s, -20s, now.
  const xTicks = [0, 1, 2, 3].map((i) => PAD_L + ((right - PAD_L) * i) / 3);

  return (
    <>
      {ticks.map((t, i) => {
        // +0.5 so a 1px rule sits on a device pixel instead of straddling two.
        const y = Math.round(PAD_T + plotH - (top > 0 ? (t / top) * plotH : 0)) + 0.5;
        const isZero = i === 0;
        return (
          <g key={t}>
            <line
              className={isZero ? 'mx-zero' : 'mx-grid'}
              x1={isZero ? PAD_L - 4 : PAD_L}
              y1={y}
              x2={right}
              y2={y}
            />
            <text className="mx-ytick num" x={PAD_L - 8} y={y} dy="0.32em" textAnchor="end">
              {format(t)}
            </text>
          </g>
        );
      })}

      {/* X tick stubs rising from the baseline — temporal reference
          without clutter. Only the two ends are labelled. */}
      {xTicks.map((x, i) => (
        <line
          key={i}
          className="mx-xtick"
          x1={Math.round(x) + 0.5}
          y1={baseY}
          x2={Math.round(x) + 0.5}
          y2={baseY + 3}
        />
      ))}

      {/* The present: a rule at the right edge so traces visibly scroll
          into a fixed `now`. */}
      <line
        className="mx-now"
        x1={Math.round(right) + 0.5}
        y1={PAD_T}
        x2={Math.round(right) + 0.5}
        y2={baseY}
      />

      <text className="label mx-xlabel" x={PAD_L} y={CHART_H - 8}>
        60S
      </text>
      <text className="label mx-xlabel" x={right} y={CHART_H - 8} textAnchor="end">
        NOW
      </text>

      {empty && (
        <text
          className="label mx-empty"
          x={(PAD_L + right) / 2}
          y={PAD_T + plotH / 2}
          dy="0.32em"
          textAnchor="middle"
        >
          AWAITING TRAFFIC
        </text>
      )}
    </>
  );
});

/** The stretched geometry layer, inset to the plot area. */
function PlotLayer({ w, children }: { w: number; children: React.ReactNode }) {
  const plotH = CHART_H - PAD_T - PAD_B;
  const plotW = Math.max(1, w - PAD_L - PAD_R);
  return (
    <svg
      className="mx-layer mx-layer-scaled"
      viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
      preserveAspectRatio="none"
      style={{ top: PAD_T, left: PAD_L, width: plotW, height: plotH }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Latency chart
 * ------------------------------------------------------------------ */

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
  const { ref, w } = useMeasuredWidth<HTMLDivElement>();
  const { at } = useXScale(history);

  const max = useMemo(() => {
    let m = 0;
    for (const p of history) if (Number.isFinite(p.p99) && p.p99 > m) m = p.p99;
    return m;
  }, [history]);

  const { top, ticks } = useStickyAxis(max, 100);

  const paths = useMemo(
    () => ({
      p50: polyline(history, at, (p) => p.p50, top),
      p95: polyline(history, at, (p) => p.p95, top),
      p99: polyline(history, at, (p) => p.p99, top),
    }),
    [history, at, top],
  );

  // The chart line and the headline number are toned by the same
  // function, so they can never disagree about what a value means.
  const tone = healthOfLatency(p99);
  // The frame always renders; the message only claims "no data" when
  // there genuinely is none. A single sample draws its own mark.
  const empty = history.length === 0;

  return (
    <section className="mx-chart" aria-label="Latency over the last 60 seconds">
      <ChartHead caption="Latency · ms" value={formatMs(p99)} tone={tone} />

      <div className="mx-plot" ref={ref} style={{ height: CHART_H }}>
        <PlotLayer w={w}>
          <polyline className="mx-line mx-line-p50" points={paths.p50} />
          <polyline className="mx-line mx-line-p95" points={paths.p95} />
          <polyline
            className={`mx-line mx-line-p99 ${toneClass(tone)}`}
            points={paths.p99}
          />
        </PlotLayer>

        <svg className="mx-layer" aria-hidden="true">
          <Frame ticks={ticks} top={top} format={formatCompact} w={w} empty={empty} />
        </svg>
      </div>

      <ul className="mx-legend">
        <LegendKey className="mx-key-p50" name="p50" value={formatMs(p50)} />
        <LegendKey className="mx-key-p95" name="p95" value={formatMs(p95)} />
        <LegendKey className="mx-key-p99" name="p99" value={formatMs(p99)} />
      </ul>
    </section>
  );
});

function LegendKey({
  className,
  name,
  value,
  dim,
}: {
  className: string;
  name: string;
  value: string;
  dim?: boolean;
}) {
  return (
    <li className="mx-key" data-dim={dim || undefined}>
      <span className={`mx-key-line ${className}`} aria-hidden="true" />
      <span className="mx-key-name">{name}</span>
      <span className="num num-sm mx-key-value">{value}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Throughput chart
 *
 * The most instructive visual in the app. The gap between offered and
 * goodput IS the dropped traffic, so it is drawn as literal area rather
 * than left for the eye to infer. When the system keeps up the two lines
 * coincide and the band has zero area; when it sheds, a red wedge opens.
 * ------------------------------------------------------------------ */

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
  const { ref, w } = useMeasuredWidth<HTMLDivElement>();
  const { at } = useXScale(history);

  const max = useMemo(() => {
    let m = 0;
    for (const p of history) {
      if (Number.isFinite(p.offered) && p.offered > m) m = p.offered;
      if (Number.isFinite(p.goodput) && p.goodput > m) m = p.goodput;
    }
    return m;
  }, [history]);

  const { top, ticks } = useStickyAxis(max, 10);

  const { offeredPts, goodputPts, gapPts } = useMemo(() => {
    const o = polyline(history, at, (p) => p.offered, top);
    const g = polyline(history, at, (p) => p.goodput, top);

    // Closed band between the two traces: offered forward, goodput back.
    // A single sample has no area, so the fill is skipped entirely.
    let gap = '';
    if (history.length > 1) {
      // Only draw where traffic is actually being lost, so a healthy
      // system shows a clean trace with no red haze over it.
      const anyGap = history.some(
        (p) =>
          Number.isFinite(p.offered) &&
          Number.isFinite(p.goodput) &&
          p.offered - p.goodput > 0.5,
      );
      if (anyGap) {
        const fwd = history.map(
          (p) => `${at(p.t).toFixed(2)},${yOf(p.offered, top).toFixed(2)}`,
        );
        const rev = history
          .map((p) => `${at(p.t).toFixed(2)},${yOf(p.goodput, top).toFixed(2)}`)
          .reverse();
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
  const live = dropped > 0.5;
  const empty = history.length === 0;

  return (
    <section className="mx-chart" aria-label="Throughput over the last 60 seconds">
      <ChartHead
        caption="Throughput · rps"
        value={formatCompact(safeGoodput)}
        extra={
          live ? (
            <span className="mx-dropped">
              <span className="label">Dropped</span>
              <span className="num num-md is-danger">{formatCompact(dropped)}</span>
            </span>
          ) : undefined
        }
      />

      <div className="mx-plot" ref={ref} style={{ height: CHART_H }}>
        <PlotLayer w={w}>
          {gapPts && <polygon className="mx-gap" points={gapPts} />}
          <polyline className="mx-line mx-line-offered" points={offeredPts} />
          <polyline className="mx-line mx-line-goodput" points={goodputPts} />
        </PlotLayer>

        <svg className="mx-layer" aria-hidden="true">
          <Frame ticks={ticks} top={top} format={formatCompact} w={w} empty={empty} />
        </svg>
      </div>

      <ul className="mx-legend">
        <LegendKey
          className="mx-key-offered"
          name="offered"
          value={formatCompact(safeOffered)}
        />
        <LegendKey
          className="mx-key-goodput"
          name="goodput"
          value={formatCompact(safeGoodput)}
        />
        <LegendKey
          className="mx-key-gap"
          name="dropped"
          value={formatCompact(dropped)}
          dim={!live}
        />
      </ul>
    </section>
  );
});

/* ------------------------------------------------------------------ *
 * Failure breakdown — a 60s stacked area chart by reason
 * ------------------------------------------------------------------ */

const REASON_ORDER: FailureReason[] = ['error', 'shed', 'timeout', 'no-route', 'depth'];

const REASON_LABEL: Record<FailureReason, string> = {
  error: 'error',
  shed: 'shed',
  timeout: 'timeout',
  'no-route': 'no route',
  depth: 'depth',
};

/**
 * One sample of the failure mix. The engine's history carries no
 * per-reason series, so the strip keeps its own 60s ring buffer of the
 * live `failuresByReason` rates — the same trick the node sparklines
 * use, and for the same reason.
 */
interface FailSample {
  t: number;
  by: Record<FailureReason, number>;
}

interface FailureChartProps {
  samples: FailSample[];
  failures: Record<FailureReason, number>;
}

const FailureChart = memo(function FailureChart({
  samples,
  failures,
}: FailureChartProps) {
  const { ref, w } = useMeasuredWidth<HTMLDivElement>();

  const rows = useMemo(
    () =>
      REASON_ORDER.map((reason) => {
        const raw = failures[reason];
        return { reason, rate: Number.isFinite(raw) && raw > 0 ? raw : 0 };
      }),
    [failures],
  );

  const total = rows.reduce((s, r) => s + r.rate, 0);

  // Axis top tracks the largest stacked total in the window.
  const max = useMemo(() => {
    let m = 0;
    for (const s of samples) {
      let sum = 0;
      for (const reason of REASON_ORDER) {
        const v = s.by[reason];
        if (Number.isFinite(v) && v > 0) sum += v;
      }
      if (sum > m) m = sum;
    }
    return m;
  }, [samples]);

  const { top, ticks } = useStickyAxis(max, 1);

  const xAt = useMemo(() => {
    const n = samples.length;
    if (n === 0) return () => 0;
    const tEnd = samples[n - 1]!.t;
    const tStart = tEnd - WINDOW_MS;
    return (t: number) =>
      Math.max(0, Math.min(1, (t - tStart) / WINDOW_MS)) * PLOT_W;
  }, [samples]);

  /**
   * Stacked bands, bottom to top. Each band is a closed polygon: its own
   * cumulative top edge forward, the previous band's top edge back.
   */
  const bands = useMemo(() => {
    if (samples.length < 2) return [];
    const cum = samples.map(() => 0);
    const out: { reason: FailureReason; points: string }[] = [];

    for (const reason of REASON_ORDER) {
      const lower = cum.slice();
      let any = false;
      samples.forEach((s, i) => {
        const v = s.by[reason];
        if (Number.isFinite(v) && v > 0) {
          cum[i] = lower[i]! + v;
          any = true;
        } else {
          cum[i] = lower[i]!;
        }
      });
      if (!any) continue;

      const fwd = samples.map(
        (s, i) => `${xAt(s.t).toFixed(2)},${yOf(cum[i]!, top).toFixed(2)}`,
      );
      const rev = samples
        .map((s, i) => `${xAt(s.t).toFixed(2)},${yOf(lower[i]!, top).toFixed(2)}`)
        .reverse();
      out.push({ reason, points: [...fwd, ...rev].join(' ') });
    }
    return out;
  }, [samples, xAt, top]);

  /* An idle failure chart is the HEALTHY state, not a missing one, so it
     never says "awaiting traffic" once the sim has produced a sample —
     it just draws a clean flat baseline, which is true information. */
  const empty = samples.length === 0;

  return (
    <section
      className="mx-chart mx-fail-col"
      aria-label="Failures over the last 60 seconds"
    >
      <ChartHead
        caption="Failures · /s"
        value={formatCompact(total)}
        tone={total > 0 ? 'danger' : 'ok'}
      />

      <div className="mx-plot" ref={ref} style={{ height: CHART_H }}>
        <PlotLayer w={w}>
          {bands.map((b) => (
            <polygon
              key={b.reason}
              className={`mx-band mx-fill-${b.reason}`}
              points={b.points}
            />
          ))}
        </PlotLayer>

        <svg className="mx-layer" aria-hidden="true">
          <Frame ticks={ticks} top={top} format={formatCompact} w={w} empty={empty} />
        </svg>
      </div>

      {/* Zero rows stay at reduced opacity rather than unmounting: rows
          appearing and vanishing under a moving slider is a major part of
          what made this panel read as unfinished. */}
      <ul className="mx-legend mx-legend-stack">
        {rows.map((r) => (
          <li key={r.reason} className="mx-key" data-dim={r.rate <= 0 || undefined}>
            <span className={`mx-key-swatch mx-fill-${r.reason}`} aria-hidden="true" />
            <span className="mx-key-name">{REASON_LABEL[r.reason]}</span>
            <span className="num num-sm mx-key-value">{formatRate(r.rate)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
});

/* ------------------------------------------------------------------ *
 * Metrics strip
 * ------------------------------------------------------------------ */

export interface MetricsProps {
  snapshot: SimSnapshot;
}

const EMPTY_BY: Record<FailureReason, number> = {
  error: 0,
  shed: 0,
  timeout: 0,
  'no-route': 0,
  depth: 0,
};

export function Metrics({ snapshot }: MetricsProps) {
  const { system, history, failuresByReason } = snapshot;

  /* The engine returns THE SAME history array instance on every snapshot
     and mutates it in place (push + splice). Memoizing on `[history]`
     therefore computes exactly once — while the array is still empty —
     and never recomputes, which leaves every trace blank forever no
     matter how much traffic flows.

     Keying on the length and newest timestamp gives a dependency that
     actually changes as the engine appends. `src/sim` is off-limits, so
     this is the correct place to absorb that. */
  const historyLen = history.length;
  const historyEnd = historyLen > 0 ? history[historyLen - 1]!.t : -1;

  // Only the trailing window is ever drawn; older samples are dropped
  // here so the charts stay cheap no matter how long the sim has run.
  // The slice also detaches the render from the engine's live buffer, so
  // React.memo on the charts compares a stable snapshot.
  const windowed = useMemo(() => {
    if (historyLen === 0) return [] as HistoryPoint[];
    const cutoff = historyEnd - WINDOW_MS;
    let i = 0;
    while (i < historyLen && history[i]!.t < cutoff) i += 1;
    return history.slice(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, historyLen, historyEnd]);

  /* The engine's history has no per-reason series, so the strip keeps a
     60-entry / 1Hz ring buffer of the live failure mix. Sampling is
     driven by sim time crossing a 1s boundary, so it follows pause,
     step and reset exactly — a wall-clock timer would keep writing
     while the sim is paused. */
  const failRef = useRef<FailSample[]>([]);
  const lastBucket = useRef<number>(-1);
  const [failSamples, setFailSamples] = useState<FailSample[]>([]);

  const timeMs = system.timeMs;
  useEffect(() => {
    if (!Number.isFinite(timeMs)) return;
    const bucket = Math.floor(timeMs / 1000);

    // Reset (time moved backwards) clears the buffer.
    if (bucket < lastBucket.current) {
      failRef.current = [];
      lastBucket.current = -1;
    }
    if (bucket === lastBucket.current) return;
    lastBucket.current = bucket;

    const next = failRef.current.concat({
      t: timeMs,
      by: { ...EMPTY_BY, ...failuresByReason },
    });
    // 60 samples at 1Hz = the same 60s window the other charts show.
    failRef.current = next.length > 60 ? next.slice(next.length - 60) : next;
    setFailSamples(failRef.current);
  }, [timeMs, failuresByReason]);

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
      <FailureChart samples={failSamples} failures={failuresByReason} />
    </div>
  );
}
