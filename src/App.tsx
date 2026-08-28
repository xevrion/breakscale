import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AnimationEvent, ReactNode } from 'react';
import type { NodeConfig, NodeKind, SimNode, SimSnapshot, Topology } from './sim/types';
import { Engine } from './sim/engine';
import { PRESETS, makeNode } from './sim/presets';
import type { Preset } from './sim/presets';
import Canvas, {
  GRID,
  NODE_H,
  NODE_W,
  SPARK_LEN,
  readoutFor,
  sourceBacklogs,
} from './components/Canvas';
import { Inspector, TrafficControl } from './components/Inspector';
import { Metrics } from './components/Metrics';
import { Palette } from './components/Palette';
import { Glossary } from './components/Glossary';
import { Shortcuts } from './components/Shortcuts';
import { Examples } from './components/Examples';
import { cloneSubgraph, isTopology, selectionSubgraph } from './clipboard';
import type { ClipboardSubgraph } from './clipboard';
import {
  NOTE_DEFAULT_WIDTH,
  SECTION_MIN_HEIGHT,
  SECTION_MIN_WIDTH,
  SECTION_TONE_COUNT,
  isSection,
  sanitizeAnnotations,
} from './sim/annotations';
import type { Annotation, Note } from './sim/annotations';
import { NEW_NOTE_TEXT } from './components/annotationLayout';
import type { AnnotationTool } from './components/Palette';
import { TooltipLayer, setGlossaryNavigate } from './components/Tooltip';
import { togglePreference, usePreference } from './content/preferences';
import { usePresence } from './components/presence';
import { SessionHistory, syncEngine } from './history';
import type { HistoryEntry, HistorySnapshot } from './history';
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

/**
 * Presence wrapper for one collapsible shell panel.
 *
 * THE STRUCTURAL FIX for panel motion. The shell used to render each panel
 * conditionally, so a closing panel was out of the DOM a frame before any
 * transition could run; there was literally nothing left to animate. This
 * wrapper keeps the panel mounted through its exit (usePresence), and the
 * panel slides from its own edge via TRANSFORM keyframes in App.css.
 *
 * Why transform, not an animated width or grid track: the canvas's
 * world-to-screen maths reads its viewport rect, so a layout that changes on
 * every animation frame would make an in-progress node drag drift and force
 * a re-fit per frame. The slots are absolutely positioned OVER the stage
 * (App.css), so in fact no state of this animation, and not even the slot's
 * mount or unmount, can change the canvas's rect: the diagram holds the same
 * screen pixels through any toggle, including one mid-drag, and the slide is
 * a pure transform that invalidates no layout at all.
 *
 * While closing the slot is `inert`: the leaving panel cannot take focus and
 * is invisible to a screen reader, and at animationend it unmounts outright,
 * so nothing hidden lingers in the DOM and an idle shell pays nothing.
 *
 * Children are FROZEN during the exit: the last element rendered while open
 * keeps rendering until unmount. The inspector needs this, because the
 * selection that justified its content is often already gone by the time it
 * slides out, and re-rendering it empty mid-exit would flash a blank panel.
 *
 * The entrance animation is skipped on the slot's very first appearance at
 * app boot (a panel restored from the saved layout is simply present, and
 * content that is simply present does not get an entrance), and plays on
 * every toggle after that.
 */
function PanelSlot({
  open,
  edge,
  children,
}: {
  open: boolean;
  edge: 'left' | 'right' | 'bottom';
  children: ReactNode;
}) {
  const { mounted, closing, unmount } = usePresence(open);

  const lastChildren = useRef(children);
  if (open) lastChildren.current = children;

  // "Has this slot ever been toggled": false until `open` first differs from
  // its value at mount, true forever after. A slot that has never toggled is
  // showing boot state and gets no entrance; one that has animates every
  // appearance. Render-phase adjustment, same pattern as usePresence.
  const [bootOpen] = useState(open);
  const [toggled, setToggled] = useState(false);
  if (!toggled && open !== bootOpen) setToggled(true);

  // The entrance class is REMOVED once its animation completes, symmetric
  // with the exit handler. A finished keyframe replays nothing, so leaving
  // the class cost little at runtime, but any remount (HMR, a key change)
  // would replay the slide on content that was simply present.
  const [entered, setEntered] = useState(false);
  const prevOpen = useRef(open);
  if (prevOpen.current !== open) {
    prevOpen.current = open;
    if (open) setEntered(false);
  }

  if (!mounted) return null;

  const state = closing ? ' is-closing' : toggled && !entered ? ' is-entering' : '';

  return (
    <div
      className={`app-slot app-slot-${edge}${state}`}
      inert={closing || undefined}
      onAnimationEnd={(e: AnimationEvent<HTMLDivElement>) => {
        // Only the slot's own animations count. Animations on children (a
        // chart transition, a button) bubble through here too.
        if (e.target !== e.currentTarget) return;
        if (closing) unmount();
        else setEntered(true);
      }}
    >
      {open ? children : lastChildren.current}
    </div>
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

/*
 * Structural validation of the stored session lives in clipboard.ts
 * (isTopology), because the clipboard paste path validates the exact same
 * shape and two hand-maintained copies of a 33-kind allowlist would drift.
 */

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
    // isTopology validates what the ENGINE dereferences; annotations are
    // presentation data it never sees, so they cross the trust boundary
    // through their own sanitizer. Anything malformed is dropped entry by
    // entry rather than costing the student the whole restored session.
    const annotations = sanitizeAnnotations(
      (s.topology as { annotations?: unknown }).annotations,
    );
    return {
      topology: {
        nodes: s.topology.nodes,
        edges: s.topology.edges,
        ...(annotations.length > 0 ? { annotations } : {}),
      },
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

/** Every traffic source on the canvas. Presets routinely have several. */
function findClients(t: Topology): SimNode[] {
  return t.nodes.filter((n) => n.kind === 'client');
}

/**
 * Total offered load: the SUM over every client node. The header used to
 * mirror a separate `rps` state cell that only the slider wrote, which came
 * apart two ways — a multi-client preset offered more than the header
 * admitted (Spotify: goodput 5.7k/s under "Offered load 5k"), and deleting
 * then re-adding a client left the header frozen on the old value while the
 * new client sent 50/s. Deriving from the topology makes the number a fact.
 */
function clientRps(t: Topology): number {
  let sum = 0;
  for (const c of findClients(t)) sum += c.config.rps;
  return sum;
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

  /** The keyboard shortcuts dialog. Ctrl+/ and the top-bar button. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);

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

  /**
   * The selection, split into the three things it can hold. Node ids and
   * edge ids share `selectedIds` with annotation ids; nodes and annotations
   * are identified by lookup and whatever remains is an edge. Kept in ONE
   * memo so the Inspector can never be handed a node list and an edge count
   * computed from different renders.
   */
  const { selectedNodes, selectedEdgeCount } = useMemo(() => {
    if (selectedIds.size === 0) {
      return { selectedNodes: EMPTY_NODES, selectedEdgeCount: 0, selectedAnnCount: 0 };
    }
    const nodes = topology.nodes.filter((n) => selectedIds.has(n.id));
    const anns = (topology.annotations ?? []).filter((a) => selectedIds.has(a.id));
    return {
      selectedNodes: nodes,
      // Whatever in the set is neither a node nor an annotation is an edge.
      selectedEdgeCount: selectedIds.size - nodes.length - anns.length,
      selectedAnnCount: anns.length,
    };
  }, [topology.nodes, topology.annotations, selectedIds]);

  /**
   * "Something the INSPECTOR can talk about is selected." Annotations are
   * deliberately excluded: a selected note has nothing to configure, and
   * opening an empty inspector for it would teach that selection sometimes
   * produces a blank panel.
   */
  const hasSelection = selectedNodes.length + selectedEdgeCount > 0;
  const inspectorVisible = hasSelection && !inspectorHidden;

  /**
   * The uncovered-canvas sentinel (see .stage-safe in App.css): an inert div
   * the shell keeps inset to the part of the canvas no floating panel
   * covers. The canvas measures it when aiming the camera (fit, palette
   * placement, paste, keyboard zoom), so content is always framed into the
   * visible area; it never triggers a camera move by changing.
   */
  const stageSafeRef = useRef<HTMLDivElement | null>(null);

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

  /* ---------------- undo / redo ---------------- */

  /**
   * History of full `{ topology, selectedIds, rps, presetId }` snapshots.
   * The stacks live in SessionHistory (a plain object, unit-tested on its
   * own); this state cell exists only to re-render when they change, and
   * canUndo/canRedo below are DERIVED from the stacks on every render, never
   * cached, so the buttons can never disagree with the stack contents.
   */
  const [, setHistVersion] = useState(0);
  const [history] = useState(
    () => new SessionHistory({ onChange: () => setHistVersion((v) => v + 1) }),
  );
  const canUndo = history.canUndo;
  const canRedo = history.canRedo;

  /**
   * The state a history entry captures, as of the LAST COMMITTED RENDER.
   * Written in an effect, so inside an event handler this is still the
   * pre-edit state: exactly what a baseline snapshot wants.
   */
  const snapRef = useRef<HistorySnapshot>({
    topology: initial.topology,
    selectedIds: new Set<string>(),
    rps: initial.rps,
    presetId: initial.presetId,
  });
  // Layout effect, not a passive one: the mirror must be current before the
  // NEXT event handler runs (a pointerup reading the final drag position),
  // and passive effects offer no such ordering guarantee.
  useLayoutEffect(() => {
    snapRef.current = { topology, selectedIds, rps, presetId };
  }, [topology, selectedIds, rps, presetId]);

  /**
   * The topology as of the LAST EVENT HANDLER, not the last committed render.
   *
   * snapRef above is refreshed by a layout effect, which only helps if React
   * renders between two handlers. Pointer moves are continuous-priority
   * events: React schedules their re-render through the scheduler, so a fast
   * flick can deliver pointerup BEFORE the render for the final pointermove
   * has committed. endGesture would then compare the drag's baseline against
   * a pre-drag snapshot, conclude the gesture went nowhere, and drop the
   * entry — a fast node drag became invisible to undo and left a stale redo
   * stack behind. Verified with a real three-event drag in a background tab.
   *
   * Every handler that writes the topology writes this ref in the same
   * synchronous breath, so a gesture's end always sees the state its own
   * moves produced, whether or not React has caught up.
   */
  const topoLiveRef = useRef<Topology>(initial.topology);
  useLayoutEffect(() => {
    topoLiveRef.current = topology;
  }, [topology]);

  /**
   * Toast naming what was undone or redone. On a large canvas the reverted
   * change can be off screen (a preset load, a node deleted at the far
   * edge), and without the toast an off-screen undo is indistinguishable
   * from a dead keypress; a two-second label is the cheapest possible proof
   * that something happened. `id` keys the element so consecutive undos
   * restart the entrance animation instead of freezing on one message.
   */
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const toastSeq = useRef(0);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const applyEntry = useCallback(
    (entry: HistoryEntry, verb: 'Undid' | 'Redid') => {
      // The engine first, via the same non-resetting paths a forward edit
      // uses: updateNodeConfig for a config-only difference, setTopology for
      // structure. Nothing here resets the simulation or its metrics.
      syncEngine(engine, snapRef.current.topology, entry.topology);
      setTopology(entry.topology);
      setSelectedIds(new Set(entry.selectedIds));
      setRps(entry.rps);
      setPresetId(entry.presetId);
      toastSeq.current += 1;
      setToast({ text: `${verb} ${entry.label}`, id: toastSeq.current });
    },
    [engine],
  );

  const handleUndo = useCallback(() => {
    const entry = history.undo(snapRef.current);
    if (entry) applyEntry(entry, 'Undid');
  }, [history, applyEntry]);

  const handleRedo = useCallback(() => {
    const entry = history.redo(snapRef.current);
    if (entry) applyEntry(entry, 'Redid');
  }, [history, applyEntry]);

  /* ---------------- structural edits ---------------- */

  /**
   * Structural changes (add/remove nodes or edges, moves) must be pushed
   * into the engine wholesale. The engine preserves per-node state for ids
   * it already knows, so editing the graph does not disturb in-flight work.
   */
  const applyTopology = useCallback(
    (next: Topology) => {
      topoLiveRef.current = next;
      setTopology(next);
      engine.setTopology(next);
      // Refresh the snapshot immediately so a topology edit made while PAUSED
      // shows the new node's readouts at once, instead of blank rows sitting
      // next to headline numbers from the previous run until the next tick.
      setSnapshot(engine.snapshot());
      setPresetId(null);
    },
    [engine],
  );

  const handleMoveNode = useCallback(
    (id: string, x: number, y: number) => {
      // Inside a pointer drag the history baseline was captured at promotion
      // (handleMoveStart below) and will commit at gesture end, so the
      // per-frame stream stays out of history entirely. A move arriving
      // OUTSIDE a gesture is an arrow-key nudge; key-repeat makes that a
      // stream too, so it takes the debounced path and one nudge burst
      // settles into one entry.
      if (!history.inGesture) history.touch('move', snapRef.current);
      // Position is presentation only — the engine does not care, so this
      // skips setTopology and avoids clearing the active preset badge.
      // Computed eagerly from the live mirror (and written back to it) so a
      // pointerup arriving before React commits still sees this move.
      const t = topoLiveRef.current;
      const next = {
        ...t,
        nodes: t.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
      };
      topoLiveRef.current = next;
      setTopology(next);
    },
    [history],
  );

  /** One drag is ONE history entry: baseline at promotion, commit at end.
   *  The canvas names the gesture ('move', 'resize') so the undo toast can
   *  say what it undid; unnamed callers stay a 'move'. */
  const handleMoveStart = useCallback(
    (label?: string) => {
      history.beginGesture(label ?? 'move', snapRef.current);
    },
    [history],
  );

  const handleMoveEnd = useCallback(() => {
    // The topology from the live mirror, never from snapRef alone: a flick's
    // pointerup can outrun the render for its last pointermove, and endGesture
    // fed the stale mirror would drop the entry as a no-op (see topoLiveRef).
    history.endGesture({ ...snapRef.current, topology: topoLiveRef.current });
  }, [history]);

  /* ---------------- annotations: notes and sections ----------------
   *
   * PRESENTATION ONLY. Every writer here goes through setAnnotations, which
   * updates React state and the live mirror and NOTHING else: the engine is
   * never told (it has no field to be told in), the snapshot is not
   * refreshed, and the active preset badge survives, exactly as it does for
   * a node move. History granularity matches nodes 1:1 — one drag or resize
   * is one entry at the gesture boundary, a creation or text edit is one
   * discrete commit.
   */

  const setAnnotations = useCallback((next: Annotation[]) => {
    const t = topoLiveRef.current;
    const nt: Topology = { ...t, annotations: next };
    topoLiveRef.current = nt;
    setTopology(nt);
  }, []);

  /** `kind-N` ids of the same shape freshId in clipboard.ts mints, scanned
   *  against the live list because a restored session's ids predate this
   *  tab's counters. */
  const freshAnnId = useCallback((prefix: 'note' | 'section'): string => {
    const used = new Set((topoLiveRef.current.annotations ?? []).map((a) => a.id));
    let n = 1;
    while (used.has(`${prefix}-${n}`)) n += 1;
    return `${prefix}-${n}`;
  }, []);

  const handleMoveAnnotation = useCallback(
    (id: string, x: number, y: number) => {
      // Same shape as handleMoveNode: inside a pointer drag the baseline
      // was captured at promotion; a move arriving outside a gesture is a
      // future streamed path and takes the debounced entry.
      if (!history.inGesture) history.touch('move', snapRef.current);
      setAnnotations(
        (topoLiveRef.current.annotations ?? []).map((a) =>
          a.id === id ? { ...a, x, y } : a,
        ),
      );
    },
    [history, setAnnotations],
  );

  const handleResizeSection = useCallback(
    (id: string, x: number, y: number, w: number, h: number) => {
      if (!history.inGesture) history.touch('resize', snapRef.current);
      setAnnotations(
        (topoLiveRef.current.annotations ?? []).map((a) =>
          a.id === id && isSection(a)
            ? {
                ...a,
                x,
                y,
                width: Math.max(w, SECTION_MIN_WIDTH),
                height: Math.max(h, SECTION_MIN_HEIGHT),
              }
            : a,
        ),
      );
    },
    [history, setAnnotations],
  );

  const handleCreateNote = useCallback(
    (x: number, y: number): string => {
      const anns = topoLiveRef.current.annotations ?? [];
      const id = freshAnnId('note');
      history.commit('add note', snapRef.current);
      setAnnotations([
        ...anns,
        {
          id,
          kind: 'note',
          text: NEW_NOTE_TEXT,
          x,
          y,
          width: NOTE_DEFAULT_WIDTH,
          size: 'md',
        },
      ]);
      setSelectedIds(new Set([id]));
      return id;
    },
    [freshAnnId, history, setAnnotations],
  );

  const handleCreateSection = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const id = freshAnnId('section');
      history.commit('add section', snapRef.current);
      setAnnotations([
        ...anns,
        {
          id,
          kind: 'section',
          label: 'Section',
          x,
          y,
          width: Math.max(w, SECTION_MIN_WIDTH),
          height: Math.max(h, SECTION_MIN_HEIGHT),
          // Rotate through the palette so adjacent frames differ by default.
          tone: anns.filter(isSection).length % SECTION_TONE_COUNT,
        },
      ]);
      setSelectedIds(new Set([id]));
    },
    [freshAnnId, history, setAnnotations],
  );

  const handleEditNote = useCallback(
    (id: string, text: string) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'note') return;
      const next = text.slice(0, 2000);
      if (!next.trim()) {
        // An emptied note is removed outright: invisible and unselectable,
        // it would otherwise be litter the reader cannot find to delete.
        history.commit('delete', snapRef.current);
        setAnnotations(anns.filter((a) => a.id !== id));
        setSelectedIds((sel) => {
          if (!sel.has(id)) return sel;
          const out = new Set(sel);
          out.delete(id);
          return out;
        });
        return;
      }
      if (next === cur.text) return;
      history.commit('note edit', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, text: next } : a)));
    },
    [history, setAnnotations],
  );

  const handleEditSectionLabel = useCallback(
    (id: string, label: string) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'section') return;
      const next = label.slice(0, 200);
      if (next === cur.label) return;
      history.commit('label edit', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, label: next } : a)));
    },
    [history, setAnnotations],
  );

  const handleSetNoteSize = useCallback(
    (id: string, size: Note['size']) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'note' || cur.size === size) return;
      history.commit('note size', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, size } : a)));
    },
    [history, setAnnotations],
  );

  /** Palette click (no drop point): place at the centre of the current
   *  view, the same aim handlePaletteAdd uses for components. */
  const handlePaletteAnnotation = useCallback(
    (tool: AnnotationTool) => {
      const centre = viewCenterRef.current?.() ?? { x: 240, y: 200 };
      const gx = (v: number) => Math.round(v / GRID) * GRID;
      if (tool === 'note') {
        handleCreateNote(gx(centre.x - NOTE_DEFAULT_WIDTH / 2), gx(centre.y));
      } else {
        handleCreateSection(gx(centre.x - 160), gx(centre.y - 112), 320, 224);
      }
    },
    [handleCreateNote, handleCreateSection],
  );

  const handleAddNode = useCallback(
    (kind: NodeKind, x: number, y: number) => {
      const node = makeNode(kind, x, y);
      history.commit('add', snapRef.current);
      applyTopology({
        ...topology,
        nodes: [...topology.nodes, node],
      });
      setSelectedIds(new Set([node.id]));
    },
    [applyTopology, topology, history],
  );

  /**
   * Filled by the canvas with a "world point at the centre of the current
   * view" getter. A palette CLICK has no drop point of its own; the old
   * placement (max x + 220) marched monotonically rightward, so after a few
   * clicks each new node — entrance animation and all — landed entirely
   * outside the viewport and the click looked like a no-op. Measured: two
   * palette clicks on the company preset created nodes at screen y ≈ -257.
   */
  const viewCenterRef = useRef<(() => { x: number; y: number }) | null>(null);

  /** Palette click (no drop point): place at the centre of the current view. */
  const handlePaletteAdd = useCallback(
    (kind: NodeKind) => {
      const centre = viewCenterRef.current?.();
      if (!centre) {
        // No canvas yet (should not happen in practice): old fallback.
        const maxX = topology.nodes.reduce((m, n) => Math.max(m, n.x), 0);
        handleAddNode(kind, maxX + 220, 200);
        return;
      }
      // Centre the node on the view, snapped to the grid. A small ring of
      // nearby offsets dodges an exact pile-up from repeated clicks, but the
      // search never leaves the neighbourhood: on a dense diagram the node
      // simply lands at the centre and overlaps, which the student can see
      // and fix — a node placed "helpfully" outside the viewport cannot be.
      const cx = Math.round((centre.x - NODE_W / 2) / GRID) * GRID;
      const cy = Math.round((centre.y - NODE_H / 2) / GRID) * GRID;
      const occupied = (px: number, py: number) =>
        topology.nodes.some(
          (n) => Math.abs(n.x - px) < NODE_W && Math.abs(n.y - py) < NODE_H,
        );
      const STEP = GRID * 4;
      const ring: [number, number][] = [
        [0, 0],
        [STEP, STEP],
        [-STEP, STEP],
        [STEP, -STEP],
        [-STEP, -STEP],
        [2 * STEP, 0],
        [0, 2 * STEP],
        [-2 * STEP, 0],
        [0, -2 * STEP],
      ];
      const spot = ring.find(([dx, dy]) => !occupied(cx + dx, cy + dy)) ?? [0, 0];
      handleAddNode(kind, cx + spot[0], cy + spot[1]);
    },
    [handleAddNode, topology.nodes],
  );

  const handleConnect = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const id = `${fromId}->${toId}`;
      if (topology.edges.some((e) => e.id === id)) return;
      history.commit('connection', snapRef.current);
      applyTopology({
        ...topology,
        edges: [...topology.edges, { id, from: fromId, to: toId, weight: 1 }],
      });
    },
    [applyTopology, topology, history],
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
    (
      nodeIds: readonly string[],
      edgeIds: readonly string[],
      annotationIds: readonly string[] = [],
    ) => {
      if (nodeIds.length === 0 && edgeIds.length === 0 && annotationIds.length === 0) {
        return;
      }
      const dropNodes = new Set(nodeIds);
      const dropEdges = new Set(edgeIds);
      const dropAnns = new Set(annotationIds);
      // ONE entry for the whole selection, orphaned edges included: the
      // filter below is a single topology edit, so its baseline is too.
      history.commit('delete', snapRef.current);

      // An annotation-only delete stays a presentation edit: the engine is
      // not disturbed and the preset badge survives, matching every other
      // annotation path. Anything structural goes through applyTopology.
      if (nodeIds.length === 0 && edgeIds.length === 0) {
        setAnnotations((topology.annotations ?? []).filter((a) => !dropAnns.has(a.id)));
      } else {
        applyTopology({
          ...topology,
          nodes: topology.nodes.filter((n) => !dropNodes.has(n.id)),
          edges: topology.edges.filter(
            (e) =>
              // Explicitly deleted, or orphaned by a node that just went away.
              !dropEdges.has(e.id) && !dropNodes.has(e.from) && !dropNodes.has(e.to),
          ),
          ...(topology.annotations
            ? {
                annotations: topology.annotations.filter((a) => !dropAnns.has(a.id)),
              }
            : {}),
        });
      }
      setSelectedIds((cur) => {
        if (cur.size === 0) return cur;
        const next = new Set(cur);
        for (const id of dropNodes) next.delete(id);
        for (const id of dropEdges) next.delete(id);
        for (const id of dropAnns) next.delete(id);
        return next;
      });
    },
    [applyTopology, setAnnotations, topology, history],
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

  /* ---------------- duplicate & paste ---------------- */

  /**
   * Append a cloned subgraph in ONE topology edit and make the clones the
   * new selection (nodes and internal edges both), which is what lets a
   * repeated Ctrl+D walk copies across the canvas. Shared by Ctrl+D,
   * alt-drag and paste so the three cannot disagree about what a copy is.
   */
  const appendClones = useCallback(
    (clones: ClipboardSubgraph) => {
      applyTopology({
        ...topology,
        nodes: [...topology.nodes, ...clones.nodes],
        edges: [...topology.edges, ...clones.edges],
      });
      const next = new Set<string>();
      for (const n of clones.nodes) next.add(n.id);
      for (const e of clones.edges) next.add(e.id);
      setSelectedIds(next);
    },
    [applyTopology, topology],
  );

  /**
   * Ctrl+D: duplicate the selection two grid steps down-right. The offset is
   * small enough that the copy reads as "yours, here" and large enough that
   * it never lands exactly on its source and looks like nothing happened.
   */
  const handleDuplicate = useCallback(() => {
    const sub = selectionSubgraph(topology, selectedIds);
    if (!sub) return;
    // ONE entry for the whole duplicate, selection included.
    history.commit('duplicate', snapRef.current);
    appendClones(cloneSubgraph(sub, topology, GRID * 2, GRID * 2));
  }, [topology, selectedIds, history, appendClones]);

  /**
   * Alt+drag: the same duplication as Ctrl+D, but born under the pointer as
   * a drag. Called by the canvas once at drag promotion; clones are placed
   * exactly on their sources (offset 0) because the drag itself supplies the
   * displacement, and the return value tells the canvas which clones the
   * gesture now carries. History: this opens a gesture the canvas's
   * onMoveEnd closes, so the entire duplicate-and-drag is one undo step
   * whose baseline predates the clones.
   */
  const handleDuplicateForDrag = useCallback(
    (primaryId: string) => {
      if (!topology.nodes.some((n) => n.id === primaryId)) return null;
      // Same scope rule as a plain drag: grabbing a member of a
      // multi-selection copies the whole selection, anything else copies
      // just the grabbed node.
      const scope: ReadonlySet<string> =
        selectedIds.has(primaryId) && selectedIds.size > 1
          ? selectedIds
          : new Set([primaryId]);
      const sub = selectionSubgraph(topology, scope);
      if (!sub) return null;
      const clones = cloneSubgraph(sub, topology, 0, 0);
      // cloneSubgraph preserves order, so source i maps to clone i.
      let primary: string | null = null;
      const group: { id: string; x: number; y: number }[] = [];
      for (let i = 0; i < sub.nodes.length; i++) {
        const clone = clones.nodes[i]!;
        if (sub.nodes[i]!.id === primaryId) primary = clone.id;
        else group.push({ id: clone.id, x: clone.x, y: clone.y });
      }
      if (!primary) return null;
      history.beginGesture('duplicate', snapRef.current);
      appendClones(clones);
      return { id: primary, group };
    },
    [topology, selectedIds, history, appendClones],
  );

  /**
   * Ctrl+V: a validated subgraph off the system clipboard, aimed at the
   * pointer. The payload's ids are whatever the copy carried (possibly from
   * another tab) and are never trusted: cloneSubgraph mints fresh ones
   * against the live topology. The bounding-box centre lands on the pointer,
   * moved by a grid-snapped delta so the subgraph's internal offsets survive
   * exactly and grid-aligned content stays aligned.
   */
  const handlePaste = useCallback(
    (sub: ClipboardSubgraph, at: { x: number; y: number }) => {
      if (sub.nodes.length === 0) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of sub.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
        if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
      }
      const dx = Math.round((at.x - (minX + maxX) / 2) / GRID) * GRID;
      const dy = Math.round((at.y - (minY + maxY) / 2) / GRID) * GRID;
      history.commit('paste', snapRef.current);
      appendClones(cloneSubgraph(sub, topology, dx, dy));
    },
    [topology, history, appendClones],
  );

  /* ---------------- live config edits ---------------- */

  /**
   * Knob changes are applied to the running engine in place. No reset: the
   * whole point is watching the system respond to a change under load.
   */
  const handleConfigChange = useCallback(
    (id: string, patch: Partial<NodeConfig>) => {
      // A slider fires this every frame, so the history side is debounced:
      // the first frame captures the pre-edit baseline, and the entry lands
      // once the value settles. One knob gesture, one undo step.
      history.touch('setting change', snapRef.current);
      engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
        ),
      }));
      // No slider sync needed: the header's offered load is DERIVED from the
      // topology's client nodes, so a per-node rps knob updates it for free.
    },
    [engine, history],
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
      history.touch('setting change', snapRef.current);
      const targets = new Set(ids);
      for (const id of targets) engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          targets.has(n.id) ? { ...n, config: { ...n.config, ...patch } } : n,
        ),
      }));
      // No slider sync needed: the header derives offered load from the
      // topology, so editing any client's rps here updates it for free.
    },
    [engine, history],
  );

  const handleRename = useCallback(
    (id: string, label: string) => {
      // Fired per keystroke; debounced the same way a slider is, so one
      // typed name settles into one entry.
      history.touch('rename', snapRef.current);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
      }));
    },
    [history],
  );

  /**
   * The top-bar slider sets the TOTAL offered load. One client gets the value
   * outright; several are scaled proportionally so a preset's deliberate
   * traffic mix survives the drag, with the remainder placed on the first
   * client so the distributed parts always sum to exactly `next`.
   */
  const handleRpsChange = useCallback(
    (next: number) => {
      setRps(next);
      const clients = findClients(topology);
      if (clients.length === 0) return;
      if (clients.length === 1) {
        handleConfigChange(clients[0]!.id, { rps: next });
        return;
      }
      const total = clients.reduce((s, c) => s + c.config.rps, 0);
      const shares = clients.map((c) =>
        Math.max(
          0,
          Math.round(next * (total > 0 ? c.config.rps / total : 1 / clients.length)),
        ),
      );
      const spread = shares.reduce((s, v) => s + v, 0);
      shares[0] = Math.max(0, shares[0]! + (next - spread));
      // One history baseline, one engine pass, one topology write.
      history.touch('setting change', snapRef.current);
      const byId = new Map(clients.map((c, i) => [c.id, shares[i]!]));
      for (const [id, rps] of byId) engine.updateNodeConfig(id, { rps });
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          byId.has(n.id) ? { ...n, config: { ...n.config, rps: byId.get(n.id)! } } : n,
        ),
      }));
    },
    [handleConfigChange, topology, history, engine],
  );

  /* ---------------- presets & reset ---------------- */

  /**
   * State backing the lost-per-second derivation further down (see the
   * cumulativeLost memo). Declared here because reset and preset load must
   * zero it SYNCHRONOUSLY: leaving it to the effect meant the old run's
   * "Dropped 104k/s" sat on screen next to p99 0ms until the next effect
   * pass — indefinitely, while paused.
   */
  const lostPrevRef = useRef<number | null>(null);
  const lostPrevTimeRef = useRef(0);
  const [lostRps, setLostRps] = useState(0);

  const resetLostRate = useCallback(() => {
    lostPrevRef.current = null;
    lostPrevTimeRef.current = 0;
    setLostRps(0);
  }, []);

  /**
   * Bumped when the diagram is replaced wholesale, so the canvas re-frames
   * the new content. Node edits never bump it: the camera belongs to the
   * student, and add/delete/undo must not move it.
   */
  const [fitNonce, setFitNonce] = useState(0);

  const handleLoadPreset = useCallback(
    (preset: Preset) => {
      // ONE entry, captured before the load, so a student who loads an
      // example over a half-built system can undo back to what they had.
      history.commit('example load', snapRef.current);
      // Deep copy: presets are module-level constants and must never be
      // mutated by editing the loaded system.
      const fresh = structuredClone(preset.topology);
      setTopology(fresh);
      setRps(clientRps(fresh));
      setPresetId(preset.id);
      setSelectedIds(new Set<string>());
      topoLiveRef.current = fresh;
      engine.setTopology(fresh);
      engine.reset();
      resetLostRate();
      setSnapshot(engine.snapshot());
      setFitNonce((n) => n + 1);
    },
    [engine, history, resetLostRate],
  );

  const handleReset = useCallback(() => {
    engine.reset();
    // Synchronously, not via the derivation effect: Reset must never leave
    // the previous run's Dropped figure standing beside a zeroed clock.
    resetLostRate();
    setSnapshot(engine.snapshot());
  }, [engine, resetLostRate]);

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

      /*
       * Undo / redo. Bound by e.code, not e.key: KeyZ is the physical key in
       * the Z position, so the chord works on layouts (Cyrillic, Greek) where
       * pressing that key produces no letter "z" at all — the exact bug
       * Excalidraw shipped and fixed. Ctrl+Shift+Z and Ctrl+Y are both redo,
       * matching the two conventions users arrive with. Inert in text fields
       * via the guard above, so the browser keeps its own text undo.
       */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyY') {
        e.preventDefault();
        handleRedo();
        return;
      }

      /*
       * Duplicate. By e.code for the same layout reasons as undo, and
       * preventDefault matters doubly here: Ctrl+D is the browser's
       * bookmark chord.
       */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyD') {
        e.preventDefault();
        handleDuplicate();
        return;
      }

      /*
       * The shortcuts dialog, on Ctrl+/ — the settled convention for "show
       * me the keys" in tools whose "?" is already spoken for, and ours is:
       * "?" has toggled the glossary since it shipped, and stealing a taught
       * binding to advertise the other bindings would be self-defeating.
       */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Slash') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
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
    handleUndo,
    handleRedo,
    handleDuplicate,
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
   * The single-node subject. Still resolved separately because the Inspector's
   * `node` prop drives the whole single-node view; `selectedNodes` only takes
   * over when it holds two or more.
   */
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0]! : null;

  const selectedStats =
    selectedNode && snapshot ? (snapshot.nodes[selectedNode.id] ?? null) : null;

  /**
   * The header's offered load, derived from the topology's client nodes (the
   * sum, so multi-client presets add up) rather than mirrored in a separate
   * state cell that add/delete paths forgot to reconcile. `rps` state remains
   * only as the persisted slider value for session restore.
   */
  const offeredRps = useMemo(() => clientRps(topology), [topology]);

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
   * panel. The backing refs and state live up beside handleReset, which must
   * zero them synchronously.
   */
  const cumulativeLost = useMemo(() => {
    if (!snapshot) return 0;
    let s = 0;
    for (const v of Object.values(snapshot.failuresByReason)) {
      if (Number.isFinite(v)) s += v;
    }
    return s;
  }, [snapshot]);

  const simTimeMs = snapshot?.system.timeMs ?? 0;

  /**
   * One definition of "the strip is open", shared by the slot and the
   * has-metrics class so the panel and the geometry that clears it (chrome
   * offsets, the safe-area sentinel) can never disagree.
   */
  const metricsVisible = layout.metrics && snapshot !== null;

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

        {/*
          Undo / redo. Beside the wordmark, at the editing end of the bar,
          away from the run/pause cluster: these operate on the DIAGRAM, not
          on the simulation. Disabled state is derived from the history
          stacks on every render, so the buttons can never claim emptiness
          while entries exist (the cached-boolean regression Excalidraw
          shipped). Icon-only, because "curved arrow left" is one of the few
          icons with a universally settled meaning, and the title carries the
          shortcut for anyone hovering to check.
        */}
        <div className="app-history">
          <button
            type="button"
            className="btn btn-sm btn-icon"
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            onClick={handleUndo}
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
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            onClick={handleRedo}
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
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
            </svg>
          </button>
        </div>

        <TrafficControl
          rps={offeredRps}
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
          aria-label={tooltipsOn ? 'Hints on' : 'Hints off'}
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
          <span className="app-glossary-label">
            {tooltipsOn ? 'Hints on' : 'Hints off'}
          </span>
        </button>

        {/*
          The way into the keyboard shortcuts dialog. Labelled, beside the
          glossary, for the same reason the glossary is: the two are the
          app's reference surfaces, and a student who knows no shortcuts is
          exactly the person an icon-only affordance would lose. The printed
          chord makes the binding learnable from the button itself.
        */}
        {/*
          Examples opens a gallery rather than living in the components rail.
          A rail row is something you drag ONTO the canvas; an example is a
          whole system you load, which is a different act, and the rail had no
          room to say what any of them teaches. It also means the empty
          canvas's "open Examples" instruction points at something that is
          always reachable, which was not true while the rail could be
          collapsed.
        */}
        <button
          type="button"
          className="btn app-glossary"
          aria-haspopup="dialog"
          aria-expanded={examplesOpen}
          aria-label="Examples"
          title="Load a worked example"
          onClick={() => setExamplesOpen((o) => !o)}
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
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <span className="app-glossary-label">Examples</span>
        </button>

        <button
          type="button"
          className="btn app-glossary"
          aria-haspopup="dialog"
          aria-expanded={shortcutsOpen}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (Ctrl+/)"
          onClick={() => setShortcutsOpen((o) => !o)}
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
            <rect x="2" y="5" width="20" height="14" rx="2.5" />
            <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6M7 17h10" />
          </svg>
          <span className="app-glossary-label">Shortcuts</span>
          <kbd className="app-glossary-key" aria-hidden="true">
            Ctrl+/
          </kbd>
        </button>

        <button
          type="button"
          className="btn app-glossary"
          aria-expanded={glossaryOpen}
          aria-label="Glossary"
          title="Glossary (?)"
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
          <span className="app-glossary-label">Glossary</span>
          <kbd className="app-glossary-key" aria-hidden="true">
            ?
          </kbd>
        </button>
      </header>

      {/*
        The has-* classes drive every piece of geometry that must clear an
        open panel: the strip's side insets, the toggle and canvas-chrome
        offsets, and the .stage-safe sentinel (all in App.css). They flip at
        toggle time, while a closing panel is still sliding out, so the
        chrome and the panel move on the same clock.
      */}
      <div
        className={
          'app-body' +
          (layout.library ? ' has-library' : '') +
          (inspectorVisible ? ' has-inspector' : '') +
          (metricsVisible ? ' has-metrics' : '')
        }
      >
        <PanelSlot open={layout.library} edge="left">
          <Palette onAdd={handlePaletteAdd} onAddAnnotation={handlePaletteAnnotation} />
        </PanelSlot>

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
              onMoveStart={handleMoveStart}
              onMoveEnd={handleMoveEnd}
              onConnect={handleConnect}
              onDeleteSelection={handleDeleteSelection}
              onDropNode={handleAddNode}
              onRename={handleRename}
              onDuplicateForDrag={handleDuplicateForDrag}
              onPaste={handlePaste}
              onMoveAnnotation={handleMoveAnnotation}
              onResizeSection={handleResizeSection}
              onCreateNote={handleCreateNote}
              onCreateSection={handleCreateSection}
              onEditNote={handleEditNote}
              onEditSectionLabel={handleEditSectionLabel}
              onSetNoteSize={handleSetNoteSize}
              spark={spark}
              viewCenterRef={viewCenterRef}
              fitSignal={fitNonce}
              visibleRef={stageSafeRef}
            />
            {/*
              The uncovered-canvas sentinel. Inert and invisible; a sibling
              of the Canvas, outside .cv-surface, so the gesture router can
              never see it. Its rect is the canvas minus every open panel.
            */}
            <div ref={stageSafeRef} className="stage-safe" aria-hidden="true" />
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
          <PanelSlot open={metricsVisible} edge="bottom">
            {snapshot ? <Metrics snapshot={snapshot} /> : null}
          </PanelSlot>
        </main>

        <PanelSlot open={inspectorVisible} edge="right">
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
        </PanelSlot>
      </div>

      {/*
        Mounted ONCE for the whole app. Every <Term> anywhere in the tree is a
        stateless trigger that this single layer renders the panel for, so the
        cost of an explanation is paid per tooltip OPEN rather than per term
        present. Both of these portal to <body>, so their position here is
        about ownership, not stacking.
      */}
      {/*
        Undo/redo receipt. role="status" (polite live region) so a screen
        reader hears the same confirmation a sighted user sees; keyed by id so
        rapid consecutive undos restart the entrance rather than sitting
        still on a message that appears not to change.
      */}
      {toast ? (
        <div key={toast.id} className="app-toast" role="status">
          {toast.text}
        </div>
      ) : null}

      <TooltipLayer />
      <Glossary open={glossaryOpen} onClose={closeGlossary} focusId={glossaryFocusId} />
      <Shortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <Examples
        open={examplesOpen}
        onClose={() => setExamplesOpen(false)}
        presets={PRESETS}
        activePresetId={presetId}
        onLoad={handleLoadPreset}
      />
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
