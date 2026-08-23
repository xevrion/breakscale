import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { FailureReason, HistoryPoint, SimSnapshot } from '../sim/types';
import {
  formatCompact,
  formatMs,
  formatPct,
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
 * resolves to 0.
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
  // A denormal or an absurd magnitude can make pow non-finite or zero;
  // either would propagate NaN into every tick and every y coordinate.
  if (!Number.isFinite(pow) || pow <= 0) return 1;
  const frac = v / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  const out = nice * pow;
  return Number.isFinite(out) && out > 0 ? out : 1;
}

/** Five ticks at 0, 25, 50, 75, 100% of the axis top. */
function ticksFor(top: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
}

/**
 * A y-axis top that rises immediately but falls only reluctantly.
 *
 * Without this the axis rescales under the student's cursor mid-drag and
 * the whole trace appears to jump. An increase applies at once; a decrease
 * waits until the observed max has stayed below half the current top for a
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

  /* `top` is the divisor for every y coordinate in the chart, so it is
     guarded here rather than at each of the call sites. niceCeil already
     returns > 0, but the fallback arrives from a caller. */
  const safeTop = Number.isFinite(top) && top > 0 ? top : 1;
  return useMemo(() => ({ top: safeTop, ticks: ticksFor(safeTop) }), [safeTop]);
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
      // WINDOW_MS is a non-zero constant, so this division is always safe.
      const f = (t - tStart) / WINDOW_MS;
      return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) * PLOT_W : 0;
    };
    return { at };
  }, [history]);
}

/** Project a value into plot-space y. `top` is guaranteed > 0 by the caller. */
function yOf(v: number, top: number): number {
  const safe = Number.isFinite(v) ? v : 0;
  const denom = Number.isFinite(top) && top > 0 ? top : 1;
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
  /** Overrides the default "AWAITING TRAFFIC" placeholder. */
  emptyLabel?: string;
}

/**
 * The unscaled overlay: gridlines, the emphasized zero line, y tick
 * labels, x tick stubs and the two x captions. Every geometry attribute
 * here is a number — no calc(), ever.
 */
const Frame = memo(function Frame({
  ticks,
  top,
  format,
  w,
  empty,
  emptyLabel = 'AWAITING TRAFFIC',
}: FrameProps) {
  const plotH = CHART_H - PAD_T - PAD_B;
  const right = Math.max(PAD_L + 1, w - PAD_R);
  const baseY = PAD_T + plotH;
  const safeTop = Number.isFinite(top) && top > 0 ? top : 1;

  // Four x ticks: -60s, -40s, -20s, now.
  const xTicks = [0, 1, 2, 3].map((i) => PAD_L + ((right - PAD_L) * i) / 3);

  return (
    <>
      {ticks.map((t, i) => {
        // +0.5 so a 1px rule sits on a device pixel instead of straddling two.
        const y = Math.round(PAD_T + plotH - (t / safeTop) * plotH) + 0.5;
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
          {emptyLabel}
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
 * coincide and the band has zero area; when it sheds, a wedge opens.
 * ------------------------------------------------------------------ */

interface ThroughputChartProps {
  history: HistoryPoint[];
  offered: number;
  goodput: number;
  /**
   * True loss, summed from the engine's `failuresByReason`. This is NOT
   * `offered - goodput`: that difference is also produced by requests still
   * in flight, which is the normal steady state of any pipeline and is not
   * a failure. Deriving loss from the gap made a healthy system report
   * "Dropped 10/s" during warm-up while every failure counter read zero.
   */
  lost: number;
}

const ThroughputChart = memo(function ThroughputChart({
  history,
  offered,
  goodput,
  lost,
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
    // Only draw when traffic is actually being LOST. `offered - goodput`
    // is not loss: it is also the in-flight backlog, which is non-zero in
    // every healthy pipeline and spikes during warm-up. Gating on the
    // engine's real failure total keeps a working system free of red haze.
    if (history.length > 1 && lost > 0.5) {
      const fwd = history.map(
        (p) => `${at(p.t).toFixed(2)},${yOf(p.offered, top).toFixed(2)}`,
      );
      const rev = history
        .map((p) => `${at(p.t).toFixed(2)},${yOf(p.goodput, top).toFixed(2)}`)
        .reverse();
      gap = [...fwd, ...rev].join(' ');
    }
    return { offeredPts: o, goodputPts: g, gapPts: gap };
  }, [history, at, top, lost]);

  // Sanitize before arithmetic: a non-finite rate from the engine would
  // otherwise reach the DOM as "NaN%".
  const safeOffered = Number.isFinite(offered) ? Math.max(0, offered) : 0;
  const safeGoodput = Number.isFinite(goodput) ? Math.max(0, goodput) : 0;
  const dropped = Number.isFinite(lost) ? Math.max(0, lost) : 0;
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

const REASON_ORDER: FailureReason[] = [
  'error',
  'shed',
  'timeout',
  'no-route',
  'depth',
  'throttled',
  'rejected',
  'crashed',
  'partitioned',
  'region-down',
];

const REASON_LABEL: Record<FailureReason, string> = {
  error: 'error',
  shed: 'shed',
  timeout: 'timeout',
  'no-route': 'no route',
  depth: 'depth',
  throttled: 'throttled',
  rejected: 'rejected',
  crashed: 'crashed',
  partitioned: 'partitioned',
  'region-down': 'region down',
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

  /* Only reasons that are ACTUALLY CARRYING TRAFFIC get a row, sorted by
     magnitude so the dominant cause is first.

     The old panel always listed the five "core" reasons, which meant the
     common healthy case rendered five rows of `0/s` — a permanent block of
     dead space that also buried the one row that mattered when something
     did fail, because that row appeared in a fixed alphabetical-ish slot
     rather than at the top.

     Sorting by rate is what makes a failing system legible at a glance:
     the first row is the answer to "what is going wrong". */
  const active = useMemo(() => {
    const rows = REASON_ORDER.map((reason) => {
      const raw = failures[reason];
      return { reason, rate: Number.isFinite(raw) && raw > 0 ? raw : 0 };
    }).filter((r) => r.rate > 0);
    rows.sort((a, b) => b.rate - a.rate);
    return rows;
  }, [failures]);

  const total = useMemo(() => active.reduce((s, r) => s + r.rate, 0), [active]);

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
    return (t: number) => {
      const f = (t - tStart) / WINDOW_MS;
      return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) * PLOT_W : 0;
    };
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

  /* Whether the window has ever carried a failure. This is what separates
     "healthy" from "no data": a chart with 60 clean samples is a REPORT,
     not an absence of one, and it should say so. */
  const windowHadFailures = useMemo(
    () => bands.length > 0,
    [bands],
  );

  const empty = samples.length === 0;
  const healthy = total <= 0;

  return (
    <section
      className="mx-chart mx-fail-col"
      aria-label="Failures over the last 60 seconds"
    >
      <ChartHead
        caption="Failures · /s"
        value={healthy ? '0' : formatCompact(total)}
        tone={healthy ? 'ok' : 'danger'}
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
          <Frame
            ticks={ticks}
            top={top}
            format={formatCompact}
            w={w}
            empty={empty}
            emptyLabel="AWAITING TRAFFIC"
          />
        </svg>
      </div>

      {/* THE HEALTHY CASE IS ONE LINE, NOT FIVE ZEROS.

          A working system says so in a single calm sentence and spends no
          further pixels. The old five-row legend of `0/s` was the largest
          block of dead space in the app, and it also trained the eye to
          skip the panel — so when a row finally went non-zero, nobody was
          looking at it any more. */}
      {healthy ? (
        <p className="mx-clean">
          {empty
            ? 'No traffic yet.'
            : windowHadFailures
              ? 'Recovered — nothing failing now.'
              : 'No failures in the last 60s.'}
        </p>
      ) : (
        <ul className="mx-legend mx-legend-stack">
          {active.map((r) => {
            /* Share of the current failure mix. `total` is > 0 here by the
               `healthy` guard above, but the division is still written
               defensively because this is a rendered number. */
            const share = total > 0 ? r.rate / total : 0;
            return (
              <li key={r.reason} className="mx-key mx-key-fail">
                <span
                  className={`mx-key-swatch mx-fill-${r.reason}`}
                  aria-hidden="true"
                />
                <span className="mx-key-name">{REASON_LABEL[r.reason]}</span>
                {/* Share as a length as well as a figure: with up to ten
                    reasons the hues are not separable on their own, so the
                    bar is the channel that actually ranks them. */}
                <span className="mx-key-bar" aria-hidden="true">
                  <span
                    className={`mx-key-bar-fill mx-fill-${r.reason}`}
                    style={{ width: `${Math.min(100, share * 100)}%` }}
                  />
                </span>
                <span className="num num-sm mx-key-value">{formatRate(r.rate)}</span>
                <span className="num num-sm mx-key-share">{formatPct(share)}</span>
              </li>
            );
          })}
        </ul>
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

/* Derived from REASON_ORDER rather than written out, so adding a failure
   reason to the engine cannot leave this map silently missing a key. */
const EMPTY_BY: Record<FailureReason, number> = Object.fromEntries(
  REASON_ORDER.map((r) => [r, 0]),
) as Record<FailureReason, number>;

export function Metrics({ snapshot }: MetricsProps) {
  const { system, history, failuresByReason } = snapshot;

  /* Lifetime failure COUNT, summed. Used only as a memo dependency that
     changes as the engine records failures — never rendered, and never
     treated as a rate. The per-second figure is derived below. */
  let cumulativeFailures = 0;
  for (const v of Object.values(failuresByReason)) {
    if (Number.isFinite(v)) cumulativeFailures += v;
  }

  /* The engine returns THE SAME `failuresByReason` object on every snapshot
     and mutates it in place, exactly as it does with `history`. React.memo
     on FailureChart therefore saw an unchanged prop reference and skipped
     every re-render, freezing the panel at its initial zeros while the
     engine was reporting thousands of shed requests per second. Copying
     here gives both memo() and the child's useMemo a dependency that
     actually changes. `src/sim` is off-limits, so this is the right place. */
  const failuresCumulative = useMemo(
    () => ({ ...EMPTY_BY, ...failuresByReason }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [failuresByReason, cumulativeFailures, system.timeMs],
  );

  /* `failuresByReason` is a LIFETIME COUNT, not a rate.
     Verified against the engine: `this.failures[reason]++` on each failure,
     zeroed only by reset(). Rendering it directly labelled `/s` was wrong
     three ways — the unit was a lie, the figure only ever grew, and a
     system that had recovered still showed thousands "failing" because a
     counter cannot fall. Dropping load to 1rps left it pinned at 8.9k/s.

     Differencing successive samples against elapsed SIM time turns the
     counter into the rate the panel claims to show. Sim time is the right
     clock: it follows pause, step and reset, where a wall clock would
     invent traffic while the simulation is stopped. */
  const prevCounts = useRef<Record<FailureReason, number> | null>(null);
  const prevTime = useRef<number>(0);
  const [rates, setRates] = useState<Record<FailureReason, number>>(EMPTY_BY);

  useEffect(() => {
    const now = system.timeMs;
    if (!Number.isFinite(now)) return;
    const prev = prevCounts.current;
    const dtMs = now - prevTime.current;

    // First sample, or a reset (time or any counter moved backwards): adopt
    // the counts as the new baseline and report nothing this frame.
    const wentBackwards =
      prev !== null &&
      REASON_ORDER.some((r) => (failuresCumulative[r] ?? 0) < (prev[r] ?? 0));

    if (prev === null || dtMs < 0 || wentBackwards) {
      prevCounts.current = failuresCumulative;
      prevTime.current = now;
      setRates(EMPTY_BY);
      return;
    }

    // Sample no faster than 250ms of sim time: below that the divisor is
    // tiny and the quotient is mostly quantisation noise.
    if (dtMs < 250) return;

    const next = { ...EMPTY_BY };
    const perSec = 1000 / dtMs; // dtMs >= 250 here, so never a divide by zero
    for (const r of REASON_ORDER) {
      const delta = (failuresCumulative[r] ?? 0) - (prev[r] ?? 0);
      next[r] = delta > 0 ? delta * perSec : 0;
    }
    prevCounts.current = failuresCumulative;
    prevTime.current = now;
    setRates(next);
  }, [failuresCumulative, system.timeMs]);

  /** True per-second failure rates — what the panel labels and charts. */
  const failuresNow = rates;

  /* Loss per second, from the differenced rates. This drives the throughput
     chart's dropped-traffic wedge, so it must be a rate: gating that fill on
     a lifetime count would leave the wedge painted for the rest of the
     session after a single early failure. */
  const lostRate = useMemo(() => {
    let s = 0;
    for (const r of REASON_ORDER) {
      const v = failuresNow[r];
      if (Number.isFinite(v) && v > 0) s += v;
    }
    return s;
  }, [failuresNow]);

  /* The engine returns THE SAME history array instance on every snapshot
     and mutates it in place (push + splice). Memoizing on `[history]`
     therefore computes exactly once — while the array is still empty —
     and never recomputes, which leaves every trace blank forever no
     matter how much traffic flows.

     Keying on the length and newest timestamp gives a dependency that
     actually changes as the engine appends. */
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
      setFailSamples(failRef.current);
    }
    if (bucket === lastBucket.current) return;
    lastBucket.current = bucket;

    const next = failRef.current.concat({ t: timeMs, by: failuresNow });
    // 60 samples at 1Hz = the same 60s window the other charts show.
    failRef.current = next.length > 60 ? next.slice(next.length - 60) : next;
    setFailSamples(failRef.current);
  }, [timeMs, failuresNow]);

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
        lost={lostRate}
      />
      <FailureChart samples={failSamples} failures={failuresNow} />
    </div>
  );
}
