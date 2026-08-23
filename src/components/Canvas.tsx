import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type {
  EdgeState,
  FailureKind,
  NodeKind,
  NodeStats,
  SimEdge,
  SimNode,
  SimSnapshot,
  Topology,
} from '../sim/types';
import {
  ICON_BOX,
  ICON_STROKE,
  KIND_ICON,
  KIND_NAME,
  NODE_DND_MIME,
  cellStrip,
  stackBadge,
  stackLayers,
} from './nodeVisuals';
import { behaviourFor } from '../sim/behaviour';
import {
  formatCount,
  formatMs,
  formatPct,
  formatRate,
  healthOfErr,
  healthOfLoad,
} from './format';
import type { Health } from './format';
import './Canvas.css';

/* ------------------------------------------------------------------ *
 * Geometry.
 *
 * Preset coordinates treat x/y as the node's top-left corner. 184x88 is
 * measured against the real preset spacing, not chosen for looks:
 *
 *   async-workers   worker(730,200) and db(860,380) overlap horizontally
 *                   (130px apart, 184px wide) and read only because of the
 *                   vertical gap: 380 - (200 + 88) = 92px. Safe.
 *   load-balanced   api1/api2/api3 stack at y=80/220/360. At H=88 the gutter
 *                   is 140 - 88 = 52px, enough for three edges to fan
 *                   through. At H=96 it would be 44px and the fan-out that
 *                   preset exists to teach starts to crowd.
 *   async-workers   api(260) -> queue(500) is the tightest horizontal pair:
 *                   240 - 184 = 56px of edge. Fine.
 *
 * Any future change to these two numbers must be re-checked against those
 * three pairs.
 * ------------------------------------------------------------------ */

export const NODE_W = 184;
export const NODE_H = 88;
/** Radii come from the design scale (3/4/6). The node body is the 6. */
const NODE_R = 6;
/**
 * Gap between the node's outline and the selection ring drawn around it.
 *
 * 3px. Large enough that the ring is a separate object rather than a fringe
 * on the border, small enough that at 0.4x zoom (where it is 1.2 device px)
 * the ring has not visually detached from the node it belongs to.
 */
const RING_GAP = 3;

/**
 * Internal layout.
 *
 * The node is a single surface divided by WHITESPACE and one hairline, never
 * by nested boxes — "boundary priority: whitespace, then background shift,
 * then border last". Vertical rhythm, all on the 4px space scale:
 *
 *    0   top edge, health rule rides here
 *    8   glyph top (18px box)
 *   26   header baseline area ends
 *   30   hairline under the header
 *   52   primary value baseline
 *   68   secondary row baseline
 *   80   meter
 *
 * The old layout put a vertical divider rule at x=104 to fence the sparkline
 * off from the numbers. That rule is gone: two type sizes and 12px of gap
 * separate them more quietly than a line does.
 */
const HEAD_H = 30;
/** Horizontal inset for everything inside the body. */
const PAD_X = 12;

/**
 * Width budget for ONE side of the two-cell secondary row.
 *
 * The row is two texts anchored to opposite edges of the node, so they grow
 * toward each other. Half the interior each, minus a gutter so they never
 * touch even when both are at their limit.
 */
const SEC_HALF = (NODE_W - PAD_X * 2 - 14) / 2;

/**
 * Advance width per character at the secondary row's font size.
 *
 * MEASURED, not guessed. The row renders two tspans at different sizes
 * (`.cv-val` at 12px, `.cv-cap` at 11px), so a single per-char figure has to
 * cover the wider of the two. getBBox() on every secondary row the presets
 * produce gave 6.49-7.29 px/char:
 *
 *     "5/5 fleet"  6.49    "72ms p99"   6.59    "500ms p99"  6.64
 *     "16% err"    6.69    "steady..."  6.96    "252 queue"  7.24
 *     "0 queue"    7.29
 *
 * The previous 6.1 under-measured EVERY one of them, so `fitWidth` cleared
 * strings that then overflowed the 73px half-budget and collided with the
 * cell anchored to the opposite edge — observed on the autoscaler as a
 * 11.1px gap where every other node had 42-56px. Digit-heavy strings are the
 * worst case (digits are tabular and wide), so the constant is the measured
 * maximum rounded up rather than the average: under-measuring silently
 * corrupts the layout, while over-measuring only condenses a string slightly
 * sooner than strictly necessary.
 */
const SEC_CHAR_W = 7.3;

/** The full string a secondary cell will render, for width estimation. */
function secText(cell: { value: string; label: string }): string {
  return cell.value && cell.label
    ? `${cell.value} ${cell.label}`
    : cell.value || cell.label;
}

/**
 * Constrain a text run to a width budget.
 *
 * Returns `textLength` only when the estimate says the string would overflow,
 * because applying it unconditionally makes short strings render subtly wrong
 * (the browser redistributes spacing to hit the exact length even when it did
 * not need to). `lengthAdjust` condenses the glyphs themselves rather than
 * only the gaps, which stays readable far longer.
 */
function fitWidth(
  text: string,
  budget: number,
): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } {
  const estimate = text.length * SEC_CHAR_W;
  if (estimate <= budget) return {};
  return { textLength: budget, lengthAdjust: 'spacingAndGlyphs' };
}

const SPARK_X = 108;
const SPARK_Y = 38;
const SPARK_W = 64;
const SPARK_H = 18;
/** One sample per second over the same 60s window the charts show. */
export const SPARK_LEN = 60;

/**
 * The utilisation meter spans the FULL width of the node, flush to both
 * insets, and sits on the bottom edge. Full width matters: the bar's length
 * is the redundant, colour-blind-safe encoding of load, so it needs the
 * longest run the node can give it to be readable at a glance.
 */
/**
 * The per-unit strip's band: full inner width, in the gap above the meter.
 *
 * A shard's partitions are the node's primary content, so the strip gets the
 * full 160px rather than the sparkline's 64px slot. That width is what keeps
 * 64 partitions legible: 64 cells in 64px is 1.00px each, which cannot carry
 * a readable fill height, while 64 cells in 160px is 2.50px each, which can.
 */
const STRIP_Y = 56;
const STRIP_H = 12;

const METER_Y = 80;
const METER_H = 3;
const METER_W = NODE_W - PAD_X * 2;
/**
 * Load at which the meter grows a threshold tick.
 *
 * DERIVED from healthOfLoad rather than restated, so this file can never drift
 * out of agreement with format.ts about where warn begins. A literal 0.7 here
 * would be a second source of truth for the same number.
 */
const WARN_AT = (() => {
  for (let v = 0; v <= 1000; v++)
    if (healthOfLoad(v / 1000) === 'warn') return v / 1000;
  return 0.7;
})();

const GRID = 8;
/** Visual radius of a port dot. */
const PORT_R = 5;
/**
 * Invisible hit radius. Roughly 3x the visual radius, per the rule that a
 * 5px target is not a target. Drawn as a transparent circle UNDER the visible
 * dot so the dot still paints at its true size.
 */
const PORT_HIT_R = 15;
const PORT_CY = NODE_H / 2;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
/** Below this the body numbers and sparkline drop. */
const DETAIL_ZOOM = 0.7;
/** Below this only the name, health rule and meter survive. */
const MINIMAL_ZOOM = 0.5;

/** Auto-fit margin and clamp. 1.5 stops a 3-node preset becoming a billboard.
 *
 * FIT_MIN is deliberately DETAIL_ZOOM, not a rounder 0.6. Auto-fit runs on
 * every preset load, so it decides what a student sees first — and at 0.6
 * the fitted view landed in the 0.6-0.7 band where the body numbers are
 * suppressed, presenting the flagship preset as a row of empty boxes. The
 * floor and the legibility threshold are the same number by definition:
 * never auto-fit to a zoom at which the diagram stops showing its data. */
const FIT_MARGIN = 64;
const FIT_MIN = DETAIL_ZOOM;
const FIT_MAX = 1.5;

/**
 * Screen-space distance a press may travel and still count as a click.
 *
 * This is the single number that separates "select" from "drag", and it is
 * measured in CSS pixels on the SCREEN, not in world units: a human's hand
 * shakes by the same number of screen pixels regardless of zoom, so a
 * world-space threshold would make the canvas feel twitchy at 2.5x and sticky
 * at 0.4x.
 */
const DRAG_THRESHOLD = 4;

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

/**
 * Per-node sparkline samples, newest last, keyed by node id.
 *
 * `SimSnapshot.history` is system-wide — `HistoryPoint` carries no node id —
 * so there is no per-node history in the engine to draw. Since src/sim is not
 * ours to change, the ring buffer lives in the UI and is passed in. Absent or
 * short buffers render a bare baseline, never a placeholder.
 */
export type SparkData = ReadonlyMap<string, ArrayLike<number>>;

export interface CanvasProps {
  topology: Topology;
  snapshot: SimSnapshot | null;
  /**
   * Ids of every selected node AND edge. Node ids and edge ids share one
   * namespace here; an edge id is `from->to`, which can never collide with a
   * node id, so a single set is unambiguous.
   */
  selectedIds: ReadonlySet<string>;
  /**
   * Replaces the whole selection. The canvas always computes the next set
   * itself (including shift/ctrl toggling and marquee union) and hands the
   * finished set over, so the shell never has to reimplement selection logic.
   */
  onSelectionChange: (ids: ReadonlySet<string>) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onConnect: (fromId: string, toId: string) => void;
  /**
   * Delete everything in one gesture. The canvas partitions the selection
   * into node ids and edge ids and passes both, so the shell can apply a
   * single topology edit instead of N sequential ones (which would make each
   * delete race the previous state).
   */
  onDeleteSelection: (nodeIds: readonly string[], edgeIds: readonly string[]) => void;
  onDropNode: (kind: NodeKind, x: number, y: number) => void;
  /** Optional: per-node sparkline history. Omitted -> no sparklines. */
  spark?: SparkData;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const inPort = (n: SimNode) => ({ x: n.x, y: n.y + PORT_CY });
const outPort = (n: SimNode) => ({ x: n.x + NODE_W, y: n.y + PORT_CY });

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** True when the event should not be intercepted by a canvas key handler. */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

/* ------------------------------------------------------------------ *
 * Readouts.
 *
 * Five live values per node, all from fields the engine already computes.
 * The previous two-value readout discarded eleven of thirteen NodeStats
 * fields — including `queued`, the backlog that three of the five presets
 * exist to teach.
 * ------------------------------------------------------------------ */

interface Cell {
  value: string;
  label: string;
}

interface Readout {
  primary: Cell;
  a: Cell;
  b: Cell;
  /** 0..1. Drives the meter width and the health band. */
  load: number;
  /** Health of the primary metric specifically. */
  health: Health;
  /** Value the sparkline plots, in the primary's units. */
  spark: number;
  /** True when traffic is actively being lost here. */
  losing: boolean;
}

function readoutFor(
  kind: NodeKind,
  s: NodeStats,
  cfg: { queueLimit: number },
): Readout {
  const util = clamp(s.utilization, 0, 1);
  const losing = s.shedRate + s.timeoutRate > 0;

  switch (kind) {
    case 'client': {
      const err = clamp(s.errorRate, 0, 1);
      /* The headline is what the client is SENDING, not what came back.
         Throughput counts successes, so during a total collapse it is
         genuinely 0 and the node read "0/s rps, 100% err", which looks like a
         client that has stopped generating load rather than one whose every
         request is dying. Offered load is the honest headline; the success
         rate belongs beside it, where the contrast between the two is the
         thing worth seeing. */
      return {
        primary: { value: formatRate(s.arrivalRate), label: 'sent' },
        a: { value: formatRate(s.throughput), label: 'ok' },
        b: { value: formatPct(err), label: 'err' },
        load: err,
        health: healthOfErr(err),
        spark: s.arrivalRate,
        losing,
      };
    }

    case 'lb':
      return {
        primary: { value: formatPct(util), label: 'util' },
        a: { value: formatRate(s.throughput), label: 'rps' },
        b: { value: formatCount(s.queued), label: 'queue' },
        load: util,
        health: healthOfLoad(util),
        spark: util,
        losing,
      };

    case 'cache': {
      const hit = clamp(s.hitRate, 0, 1);
      // A cache's meter shows misses: an empty bar is a cache doing its job.
      const miss = 1 - hit;
      return {
        primary: { value: formatPct(hit), label: 'hit' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatRate(s.throughput), label: 'rps' },
        load: miss,
        health: healthOfLoad(miss),
        spark: hit,
        losing,
      };
    }

    case 'queue': {
      const depth = s.queued + s.inFlight;
      // Divide by the node's own limit. The old hardcoded 500 was wrong for
      // every preset: the real limits are 5000, 512, 256, 128, 96, 64, 48, 32.
      const limit = cfg.queueLimit > 0 ? cfg.queueLimit : 1;
      const fill = clamp(depth / limit, 0, 1);
      return {
        primary: { value: formatCount(depth), label: 'depth' },
        a: { value: formatRate(s.arrivalRate), label: 'in' },
        b: { value: formatRate(s.throughput), label: 'out' },
        load: fill,
        health: healthOfLoad(fill),
        spark: depth,
        losing,
      };
    }

    /**
     * A shard reports its HOTTEST partition, not its mean.
     *
     * The mean is the number that lies. Measured on the real engine at
     * hotKeyFraction 0.85 with 8 partitions: the node mean sat at 0.17 —
     * comfortably "ok", green meter, nothing to see — while partition 0 was
     * pinned at 1.00. A student watching the mean would conclude the store
     * had 83% headroom at the exact moment one partition was melting.
     *
     * So the primary is the max, the meter is driven by the max, and health
     * is judged on the max. The strip beside it shows the spread that the
     * single number cannot, and `min` is reported next to it precisely so the
     * GAP between them is legible: 100% hot against 0% cold is the signature
     * of a hot key, and it is unmissable when both are printed.
     */
    case 'shard': {
      const hot = clamp(s.maxShardUtilization, 0, 1);
      return {
        primary: { value: formatPct(hot), label: 'hot shard' },
        a: { value: formatPct(clamp(s.minShardUtilization, 0, 1)), label: 'coldest' },
        b: { value: formatCount(s.queued), label: 'queue' },
        load: hot,
        health: healthOfLoad(hot),
        spark: hot,
        losing,
      };
    }

    /**
     * A replica set reports its stale-read rate when there is one.
     *
     * Replication lag is the entire reason a read replica is a different
     * component from a database, and it was previously invisible. It is shown
     * only when non-zero: a synchronous set (replicationLagMs 0) never goes
     * stale, and printing "0% stale" on it forever would train the student to
     * stop reading the field before it ever had something to say.
     */
    case 'replica': {
      const stale = clamp(s.staleReadRate, 0, 1);
      return {
        primary: { value: formatPct(util), label: 'util' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b:
          stale > 0
            ? { value: formatPct(stale), label: 'stale' }
            : { value: formatCount(s.queued), label: 'queue' },
        load: util,
        health: healthOfLoad(util),
        spark: util,
        losing,
      };
    }

    // service, db, worker
    case 'autoscaler': {
      /* A controller serves no requests, so utilisation, p99 and queue depth
         are all permanently zero for it. Showing them made the autoscaler look
         broken and identical to every other box. What it is actually doing is
         watching someone else's utilisation against a setpoint, so report
         that instead: the number it is reacting to, the fleet size it wants,
         and what it is doing about it right now. */
      const watched = clamp(s.watchedUtil ?? 0, 0, 1);
      const setpoint = s.setpoint ?? 0.7;
      const want = s.targetInstances ?? 0;
      const have = s.watchedInstances ?? 0;

      // Distance from setpoint drives the meter, so the node reads calm when
      // the controller has converged and hot when it is chasing a spike.
      const drift = setpoint > 0 ? clamp(watched / setpoint, 0, 1) : 0;

      /* The secondary row is two texts anchored to opposite edges of the node,
         so they grow toward each other and collide if either is wordy. Both
         cells here must stay about as short as "23ms" and "p99". An earlier
         version put the phase word in the value slot AND a "scaling up" label
         beside it, which overlapped into mush at real fleet sizes. */
      const phase = s.scalePhase ?? 'idle';
      return {
        primary: { value: formatPct(watched), label: 'watching' },
        a: { value: `${have}/${want}`, label: 'pods' },
        b: { value: '', label: phase },
        load: drift,
        health: healthOfLoad(drift),
        spark: watched,
        losing: false,
      };
    }

    default:
      return {
        primary: { value: formatPct(util), label: 'util' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatCount(s.queued), label: 'queue' },
        load: util,
        health: healthOfLoad(util),
        spark: util,
        losing,
      };
  }
}

/* ------------------------------------------------------------------ *
 * Sparkline
 * ------------------------------------------------------------------ */

/** Round up to a friendly ceiling so the y-domain does not jitter each sample. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

interface SparkProps {
  data: ArrayLike<number> | undefined;
  /** Fractions (utilization, hit rate) prefer a fixed 0..1 domain. */
  unit: boolean;
}

const Spark = memo(function Spark({ data, unit }: SparkProps) {
  const points = useMemo(() => {
    if (!data || data.length < 2) return '';
    let max = 0;
    let filled = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      filled += 1;
      if (v > max) max = v;
    }
    // A single sample is a dot, not a trend; draw nothing until there are two.
    if (filled < 2) return '';
    /**
     * Fractional series read against a fixed 0..1 domain, so a node at 20%
     * looks like a node at 20% rather than being auto-scaled to fill the box.
     *
     * The exception is a series that never leaves the bottom of that domain —
     * a load balancer runs at ~0.01% utilization, and against a domain of 1
     * every sample lands on the baseline, producing a flat line that cannot
     * show variation no matter what the node does. Below 10% the domain
     * relaxes to the data so the trace still carries information.
     */
    const top = unit && max >= 0.1 ? 1 : niceCeil(max * 1.15);
    const n = data.length;
    const out: string[] = [];
    // Only sampled slots are plotted. The newest sample stays pinned to the
    // right edge and the trace grows leftwards as history accumulates, so a
    // 5-second-old node shows a short honest trace instead of a full-width
    // line that is mostly fabricated zeros.
    for (let i = n - filled; i < n; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      const x = filled > 1 ? ((i - (n - filled)) / (filled - 1)) * SPARK_W : SPARK_W;
      const y = SPARK_H - clamp(v / top, 0, 1) * SPARK_H;
      out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return out.join(' ');
  }, [data, unit]);

  return (
    <g transform={`translate(${SPARK_X},${SPARK_Y})`}>
      <line
        className="cv-spark-base"
        x1={0}
        y1={SPARK_H + 0.5}
        x2={SPARK_W}
        y2={SPARK_H + 0.5}
      />
      {points && <polyline className="cv-spark" points={points} />}
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Glyph
 * ------------------------------------------------------------------ */

/**
 * Rendered glyph size, in world units.
 *
 * 18, not 14. The set was rendered and inspected at both: at 14px the denser
 * icons (the globe, the film frame, the calendar-clock) close up into solid
 * blobs, because the stroke eats too much of a 14px box. 18px is the
 * smallest size at which the whole set stays distinguishable, and it is
 * also the header's 14px name cap-height plus its 4px breathing room, so
 * the icon and the name read as one line.
 */
const GLYPH_PX = 18;
const GLYPH_SCALE = GLYPH_PX / ICON_BOX;

/**
 * Trim a node label to what actually fits on the node.
 *
 * Width is estimated rather than measured, deliberately. Measuring would mean
 * getComputedTextLength() on every node on every one of the 10Hz snapshots —
 * a forced synchronous layout per node per tick, which is precisely the kind
 * of thing that turns a smooth canvas into a stuttering one. An estimate that
 * is slightly conservative costs at most one character of a label; a layout
 * thrash costs frames.
 *
 * 0.55em per character is the average advance width of the UI sans stack at
 * 14px across mixed-case text. Capitals run wider, so the result errs toward
 * trimming one character early on a SHOUTY LABEL, which is the harmless
 * direction to be wrong in.
 */
const NAME_CHAR_W = 0.55 * 14;

function truncateLabel(label: string, showHeader: boolean): string {
  const startX = showHeader ? PAD_X + GLYPH_PX + 8 : PAD_X;
  // Reserve room for the status mark in the top-right corner when it can
  // appear, so a long name never collides with the warn/danger/fault mark.
  const avail = NODE_W - PAD_X - startX - (showHeader ? 12 : 0);
  const max = Math.floor(avail / NAME_CHAR_W);
  if (max <= 1 || label.length <= max) return label;
  // U+2026, one glyph, so the ellipsis costs a single character of budget
  // rather than the three that "..." would.
  return `${label.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One kind icon, painted as raw SVG primitives inside the node's <svg>.
 *
 * A Lucide COMPONENT renders its own <svg> root, which inside another svg
 * would be a nested viewport with its own coordinate system; instead the
 * icon's primitive list (KIND_ICON, the same data the component is built
 * from) is painted straight into the positioned <g> the caller provides,
 * exactly the way the old hand-drawn <path> was. Stroke properties sit on
 * this group so each primitive inherits them; the few primitives that carry
 * their own fill (chart-scatter's points) keep it via the attribute
 * spread. Colour is always currentColor, so the surrounding token decides.
 *
 * memo on `kind` (a string) means the 10Hz snapshot re-renders skip this
 * subtree entirely; the primitives are only ever built when a node first
 * appears or changes kind.
 */
const Glyph = memo(function Glyph({ kind }: { kind: NodeKind }) {
  return (
    <g
      className="cv-glyph"
      fill="none"
      stroke="currentColor"
      // Lucide's native weight (2/24 of the box), stated in screen px
      // because .cv-glyph uses non-scaling-stroke to stay crisp under zoom.
      strokeWidth={(ICON_STROKE * GLYPH_PX) / ICON_BOX}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {KIND_ICON[kind].map(([tag, attrs]) => {
        const { key, ...rest } = attrs;
        return createElement(tag, { key, ...rest });
      })}
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

/**
 * Edge routing: a straight run with ONE filleted turn at each end.
 *
 * This replaces a full-width cubic bezier, and the reason is the user's
 * complaint that the wires "read as noise". A bezier between two ports is
 * curving along its ENTIRE length, so ten of them crossing a diagram produce
 * ten unique arcs with no shared direction — the eye cannot group them and
 * the result looks like scribble.
 *
 * An engineering diagram instead reads as a bus: every wire leaves its source
 * horizontally, travels along ONE axis, and arrives horizontally. Only the
 * corners are curved, and they all share the same radius, so the picture is
 * built from a small vocabulary of repeated shapes. That is what makes a
 * schematic scan cleanly at a glance.
 *
 * Geometry: leave the source horizontally for STUB px, turn, run vertically
 * to the target's row, turn again, arrive horizontally. When the two ports are
 * already on (nearly) the same row the whole thing degenerates to a straight
 * line, which is both the common case and the cheapest to read.
 *
 * `mid` is where the vertical run happens. Halfway between the ports normally;
 * clamped to leave a stub at each end so the corner radius always fits.
 */
const EDGE_STUB = 22;
const EDGE_RADIUS = 12;

function edgePath(ax: number, ay: number, bx: number, by: number): string {
  const dy = by - ay;

  // Same row (within a hair): a straight line. No corners to draw.
  if (Math.abs(dy) < 1) return `M${ax},${ay} L${bx},${by}`;

  const dx = bx - ax;
  // Where the vertical leg sits. Keep a stub at both ends so each fillet has
  // room; when the target is BEHIND the source there is no room for a mid
  // route, so the leg goes just past the source and the path doubles back.
  const mid = dx > EDGE_STUB * 2 ? ax + Math.max(EDGE_STUB, dx / 2) : ax + EDGE_STUB;

  // Corner radius must never exceed half of either leg it joins, or the two
  // arcs overlap and the path visibly kinks.
  const r = Math.min(
    EDGE_RADIUS,
    Math.abs(dy) / 2,
    Math.max(1, Math.abs(mid - ax)),
    Math.max(1, Math.abs(bx - mid)),
  );
  const sy = dy > 0 ? 1 : -1;
  // Sweep flags flip with direction so both corners bend the correct way.
  const s1 = dy > 0 ? 1 : 0;
  const s2 = dy > 0 ? 0 : 1;

  return [
    `M${ax},${ay}`,
    `L${mid - r},${ay}`,
    `A${r},${r} 0 0 ${s1} ${mid},${ay + r * sy}`,
    `L${mid},${by - r * sy}`,
    `A${r},${r} 0 0 ${s2} ${mid + r},${by}`,
    `L${bx},${by}`,
  ].join(' ');
}

/**
 * Stroke width from flow. Logarithmic so 10rps and 1000rps stay in one visual
 * family while still ranking unambiguously:
 *   0 -> 1.0   1 -> 1.26   10 -> 1.85   100 -> 2.71   1k -> 3.55   5k -> 4.16
 */
function edgeWidth(f: number): number {
  return f <= 0 ? 1 : clamp(1 + Math.log10(1 + f) * 0.85, 1, 4.5);
}

/**
 * Arrowhead geometry. Because every edge now arrives horizontally the head is
 * a fixed triangle rather than a rotated one: ARROW_LEN along the wire,
 * ARROW_HALF either side of it. INSET is how far the LINE stops short of the
 * tip so the stroke never pokes through the solid head.
 */
const ARROW_INSET = 8;
const ARROW_LEN = 8;
const ARROW_HALF = 3.6;

interface EdgeViewProps {
  edge: SimEdge;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  flow: number;
  /**
   * Why this wire is or is not carrying traffic, straight from the engine.
   *
   * This is NOT derivable from `flow`, and assuming it was is the specific
   * dishonesty this prop exists to fix. Measured on the circuit-breaker
   * preset at 3x load: for 665 of 900 frames the breaker's downstream edge
   * was 'blocked', and `edgeFlow` on that edge read as high as 314 rps the
   * whole time — that number is traffic ARRIVING at the breaker and being
   * failed fast, not traffic crossing to payments. Drawing width from flow
   * alone painted the single most severed link on the canvas as one of the
   * thickest and busiest. State gates flow; it does not blend with it.
   */
  state: EdgeState;
  /**
   * True when this edge is a CONTROL relationship — an autoscaler driving the
   * node it resizes — rather than a request path. No request ever crosses it.
   */
  control: boolean;
  selected: boolean;
  /** Health of the TARGET node — a failing sink colors its inbound wire. */
  targetHealth: Health;
  showLabel: boolean;
}

const EdgeView = memo(function EdgeView({
  edge,
  ax,
  ay,
  bx,
  by,
  flow,
  state,
  control,
  selected,
  targetHealth,
  showLabel,
}: EdgeViewProps) {
  // Every edge now ARRIVES horizontally (see edgePath), so the arrowhead is
  // always axis-aligned and needs no trigonometry. That is a direct benefit of
  // the routing change: the old bezier arrived at an arbitrary angle, which
  // meant computing atan2 per edge per frame and produced arrowheads that
  // each sat at their own tilt.
  const tipX = bx - 2;
  const d = edgePath(ax, ay, tipX - ARROW_INSET, by);

  /**
   * A wire that cannot carry traffic is never drawn as if it might.
   *
   * `cut` and `blocked` are STRUCTURAL assertions the engine stands behind:
   * nothing is crossing, whatever `edgeFlow` says about what is arriving at
   * the source. Both therefore force the width to its minimum and kill the
   * flow animation outright, rather than being tinted variants of a live
   * wire. A control edge is the same case for a different reason — it is not
   * a request path at all — so it also never animates.
   */
  const severed = state === 'cut' || state === 'blocked';
  const width = severed || control ? 1 : edgeWidth(flow);
  const active = !severed && !control && flow > 0.05;

  /**
   * Flow is encoded as dash DENSITY, and the animation only carries speed.
   *
   * `--dash` is the cycle length in user units: heavy flow packs the dashes
   * tightly, light flow spaces them out. That is the channel a reader can
   * still measure with the animation stopped, which is why it survives
   * prefers-reduced-motion.
   *
   * `animationDuration` is derived so one cycle takes proportionally less time
   * as the rate climbs, and is clamped at both ends: below 0.35s the dashes
   * strobe, above 2.4s they look frozen. Driving it from a CSS custom property
   * means React never touches this per frame — the canvas re-renders at 10Hz,
   * and the browser interpolates the motion continuously in between.
   */
  const style = useMemo(() => {
    if (!active) return undefined;
    // Cycle length in USER UNITS (not px): dense at high flow, sparse at low.
    const cycle = clamp(20 - Math.log10(1 + flow) * 4, 7, 20);
    const on = 3;
    return {
      '--dash-on': on.toFixed(1),
      '--dash-off': (cycle - on).toFixed(1),
      // Travel exactly one cycle per iteration so the pattern never jumps.
      '--dash-cycle': (-cycle).toFixed(1),
      animationDuration: `${clamp(3.2 / Math.log10(10 + flow), 0.35, 2.4).toFixed(2)}s`,
    } as CSSProperties;
  }, [active, flow]);

  /**
   * Anchor for the flow label and the delete button.
   *
   * This must land on a part of the wire that is NOT covered by a node, and
   * that is a stricter requirement than "the middle of the path". Nodes are
   * painted after edges, so anything the edge draws underneath a node body is
   * both invisible and unclickable — the delete button silently stopped
   * working on exactly those edges, which is the same class of dead-overlay
   * bug the input rebuild was done to kill.
   *
   * The safe region is the horizontal GAP between the source's exit port and
   * the target's entry port. Both ports sit on node edges, so the span
   * strictly between them is the one stretch of wire guaranteed to be clear
   * of both endpoints. When the target is to the LEFT of the source (a
   * back-edge, which routes out and around) that gap is empty or inverted, so
   * the anchor falls back to the outbound stub, which is always exposed.
   */
  const gap = bx - ARROW_INSET - ax;
  const midX = gap > EDGE_STUB ? ax + gap / 2 : ax + EDGE_STUB;
  const midY = (ay + by) / 2;

  return (
    <g
      className={`cv-edge${selected ? ' is-selected' : ''}${
        active ? ' is-active' : ''
      }${control ? ' is-control' : ''} is-state-${state} is-${
        /* A severed wire takes its own state, not the health of the node
           behind it. A breaker that is doing its job protects a downstream
           that is failing, so colouring the blocked wire by that downstream's
           danger would paint the protection and the problem identically. */
        severed || control ? 'ok' : targetHealth
      }`}
    >
      {/* Fat invisible hit area — a 1px line is impossible to click. The
          data-* attributes are what the surface's pointerdown router reads;
          no handler is attached here, so nothing can be swallowed before the
          router sees it. */}
      <path d={d} className="cv-edge-hit" data-hit="edge" data-id={edge.id} />
      <path d={d} className="cv-edge-line" strokeWidth={width} />
      {active && (
        <path d={d} className="cv-edge-flow" strokeWidth={width * 0.75} style={style} />
      )}
      {/* Arrowhead. Axis-aligned because every edge arrives horizontally. */}
      <path
        d={`M${tipX},${by} L${tipX - ARROW_LEN},${by - ARROW_HALF} L${
          tipX - ARROW_LEN
        },${by + ARROW_HALF} Z`}
        className="cv-edge-arrow"
      />

      {/*
        THE BREAK. A severed wire gets a physical gap with two cut ends, not
        just a fainter stroke.

        This is the difference between "quiet" and "disconnected", and it has
        to survive being read at a glance across a diagram. A dashed grey line
        reads as low traffic; a line with a piece visibly MISSING from it
        reads as broken, which is what has actually happened. The mark is
        drawn over the wire's own midpoint gap, so the wire appears to stop,
        break, and resume.
      */}
      {severed && (
        <g className="cv-edge-break" transform={`translate(${midX},${midY})`}>
          <rect className="cv-edge-break-gap" x={-7} y={-7} width={14} height={14} />
          <path
            className="cv-edge-break-mark"
            d="M-4.5,-5 L-1.5,0 L-4.5,5 M4.5,-5 L1.5,0 L4.5,5"
          />
        </g>
      )}

      {/*
        A control edge says what it IS, in a word.

        The dashing and the hollow arrowhead already separate it from a
        request path, but "this line means something categorically different"
        is not a thing a student can be expected to infer from a stroke
        pattern. One word removes the guess. It is shown at the same zoom the
        rate labels appear at, so it obeys the existing detail budget.
      */}
      {showLabel && control && (
        <text className="cv-edge-label is-control" x={midX} y={midY - 6}>
          scales
        </text>
      )}

      {/* How traffic splits at a fan-out. Invisible before this change. */}
      {showLabel && active && (
        <text className="cv-edge-label" x={midX} y={midY - 6}>
          {formatRate(flow)}
        </text>
      )}

      {selected && (
        <g
          className="cv-edge-del"
          transform={`translate(${midX},${midY})`}
          data-hit="edge-delete"
          data-id={edge.id}
          role="button"
          aria-label="Delete connection"
        >
          <rect x={-9} y={-9} width={18} height={18} rx={3} />
          <path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" />
        </g>
      )}
    </g>
  );
});

/* ================================================================== *
 * What a node is MADE OF
 *
 * Four small components, one per structural truth the engine exposes and the
 * canvas used to throw away. Each is memoised separately from the node body
 * so that a node whose structure did not change this frame does not re-render
 * its units just because its p99 moved.
 *
 * The shared rule for all four: EVERY element they emit is
 * `pointer-events: none` (set in Canvas.css on `.cv-units`, `.cv-strip`,
 * `.cv-vessel` and their children). They are decoration painted inside the
 * node group, and the node group already carries the `data-hit="node"` that
 * the pointer router reads. If any of these could take a pointer, a press on
 * a shard cell would resolve to the cell rather than to the node, and
 * `closest('[data-hit]')` would still find the node — but the extra elements
 * would sit above the ports' 15px hit discs and eat link gestures near the
 * node's edges. Making them inert is what keeps the input layer untouched.
 * ================================================================== */

/**
 * The layered cards behind a node body that say "this is several machines".
 *
 * Drawn as siblings BEHIND the body rect (earlier in paint order), each
 * offset up and to the right, so the node reads as the front card of a stack.
 * Offsetting up-right rather than down-right matters: down-right would push
 * the stack toward the meter and the ports, which live along the bottom and
 * sides, and would collide with the node below in a stacked preset.
 */
const InstanceStack = memo(function InstanceStack({
  live,
  pending,
}: {
  live: number;
  pending: number;
}) {
  const layers = stackLayers(live, pending);
  if (layers.length === 0) return null;
  return (
    <g className="cv-units" aria-hidden="true">
      {layers.map((l) => (
        <rect
          key={`${l.offset}-${l.pending ? 'p' : 'l'}`}
          className={l.pending ? 'cv-unit is-pending' : 'cv-unit'}
          x={l.offset}
          y={-l.offset}
          width={NODE_W}
          height={NODE_H}
          rx={NODE_R}
          ry={NODE_R}
        />
      ))}
    </g>
  );
});

/**
 * A strip of per-unit cells, each filled by that unit's own utilisation.
 *
 * This is the sharding lesson in one object. The node-level `utilization` a
 * shard reports is the MEAN across partitions, and with a hot key that mean is
 * reassuring while one partition is pinned at 1.0 — measured on the real
 * engine at hotKeyFraction 0.85: per-shard [1.00, 0.10, 0.05, 0.03, 0.09,
 * 0.00, 0.07, 0.03] against a node mean of 0.17. A single meter cannot say
 * that. Eight cells can, instantly, without a number being read.
 *
 * Each cell fills from the BOTTOM like a column of liquid, so the strip reads
 * as a bar chart of load rather than as a row of status lights. A cell at or
 * past the danger threshold also gets a class, so colour is a redundant
 * channel on top of height rather than the only one.
 */
const UnitStrip = memo(function UnitStrip({
  values,
  x,
  y,
  width,
  height,
  /** Index that should be marked as structurally distinct (a replica primary). */
  leadIndex = -1,
}: {
  values: readonly number[];
  x: number;
  y: number;
  width: number;
  height: number;
  leadIndex?: number;
}) {
  const n = values.length;
  if (n === 0) return null;
  const strip = cellStrip(n, width);
  return (
    <g className="cv-strip" transform={`translate(${x},${y})`} aria-hidden="true">
      {values.map((raw, i) => {
        const v = clamp(Number.isFinite(raw) ? raw : 0, 0, 1);
        // Never render a busy unit as an empty cell: the same
        // never-print-zero rule the meter follows. 1px of fill is the
        // difference between "idle" and "barely working", and at these cell
        // sizes it is the smallest mark that still resolves.
        const fh = v > 0 ? Math.max(1, v * height) : 0;
        const cls = [
          'cv-cell-fill',
          healthOfLoad(v) === 'danger'
            ? 'is-danger'
            : healthOfLoad(v) === 'warn'
              ? 'is-warn'
              : '',
          i === leadIndex ? 'is-lead' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g key={i}>
            <rect
              className={i === leadIndex ? 'cv-cell is-lead' : 'cv-cell'}
              x={strip.x(i)}
              y={0}
              width={strip.w}
              height={height}
            />
            {fh > 0 && (
              <rect
                className={cls}
                x={strip.x(i)}
                y={height - fh}
                width={strip.w}
                height={fh}
              />
            )}
          </g>
        );
      })}
    </g>
  );
});

/**
 * A queue drawn as a vessel filling toward its limit.
 *
 * A queue's `utilization` is structurally ZERO — measured on async-workers
 * under 2.5x load: depth climbed 369 -> 946 -> 2478 while utilisation stayed
 * at 0.00 the whole time, because a buffer holds work rather than serving it.
 * So the standard meter on a queue node was not merely uninformative, it was
 * pinned empty while the backlog ran away. Depth against limit is the only
 * honest reading, and it is the one a student can watch fill and drain.
 *
 * At the limit the vessel gains a shedding state, because that is the moment
 * the queue stops being a buffer and starts destroying requests.
 */
const QueueVessel = memo(function QueueVessel({
  depth,
  limit,
  shedding,
  x,
  y,
  width,
  height,
}: {
  depth: number;
  limit: number;
  shedding: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const lim = limit > 0 ? limit : 1;
  const fill = clamp(depth / lim, 0, 1);
  const fw = fill > 0 ? Math.max(1.5, fill * width) : 0;
  return (
    <g
      className={shedding ? 'cv-vessel is-shedding' : 'cv-vessel'}
      transform={`translate(${x},${y})`}
      aria-hidden="true"
    >
      <rect
        className="cv-vessel-track"
        x={0}
        y={0}
        width={width}
        height={height}
        rx={2}
      />
      {fw > 0 && (
        <rect
          className="cv-vessel-fill"
          x={0}
          y={0}
          width={fw}
          height={height}
          rx={2}
        />
      )}
      {/* The limit wall. A vessel with no visible brim gives the fill nothing
          to be full AGAINST, so a backlog of 2478 and one of 80 look the same
          when both are drawn against their own scale. */}
      <rect
        className="cv-vessel-brim"
        x={width - 1}
        y={-1}
        width={1.5}
        height={height + 2}
      />
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Node
 * ------------------------------------------------------------------ */

/** Why a node cannot be the target of the link currently in flight. */
type LinkRole = 'none' | 'source' | 'valid' | 'invalid';

interface NodeViewProps {
  node: SimNode;
  stats: NodeStats | null;
  spark: ArrayLike<number> | undefined;
  selected: boolean;
  /** 2 = full, 1 = header + meter only, 0 = name + meter. */
  detail: 0 | 1 | 2;
  /** Role in the link gesture currently in flight, if any. */
  linkRole: LinkRole;
  /** True while any link gesture is live: forces the ports visible. */
  linking: boolean;
  /** True when this node is the snapped target of the live link. */
  linkTarget: boolean;
  /**
   * An injected failure in force on this node right now, or null. Sourced from
   * `snapshot.activeFailures`, so a crashed or slowed node is marked as
   * FAULTED even when its own stats look calm — a crashed node serves nothing,
   * which reads as 0% utilisation and would otherwise paint as perfectly
   * healthy. This is the one state the metrics alone cannot express.
   */
  fault: FailureKind | null;
  onActivate: (id: string, additive: boolean) => void;
  onNudge: (id: string, dx: number, dy: number) => void;
}

const NodeView = memo(function NodeView({
  node,
  stats,
  spark,
  selected,
  detail,
  linkRole,
  linking,
  linkTarget,
  fault,
  onActivate,
  onNudge,
}: NodeViewProps) {
  const readout = stats ? readoutFor(node.kind, stats, node.config) : null;
  // A faulted node is never reported as healthy, whatever its metrics say.
  const health: Health = fault ? 'danger' : readout ? readout.health : 'ok';

  /* ---- structure: what this node is made of -----------------------
     `instances === undefined` means "this kind is genuinely one thing" and
     must fall back to the scalar meters — never be treated as zero. That is
     the engine's documented contract, and it is why every branch below tests
     for undefined rather than for a count. */
  const units = stats?.perInstance;
  const pending = stats?.instancesPending ?? 0;
  const badge = stackBadge(stats?.instances);

  /**
   * Which structural drawing this kind gets. One kind, one answer — the
   * three are mutually exclusive, so a node can never draw two competing
   * pictures of itself.
   *
   *   strip   the units are INDEPENDENT and their individual values carry
   *           the lesson (shard partitions, replica set members).
   *   vessel  the node is a buffer, and depth-against-limit is the reading
   *           (queue).
   *   stack   the units are INTERCHANGEABLE machines and the count is the
   *           lesson (service, worker, db, cache, lb, cdn).
   */
  const structure: 'strip' | 'vessel' | 'stack' | 'none' =
    node.kind === 'shard' || node.kind === 'replica'
      ? 'strip'
      : node.kind === 'queue'
        ? 'vessel'
        : units && units.length > 1
          ? 'stack'
          : pending > 0
            ? 'stack'
            : 'none';

  const handleKey = useCallback(
    (e: React.KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        // Shift/ctrl+Enter toggles, matching shift/ctrl-click.
        onActivate(node.id, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      // Arrows nudge by one grid step, shift+arrow by four.
      const step = e.shiftKey ? GRID * 4 : GRID;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      e.stopPropagation();
      onNudge(node.id, dx, dy);
    },
    [node.id, onActivate, onNudge],
  );

  // A working node must never render an empty meter: 2px minimum whenever
  // load is non-zero. This is the geometric twin of the never-print-zero rule.
  const load = readout ? clamp(readout.load, 0, 1) : 0;
  const meterW = load > 0 ? Math.max(2, load * METER_W) : 0;

  // Fractional metrics pin the sparkline domain to 0..1 so a utilization
  // trace does not rescale itself into looking permanently full.
  const sparkUnit = node.kind !== 'queue' && node.kind !== 'client';

  const full = detail === 2;
  const showHeader = detail >= 1;

  const linkClass =
    linkRole === 'none'
      ? ''
      : ` is-link-${linkRole}${linkTarget ? ' is-link-target' : ''}`;

  return (
    <g
      className={`cv-node is-${health}${selected ? ' is-selected' : ''}${
        readout?.losing ? ' is-losing' : ''
      }${fault ? ' is-faulted' : ''}${linking ? ' is-linking' : ''}${linkClass}`}
      transform={`translate(${node.x},${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={[
        // The kind is dropped when the user's own label already says it, so
        // a node called "Database" is announced once, not as "Database,
        // Database". Compared case-insensitively because the label is free
        // text the student typed.
        node.label.trim().toLowerCase() === KIND_NAME[node.kind].toLowerCase()
          ? null
          : KIND_NAME[node.kind],
        node.label,
        readout ? `${readout.primary.value} ${readout.primary.label}` : null,
        /* The structure is announced, not just drawn. A stack of cards, a
             strip of partitions and a filling vessel are all pure geometry —
             a screen-reader user has no access to any of them, and they are
             the whole point of this pass. Said in words rather than as a
             count alone: "4 partitions" beats "4x". */
        badge
          ? node.kind === 'shard'
            ? `${stats?.instances} partitions`
            : node.kind === 'replica'
              ? `primary plus ${(stats?.instances ?? 1) - 1} read replicas`
              : `${stats?.instances} instances`
          : null,
        pending > 0 ? `${pending} warming up` : null,
        // The fault is announced, not just drawn: a screen-reader user has
        // no access to the square mark in the corner.
        fault ? `faulted: ${fault}` : null,
      ]
        .filter(Boolean)
        .join(', ')}
      aria-pressed={selected}
      data-hit="node"
      data-id={node.id}
      /* Drives the per-kind colour trio in Canvas.css. Identity is expressed
         entirely through CSS custom properties keyed off this one attribute,
         so no colour value is ever computed in JS. */
      data-kind={node.kind}
      onKeyDown={handleKey}
    >
      {/* The fleet, BEHIND the body. Painted first so the body is the front
          card of the stack rather than an object sitting on top of one. */}
      {structure === 'stack' && showHeader && (
        <InstanceStack live={units?.length ?? 1} pending={pending} />
      )}

      {/* Body. One surface. No header band fill, no card-in-card. */}
      <rect
        className="cv-node-body"
        width={NODE_W}
        height={NODE_H}
        rx={NODE_R}
        ry={NODE_R}
      />

      {/*
        Selection ring.

        Drawn as a SEPARATE rect OUTSIDE the body, offset by 3px, rather than
        as a border on the body itself. Three reasons, and on a per-kind
        palette the third is decisive:

          - it can be 2px without changing the body's geometry (a thicker
            border would shift every child by a pixel);
          - offsetting it outward leaves a 3px gap of raw canvas between ring
            and node, and that gap is what makes it read as a ring AROUND the
            component rather than as a recolouring of its outline;
          - the node now has its own kind colour on its border. If selection
            simply repainted that border, selecting a node would destroy the
            identity cue the whole redesign exists to establish. Keeping them
            on separate geometry means a selected database is still visibly
            a database.

        Measured: --accent against the palest of the fourteen kind fills is
        5.42:1, so the ring is unmistakable on every node in the system.
      */}
      {selected && (
        <rect
          className="cv-node-ring"
          x={-RING_GAP}
          y={-RING_GAP}
          width={NODE_W + RING_GAP * 2}
          height={NODE_H + RING_GAP * 2}
          rx={NODE_R + RING_GAP}
          ry={NODE_R + RING_GAP}
        />
      )}

      {/* No kind rule along the top edge. It used to sit at y=0, but the body
          rect is stroked and a stroke straddles its own path, so half the
          border already occupies that row. The bar landed on top of the inner
          half and stopped flat where the corner radius curved away, which read
          as a misaligned second border. The kind colour is on the border
          itself, so the bar was saying the same thing twice anyway. */}

      {showHeader && (
        <>
          <line
            className="cv-node-hair"
            x1={PAD_X}
            y1={HEAD_H}
            x2={NODE_W - PAD_X}
            y2={HEAD_H}
          />

          <g
            className="cv-node-icon"
            transform={`translate(${PAD_X},6) scale(${GLYPH_SCALE})`}
          >
            <Glyph kind={node.kind} />
          </g>
        </>
      )}

      {/*
        The node name, truncated to the width actually available.

        SVG <text> has no text-overflow: it simply paints past its container,
        so a long label used to run straight out of the node and across the
        canvas (measured: 125px of overhang on a 36-character label, over open
        background and neighbouring wires). Since the student types this
        label, "nobody would do that" is not a defence.

        The budget is derived from the real geometry rather than hardcoded, so
        it stays correct if the glyph size or insets ever change. The full
        label is always available: it is in the accessible name, and <title>
        gives it a native hover tooltip.
      */}
      <text
        className="cv-node-name"
        x={showHeader ? PAD_X + GLYPH_PX + 8 : PAD_X}
        y={showHeader ? 21 : 24}
      >
        {truncateLabel(node.label, showHeader)}
        {truncateLabel(node.label, showHeader) !== node.label && (
          <title>{node.label}</title>
        )}
      </text>

      {/*
        Status mark, top right. Redundant with colour by SHAPE, which is the
        rule that keeps the diagram readable under deuteranopia (where warn and
        danger converge to the same yellow-green):

          ok      nothing at all — a healthy node carries no mark
          warn    a hollow ring
          danger  a filled disc
          fault   a square, which no metric state ever produces

        So the three states differ in fill and the fourth in silhouette,
        before any colour is applied.
      */}
      {showHeader && fault && (
        <rect
          className="cv-node-mark is-fault"
          x={NODE_W - PAD_X - 7}
          y={9}
          width={7}
          height={7}
        />
      )}
      {showHeader && !fault && health === 'danger' && (
        <circle
          className="cv-node-mark is-danger"
          cx={NODE_W - PAD_X - 3.5}
          cy={12.5}
          r={3.5}
        />
      )}
      {showHeader && !fault && health === 'warn' && (
        <circle
          className="cv-node-mark is-warn"
          cx={NODE_W - PAD_X - 3.5}
          cy={12.5}
          r={3}
        />
      )}

      {/*
        Unit count. The PRECISE channel for how many things this node is,
        where the stack behind it is only the approximate one — past five
        instances the stack stops growing and this is what still tells the
        truth. Sits left of the status mark so the two never overlap, and is
        suppressed entirely at one unit (see stackBadge).

        `+n` is appended while units are warming up. That is a different claim
        from the count itself — "5 running, 3 on the way" — and keeping it in
        one label rather than two stops a scaling node from gaining and losing
        a whole separate element every few seconds.
      */}
      {showHeader && badge && (
        <text
          className={pending > 0 ? 'cv-node-badge is-warming' : 'cv-node-badge'}
          x={NODE_W - PAD_X - (fault || health !== 'ok' ? 12 : 0)}
          y={16}
          textAnchor="end"
        >
          {badge}
          {pending > 0 ? `+${pending}` : ''}
        </text>
      )}

      {full && readout && (
        <>
          <text className="cv-node-primary" x={PAD_X} y={52}>
            <tspan className="cv-val">{readout.primary.value}</tspan>
            <tspan className="cv-cap" dx={4}>
              {readout.primary.label}
            </tspan>
          </text>

          {/*
            The sparkline slot carries the STRUCTURE when the node has one,
            and the trend otherwise.

            For a shard or a replica set this is a straight upgrade, not a
            trade: the sparkline there plots the node-level MEAN, which is the
            single most misleading number those two kinds produce. A shard at
            hotKeyFraction 0.85 traces a calm flat 0.17 while partition 0 is
            pinned at 1.00 and shedding. The strip shows both facts at once and
            the trend is still available on the meter and in the Inspector.
          */}
          {structure === 'strip' && units ? (
            <UnitStrip
              values={units}
              /* FULL BODY WIDTH, not the sparkline's 64px slot.

                 For a shard the strip is not a secondary indicator sitting
                 beside the numbers — it IS the node's primary content, and
                 the width directly buys legibility at high partition counts.
                 Measured: 64 partitions in the 64px slot gives 1.00px cells,
                 which is below the point where a fill height can be read; the
                 same 64 partitions across the full 160px inner width give
                 2.50px cells, which still resolve as distinct bars. The
                 numbers move left to their own column to make room. */
              x={PAD_X}
              /* Sits in the band between the secondary readout (baseline 70)
                 and the meter (80): a 10px strip at y=58 clears the primary
                 text above it and the meter below without either moving. */
              y={STRIP_Y}
              width={METER_W}
              height={STRIP_H}
              // A replica set is [primary, ...replicas]: index 0 is a
              // different KIND of thing from the rest, not just another
              // member, and the write pool saturating while the read set
              // idles is the lesson. A shard has no privileged partition.
              leadIndex={node.kind === 'replica' ? 0 : -1}
            />
          ) : structure === 'vessel' && stats ? (
            <QueueVessel
              depth={stats.queued}
              limit={stats.queueLimit}
              shedding={stats.shedRate > 0}
              x={SPARK_X}
              y={SPARK_Y + SPARK_H - 10}
              width={SPARK_W}
              height={10}
            />
          ) : (
            <Spark data={spark} unit={sparkUnit} />
          )}

          {/*
            The two secondary metrics are anchored to OPPOSITE edges — the
            first to the left inset, the second to the right — rather than the
            second sitting at a fixed x offset from the first.

            The fixed offset was a real bug, not a style preference: it
            assumed the left metric never got wide. At three-digit latency
            ("117ms P99") the left pair overran the offset and printed
            straight through the right pair, rendering "P99" and "89%" on top
            of each other. Anchoring them to opposite edges makes the two grow
            AWAY from one another, so the gap between them shrinks under
            pressure instead of going negative.
          */}
          {/* The strip occupies this row and already shows the spread these
              two numbers summarise, so they are dropped for those kinds
              rather than printed on top of it. The exact hottest/coldest
              figures remain one click away in the Inspector. */}
          {structure !== 'strip' && (
            <>
              {/* Each half gets a hard width budget and textLength forces the
                  glyphs to fit it. SVG text neither wraps nor ellipsises, so
                  without this a wordy readout simply grows across the node and
                  collides with its neighbour, which is exactly what happened
                  when the autoscaler printed a phase word here. Condensing is
                  ugly at extremes but it is always legible, and it can never
                  overlap. */}
              <text
                className="cv-node-sec"
                x={PAD_X}
                y={70}
                {...fitWidth(secText(readout.a), SEC_HALF)}
              >
                <tspan className="cv-val">{readout.a.value}</tspan>
                {readout.a.value && readout.a.label ? (
                  <tspan className="cv-cap" dx={3}>
                    {readout.a.label}
                  </tspan>
                ) : (
                  <tspan className="cv-cap">{readout.a.label}</tspan>
                )}
              </text>
              <text
                className="cv-node-sec"
                x={NODE_W - PAD_X}
                y={70}
                textAnchor="end"
                {...fitWidth(secText(readout.b), SEC_HALF)}
              >
                <tspan className="cv-val">{readout.b.value}</tspan>
                {readout.b.value && readout.b.label ? (
                  <tspan className="cv-cap" dx={3}>
                    {readout.b.label}
                  </tspan>
                ) : (
                  <tspan className="cv-cap">{readout.b.label}</tspan>
                )}
              </text>
            </>
          )}
        </>
      )}

      {/* Meter. Length is the primary encoding of load — it survives both
          colourblindness and the zoom levels where text has dropped out. */}
      <rect
        className="cv-meter-track"
        x={PAD_X}
        y={METER_Y}
        width={METER_W}
        height={METER_H}
        rx={1.5}
      />
      {meterW > 0 && (
        <rect
          className="cv-meter-fill"
          x={PAD_X}
          y={METER_Y}
          width={meterW}
          height={METER_H}
          rx={1.5}
        />
      )}
      {/* Threshold tick. A fixed landmark at the warn line, so a bar can be
          read against WHERE trouble starts, not just against its own length. */}
      <rect
        className="cv-meter-tick"
        x={PAD_X + METER_W * WARN_AT}
        y={METER_Y - 1}
        width={1}
        height={METER_H + 2}
      />

      {/*
        Ports. Input left, output right.

        Each port is TWO circles: a transparent 15px hit disc and the 5px dot
        that is actually seen. The hit disc is what the pointerdown router
        finds via closest('[data-hit]'), so aiming is forgiving while the
        drawing stays precise. The hit disc is drawn first so the visible dot
        paints over it.
      */}
      <circle
        className="cv-port-hit"
        cx={0}
        cy={PORT_CY}
        r={PORT_HIT_R}
        data-hit="port-in"
        data-id={node.id}
      />
      <circle className="cv-port cv-port-in" cx={0} cy={PORT_CY} r={PORT_R} />

      <circle
        className="cv-port-hit"
        cx={NODE_W}
        cy={PORT_CY}
        r={PORT_HIT_R}
        data-hit="port-out"
        data-id={node.id}
      />
      <circle className="cv-port cv-port-out" cx={NODE_W} cy={PORT_CY} r={PORT_R} />
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Input layer
 *
 * ONE pointerdown router lives on `.cv-surface`, an element that contains the
 * SVG and nothing else. Every piece of overlay chrome (zoom controls, ledger,
 * empty-state copy) is a SIBLING of the surface, not a descendant, so a press
 * on a button can never reach this code and can never be swallowed by pointer
 * capture. That is the structural half of the fix; the router also bails on
 * anything matching `button, input, select, textarea, a, [data-chrome]` as a
 * belt-and-braces second half.
 *
 * The state machine has two phases:
 *
 *   PENDING   pointerdown recorded what was hit and where, and NOTHING else.
 *             No capture, no state change, no selection change. A release in
 *             this phase is a CLICK and is routed by what was hit.
 *
 *   ACTIVE    the pointer travelled more than DRAG_THRESHOLD screen px, so
 *             the gesture is promoted to the drag its hit target implies and
 *             the pointer is captured at that moment — never earlier.
 *
 * `pendingLink` is a third, modeless state: a completed click on an output
 * port arms a link that the NEXT click completes. That gives beginners a
 * two-click alternative to a precise drag.
 * ------------------------------------------------------------------ */

/** What a pointerdown landed on, resolved once at press time. */
type HitKind = 'node' | 'port-in' | 'port-out' | 'edge' | 'edge-delete' | 'background';

interface Hit {
  kind: HitKind;
  id: string | null;
}

interface Pending {
  pointerId: number;
  hit: Hit;
  /** Screen coords at press. Drag promotion is measured from here. */
  screenX: number;
  screenY: number;
  /** World coords at press. Node drags compute their grab offset from here. */
  worldX: number;
  worldY: number;
  shift: boolean;
  ctrl: boolean;
  /** Viewport at press, so a pan is absolute rather than incremental. */
  vx: number;
  vy: number;
  /** True once promoted past the threshold. */
  active: boolean;
  /** Which drag it was promoted to. Only meaningful when active. */
  mode: 'pan' | 'node' | 'link' | 'marquee' | null;
  /** Grab offset for a node drag, in world units. Set at promotion. */
  grabDx: number;
  grabDy: number;
  /** Ids moved as a group with the primary node (a multi-selection drag). */
  groupIds: string[];
  /** Origin of each grouped node at promotion, so moves stay relative. */
  groupOrigins: Map<string, { x: number; y: number }>;
}

/** Live marquee rectangle, in world units. */
interface Marquee {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Live link gesture: preview endpoint and the snapped target, if any. */
interface LinkState {
  from: string;
  /** World coords of the loose end. */
  x: number;
  y: number;
  /** Node the pointer is currently over, if any. */
  over: string | null;
}

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

export default function Canvas({
  topology,
  snapshot,
  selectedIds,
  onSelectionChange,
  onMoveNode,
  onConnect,
  onDeleteSelection,
  onDropNode,
  spark,
}: CanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const spaceRef = useRef(false);

  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  /**
   * Mirror of `view` for use inside pointer handlers. Keeping the live value
   * in a ref lets `toWorld` stay identity-stable, so the memoized node and
   * edge subtrees do not rebuild on every pan/zoom frame. Synced in a layout
   * effect rather than during render so concurrent rendering cannot observe
   * a torn value.
   */
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);

  const [cursor, setCursor] = useState<'grab' | 'grabbing' | 'crosshair' | 'default'>(
    'default',
  );
  /** Live drag-link preview, or null. */
  const [link, setLink] = useState<LinkState | null>(null);
  /**
   * Click-to-link: an output port that was CLICKED (not dragged). The next
   * click on a node completes the edge. Kept separate from `link` because it
   * survives across pointer gestures.
   */
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [dropHint, setDropHint] = useState(false);

  /* ---------------- live mirrors for pointer handlers ---------------- */

  /**
   * Handlers run from native listeners on the window during a drag, and must
   * see the CURRENT topology and selection without being re-created (which
   * would tear down and rebuild the listeners mid-gesture). Refs are the
   * mechanism; they are written in a layout effect so a render can never be
   * observed half-applied.
   */
  const topoRef = useRef(topology);
  const selRef = useRef(selectedIds);
  useLayoutEffect(() => {
    topoRef.current = topology;
    selRef.current = selectedIds;
  }, [topology, selectedIds]);

  /* ---------------- coordinate conversion ---------------- */

  /**
   * Screen (client) -> world. This is the inverse of the <g> transform
   * `translate(vx,vy) scale(k)` applied inside an SVG whose top-left is at
   * the surface element's bounding rect. Getting this wrong makes every drag
   * drift under zoom, so it is the single source of truth: nothing else in
   * this file does its own math.
   *
   *   screen = world * k + v          =>      world = (screen - v) / k
   *
   * The consequence that matters, and that the test suite asserts: a screen
   * delta of D always corresponds to a world delta of exactly D / k, at every
   * zoom level, because the offset terms cancel in the subtraction.
   */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const el = surfaceRef.current;
    const v = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: (clientX - r.left - v.x) / v.k,
      y: (clientY - r.top - v.y) / v.k,
    };
  }, []);

  /* ---------------- selection helpers ---------------- */

  const nodeIdSet = useMemo(
    () => new Set(topology.nodes.map((n) => n.id)),
    [topology.nodes],
  );

  const setSelection = useCallback(
    (ids: ReadonlySet<string>) => {
      const cur = selRef.current;
      // Skip the callback when nothing actually changed, so a plain click on
      // an already-selected node does not churn the shell's state.
      if (cur.size === ids.size) {
        let same = true;
        for (const id of ids) {
          if (!cur.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return;
      }
      onSelectionChange(ids);
    },
    [onSelectionChange],
  );

  /** Click semantics: plain replaces, shift/ctrl toggles. */
  const selectOne = useCallback(
    (id: string, additive: boolean) => {
      if (!additive) {
        setSelection(new Set([id]));
        return;
      }
      const next = new Set(selRef.current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
    },
    [setSelection],
  );

  const clearSelection = useCallback(() => {
    setSelection(EMPTY_SELECTION);
  }, [setSelection]);

  /* ---------------- link validity ---------------- */

  /**
   * Whether an edge from -> to may be created. Rejects a self-link and a
   * duplicate. Both rejections are reported to the user by the target
   * refusing to highlight, and both make the drop a silent no-op.
   */
  const canLink = useCallback((from: string, to: string): boolean => {
    if (from === to) return false;
    const t = topoRef.current;
    if (!t.nodes.some((n) => n.id === from)) return false;
    if (!t.nodes.some((n) => n.id === to)) return false;
    return !t.edges.some((e) => e.from === from && e.to === to);
  }, []);

  /** World-space hit test against node rects. Topmost (last drawn) wins. */
  const nodeAt = useCallback((wx: number, wy: number): string | null => {
    const nodes = topoRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (wx >= n.x && wx <= n.x + NODE_W && wy >= n.y && wy <= n.y + NODE_H) {
        return n.id;
      }
    }
    return null;
  }, []);

  /* ---------------- gesture teardown ---------------- */

  const cancelGesture = useCallback(() => {
    const p = pendingRef.current;
    if (p) {
      const el = surfaceRef.current;
      try {
        if (el && el.hasPointerCapture?.(p.pointerId)) {
          el.releasePointerCapture(p.pointerId);
        }
      } catch {
        // Same reasoning as the capture above: releasing a pointer the
        // browser has already reclaimed is not an error worth propagating.
      }
    }
    pendingRef.current = null;
    setLink(null);
    setMarquee(null);
    setCursor(spaceRef.current ? 'grab' : 'default');
  }, []);

  /* ---------------- pointerdown: route, do not capture ---------------- */

  /**
   * Resolve what was pressed. Reads `data-hit` attributes rather than relying
   * on per-element React handlers, so the decision is made in ONE place with
   * full knowledge, instead of being raced by stopPropagation calls scattered
   * across the tree.
   */
  const hitTest = useCallback((target: EventTarget | null): Hit => {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function') {
      return { kind: 'background', id: null };
    }
    const found = el.closest('[data-hit]');
    if (!found) return { kind: 'background', id: null };
    const kind = found.getAttribute('data-hit') as HitKind | null;
    if (!kind) return { kind: 'background', id: null };
    return { kind, id: found.getAttribute('data-id') };
  }, []);

  const onSurfaceDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // (A) Interactive chrome is never the canvas's business. Structurally
      // it is not even a descendant of this element, but a stray button
      // rendered inside the surface later must still be safe.
      const el = e.target as Element | null;
      if (el?.closest?.('button, input, select, textarea, a, [data-chrome]')) {
        return;
      }

      // Middle button pans; right button does nothing (the context menu is
      // already suppressed). Anything else is ignored outright.
      const middle = e.button === 1;
      if (e.button !== 0 && !middle) return;

      const hit = middle
        ? ({ kind: 'background', id: null } as Hit)
        : hitTest(e.target);
      const w = toWorld(e.clientX, e.clientY);
      const v = viewRef.current;

      pendingRef.current = {
        pointerId: e.pointerId,
        // Space-held or middle-drag forces a pan regardless of what is under
        // the pointer, which is the documented escape hatch for panning while
        // the viewport is full of nodes.
        hit: spaceRef.current || middle ? { kind: 'background', id: null } : hit,
        screenX: e.clientX,
        screenY: e.clientY,
        worldX: w.x,
        worldY: w.y,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        vx: v.x,
        vy: v.y,
        active: false,
        mode: null,
        grabDx: 0,
        grabDy: 0,
        groupIds: [],
        groupOrigins: new Map(),
      };

      // (B) NO setPointerCapture here. That single line was the whole bug:
      // capturing on press retargets the subsequent pointerup to this
      // element, which suppresses the browser's synthesized `click` on any
      // button underneath and makes every overlay control inert. Capture
      // happens at promotion, in onSurfaceMove, once the gesture is known to
      // be a drag.
    },
    [hitTest, toWorld],
  );

  /* ---------------- pointermove: promote, then drag ---------------- */

  const promote = useCallback(
    (p: Pending) => {
      p.active = true;

      switch (p.hit.kind) {
        case 'node': {
          const id = p.hit.id;
          const node = id ? topoRef.current.nodes.find((n) => n.id === id) : null;
          if (!node || !id) {
            p.mode = 'pan';
            break;
          }
          p.mode = 'node';
          p.grabDx = node.x - p.worldX;
          p.grabDy = node.y - p.worldY;
          // Dragging a node that is part of a multi-selection moves the whole
          // selection. Dragging an unselected node moves only that node and
          // makes it the selection, which is what a user expects from a
          // direct grab.
          const sel = selRef.current;
          if (sel.has(id) && sel.size > 1) {
            for (const other of topoRef.current.nodes) {
              if (other.id !== id && sel.has(other.id)) {
                p.groupIds.push(other.id);
                p.groupOrigins.set(other.id, { x: other.x, y: other.y });
              }
            }
          } else {
            selectOne(id, false);
          }
          break;
        }

        case 'port-out':
          p.mode = 'link';
          setPendingLink(null);
          setLink({ from: p.hit.id!, x: p.worldX, y: p.worldY, over: null });
          break;

        case 'port-in':
        case 'edge':
        case 'edge-delete':
          // Dragging an edge or an input port is not a gesture this canvas
          // defines. Falling through to a pan is better than dead-ending the
          // pointer, because the user still gets motion for their effort.
          p.mode = 'pan';
          break;

        default:
          // Empty background: shift or ctrl starts a marquee, a plain drag
          // pans. Panning is the more common intent, and the marquee stays
          // one modifier away.
          p.mode = p.shift || p.ctrl ? 'marquee' : 'pan';
          break;
      }

      setCursor(p.mode === 'link' ? 'crosshair' : 'grabbing');

      // NOW the gesture is real, so take the pointer. From here on, moves and
      // the terminating up are guaranteed to reach this element even if the
      // pointer leaves the window.
      //
      // Capture is an OPTIMISATION, never a precondition: it throws
      // NotFoundError whenever the id does not belong to a live pointer —
      // a pointer released between the down and this promotion, or a
      // synthetic event from a test harness. Letting that escape would abort
      // the rest of promote() and leave the gesture half-built, which is a
      // far worse failure than a drag that stops tracking outside the window.
      try {
        surfaceRef.current?.setPointerCapture(p.pointerId);
      } catch {
        // Without capture the gesture still works inside the surface, which
        // is where essentially all of it happens.
      }
    },
    [selectOne],
  );

  const onSurfaceMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const p = pendingRef.current;
      if (!p || p.pointerId !== e.pointerId) return;

      // The button is no longer down, so whatever this gesture was, it ended
      // somewhere we could not see.
      //
      // Capture is deliberately deferred until the drag threshold, which is
      // what keeps overlay buttons clickable. The cost is a window where a
      // press can leave the surface uncaptured: press a node, slide off before
      // the threshold, release outside the window, and no pointerup ever
      // reaches us. A mouse keeps one pointerId for its whole life, so the
      // next time the cursor crossed the canvas the stale entry would clear
      // the threshold and promote a drag with no button held, leaving a node
      // stuck to the cursor.
      if (e.buttons === 0) {
        cancelGesture();
        return;
      }

      if (!p.active) {
        const dx = e.clientX - p.screenX;
        const dy = e.clientY - p.screenY;
        // Squared comparison: no sqrt on the hot path.
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
        promote(p);
      }

      if (p.mode === 'pan') {
        setView((v) => ({
          ...v,
          x: p.vx + (e.clientX - p.screenX),
          y: p.vy + (e.clientY - p.screenY),
        }));
        return;
      }

      const w = toWorld(e.clientX, e.clientY);

      if (p.mode === 'node') {
        const id = p.hit.id!;
        const nx = snap(w.x + p.grabDx);
        const ny = snap(w.y + p.grabDy);
        onMoveNode(id, nx, ny);
        // Grouped nodes translate by the same snapped delta, so the shape of
        // a multi-selection is preserved exactly rather than each member
        // being snapped independently.
        if (p.groupIds.length > 0) {
          const node = topoRef.current.nodes.find((n) => n.id === id);
          if (node) {
            const baseX = snap(p.worldX + p.grabDx);
            const baseY = snap(p.worldY + p.grabDy);
            const mdx = nx - baseX;
            const mdy = ny - baseY;
            for (const other of p.groupIds) {
              const o = p.groupOrigins.get(other);
              if (o) onMoveNode(other, o.x + mdx, o.y + mdy);
            }
          }
        }
        return;
      }

      if (p.mode === 'link') {
        // Snap to the whole node body, not to the input port. Requiring a
        // 5px port as the drop target is the single biggest reason linking
        // felt unreliable.
        const over = nodeAt(w.x, w.y);
        setLink((cur) => (cur ? { from: cur.from, x: w.x, y: w.y, over } : cur));
        return;
      }

      if (p.mode === 'marquee') {
        setMarquee({
          x: Math.min(p.worldX, w.x),
          y: Math.min(p.worldY, w.y),
          w: Math.abs(w.x - p.worldX),
          h: Math.abs(w.y - p.worldY),
        });
      }
    },
    [promote, toWorld, onMoveNode, nodeAt],
  );

  /* ---------------- pointerup: click, or finish the drag ---------------- */

  const onSurfaceUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const p = pendingRef.current;
      if (!p || p.pointerId !== e.pointerId) return;

      if (!p.active) {
        /* ---- CLICK ---- */
        const additive = p.shift || p.ctrl;

        // A click while a click-link is armed always tries to complete it,
        // whatever it landed on. That is what makes two-click linking feel
        // like one gesture rather than two unrelated clicks.
        if (pendingLink !== null) {
          const from = pendingLink;
          setPendingLink(null);
          let target: string | null = null;
          if (
            p.hit.kind === 'node' ||
            p.hit.kind === 'port-in' ||
            p.hit.kind === 'port-out'
          ) {
            target = p.hit.id;
          } else {
            target = nodeAt(p.worldX, p.worldY);
          }
          if (target && canLink(from, target)) {
            onConnect(from, target);
            cancelGesture();
            return;
          }
          // Invalid or empty: the arm is spent and the click falls through to
          // ordinary selection, so a mis-aimed second click is not a dead end.
        }

        switch (p.hit.kind) {
          case 'edge-delete':
            if (p.hit.id) {
              onDeleteSelection([], [p.hit.id]);
              clearSelection();
            }
            break;

          case 'node':
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          case 'edge':
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          case 'port-out':
            // Arm a click-to-link. Selecting the node too would fight the
            // arming state visually, so a port click does only this.
            if (p.hit.id) setPendingLink(p.hit.id);
            break;

          case 'port-in':
            // An input port click selects its node; there is nothing to arm
            // from an input.
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          default:
            if (!additive) clearSelection();
            break;
        }

        cancelGesture();
        return;
      }

      /* ---- END OF DRAG ---- */

      if (p.mode === 'link') {
        const w = toWorld(e.clientX, e.clientY);
        const target = nodeAt(w.x, w.y);
        if (target && canLink(p.hit.id!, target)) {
          onConnect(p.hit.id!, target);
        }
        // Releasing over empty space, over the source, or over an existing
        // target is a clean no-op: cancelGesture below drops the preview.
      } else if (p.mode === 'marquee') {
        const w = toWorld(e.clientX, e.clientY);
        const x0 = Math.min(p.worldX, w.x);
        const y0 = Math.min(p.worldY, w.y);
        const x1 = Math.max(p.worldX, w.x);
        const y1 = Math.max(p.worldY, w.y);
        // Intersection, not containment: a box that clips a node selects it.
        // Containment forces a user to lasso generously around big nodes.
        const next = new Set<string>(p.shift || p.ctrl ? selRef.current : []);
        for (const n of topoRef.current.nodes) {
          if (n.x <= x1 && n.x + NODE_W >= x0 && n.y <= y1 && n.y + NODE_H >= y0) {
            next.add(n.id);
          }
        }
        setSelection(next);
      }

      cancelGesture();
    },
    [
      pendingLink,
      nodeAt,
      canLink,
      onConnect,
      onDeleteSelection,
      clearSelection,
      selectOne,
      setSelection,
      toWorld,
      cancelGesture,
    ],
  );

  /* ---------------- marquee drag on empty background ----------------
   *
   * A plain drag on empty background pans; shift/ctrl+drag box-selects.
   * Documented here and in the on-canvas hint so the choice is discoverable.
   */

  /* ---------------- wheel: zoom + pan ---------------- */

  // Attached natively (not via React's onWheel) because React attaches wheel
  // listeners as passive at the root, and ctrl+wheel must be preventable to
  // stop the browser's own page zoom on trackpad pinch.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      // Trackpad pinch arrives as ctrlKey wheel events on every platform.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setView((v) => {
          const k = clamp(v.k * Math.exp(-e.deltaY * 0.0022), MIN_ZOOM, MAX_ZOOM);
          if (k === v.k) return v;
          // Keep the world point under the CURSOR pinned to the cursor.
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          const wx = (px - v.x) / v.k;
          const wy = (py - v.y) / v.k;
          return { k, x: px - wx * k, y: py - wy * k };
        });
        return;
      }
      // Plain wheel / two-finger scroll pans.
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------------- space-to-pan ---------------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      // Only claim space when the canvas is what the user is looking at.
      if (
        hostRef.current?.contains(document.activeElement) ||
        document.activeElement === document.body
      ) {
        spaceRef.current = true;
        if (!pendingRef.current) setCursor('grab');
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      if (!pendingRef.current) setCursor('default');
    };
    const blur = () => {
      spaceRef.current = false;
      if (!pendingRef.current) setCursor('default');
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* ---------------- keyboard: delete, escape, select-all ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      if (e.key === 'Escape') {
        // Escape unwinds one layer at a time is tempting, but a beginner
        // pressing Escape means "get me out of whatever this is". So it
        // cancels the in-flight gesture, the armed link AND the selection.
        if (pendingRef.current) cancelGesture();
        setPendingLink(null);
        setLink(null);
        setMarquee(null);
        clearSelection();
        return;
      }

      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const all = new Set<string>();
        for (const n of topology.nodes) all.add(n.id);
        for (const ed of topology.edges) all.add(ed.id);
        setSelection(all);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const nodes: string[] = [];
        const edges: string[] = [];
        for (const id of selectedIds) {
          if (nodeIdSet.has(id)) nodes.push(id);
          else edges.push(id);
        }
        onDeleteSelection(nodes, edges);
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selectedIds,
    nodeIdSet,
    topology.nodes,
    topology.edges,
    onDeleteSelection,
    clearSelection,
    setSelection,
    cancelGesture,
  ]);

  /* ---------------- keyboard activation from a node ---------------- */

  const onActivate = useCallback(
    (id: string, additive: boolean) => {
      // Enter on an output-port-armed canvas completes the link, matching the
      // click path.
      if (pendingLink !== null && canLink(pendingLink, id)) {
        onConnect(pendingLink, id);
        setPendingLink(null);
        return;
      }
      selectOne(id, additive);
    },
    [pendingLink, canLink, onConnect, selectOne],
  );

  const onNudge = useCallback(
    (id: string, dx: number, dy: number) => {
      const n = topology.nodes.find((m) => m.id === id);
      if (!n) return;
      onMoveNode(id, snap(n.x + dx), snap(n.y + dy));
    },
    [topology.nodes, onMoveNode],
  );

  /* ---------------- palette drops ---------------- */

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(NODE_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHint(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Ignore bubbling leaves from children.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHint(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const kind = e.dataTransfer.getData(NODE_DND_MIME) as NodeKind;
      setDropHint(false);
      if (!kind) return;
      e.preventDefault();
      const w = toWorld(e.clientX, e.clientY);
      // Drop centers the node on the cursor rather than pinning its corner.
      onDropNode(kind, snap(w.x - NODE_W / 2), snap(w.y - NODE_H / 2));
    },
    [toWorld, onDropNode],
  );

  /* ---------------- fit to content ---------------- */

  const fitToContent = useCallback(() => {
    const el = surfaceRef.current;
    if (!el || topology.nodes.length === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of topology.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
      if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = clamp(
      Math.min((r.width - FIT_MARGIN * 2) / bw, (r.height - FIT_MARGIN * 2) / bh),
      FIT_MIN,
      FIT_MAX,
    );
    setView({
      k,
      x: (r.width - bw * k) / 2 - minX * k,
      y: (r.height - bh * k) / 2 - minY * k,
    });
  }, [topology.nodes]);

  /**
   * Re-fit whenever the topology is replaced wholesale (mount, preset load) —
   * keyed on the set of node ids so dragging a node or editing its config
   * never yanks the viewport out from under the user.
   */
  const topoKey = useMemo(
    () =>
      topology.nodes
        .map((n) => n.id)
        .sort()
        .join(','),
    [topology.nodes],
  );

  useLayoutEffect(() => {
    if (topology.nodes.length === 0) return;
    fitToContent();
    // fitToContent is intentionally omitted: it changes identity on every node
    // move, and re-fitting mid-drag is exactly what this guard prevents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey]);

  /** Re-fit on container resize, but only while the user is idle. */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (pendingRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitToContent());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitToContent]);

  const zoomBy = useCallback((factor: number) => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      if (k === v.k) return v;
      // Zoom about the viewport center.
      const px = r.width / 2;
      const py = r.height / 2;
      const wx = (px - v.x) / v.k;
      const wy = (py - v.y) / v.k;
      return { k, x: px - wx * k, y: py - wy * k };
    });
  }, []);

  /* ---------------- derived render data ---------------- */

  const nodeById = useMemo(() => {
    const m = new Map<string, SimNode>();
    for (const n of topology.nodes) m.set(n.id, n);
    return m;
  }, [topology.nodes]);

  const detail: 0 | 1 | 2 = view.k >= DETAIL_ZOOM ? 2 : view.k >= MINIMAL_ZOOM ? 1 : 0;
  const showEdgeLabels = view.k >= 1;

  /**
   * Injected failures in force, keyed by node id.
   *
   * `activeFailures` is an ARRAY on the snapshot, so looking a node up in it
   * directly would be O(n) per node per render. Indexing it once per snapshot
   * keeps NodeView's prop a plain string that memo can compare by identity.
   */
  const faultById = useMemo(() => {
    const m = new Map<string, FailureKind>();
    if (!snapshot) return m;
    for (const f of snapshot.activeFailures) m.set(f.nodeId, f.kind);
    return m;
  }, [snapshot]);

  /**
   * Which edges are CONTROL relationships rather than request paths.
   *
   * The rule is read from the behaviour registry rather than restated here,
   * so the canvas and the engine cannot drift apart about what a control edge
   * is. The engine's definition is exactly this OR: an explicit
   * `SimEdge.control` flag, or a source whose kind only ever supervises. The
   * OR is why no preset needed a flag added — an autoscaler's edge is control
   * because of what an autoscaler IS.
   *
   * Depends only on the topology, not the snapshot, so it survives every
   * frame of a running simulation without recomputing.
   */
  const controlEdges = useMemo(() => {
    const set = new Set<string>();
    for (const e of topology.edges) {
      if (e.control) {
        set.add(e.id);
        continue;
      }
      const src = nodeById.get(e.from);
      if (src && behaviourFor(src.kind).controlsTarget) set.add(e.id);
    }
    return set;
  }, [topology.edges, nodeById]);

  /**
   * Health per node, so an edge can be colored by the state of the node it
   * feeds. Computed once per snapshot rather than per edge.
   *
   * A faulted node is forced to `danger` here as well as inside NodeView, so
   * that the WIRES feeding a crashed node also read as failing. Without this
   * a crashed node (which serves nothing, so reports 0% utilisation) would sit
   * at the end of a set of perfectly healthy-looking edges.
   */
  const healthById = useMemo(() => {
    const m = new Map<string, Health>();
    if (!snapshot) return m;
    for (const n of topology.nodes) {
      if (faultById.has(n.id)) {
        m.set(n.id, 'danger');
        continue;
      }
      const s = snapshot.nodes[n.id];
      if (s) m.set(n.id, readoutFor(n.kind, s, n.config).health);
    }
    return m;
  }, [snapshot, topology.nodes, faultById]);

  /**
   * The link gesture currently in flight, from either mechanism. Drag and
   * click-to-link produce the same source id, so downstream rendering treats
   * them identically and the two modes cannot look different.
   */
  const linkFrom = link ? link.from : pendingLink;
  const previewFrom = linkFrom ? nodeById.get(linkFrom) : undefined;
  const previewPort = previewFrom ? outPort(previewFrom) : null;

  /**
   * Per-node role in the live link. Precomputed so NodeView receives a plain
   * string and stays memo-stable for every node not involved.
   */
  const linkRoles = useMemo(() => {
    const m = new Map<string, LinkRole>();
    if (!linkFrom) return m;
    for (const n of topology.nodes) {
      if (n.id === linkFrom) {
        m.set(n.id, 'source');
        continue;
      }
      const dup = topology.edges.some((e) => e.from === linkFrom && e.to === n.id);
      m.set(n.id, dup ? 'invalid' : 'valid');
    }
    return m;
  }, [linkFrom, topology.nodes, topology.edges]);

  /**
   * Ruled grid. 32px minor, 128px major — a ruled field reads as a workspace,
   * where the old 8px dot field read as an empty document (and painted tens of
   * thousands of dots of static across a wide canvas).
   */
  const minor = 32 * view.k;
  const major = 128 * view.k;
  const gridStyle: CSSProperties = {
    backgroundSize: `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
    // Fade the grid out as the diagram shrinks past the point where rules help.
    // Keyed to the DETAIL threshold, not to the fit floor: the grid should
    // thin out at the same zoom the nodes stop showing their numbers.
    opacity: view.k < MINIMAL_ZOOM ? 0 : view.k < DETAIL_ZOOM ? 0.5 : 1,
  };

  const elapsed = snapshot ? snapshot.system.timeMs / 1000 : 0;

  /** Snapped drop target of the live drag-link, if the drop would be legal. */
  const snapTarget =
    link && link.over && canLink(link.from, link.over) ? link.over : null;

  /**
   * Loose end of the preview wire.
   *
   * While DRAGGING it follows the pointer, and jumps to the target's input
   * port once a legal target is under it — the visual promise that releasing
   * now connects these two.
   *
   * While ARMED by a click there is no pointer to follow, so the wire is a
   * short stub leaving the source port. Without it, clicking a port produced
   * a text hint and no mark on the diagram at all, which left the source of
   * the pending connection completely unidentified.
   */
  const ARMED_STUB = 56;
  let previewX = 0;
  let previewY = 0;
  if (previewPort) {
    if (link) {
      previewX = link.x;
      previewY = link.y;
      if (snapTarget) {
        const t = nodeById.get(snapTarget);
        if (t) {
          const q = inPort(t);
          previewX = q.x;
          previewY = q.y;
        }
      }
    } else {
      previewX = previewPort.x + ARMED_STUB;
      previewY = previewPort.y;
    }
  }

  return (
    <div
      ref={hostRef}
      className={`cv-host${dropHint ? ' is-dropping' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/*
        The interaction surface. Everything the pointer router cares about
        lives inside it; every overlay control is a sibling BELOW it in this
        tree. That separation is what makes the zoom buttons clickable, and it
        is structural rather than a conditional inside a handler.
      */}
      <div
        ref={surfaceRef}
        className="cv-surface"
        data-cursor={cursor}
        onPointerDown={onSurfaceDown}
        onPointerMove={onSurfaceMove}
        onPointerUp={onSurfaceUp}
        onPointerCancel={cancelGesture}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="cv-grid" style={gridStyle} aria-hidden="true" />

        <svg className="cv-svg">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            <g className="cv-edges">
              {topology.edges.map((ed) => {
                const a = nodeById.get(ed.from);
                const b = nodeById.get(ed.to);
                if (!a || !b) return null;
                const p = outPort(a);
                const q = inPort(b);
                return (
                  <EdgeView
                    key={ed.id}
                    edge={ed}
                    ax={p.x}
                    ay={p.y}
                    bx={q.x}
                    by={q.y}
                    flow={snapshot?.edgeFlow[ed.id] ?? 0}
                    state={snapshot?.edgeState[ed.id] ?? 'idle'}
                    control={controlEdges.has(ed.id)}
                    selected={selectedIds.has(ed.id)}
                    targetHealth={healthById.get(ed.to) ?? 'ok'}
                    showLabel={showEdgeLabels}
                  />
                );
              })}
            </g>

            {previewPort && (
              <path
                className={`cv-link-preview${snapTarget ? ' is-snapped' : ''}`}
                d={edgePath(previewPort.x, previewPort.y, previewX, previewY)}
              />
            )}

            <g className="cv-nodes">
              {topology.nodes.map((n) => (
                <NodeView
                  key={n.id}
                  node={n}
                  stats={snapshot?.nodes[n.id] ?? null}
                  spark={spark?.get(n.id)}
                  selected={selectedIds.has(n.id)}
                  detail={detail}
                  linkRole={linkRoles.get(n.id) ?? 'none'}
                  linking={linkFrom !== null}
                  linkTarget={snapTarget === n.id}
                  fault={faultById.get(n.id) ?? null}
                  onActivate={onActivate}
                  onNudge={onNudge}
                />
              ))}
            </g>

            {marquee && (
              <rect
                className="cv-marquee"
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
              />
            )}
          </g>
        </svg>
      </div>

      {topology.nodes.length === 0 && (
        <p className="cv-empty">Drag a component here, or load an example system.</p>
      )}

      {/* Status ledger. A corner carrying a true number stops reading as
          dead space. */}
      {topology.nodes.length > 0 && (
        <div className="cv-ledger label" aria-hidden="true">
          <span>{topology.nodes.length} nodes</span>
          <span>{topology.edges.length} edges</span>
          <span>zoom {Math.round(view.k * 100)}%</span>
          <span>{elapsed.toFixed(1)}s</span>
        </div>
      )}

      {/* Live instruction while a click-to-link is armed. A student who
          clicked a port has no other way to learn what happens next. */}
      {pendingLink !== null && (
        <p className="cv-hint" role="status">
          Click a component to connect · Esc to cancel
        </p>
      )}

      <div className="cv-zoom" data-chrome="zoom">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => zoomBy(1 / 1.25)}
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <button
          type="button"
          className="btn btn-ghost cv-zoom-level"
          onClick={fitToContent}
          aria-label="Fit to content"
        >
          {Math.round(view.k * 100)}%
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => zoomBy(1.25)}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
    </div>
  );
}
