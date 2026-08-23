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
const PORT_R = 5;
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
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onConnect: (fromId: string, toId: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
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
  onSelect: (id: string | null) => void;
  onDeleteEdge: (id: string) => void;
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
  onSelect,
  onDeleteEdge,
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

  const handleDown = useCallback(
    (e: ReactPointerEvent<SVGPathElement>) => {
      e.stopPropagation();
      onSelect(edge.id);
    },
    [edge.id, onSelect],
  );

  const handleDelete = useCallback(
    (e: ReactPointerEvent<SVGGElement>) => {
      e.stopPropagation();
      onDeleteEdge(edge.id);
    },
    [edge.id, onDeleteEdge],
  );

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
      {/* Fat invisible hit area — a 1px line is impossible to click. */}
      <path d={d} className="cv-edge-hit" onPointerDown={handleDown} />
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
          onPointerDown={handleDelete}
          role="button"
          aria-label="Delete connection"
        >
          <rect x={-7} y={-7} width={14} height={14} rx={3} />
          <path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" />
        </g>
      )}
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Node
 * ------------------------------------------------------------------ */

interface NodeViewProps {
  node: SimNode;
  stats: NodeStats | null;
  spark: ArrayLike<number> | undefined;
  selected: boolean;
  /** 2 = full, 1 = header + meter only, 0 = name + meter. */
  detail: 0 | 1 | 2;
  linking: boolean;
  onSelect: (id: string | null) => void;
  onNodeDown: (e: ReactPointerEvent<SVGGElement>, id: string) => void;
  onPortDown: (e: ReactPointerEvent<SVGCircleElement>, id: string) => void;
  onPortEnter: (id: string) => void;
  onPortLeave: () => void;
  onNudge: (id: string, dx: number, dy: number) => void;
}

const NodeView = memo(function NodeView({
  node,
  stats,
  spark,
  selected,
  detail,
  linking,
  onSelect,
  onNodeDown,
  onPortDown,
  onPortEnter,
  onPortLeave,
  onNudge,
}: NodeViewProps) {
  const readout = stats ? readoutFor(node.kind, stats, node.config) : null;
  const health = readout ? readout.health : 'ok';

  const handleDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>) => onNodeDown(e, node.id),
    [node.id, onNodeDown],
  );
  const handlePortDown = useCallback(
    (e: ReactPointerEvent<SVGCircleElement>) => onPortDown(e, node.id),
    [node.id, onPortDown],
  );
  const handlePortEnter = useCallback(
    () => onPortEnter(node.id),
    [node.id, onPortEnter],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(node.id);
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
      onNudge(node.id, dx, dy);
    },
    [node.id, onSelect, onNudge],
  );

  // A working node must never render an empty meter: 2px minimum whenever
  // load is non-zero. This is the geometric twin of the never-print-zero rule.
  const load = readout ? clamp(readout.load, 0, 1) : 0;
  const meterW = load > 0 ? Math.max(2, load * METER_W) : 0;

  // Fractional metrics pin the sparkline domain to 0..1 so a utilization
  // trace does not rescale itself into looking permanently full.
  const sparkUnit =
    node.kind !== 'queue' && node.kind !== 'client';

  const full = detail === 2;
  const showHeader = detail >= 1;

  return (
    <g
      className={`cv-node is-${health}${selected ? ' is-selected' : ''}${
        readout?.losing ? ' is-losing' : ''
      }`}
      transform={`translate(${node.x},${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={
        readout
          ? `${KIND_NAME[node.kind]} ${node.label}, ${readout.primary.value} ${readout.primary.label}`
          : `${KIND_NAME[node.kind]} ${node.label}`
      }
      aria-pressed={selected}
      onPointerDown={handleDown}
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

      {/* Ports. Input left, output right. */}
      <circle
        className="cv-port cv-port-in"
        cx={0}
        cy={PORT_CY}
        r={PORT_R}
        onPointerEnter={linking ? handlePortEnter : undefined}
        onPointerLeave={linking ? onPortLeave : undefined}
      />
      <circle
        className="cv-port cv-port-out"
        cx={NODE_W}
        cy={PORT_CY}
        r={PORT_R}
        onPointerDown={handlePortDown}
      />
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Interaction state (kept in refs — none of it should re-render).
 * ------------------------------------------------------------------ */

type Drag =
  | { mode: 'none' }
  | { mode: 'pan'; startX: number; startY: number; vx: number; vy: number }
  | {
      mode: 'node';
      id: string;
      /** Offset from pointer to node origin, in world units. */
      dx: number;
      dy: number;
      moved: boolean;
    }
  | { mode: 'link'; from: string };

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

export default function Canvas({
  topology,
  snapshot,
  selectedId,
  onSelect,
  onMoveNode,
  onConnect,
  onDeleteNode,
  onDeleteEdge,
  onDropNode,
  spark,
}: CanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag>({ mode: 'none' });
  const hoverPortRef = useRef<string | null>(null);
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

  const [cursor, setCursor] = useState<'grab' | 'grabbing' | 'default'>(
    'default',
  );
  /** Live preview endpoint while dragging a new edge, in world coords. */
  const [linkPreview, setLinkPreview] = useState<{
    from: string;
    x: number;
    y: number;
  } | null>(null);
  const [dropHint, setDropHint] = useState(false);

  /* ---------------- coordinate conversion ---------------- */

  /**
   * Screen (client) -> world. This is the inverse of the <g> transform
   * `translate(vx,vy) scale(k)` applied inside an SVG whose top-left is at
   * the host element's bounding rect. Getting this wrong makes every drag
   * drift under zoom, so it is the single source of truth: nothing else
   * in this file does its own math.
   */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const host = hostRef.current;
    const v = viewRef.current;
    if (!host) return { x: 0, y: 0 };
    const r = host.getBoundingClientRect();
    return {
      x: (clientX - r.left - v.x) / v.k,
      y: (clientY - r.top - v.y) / v.k,
    };
  }, []);

  /* ---------------- wheel: zoom + pan ---------------- */

  // Attached natively (not via React's onWheel) because React attaches wheel
  // listeners as passive at the root, and ctrl+wheel must be preventable to
  // stop the browser's own page zoom on trackpad pinch.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onWheel = (e: WheelEvent) => {
      const r = host.getBoundingClientRect();
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
          // Keep the world point under the cursor pinned to the cursor.
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

    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------------- space-to-pan ---------------- */

  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      );
    };

    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        // Only swallow the space if the canvas is what the user is looking at.
        if (
          hostRef.current?.contains(document.activeElement) ||
          document.activeElement === document.body
        ) {
          spaceRef.current = true;
          if (dragRef.current.mode === 'none') setCursor('grab');
          e.preventDefault();
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        if (dragRef.current.mode === 'none') setCursor('default');
      }
    };
    const blur = () => {
      spaceRef.current = false;
      if (dragRef.current.mode === 'none') setCursor('default');
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

  /* ---------------- delete selection ---------------- */

  const nodeIds = useMemo(
    () => new Set(topology.nodes.map((n) => n.id)),
    [topology.nodes],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!selectedId) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (nodeIds.has(selectedId)) onDeleteNode(selectedId);
      else onDeleteEdge(selectedId);
      onSelect(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, nodeIds, onDeleteNode, onDeleteEdge, onSelect]);

  /* ---------------- pointer handling ---------------- */

  const endDrag = useCallback(() => {
    dragRef.current = { mode: 'none' };
    hoverPortRef.current = null;
    setLinkPreview(null);
    setCursor(spaceRef.current ? 'grab' : 'default');
  }, []);

  const onBackgroundDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Only the primary button pans; ignore right/middle click.
      if (e.button !== 0) return;
      const v = viewRef.current;
      dragRef.current = {
        mode: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        vx: v.x,
        vy: v.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setCursor('grabbing');
      // A plain background click clears selection; a pan does not, but
      // clearing here and re-selecting on drag would flicker. Clear on up.
    },
    [],
  );

  const onNodeDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, id: string) => {
      if (e.button !== 0) return;
      // Space held = pan even over a node.
      if (spaceRef.current) return;
      e.stopPropagation();
      const node = topology.nodes.find((n) => n.id === id);
      if (!node) return;
      const w = toWorld(e.clientX, e.clientY);
      dragRef.current = {
        mode: 'node',
        id,
        dx: node.x - w.x,
        dy: node.y - w.y,
        moved: false,
      };
      onSelect(id);
      hostRef.current?.setPointerCapture(e.pointerId);
      setCursor('grabbing');
    },
    [topology.nodes, toWorld, onSelect],
  );

  const onPortDown = useCallback(
    (e: ReactPointerEvent<SVGCircleElement>, id: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragRef.current = { mode: 'link', from: id };
      hoverPortRef.current = null;
      const w = toWorld(e.clientX, e.clientY);
      setLinkPreview({ from: id, x: w.x, y: w.y });
      hostRef.current?.setPointerCapture(e.pointerId);
    },
    [toWorld],
  );

  const onPortEnter = useCallback((id: string) => {
    hoverPortRef.current = id;
  }, []);
  const onPortLeave = useCallback(() => {
    hoverPortRef.current = null;
  }, []);

  const onNudge = useCallback(
    (id: string, dx: number, dy: number) => {
      const n = topology.nodes.find((m) => m.id === id);
      if (!n) return;
      onMoveNode(id, snap(n.x + dx), snap(n.y + dy));
    },
    [topology.nodes, onMoveNode],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (d.mode === 'none') return;

      if (d.mode === 'pan') {
        setView((v) => ({
          ...v,
          x: d.vx + (e.clientX - d.startX),
          y: d.vy + (e.clientY - d.startY),
        }));
        return;
      }

      const w = toWorld(e.clientX, e.clientY);

      if (d.mode === 'node') {
        d.moved = true;
        onMoveNode(d.id, snap(w.x + d.dx), snap(w.y + d.dy));
        return;
      }

      if (d.mode === 'link') {
        setLinkPreview({ from: d.from, x: w.x, y: w.y });
      }
    },
    [toWorld, onMoveNode],
  );

  const existingEdge = useCallback(
    (from: string, to: string) =>
      topology.edges.some((ed) => ed.from === from && ed.to === to),
    [topology.edges],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;

      if (d.mode === 'pan') {
        // Treat a pan that never moved as a background click.
        const moved =
          Math.abs(e.clientX - d.startX) > 3 ||
          Math.abs(e.clientY - d.startY) > 3;
        if (!moved) onSelect(null);
      } else if (d.mode === 'link') {
        // Prefer the port the pointer is over; fall back to hit-testing the
        // node rect so dropping anywhere on the target node also connects.
        let target = hoverPortRef.current;
        if (!target) {
          const w = toWorld(e.clientX, e.clientY);
          const hit = topology.nodes.find(
            (n) =>
              w.x >= n.x &&
              w.x <= n.x + NODE_W &&
              w.y >= n.y &&
              w.y <= n.y + NODE_H,
          );
          target = hit ? hit.id : null;
        }
        if (target && target !== d.from && !existingEdge(d.from, target)) {
          onConnect(d.from, target);
        }
      }

      endDrag();
    },
    [onSelect, onConnect, endDrag, toWorld, topology.nodes, existingEdge],
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
    const host = hostRef.current;
    if (!host || topology.nodes.length === 0) return;
    const r = host.getBoundingClientRect();
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
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (dragRef.current.mode !== 'none') return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitToContent());
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitToContent]);

  const zoomBy = useCallback((factor: number) => {
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
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

  const previewFrom = linkPreview ? nodeById.get(linkPreview.from) : undefined;
  const previewPort = previewFrom ? outPort(previewFrom) : null;

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

  return (
    <div
      ref={hostRef}
      className={`cv-host${dropHint ? ' is-dropping' : ''}`}
      data-cursor={cursor}
      onPointerDown={onBackgroundDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="cv-grid" style={gridStyle} aria-hidden="true" />

      <svg ref={svgRef} className="cv-svg">
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
                  selected={selectedId === ed.id}
                  targetHealth={healthById.get(ed.to) ?? 'ok'}
                  showLabel={showEdgeLabels}
                  onSelect={onSelect}
                  onDeleteEdge={onDeleteEdge}
                />
              );
            })}
          </g>

          {previewPort && linkPreview && (
            <path
              className="cv-link-preview"
              d={edgePath(
                previewPort.x,
                previewPort.y,
                linkPreview.x,
                linkPreview.y,
              )}
            />
          )}

          <g className="cv-nodes">
            {topology.nodes.map((n) => (
              <NodeView
                key={n.id}
                node={n}
                stats={snapshot?.nodes[n.id] ?? null}
                spark={spark?.get(n.id)}
                selected={selectedId === n.id}
                detail={detail}
                linking={linkPreview !== null}
                onSelect={onSelect}
                onNodeDown={onNodeDown}
                onPortDown={onPortDown}
                onPortEnter={onPortEnter}
                onPortLeave={onPortLeave}
                onNudge={onNudge}
              />
            ))}
          </g>
        </g>
      </svg>

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

      <div className="cv-zoom">
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
