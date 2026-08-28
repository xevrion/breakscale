import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeConfig, NodeKind, SimNode, SimSnapshot, Topology } from './sim/types';
import { Engine } from './sim/engine';
import { PRESETS, makeNode } from './sim/presets';
import type { Preset } from './sim/presets';
import Canvas, { SPARK_LEN, readoutFor, sourceBacklogs } from './components/Canvas';
import { Inspector, TrafficControl } from './components/Inspector';
import { Metrics } from './components/Metrics';
import { Palette } from './components/Palette';
import { Glossary } from './components/Glossary';
import { TooltipLayer, setGlossaryNavigate } from './components/Tooltip';
import { togglePreference, usePreference } from './content/preferences';
import './App.css';

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'breakscale.session.v1';

/* ------------------------------------------------------------------ *
 * Layout persistence
 *
 * Which panels are open is kept separate from the session: clearing a
 * topology should never reset a student's layout, and vice versa.
 *
 * The inspector is deliberately NOT in here. It is selection-driven (see
 * the inspector state in App), and persisting "hidden" would mean a
 * student who dismissed it once could select nodes forever after and
 * never see their settings again, with nothing on screen to explain why.
 * ------------------------------------------------------------------ */

const LAYOUT_KEY = 'breakscale.layout.v1';

interface LayoutPrefs {
  /** The left component rail. */
  library: boolean;
  /** The bottom charts strip. */
  metrics: boolean;
}

/**
 * First run: the rail is open because it is the app's verbs — components
 * to add and examples to load — and a canvas with no visible way to act
 * on it is a dead end. The charts start closed: the top bar already
 * carries p99, goodput, errors and dropped, so the strip is depth to be
 * opened when a headline number needs explaining, not a fixture.
 */
const DEFAULT_LAYOUT: LayoutPrefs = { library: true, metrics: false };

function loadLayout(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;
    const p = parsed as Partial<LayoutPrefs>;
    return {
      library: typeof p.library === 'boolean' ? p.library : DEFAULT_LAYOUT.library,
      metrics: typeof p.metrics === 'boolean' ? p.metrics : DEFAULT_LAYOUT.metrics,
    };
  } catch {
    // Blocked or corrupt storage: the default layout, never a crash.
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(layout: LayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Persistence is a convenience; losing it must stay invisible.
  }
}

/**
 * One shape for the three panel-toggle glyphs: a frame with the edge that
 * panel lives on marked. The icon states position, the accessible name and
 * `title` state content, so together the button says "the thing over here".
 */
function PanelGlyph({ edge }: { edge: 'left' | 'right' | 'bottom' }) {
  const d = edge === 'left' ? 'M9 4v16' : edge === 'right' ? 'M15 4v16' : 'M4 14h16';
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d={d} />
    </svg>
  );
}

/** Snapshot rate for React. The engine still advances every animation frame. */
const SNAPSHOT_HZ = 10;
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

/**
 * Largest frame delta we hand the engine. A backgrounded tab produces one
 * enormous delta on return; without this the sim would try to catch up on
 * minutes of simulated time in a single frame.
 */
const MAX_FRAME_MS = 100;

/**
 * One press of Step advances this much simulated time. The engine exposes no
 * step() of its own — only advance(dt) — so a step is simply one manual frame
 * at a size big enough to visibly move the state.
 */
const STEP_MS = 100;

/**
 * Sparkline cadence. 1Hz x 60 samples = the same 60s window the charts show.
 * The engine emits history every 250ms; sampling at 1Hz keeps the node
 * sparkline and the metrics charts describing the same span of time.
 */
const SPARK_INTERVAL_MS = 1000;

/*
 * The series each node kind's sparkline plots is `readoutFor(...).spark`:
 * the SAME per-kind primary metric the canvas headlines, taken from the same
 * function, so the trend line under a number is a trend line OF that number.
 * A local per-kind switch lived here before and had already drifted from the
 * canvas's choices for most kinds (everything defaulted to utilisation,
 * which is hardwired 0 for every gate and controller kind).
 */

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
  'replica',
  'shard',
  'autoscaler',
  'region',
  // This list gates what loads back out of localStorage, so every kind the
  // registry knows must appear here or a student's saved topology that uses
  // it is silently thrown away on reload. The three edge kinds below were
  // missing since they shipped; the rest arrived with their tiers.
  'cdn',
  'ratelimiter',
  'breaker',
  'objectstore',
  'searchindex',
  'timeseriesdb',
  'graphdb',
  'coldstorage',
  'vectordb',
  'streambroker',
  'pubsub',
  'websocket',
  'apigateway',
  'sidecar',
  'lambda',
  'cron',
  'bulkhead',
  'retryqueue',
  'transcoder',
  'edgecompute',
  'writebehind',
  'loadshedder',
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
    const e = raw as Partial<{
      id: unknown;
      from: unknown;
      to: unknown;
      weight: unknown;
    }>;
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
  /**
   * Canvas selection. Node ids and edge ids share this one set; an edge id is
   * `from->to`, which can never collide with a node id, so the namespace is
   * unambiguous and a single set covers both.
   *
   * The Inspector still edits exactly one node, so `selectedNode` below
   * resolves the set down to a single node — a multi-selection simply shows
   * the empty inspector rather than an arbitrary member.
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [running, setRunning] = useState(true);

  /**
   * The glossary side sheet.
   *
   * `glossaryFocusId` is the entry to land on. It is cleared when the sheet
   * closes so that reopening from the top bar starts at the top of the list
   * rather than resuming wherever the last "see also" link happened to go.
   */
  const tooltipsOn = usePreference('tooltips');
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryFocusId, setGlossaryFocusId] = useState<string | undefined>(undefined);

  /* ---------------- panel layout ---------------- */

  const [layout, setLayout] = useState<LayoutPrefs>(loadLayout);

  const toggleLibrary = useCallback(
    () => setLayout((l) => ({ ...l, library: !l.library })),
    [],
  );
  const toggleMetrics = useCallback(
    () => setLayout((l) => ({ ...l, metrics: !l.metrics })),
    [],
  );

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  /**
   * The inspector is selection-driven, the way Excalidraw's properties
   * panel is: nothing selected means nothing to configure, so the panel is
   * simply absent and the canvas has the width. `inspectorHidden` is the
   * manual override on top of that — pressing I (or the floating toggle)
   * dismisses the panel for the CURRENT selection, and the effect below
   * clears the override on the next selection gesture. That gives "get
   * this out of my way while I look" without creating a mode a student
   * has to remember: selecting something is always enough to bring the
   * settings back. Deliberately not persisted, for the same reason.
   */
  const [inspectorHidden, setInspectorHidden] = useState(false);

  useEffect(() => {
    if (selectedIds.size > 0) setInspectorHidden(false);
  }, [selectedIds]);

  const toggleInspector = useCallback(() => setInspectorHidden((h) => !h), []);

  const hasSelection = selectedIds.size > 0;
  const inspectorVisible = hasSelection && !inspectorHidden;

  const openGlossary = useCallback((id?: string) => {
    setGlossaryFocusId(id);
    setGlossaryOpen(true);
  }, []);

  const closeGlossary = useCallback(() => {
    setGlossaryOpen(false);
    setGlossaryFocusId(undefined);
  }, []);

  /**
   * Where a tooltip's "see also" links go.
   *
   * Registered once with the tooltip module rather than threaded down as a
   * prop, which is what lets <Term> stay a props-free wrapper at every one of
   * its call sites. Unregistered on unmount so a stale closure can never
   * outlive this shell.
   */
  useEffect(() => {
    setGlossaryNavigate(openGlossary);
    return () => setGlossaryNavigate(null);
  }, [openGlossary]);

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
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(() => engine.snapshot());

  /**
   * Live mirrors of the play/pause state. The rAF loop is started once and
   * reads these on each frame, so toggling pause never tears down and
   * rebuilds the loop (which would drop the accumulated frame timing).
   */
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  /* ---------------- per-node sparkline history ----------------
   *
   * `SimSnapshot.history` is system-wide — `HistoryPoint` carries no node id —
   * so there is no per-node series in the engine to draw, and src/sim is not
   * ours to change. The ring buffer therefore lives here.
   *
   * Sampled when the engine's own clock crosses a 1000ms boundary rather than
   * on a wall-clock timer, so the trace stays correct while paused, while
   * single-stepping, and after a tab-away. 60 samples at 1Hz is the same 60s
   * window the charts below the canvas show.
   */
  const sparkRef = useRef(new Map<string, Float32Array>());
  const sparkTickRef = useRef(-1);
  const [spark, setSpark] = useState<ReadonlyMap<string, Float32Array>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!snapshot) return;
    const tick = Math.floor(snapshot.system.timeMs / SPARK_INTERVAL_MS);
    if (tick === sparkTickRef.current) return;
    // A reset moves the clock backwards; drop the stale trace rather than
    // splicing new samples onto the tail of the previous run.
    const rewound = tick < sparkTickRef.current;
    sparkTickRef.current = tick;

    const prev = sparkRef.current;
    const next = new Map<string, Float32Array>();
    // Pull-based consumers headline the backlog of the buffers feeding them.
    const backlogs = sourceBacklogs(topology, snapshot.nodes);

    for (const n of topology.nodes) {
      const s = snapshot.nodes[n.id];
      const old = rewound ? undefined : prev.get(n.id);
      // NaN, not 0, marks "not yet sampled". A zero-filled buffer made a
      // young trace draw a long false flat line along the baseline and then
      // jump vertically to the first real sample, which read as a broken
      // axis rather than as data. Spark skips non-finite slots entirely.
      const buf = new Float32Array(SPARK_LEN).fill(Number.NaN);
      if (old) buf.set(old.subarray(1));
      buf[SPARK_LEN - 1] = s
        ? readoutFor(n.kind, s, n.config, backlogs.get(n.id) ?? 0).spark
        : 0;
      next.set(n.id, buf);
    }

    // Entries for removed nodes are dropped by virtue of rebuilding from the
    // current topology, so the map cannot leak across preset loads.
    sparkRef.current = next;
    setSpark(next);
  }, [snapshot, topology.nodes]);

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
      setSelectedIds(new Set([node.id]));
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

  /**
   * Delete a whole selection in ONE topology edit.
   *
   * Deleting N items with N sequential single-item calls is a bug waiting to
   * happen: each call closes over the topology as it was at render time, so
   * the second delete would resurrect what the first removed. Partitioning
   * up front and filtering once is both correct and cheaper.
   */
  const handleDeleteSelection = useCallback(
    (nodeIds: readonly string[], edgeIds: readonly string[]) => {
      if (nodeIds.length === 0 && edgeIds.length === 0) return;
      const dropNodes = new Set(nodeIds);
      const dropEdges = new Set(edgeIds);
      applyTopology({
        nodes: topology.nodes.filter((n) => !dropNodes.has(n.id)),
        edges: topology.edges.filter(
          (e) =>
            // Explicitly deleted, or orphaned by a node that just went away.
            !dropEdges.has(e.id) && !dropNodes.has(e.from) && !dropNodes.has(e.to),
        ),
      });
      setSelectedIds((cur) => {
        if (cur.size === 0) return cur;
        const next = new Set(cur);
        for (const id of dropNodes) next.delete(id);
        for (const id of dropEdges) next.delete(id);
        return next;
      });
    },
    [applyTopology, topology],
  );

  /** The Inspector's single-node delete routes through the same path. */
  const handleDeleteNode = useCallback(
    (id: string) => handleDeleteSelection([id], []),
    [handleDeleteSelection],
  );

  /**
   * Delete every node in a multi-selection. Routes through the same single
   * topology edit as everything else, so orphaned edges go with it.
   */
  const handleDeleteMany = useCallback(
    (ids: readonly string[]) => handleDeleteSelection(ids, []),
    [handleDeleteSelection],
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

  /**
   * Apply ONE patch to MANY nodes. Deliberately not a loop over
   * handleConfigChange: each call would close over the topology as it was at
   * render time, so the second write would resurrect the first node's old
   * config. The engine is told node-by-node (its API is per-node and applies
   * in place, so that part is safe to iterate), but React state is rebuilt in
   * a single pass over one `Set`.
   */
  const handleConfigChangeMany = useCallback(
    (ids: readonly string[], patch: Partial<NodeConfig>) => {
      if (ids.length === 0) return;
      const targets = new Set(ids);
      for (const id of targets) engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          targets.has(n.id) ? { ...n, config: { ...n.config, ...patch } } : n,
        ),
      }));
      // If the traffic source was in the selection, the load slider must
      // follow it — the bar and the client's rps knob are one value.
      if (patch.rps !== undefined) {
        const client = findClient(topology);
        if (client && targets.has(client.id)) setRps(patch.rps);
      }
    },
    [engine, topology],
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
      setSelectedIds(new Set<string>());
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

  /**
   * Advance one fixed tick with the loop stopped. Stepping while running
   * would race the rAF loop and make the delta non-deterministic, so a step
   * always pauses first — the same contract a debugger's step button has.
   */
  const handleStep = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    engine.advance(STEP_MS);
    setSnapshot(engine.snapshot());
  }, [engine]);

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

      // Step one tick. Ignored with a modifier held so it cannot shadow
      // browser shortcuts like Cmd/Ctrl+S.
      if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleStep();
        return;
      }

      /*
       * The glossary. `?` is the long-standing convention for "show me the
       * reference", and it collides with nothing here: Space is play/pause,
       * S steps, Delete and Escape belong to the canvas. It is also inert
       * inside a text field by the guard at the top of this handler, which
       * matters because `?` is an ordinary character a student may well type
       * into the node-name box or the glossary's own search.
       *
       * Matched on e.key rather than a code plus Shift, so it works on the
       * keyboard layouts where `?` is not Shift+/ at all.
       *
       * It TOGGLES. A student who opened the panel with a key expects the
       * same key to shut it, and hunting for the close button after that is
       * exactly the small friction this whole feature exists to remove.
       */
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (glossaryOpen) closeGlossary();
        else openGlossary();
        return;
      }

      /*
       * Panel toggles. Single letters, like S above, and inert inside a
       * text field by the same guard: C for the components rail, M for the
       * metrics strip, I for the inspector. All three ignore held
       * modifiers so they can never shadow Cmd/Ctrl+C, Cmd/Ctrl+M or
       * Cmd/Ctrl+I in the browser.
       *
       * I is a no-op with nothing selected: the inspector is
       * selection-driven and an empty panel is not worth opening.
       */
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          toggleLibrary();
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          toggleMetrics();
          return;
        }
        if (e.key === 'i' || e.key === 'I') {
          if (hasSelection) {
            e.preventDefault();
            toggleInspector();
          }
          return;
        }
      }

      // Delete/Backspace, Escape and Ctrl/Cmd+A belong to the canvas, which
      // owns the selection and knows how to partition it. Handling them here
      // too would double-fire.
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleStep,
    glossaryOpen,
    openGlossary,
    closeGlossary,
    toggleLibrary,
    toggleMetrics,
    toggleInspector,
    hasSelection,
  ]);

  /* ---------------- derived ---------------- */

  /**
   * The selection, split into the two things the Inspector understands.
   *
   * Node ids and edge ids share `selectedIds`, so the split is simply "is
   * there a node with this id". Anything left over is an edge — the canvas
   * only ever puts those two kinds of id in the set.
   *
   * Kept in ONE memo rather than three so the panel can never be handed a
   * node list and an edge count computed from different renders.
   */
  const { selectedNodes, selectedEdgeCount } = useMemo(() => {
    if (selectedIds.size === 0) {
      return { selectedNodes: EMPTY_NODES, selectedEdgeCount: 0 };
    }
    const nodes = topology.nodes.filter((n) => selectedIds.has(n.id));
    return {
      selectedNodes: nodes,
      // Whatever in the set is not a node id is an edge id.
      selectedEdgeCount: selectedIds.size - nodes.length,
    };
  }, [topology.nodes, selectedIds]);

  /**
   * The single-node subject. Still resolved separately because the Inspector's
   * `node` prop drives the whole single-node view; `selectedNodes` only takes
   * over when it holds two or more.
   */
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0]! : null;

  const selectedStats =
    selectedNode && snapshot ? (snapshot.nodes[selectedNode.id] ?? null) : null;

  /**
   * Requests actually lost PER SECOND, derived from the engine's per-reason
   * counters. This is the single source of truth for "dropped": the top bar
   * and the throughput chart previously derived it two different ways
   * (`errorRate * offeredRps` and `offered - goodput`) and disagreed with
   * each other and with the failures panel. Neither derivation is loss —
   * `offered - goodput` counts in-flight work, and the errorRate product
   * rides a smoothed fraction against an instantaneous rate.
   *
   * `failuresByReason` is a LIFETIME COUNT, not a rate: the engine does
   * `this.failures[reason]++` per failure and zeroes it only on reset().
   * Summing it and labelling the total `/s` was wrong three ways — the unit
   * was a lie, the figure could only ever grow, and a recovered system still
   * read hundreds of thousands "dropped per second" because a counter cannot
   * fall. Observed directly: goodput 76/s and ERRORS 0% next to DROPPED
   * 218k/s.
   *
   * Differencing successive samples against elapsed SIM time turns the
   * counter into the rate this claims to be. Sim time is the right clock —
   * it follows pause, step and reset, where a wall clock would invent
   * traffic while the simulation is stopped. This mirrors the identical
   * derivation in Metrics.tsx, which fixed this same bug for the failures
   * panel.
   */
  const lostPrevRef = useRef<number | null>(null);
  const lostPrevTimeRef = useRef(0);
  const [lostRps, setLostRps] = useState(0);

  const cumulativeLost = useMemo(() => {
    if (!snapshot) return 0;
    let s = 0;
    for (const v of Object.values(snapshot.failuresByReason)) {
      if (Number.isFinite(v)) s += v;
    }
    return s;
  }, [snapshot]);

  const simTimeMs = snapshot?.system.timeMs ?? 0;

  useEffect(() => {
    if (!Number.isFinite(simTimeMs)) return;
    const prev = lostPrevRef.current;
    const dtMs = simTimeMs - lostPrevTimeRef.current;

    // First sample, or a reset (sim time or the counter moved backwards):
    // adopt the count as the new baseline and report nothing this frame.
    if (prev === null || dtMs < 0 || cumulativeLost < prev) {
      lostPrevRef.current = cumulativeLost;
      lostPrevTimeRef.current = simTimeMs;
      setLostRps(0);
      return;
    }

    // Sample no faster than 250ms of sim time: below that the divisor is
    // tiny and the quotient is mostly quantisation noise.
    if (dtMs < 250) return;

    const delta = cumulativeLost - prev;
    lostPrevRef.current = cumulativeLost;
    lostPrevTimeRef.current = simTimeMs;
    setLostRps(delta > 0 ? (delta * 1000) / dtMs : 0);
  }, [cumulativeLost, simTimeMs]);

  return (
    <div className="app">
      <header className="app-bar">
        {/* The wordmark is the one place the product speaks in its own
            voice. Two words, sentence case, no abbreviation — a student
            opening this should be able to say what it is out loud. */}
        <div className="app-brand">
          <h1 className="app-title">Breakscale</h1>
          <p className="app-tagline">Build it, load it, watch it break</p>
        </div>
        <TrafficControl
          rps={rps}
          onRpsChange={handleRpsChange}
          running={running}
          onToggleRun={handleToggleRun}
          onStep={handleStep}
          onReset={handleReset}
          system={snapshot?.system ?? EMPTY_SYSTEM}
          lost={lostRps}
          empty={topology.nodes.length === 0}
        />

        {/*
          THE WAY INTO THE GLOSSARY.

          Labelled, not an icon. A lone question mark in a circle is the
          weakest affordance in interface design: it could be help, support,
          an about box or a tour, and a student who does not know what "p99"
          means will not gamble a click to find out which. The word
          "Glossary" says exactly what is behind it.

          It lives in the top bar because that is the one region present on
          every screen state, and at the far end because it is a reference,
          not part of the run/pause loop the bar's other controls belong to.

          `aria-expanded` because it discloses the sheet, and the shortcut is
          printed rather than hidden in a tooltip so it is learnable by
          someone who has never opened the panel.
        */}
        {/*
          Tooltips are off by default, so this is how a student turns the
          explanations on. It sits beside the glossary because the two are the
          same feature seen from different angles: the panel is the reference
          you go and read, the tooltips are the reference coming to you.

          aria-pressed rather than aria-expanded: it switches a mode on and
          off, it does not disclose anything.
        */}
        <button
          type="button"
          className="btn app-glossary"
          aria-pressed={tooltipsOn}
          title={
            tooltipsOn
              ? 'Hide the explanations on metric names'
              : 'Explain metric names on hover'
          }
          onClick={() => togglePreference('tooltips')}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </svg>
          {tooltipsOn ? 'Hints on' : 'Hints off'}
        </button>

        <button
          type="button"
          className="btn app-glossary"
          aria-expanded={glossaryOpen}
          onClick={() => (glossaryOpen ? closeGlossary() : openGlossary())}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
          </svg>
          Glossary
          <kbd className="app-glossary-key" aria-hidden="true">
            ?
          </kbd>
        </button>
      </header>

      <div className="app-body">
        {layout.library ? (
          <Palette
            onAdd={handlePaletteAdd}
            presets={PRESETS}
            activePresetId={presetId}
            onLoadPreset={handleLoadPreset}
          />
        ) : null}

        <main className="app-stage">
          {/*
            The canvas plus the chrome that floats OVER it. The toggles are
            SIBLINGS of the Canvas, never children of .cv-surface, so the
            canvas gesture router cannot see a press on them; data-chrome is
            belt and braces on top of that, matching the exclusion selector
            the router uses.

            Each panel's toggle lives at the canvas edge the panel occupies
            and stays there in both states, so collapsing something never
            leaves a dead edge: the affordance that closed it is the
            affordance that brings it back, in the same place.
          */}
          <div className="stage-canvas">
            <Canvas
              topology={topology}
              snapshot={snapshot}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              onMoveNode={handleMoveNode}
              onConnect={handleConnect}
              onDeleteSelection={handleDeleteSelection}
              onDropNode={handleAddNode}
              spark={spark}
            />
            <button
              type="button"
              className="btn btn-sm btn-icon stage-toggle stage-toggle-library"
              data-chrome="layout"
              aria-expanded={layout.library}
              aria-label={layout.library ? 'Hide components' : 'Show components'}
              title={layout.library ? 'Hide components (C)' : 'Show components (C)'}
              onClick={toggleLibrary}
            >
              <PanelGlyph edge="left" />
            </button>
            {/*
              Rendered only while something is selected, because that is the
              only time the inspector can exist at all. With nothing
              selected there is no panel AND no button — the affordance for
              the inspector is selection itself, which the empty-canvas copy
              and the palette rows already teach.
            */}
            {hasSelection ? (
              <button
                type="button"
                className="btn btn-sm btn-icon stage-toggle stage-toggle-inspector"
                data-chrome="layout"
                aria-expanded={inspectorVisible}
                aria-label={inspectorVisible ? 'Hide inspector' : 'Show inspector'}
                title={inspectorVisible ? 'Hide inspector (I)' : 'Show inspector (I)'}
                onClick={toggleInspector}
              >
                <PanelGlyph edge="right" />
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-icon stage-toggle stage-toggle-metrics"
              data-chrome="layout"
              aria-expanded={layout.metrics}
              aria-label={layout.metrics ? 'Hide charts' : 'Show charts'}
              title={layout.metrics ? 'Hide charts (M)' : 'Show charts (M)'}
              onClick={toggleMetrics}
            >
              <PanelGlyph edge="bottom" />
            </button>
          </div>
          {layout.metrics && snapshot ? <Metrics snapshot={snapshot} /> : null}
        </main>

        {inspectorVisible ? (
          <Inspector
            node={selectedNode}
            stats={selectedStats}
            onChange={handleConfigChange}
            onDelete={handleDeleteNode}
            onRename={handleRename}
            selectedNodes={selectedNodes}
            selectedEdgeCount={selectedEdgeCount}
            onChangeMany={handleConfigChangeMany}
            onDeleteMany={handleDeleteMany}
          />
        ) : null}
      </div>

      {/*
        Mounted ONCE for the whole app. Every <Term> anywhere in the tree is a
        stateless trigger that this single layer renders the panel for, so the
        cost of an explanation is paid per tooltip OPEN rather than per term
        present. Both of these portal to <body>, so their position here is
        about ownership, not stacking.
      */}
      <TooltipLayer />
      <Glossary open={glossaryOpen} onClose={closeGlossary} focusId={glossaryFocusId} />
    </div>
  );
}

/**
 * Stable empty array for the no-selection case. A fresh `[]` each render
 * would give the Inspector a new prop identity every 100ms and defeat any
 * memoisation it does.
 */
const EMPTY_NODES: readonly SimNode[] = [];

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
