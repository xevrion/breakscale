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
import { FILLED_GLYPHS, GLYPH, NODE_DND_MIME } from './nodeVisuals';
import './Canvas.css';

/* ------------------------------------------------------------------ *
 * Geometry constants. Preset coordinates treat x/y as the node's
 * top-left corner, spaced ~200-320px apart horizontally.
 * ------------------------------------------------------------------ */

export const NODE_W = 168;
export const NODE_H = 60;
const GRID = 8;
const PORT_R = 5;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
/** Below this zoom the live numbers are dropped so labels stay readable. */
const DETAIL_ZOOM = 0.7;

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

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
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

const inPort = (n: SimNode) => ({ x: n.x, y: n.y + NODE_H / 2 });
const outPort = (n: SimNode) => ({ x: n.x + NODE_W, y: n.y + NODE_H / 2 });

/** Health band for a utilization in 0..1. */
function healthOf(u: number): 'ok' | 'warn' | 'danger' {
  if (u >= 0.9) return 'danger';
  if (u >= 0.7) return 'warn';
  return 'ok';
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  if (ms >= 100) return `${Math.round(ms)}`;
  return ms >= 10 ? ms.toFixed(0) : ms.toFixed(1);
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function fmtRate(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `${Math.round(n)}`;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

/**
 * The two numbers that matter most for each kind, plus the value that
 * drives the health bar. Queue nodes are about backlog, not utilization;
 * caches are about hit rate; everything else is utilization + p99.
 */
interface Readout {
  a: { label: string; value: string };
  b: { label: string; value: string };
  /** 0..1, drives the health bar width and color. */
  load: number;
}

function readoutFor(kind: NodeKind, s: NodeStats): Readout {
  const util = clamp(s.utilization, 0, 1);
  switch (kind) {
    case 'client':
      return {
        a: { label: 'rps', value: fmtRate(s.throughput) },
        b: { label: 'p99', value: fmtMs(s.p99) },
        load: clamp(s.errorRate, 0, 1),
      };
    case 'queue': {
      const depth = s.queued + s.inFlight;
      return {
        a: { label: 'depth', value: fmtCount(depth) },
        b: { label: 'in/s', value: fmtRate(s.arrivalRate) },
        // Backlog health: a queue is fine empty, alarming when it is filling.
        load: clamp(depth / 500, 0, 1),
      };
    }
    case 'cache':
      return {
        a: { label: 'hit', value: `${Math.round(s.hitRate * 100)}%` },
        b: { label: 'p99', value: fmtMs(s.p99) },
        load: util,
      };
    default:
      return {
        a: { label: 'util', value: `${Math.round(util * 100)}%` },
        b: { label: 'p99', value: fmtMs(s.p99) },
        load: util,
      };
  }
}


const KIND_NAME: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
};

const Glyph = memo(function Glyph({ kind }: { kind: NodeKind }) {
  const filled = FILLED_GLYPHS.has(kind);
  return (
    <path
      d={GLYPH[kind]}
      className="cv-glyph"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
});

/* ------------------------------------------------------------------ *
 * Edge path: horizontal-tangent cubic bezier between two ports.
 * ------------------------------------------------------------------ */

function edgePath(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): string {
  const dx = bx - ax;
  // Bow out enough to read as a curve even when the nodes are stacked
  // vertically or the target sits behind the source.
  const bow = Math.max(40, Math.min(180, Math.abs(dx) * 0.5));
  const c1 = ax + bow;
  const c2 = bx - bow;
  return `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`;
}

/** Where the arrowhead sits: just short of the target port. */
const ARROW_INSET = 9;

/* ------------------------------------------------------------------ *
 * Edge
 * ------------------------------------------------------------------ */

interface EdgeViewProps {
  edge: SimEdge;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  flow: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
}

const EdgeView = memo(function EdgeView({
  edge,
  ax,
  ay,
  bx,
  by,
  flow,
  selected,
  onSelect,
}: EdgeViewProps) {
  // Pull the endpoint back so the stroke does not poke through the arrowhead.
  const angle = Math.atan2(by - ay, bx - ax);
  const tipX = bx - Math.cos(angle) * 2;
  const tipY = by - Math.sin(angle) * 2;
  const d = edgePath(ax, ay, tipX - Math.cos(angle) * ARROW_INSET, tipY - Math.sin(angle) * ARROW_INSET);

  // Thickness grows gently: log-ish so 10rps and 1000rps stay in the same
  // visual family instead of one edge becoming a slab.
  const width = flow > 0 ? clamp(1.25 + Math.log10(1 + flow) * 0.7, 1.25, 4) : 1.25;

  // Dash animation period: faster flow = shorter period. One dash cycle is
  // 12 user units, so duration = 12 / speed. Clamped so it never strobes.
  const active = flow > 0.05;
  const period = active
    ? clamp(3.2 / Math.log10(10 + flow), 0.35, 2.4)
    : 0;

  const style = active
    ? ({ animationDuration: `${period}s` } as CSSProperties)
    : undefined;

  const handleDown = useCallback(
    (e: ReactPointerEvent<SVGPathElement>) => {
      e.stopPropagation();
      onSelect(edge.id);
    },
    [edge.id, onSelect],
  );

  return (
    <g
      className={`cv-edge${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
    >
      {/* Fat invisible hit area — a 1.25px line is impossible to click. */}
      <path d={d} className="cv-edge-hit" onPointerDown={handleDown} />
      <path d={d} className="cv-edge-line" strokeWidth={width} />
      {active && (
        <path
          d={d}
          className="cv-edge-flow"
          strokeWidth={width}
          style={style}
        />
      )}
      <path
        d={`M${tipX},${tipY} L${tipX - Math.cos(angle - 0.42) * 9},${tipY - Math.sin(angle - 0.42) * 9} L${tipX - Math.cos(angle + 0.42) * 9},${tipY - Math.sin(angle + 0.42) * 9} Z`}
        className="cv-edge-arrow"
      />
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Node
 * ------------------------------------------------------------------ */

interface NodeViewProps {
  node: SimNode;
  stats: NodeStats | null;
  selected: boolean;
  showDetail: boolean;
  linking: boolean;
  onSelect: (id: string | null) => void;
  onNodeDown: (e: ReactPointerEvent<SVGGElement>, id: string) => void;
  onPortDown: (e: ReactPointerEvent<SVGCircleElement>, id: string) => void;
  onPortEnter: (id: string) => void;
  onPortLeave: () => void;
}

const NodeView = memo(function NodeView({
  node,
  stats,
  selected,
  showDetail,
  linking,
  onSelect,
  onNodeDown,
  onPortDown,
  onPortEnter,
  onPortLeave,
}: NodeViewProps) {
  const readout = stats ? readoutFor(node.kind, stats) : null;
  const health = readout ? healthOf(readout.load) : 'ok';

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
      }
    },
    [node.id, onSelect],
  );

  const barW = readout ? clamp(readout.load, 0, 1) * (NODE_W - 24) : 0;

  return (
    <g
      className={`cv-node is-${health}${selected ? ' is-selected' : ''}`}
      transform={`translate(${node.x},${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={`${KIND_NAME[node.kind]} ${node.label}`}
      aria-pressed={selected}
      onPointerDown={handleDown}
      onKeyDown={handleKey}
    >
      <rect
        className="cv-node-body"
        width={NODE_W}
        height={NODE_H}
        rx={7}
        ry={7}
      />

      <g className="cv-node-icon" transform="translate(12,10)">
        <Glyph kind={node.kind} />
      </g>

      <text className="cv-node-label" x={36} y={22}>
        {node.label}
      </text>

      {showDetail && readout ? (
        <text className="cv-node-nums" x={36} y={38}>
          <tspan className="cv-num">{readout.a.value}</tspan>
          <tspan className="cv-unit" dx={3}>
            {readout.a.label}
          </tspan>
          <tspan className="cv-num" dx={10}>
            {readout.b.value}
          </tspan>
          <tspan className="cv-unit" dx={3}>
            {readout.b.label}
          </tspan>
        </text>
      ) : (
        <text className="cv-node-kind" x={36} y={38}>
          {KIND_NAME[node.kind]}
        </text>
      )}

      {/* Health bar. The only strong color at rest. */}
      <rect
        className="cv-bar-track"
        x={12}
        y={NODE_H - 9}
        width={NODE_W - 24}
        height={3}
        rx={1.5}
      />
      {readout && barW > 0 && (
        <rect
          className="cv-bar-fill"
          x={12}
          y={NODE_H - 9}
          width={barW}
          height={3}
          rx={1.5}
        />
      )}

      {/* Ports. Input on the left, output on the right. */}
      <circle
        className="cv-port cv-port-in"
        cx={0}
        cy={NODE_H / 2}
        r={PORT_R}
        onPointerEnter={linking ? handlePortEnter : undefined}
        onPointerLeave={linking ? onPortLeave : undefined}
      />
      <circle
        className="cv-port cv-port-out"
        cx={NODE_W}
        cy={NODE_H / 2}
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
          const k = clamp(v.k * Math.exp(-e.deltaY * 0.0022), MIN_ZOOM, MAX_ZOOM);
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
        if (hostRef.current?.contains(document.activeElement) ||
            document.activeElement === document.body) {
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

  /* ---------------- initial fit ---------------- */

  const fittedRef = useRef(false);
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
    const pad = 72;
    const k = clamp(
      Math.min(
        (r.width - pad * 2) / Math.max(1, maxX - minX),
        (r.height - pad * 2) / Math.max(1, maxY - minY),
      ),
      MIN_ZOOM,
      1.15,
    );
    setView({
      k,
      x: (r.width - (maxX - minX) * k) / 2 - minX * k,
      y: (r.height - (maxY - minY) * k) / 2 - minY * k,
    });
  }, [topology.nodes]);

  useLayoutEffect(() => {
    if (fittedRef.current) return;
    if (topology.nodes.length === 0) return;
    fittedRef.current = true;
    fitToContent();
  }, [topology.nodes.length, fitToContent]);

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

  const showDetail = view.k >= DETAIL_ZOOM;

  const previewFrom = linkPreview ? nodeById.get(linkPreview.from) : undefined;
  const previewPort = previewFrom ? outPort(previewFrom) : null;

  const gridStyle: CSSProperties = {
    backgroundSize: `${GRID * 3 * view.k}px ${GRID * 3 * view.k}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
  };

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
                  onSelect={onSelect}
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
                selected={selectedId === n.id}
                showDetail={showDetail}
                linking={linkPreview !== null}
                onSelect={onSelect}
                onNodeDown={onNodeDown}
                onPortDown={onPortDown}
                onPortEnter={onPortEnter}
                onPortLeave={onPortLeave}
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

      <div className="cv-zoom">
        <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
          &minus;
        </button>
        <button type="button" className="cv-zoom-level" onClick={fitToContent}>
          {Math.round(view.k * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          +
        </button>
      </div>
    </div>
  );
}
