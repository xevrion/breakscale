import {
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
  NodeKind,
  NodeStats,
  SimEdge,
  SimNode,
  SimSnapshot,
  Topology,
} from '../sim/types';
import {
  FILLED_GLYPHS,
  GLYPH,
  GLYPH_BOX,
  KIND_NAME,
  NODE_DND_MIME,
} from './nodeVisuals';
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
const NODE_R = 5;

/** Height of the title block. The body is the remaining 64px. */
const HEAD_H = 24;
/** Horizontal inset for everything inside the body. */
const PAD_X = 12;
/** x of the vertical rule splitting numbers from the sparkline. */
const DIVIDER_X = 104;

const SPARK_X = 112;
const SPARK_Y = 32;
const SPARK_W = 60;
const SPARK_H = 20;
/** One sample per second over the same 60s window the charts show. */
export const SPARK_LEN = 60;

const METER_Y = 78;
const METER_H = 4;
const METER_W = NODE_W - PAD_X * 2;

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

/** Auto-fit margin and clamp. 1.5 stops a 3-node preset becoming a billboard. */
const FIT_MARGIN = 64;
const FIT_MIN = 0.6;
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
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

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
      return {
        primary: { value: formatRate(s.throughput), label: 'rps' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatPct(err), label: 'err' },
        load: err,
        health: healthOfErr(err),
        spark: s.throughput,
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

    // service, db, worker
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

const GLYPH_SCALE = 14 / GLYPH_BOX;

const Glyph = memo(function Glyph({ kind }: { kind: NodeKind }) {
  const filled = FILLED_GLYPHS.has(kind);
  return (
    <path
      d={GLYPH[kind]}
      className="cv-glyph"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.3 / GLYPH_SCALE}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
});

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

/**
 * Horizontal-tangent cubic bezier between two ports.
 *
 * Orthogonal routing with filleted corners was considered and rejected: it is
 * a real path-generation problem (fillet clamping, overlap avoidance, a
 * four-corner back-route case) and this curve already reads correctly for
 * every topology the presets produce.
 */
function edgePath(ax: number, ay: number, bx: number, by: number): string {
  const dx = bx - ax;
  // Bow scales with the gap so stacked nodes still read as curves, and is
  // floored at 48 for the wider node.
  const bow = clamp(Math.abs(dx) * 0.5, 48, 200);
  return `M${ax},${ay} C${ax + bow},${ay} ${bx - bow},${by} ${bx},${by}`;
}

/**
 * Stroke width from flow. Logarithmic so 10rps and 1000rps stay in one visual
 * family while still ranking unambiguously:
 *   0 -> 1.0   1 -> 1.26   10 -> 1.85   100 -> 2.71   1k -> 3.55   5k -> 4.16
 */
function edgeWidth(f: number): number {
  return f <= 0 ? 1 : clamp(1 + Math.log10(1 + f) * 0.85, 1, 4.5);
}

/** Where the arrowhead sits: just short of the target port. */
const ARROW_INSET = 9;
const ARROW_LEN = 9;
const ARROW_SPREAD = 0.42;

interface EdgeViewProps {
  edge: SimEdge;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  flow: number;
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
  selected,
  targetHealth,
  showLabel,
}: EdgeViewProps) {
  // Pull the endpoint back so the stroke does not poke through the arrowhead.
  const angle = Math.atan2(by - ay, bx - ax);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tipX = bx - cos * 2;
  const tipY = by - sin * 2;
  const d = edgePath(ax, ay, tipX - cos * ARROW_INSET, tipY - sin * ARROW_INSET);

  const width = edgeWidth(flow);
  const active = flow > 0.05;

  // One dash cycle is 12 user units, so animation-duration directly encodes
  // the flow rate. Clamped so it never strobes and never appears frozen.
  const style = active
    ? ({
        animationDuration: `${clamp(3.2 / Math.log10(10 + flow), 0.35, 2.4)}s`,
      } as CSSProperties)
    : undefined;

  // Midpoint of a cubic whose control points share the endpoints' y is simply
  // the average in y; x is the average of the four control x's at t=0.5.
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2;

  return (
    <g
      className={`cv-edge${selected ? ' is-selected' : ''}${
        active ? ' is-active' : ''
      } is-${targetHealth}`}
    >
      {/* Fat invisible hit area — a 1px line is impossible to click. The
          data-* attributes are what the surface's pointerdown router reads;
          no handler is attached here, so nothing can be swallowed before the
          router sees it. */}
      <path
        d={d}
        className="cv-edge-hit"
        data-hit="edge"
        data-id={edge.id}
      />
      <path d={d} className="cv-edge-line" strokeWidth={width} />
      {active && (
        <path
          d={d}
          className="cv-edge-flow"
          strokeWidth={width * 0.75}
          style={style}
        />
      )}
      <path
        d={`M${tipX},${tipY} L${tipX - Math.cos(angle - ARROW_SPREAD) * ARROW_LEN},${
          tipY - Math.sin(angle - ARROW_SPREAD) * ARROW_LEN
        } L${tipX - Math.cos(angle + ARROW_SPREAD) * ARROW_LEN},${
          tipY - Math.sin(angle + ARROW_SPREAD) * ARROW_LEN
        } Z`}
        className="cv-edge-arrow"
      />

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
  onActivate,
  onNudge,
}: NodeViewProps) {
  const readout = stats ? readoutFor(node.kind, stats, node.config) : null;
  const health = readout ? readout.health : 'ok';

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
      }${linking ? ' is-linking' : ''}${linkClass}`}
      transform={`translate(${node.x},${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={
        readout
          ? `${KIND_NAME[node.kind]} ${node.label}, ${readout.primary.value} ${readout.primary.label}`
          : `${KIND_NAME[node.kind]} ${node.label}`
      }
      aria-pressed={selected}
      data-hit="node"
      data-id={node.id}
      onKeyDown={handleKey}
    >
      {/* Body. */}
      <rect
        className="cv-node-body"
        width={NODE_W}
        height={NODE_H}
        rx={NODE_R}
        ry={NODE_R}
      />

      {showHeader && (
        <>
          {/* Header band. Rounded at the top only, square where it meets
              the hairline — drawn as a path because a rect cannot do that. */}
          <path
            className="cv-node-head"
            d={`M0,${HEAD_H} L0,${NODE_R} A${NODE_R},${NODE_R} 0 0 1 ${NODE_R},0 L${
              NODE_W - NODE_R
            },0 A${NODE_R},${NODE_R} 0 0 1 ${NODE_W},${NODE_R} L${NODE_W},${HEAD_H} Z`}
          />
          {/* Health rule along the top edge. */}
          <path
            className="cv-node-rule"
            d={`M0,${NODE_R} A${NODE_R},${NODE_R} 0 0 1 ${NODE_R},0 L${
              NODE_W - NODE_R
            },0 A${NODE_R},${NODE_R} 0 0 1 ${NODE_W},${NODE_R} L${NODE_W},1.5 L0,1.5 Z`}
          />
          <line
            className="cv-node-hair"
            x1={0}
            y1={HEAD_H}
            x2={NODE_W}
            y2={HEAD_H}
          />

          <g
            className="cv-node-icon"
            transform={`translate(10,5) scale(${GLYPH_SCALE})`}
          >
            <Glyph kind={node.kind} />
          </g>
        </>
      )}

      <text
        className="cv-node-name"
        x={showHeader ? 30 : PAD_X}
        y={showHeader ? 16 : 20}
      >
        {node.label}
      </text>

      {showHeader && <circle className="cv-node-dot" cx={172} cy={12} r={4} />}

      {/* Traffic is actively being lost here. The only added decoration, and
          it appears only when the statement is true. */}
      {full && readout?.losing && (
        // x=156, not 164: the health dot occupies 168..176 (cx 172, r 4), so
        // a square at 164 shared an edge with it and the two read as a single
        // smudge at 100% zoom. 156 leaves a clear 8px gap between them.
        <rect className="cv-node-loss" x={156} y={6} width={4} height={4} />
      )}

      {full && readout && (
        <>
          <text className="cv-node-primary" x={PAD_X} y={50}>
            <tspan className="cv-val">{readout.primary.value}</tspan>
            <tspan className="cv-cap" dx={4}>
              {readout.primary.label}
            </tspan>
          </text>

          <line
            className="cv-node-div"
            x1={DIVIDER_X}
            y1={32}
            x2={DIVIDER_X}
            y2={60}
          />

          <Spark data={spark} unit={sparkUnit} />

          <text className="cv-node-sec" x={PAD_X} y={68}>
            <tspan className="cv-val">{readout.a.value}</tspan>
            <tspan className="cv-cap" dx={4}>
              {readout.a.label}
            </tspan>
          </text>
          <text className="cv-node-sec" x={96} y={68}>
            <tspan className="cv-val">{readout.b.value}</tspan>
            <tspan className="cv-cap" dx={4}>
              {readout.b.label}
            </tspan>
          </text>
        </>
      )}

      {/* Meter. Position-encoded, so it survives colorblindness and low zoom. */}
      <rect
        className="cv-meter-track"
        x={PAD_X}
        y={METER_Y}
        width={METER_W}
        height={METER_H}
        rx={2}
      />
      {meterW > 0 && (
        <rect
          className="cv-meter-fill"
          x={PAD_X}
          y={METER_Y}
          width={meterW}
          height={METER_H}
          rx={2}
        />
      )}

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
      <circle
        className="cv-port cv-port-out"
        cx={NODE_W}
        cy={PORT_CY}
        r={PORT_R}
      />
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
        setLink((cur) =>
          cur ? { from: cur.from, x: w.x, y: w.y, over } : cur,
        );
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
          if (p.hit.kind === 'node' || p.hit.kind === 'port-in' || p.hit.kind === 'port-out') {
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
          const k = clamp(
            v.k * Math.exp(-e.deltaY * 0.0022),
            MIN_ZOOM,
            MAX_ZOOM,
          );
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
      Math.min(
        (r.width - FIT_MARGIN * 2) / bw,
        (r.height - FIT_MARGIN * 2) / bh,
      ),
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

  const detail: 0 | 1 | 2 =
    view.k >= DETAIL_ZOOM ? 2 : view.k >= MINIMAL_ZOOM ? 1 : 0;
  const showEdgeLabels = view.k >= 1;

  /**
   * Health per node, so an edge can be colored by the state of the node it
   * feeds. Computed once per snapshot rather than per edge.
   */
  const healthById = useMemo(() => {
    const m = new Map<string, Health>();
    if (!snapshot) return m;
    for (const n of topology.nodes) {
      const s = snapshot.nodes[n.id];
      if (s) m.set(n.id, readoutFor(n.kind, s, n.config).health);
    }
    return m;
  }, [snapshot, topology.nodes]);

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
      const dup = topology.edges.some(
        (e) => e.from === linkFrom && e.to === n.id,
      );
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
    opacity: view.k < MINIMAL_ZOOM ? 0 : view.k < FIT_MIN ? 0.5 : 1,
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
        <p className="cv-empty">
          Drag a component here, or load an example system.
        </p>
      )}

      {/* Status ledger. A corner carrying a true number stops reading as
          dead space. */}
      {topology.nodes.length > 0 && (
        <div className="cv-ledger label" aria-hidden="true">
          {topology.nodes.length} nodes
          <span className="cv-ledger-sep">·</span>
          {topology.edges.length} edges
          <span className="cv-ledger-sep">·</span>
          zoom {Math.round(view.k * 100)}%
          <span className="cv-ledger-sep">·</span>
          {elapsed.toFixed(1)}s
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
