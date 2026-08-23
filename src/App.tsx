import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeConfig, NodeKind, SimSnapshot, Topology } from './sim/types';
import { Engine } from './sim/engine';
import { PRESETS, makeNode } from './sim/presets';
import type { Preset } from './sim/presets';
import Canvas from './components/Canvas';
import { Inspector, TrafficControl } from './components/Inspector';
import { Metrics } from './components/Metrics';
import { Palette } from './components/Palette';
import './App.css';

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'sys-sim.session.v1';

/** Snapshot rate for React. The engine still advances every animation frame. */
const SNAPSHOT_HZ = 10;
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

/**
 * Largest frame delta we hand the engine. A backgrounded tab produces one
 * enormous delta on return; without this the sim would try to catch up on
 * minutes of simulated time in a single frame.
 */
const MAX_FRAME_MS = 100;

interface Session {
  topology: Topology;
  rps: number;
  presetId: string | null;
}

const NODE_KINDS: readonly NodeKind[] = [
  'client',
  'lb',
  'service',
  'cache',
  'db',
  'queue',
  'worker',
];

/**
 * Structural validation of anything coming out of localStorage. A stored
 * value can be stale from an older build or hand-edited, so every field the
 * engine will dereference is checked before it is trusted.
 */
function isTopology(value: unknown): value is Topology {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(t.nodes) || !Array.isArray(t.edges)) return false;

  const ids = new Set<string>();
  for (const raw of t.nodes) {
    if (typeof raw !== 'object' || raw === null) return false;
    const n = raw as Partial<{
      id: unknown;
      kind: unknown;
      label: unknown;
      x: unknown;
      y: unknown;
      config: unknown;
    }>;
    if (typeof n.id !== 'string' || n.id === '') return false;
    if (typeof n.label !== 'string') return false;
    if (!NODE_KINDS.includes(n.kind as NodeKind)) return false;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
    if (typeof n.config !== 'object' || n.config === null) return false;
    const cfg = n.config as Record<string, unknown>;
    for (const key of [
      'capacity',
      'serviceMs',
      'serviceCv',
      'queueLimit',
      'hitRate',
      'errorRate',
      'timeoutMs',
      'retries',
      'rps',
    ]) {
      if (!Number.isFinite(cfg[key])) return false;
    }
    if (ids.has(n.id)) return false;
    ids.add(n.id);
  }

  for (const raw of t.edges) {
    if (typeof raw !== 'object' || raw === null) return false;
    const e = raw as Partial<{ id: unknown; from: unknown; to: unknown; weight: unknown }>;
    if (typeof e.id !== 'string' || e.id === '') return false;
    if (typeof e.from !== 'string' || typeof e.to !== 'string') return false;
    // A dangling edge would make the engine route into nothing.
    if (!ids.has(e.from) || !ids.has(e.to)) return false;
    if (!Number.isFinite(e.weight)) return false;
  }

  return true;
}

function loadSession(): Session {
  const fallback: Session = {
    topology: PRESETS[0]!.topology,
    rps: clientRps(PRESETS[0]!.topology),
    presetId: PRESETS[0]!.id,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const s = parsed as Partial<Session>;
    if (!isTopology(s.topology)) return fallback;
    const rps = Number.isFinite(s.rps) ? (s.rps as number) : clientRps(s.topology);
    return {
      topology: s.topology,
      rps: Math.min(5000, Math.max(0, rps)),
      presetId: typeof s.presetId === 'string' ? s.presetId : null,
    };
  } catch {
    // Corrupt JSON, blocked storage (private mode, disabled cookies) — any
    // failure here falls back to the first preset rather than breaking boot.
    return fallback;
  }
}

function saveSession(session: Session): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded or storage unavailable. Persistence is a convenience,
    // never a correctness requirement, so this is silent by design.
  }
}

/** The client node is the traffic source; its rps is the load slider's value. */
function findClient(t: Topology) {
  return t.nodes.find((n) => n.kind === 'client') ?? null;
}

function clientRps(t: Topology): number {
  return findClient(t)?.config.rps ?? 0;
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export default function App() {
  // Read storage once, before the first paint, so the app never flashes a
  // preset and then swaps to the restored session.
  const [initial] = useState(loadSession);

  const [topology, setTopology] = useState<Topology>(initial.topology);
  const [rps, setRps] = useState<number>(initial.rps);
  const [presetId, setPresetId] = useState<string | null>(initial.presetId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(true);

  /**
   * The engine is a mutable simulation owned outside React's render cycle.
   * Held in state with a lazy initializer rather than a ref written during
   * render: the instance must exist for the very first render (so a snapshot
   * is available immediately), and this keeps the render phase pure. The
   * value is never replaced, so it behaves as a stable instance —
   * StrictMode's double render reuses the same engine.
   */
  const [engine] = useState(() => new Engine(initial.topology));

  /**
   * Seeded from the engine's initial state rather than set by an effect, so
   * the very first paint already shows the loaded system instead of an empty
   * canvas followed by a second render.
   */
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(() =>
    engine.snapshot(),
  );

  /**
   * Live mirrors of the play/pause state. The rAF loop is started once and
   * reads these on each frame, so toggling pause never tears down and
   * rebuilds the loop (which would drop the accumulated frame timing).
   */
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  /* ---------------- the simulation loop ---------------- */

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let sinceSnapshot = 0;
    let cancelled = false;

    const frame = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(frame);

      const dt = now - last;
      last = now;

      if (!runningRef.current) return;

      // Clamp so a long tab-away does not replay minutes of simulated time.
      engine.advance(Math.min(dt, MAX_FRAME_MS));

      // React re-renders at ~10Hz, not once per frame. The engine keeps
      // full temporal resolution regardless.
      sinceSnapshot += dt;
      if (sinceSnapshot >= SNAPSHOT_INTERVAL_MS) {
        sinceSnapshot = 0;
        setSnapshot(engine.snapshot());
      }
    };

    raf = requestAnimationFrame(frame);

    return () => {
      // StrictMode double-invokes this effect in development. `cancelled`
      // guarantees the frame scheduled by the discarded run cannot queue a
      // successor after its cleanup, so only one loop is ever live.
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [engine]);

  /* ---------------- persistence ---------------- */

  useEffect(() => {
    // Debounced: dragging a node or a slider must not write on every frame.
    const id = window.setTimeout(() => {
      saveSession({ topology, rps, presetId });
    }, 400);
    return () => window.clearTimeout(id);
  }, [topology, rps, presetId]);

  /* ---------------- structural edits ---------------- */

  /**
   * Structural changes (add/remove nodes or edges, moves) must be pushed
   * into the engine wholesale. The engine preserves per-node state for ids
   * it already knows, so editing the graph does not disturb in-flight work.
   */
  const applyTopology = useCallback(
    (next: Topology) => {
      setTopology(next);
      engine.setTopology(next);
      setPresetId(null);
    },
    [engine],
  );

  const handleMoveNode = useCallback((id: string, x: number, y: number) => {
    // Position is presentation only — the engine does not care, so this
    // skips setTopology and avoids clearing the active preset badge.
    setTopology((t) => ({
      ...t,
      nodes: t.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
    }));
  }, []);

  const handleAddNode = useCallback(
    (kind: NodeKind, x: number, y: number) => {
      const node = makeNode(kind, x, y);
      applyTopology({
        ...topology,
        nodes: [...topology.nodes, node],
      });
      setSelectedId(node.id);
    },
    [applyTopology, topology],
  );

  /** Palette click (no drop point): place into open space near the middle. */
  const handlePaletteAdd = useCallback(
    (kind: NodeKind) => {
      const maxX = topology.nodes.reduce((m, n) => Math.max(m, n.x), 0);
      handleAddNode(kind, maxX + 220, 200);
    },
    [handleAddNode, topology.nodes],
  );

  const handleConnect = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const id = `${fromId}->${toId}`;
      if (topology.edges.some((e) => e.id === id)) return;
      applyTopology({
        ...topology,
        edges: [...topology.edges, { id, from: fromId, to: toId, weight: 1 }],
      });
    },
    [applyTopology, topology],
  );

  const handleDeleteNode = useCallback(
    (id: string) => {
      applyTopology({
        nodes: topology.nodes.filter((n) => n.id !== id),
        // Drop edges that would otherwise dangle.
        edges: topology.edges.filter((e) => e.from !== id && e.to !== id),
      });
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [applyTopology, topology],
  );

  const handleDeleteEdge = useCallback(
    (id: string) => {
      applyTopology({
        ...topology,
        edges: topology.edges.filter((e) => e.id !== id),
      });
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [applyTopology, topology],
  );

  /* ---------------- live config edits ---------------- */

  /**
   * Knob changes are applied to the running engine in place. No reset: the
   * whole point is watching the system respond to a change under load.
   */
  const handleConfigChange = useCallback(
    (id: string, patch: Partial<NodeConfig>) => {
      engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
        ),
      }));
      // The load slider and the client's rps knob are the same value.
      if (patch.rps !== undefined) setRps(patch.rps);
    },
    [engine],
  );

  const handleRename = useCallback((id: string, label: string) => {
    setTopology((t) => ({
      ...t,
      nodes: t.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
    }));
  }, []);

  /** The top-bar slider writes straight through to the client node. */
  const handleRpsChange = useCallback(
    (next: number) => {
      setRps(next);
      const client = findClient(topology);
      if (client) handleConfigChange(client.id, { rps: next });
    },
    [handleConfigChange, topology],
  );

  /* ---------------- presets & reset ---------------- */

  const handleLoadPreset = useCallback(
    (preset: Preset) => {
      // Deep copy: presets are module-level constants and must never be
      // mutated by editing the loaded system.
      const fresh = structuredClone(preset.topology);
      setTopology(fresh);
      setRps(clientRps(fresh));
      setPresetId(preset.id);
      setSelectedId(null);
      engine.setTopology(fresh);
      engine.reset();
      setSnapshot(engine.snapshot());
    },
    [engine],
  );

  const handleReset = useCallback(() => {
    engine.reset();
    setSnapshot(engine.snapshot());
  }, [engine]);

  const handleToggleRun = useCallback(() => setRunning((r) => !r), []);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never steal keys from a field the user is typing into.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => !r);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        setSelectedId((cur) => {
          if (cur === null) return cur;
          // Selection ids are shared between nodes and edges; an edge id is
          // never also a node id, so this dispatch is unambiguous.
          if (topology.nodes.some((n) => n.id === cur)) {
            handleDeleteNode(cur);
          } else if (topology.edges.some((edge) => edge.id === cur)) {
            handleDeleteEdge(cur);
          }
          return null;
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDeleteNode, handleDeleteEdge, topology.nodes, topology.edges]);

  /* ---------------- derived ---------------- */

  const selectedNode = useMemo(
    () => topology.nodes.find((n) => n.id === selectedId) ?? null,
    [topology.nodes, selectedId],
  );

  const selectedStats =
    selectedNode && snapshot ? (snapshot.nodes[selectedNode.id] ?? null) : null;

  return (
    <div className="app">
      <header className="app-bar">
        <h1 className="app-title">System Design Simulator</h1>
        <TrafficControl
          rps={rps}
          onRpsChange={handleRpsChange}
          running={running}
          onToggleRun={handleToggleRun}
          onReset={handleReset}
          system={snapshot?.system ?? EMPTY_SYSTEM}
        />
      </header>

      <div className="app-body">
        <Palette
          onAdd={handlePaletteAdd}
          presets={PRESETS}
          activePresetId={presetId}
          onLoadPreset={handleLoadPreset}
        />

        <main className="app-stage">
          <Canvas
            topology={topology}
            snapshot={snapshot}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMoveNode={handleMoveNode}
            onConnect={handleConnect}
            onDeleteNode={handleDeleteNode}
            onDeleteEdge={handleDeleteEdge}
            onDropNode={handleAddNode}
          />
          {snapshot ? <Metrics snapshot={snapshot} /> : null}
        </main>

        <Inspector
          node={selectedNode}
          stats={selectedStats}
          onChange={handleConfigChange}
          onDelete={handleDeleteNode}
          onRename={handleRename}
        />
      </div>
    </div>
  );
}

/** Shown for the single frame before the first snapshot exists. */
const EMPTY_SYSTEM = {
  timeMs: 0,
  offeredRps: 0,
  goodputRps: 0,
  errorRate: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  totalRequests: 0,
  totalFailed: 0,
};
