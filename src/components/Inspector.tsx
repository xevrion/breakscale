import { useCallback, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import type {
  NodeConfig,
  NodeKind,
  NodeStats,
  SimNode,
  SystemStats,
} from '../sim/types';
import { defaultConfig } from '../sim/presets';
import { KIND_NAME } from './nodeVisuals';
import {
  NA,
  formatCount,
  formatMs,
  formatPct,
  formatRate,
  formatRateBare,
  healthOfErr,
  healthOfLatency,
  healthOfLoad,
  toneClass,
} from './format';
import './Inspector.css';

/* ------------------------------------------------------------------ *
 * Which knobs actually apply to which kind.
 *
 * This is the whole point of the panel: a cache shows hitRate, a db does
 * not; a client shows the load it offers and how long it waits; a queue
 * shows only how deep it may get. Thirty knobs on every node would make
 * the app look configurable and feel meaningless.
 *
 * FIELDS_BY_KIND is the single source of truth for that filtering, and
 * the assertion below it is what keeps the promise honest: every field
 * that exists must be claimed by at least one kind, so a knob can never
 * be added to the type and silently reach every panel.
 * ------------------------------------------------------------------ */

type Field =
  | 'rps'
  | 'capacity'
  | 'serviceMs'
  | 'serviceCv'
  | 'queueLimit'
  | 'hitRate'
  | 'errorRate'
  | 'timeoutMs'
  | 'retries'
  | 'replicaCount'
  | 'replicationLagMs'
  | 'readFraction'
  | 'shardCount'
  | 'shardCapacity'
  | 'hotKeyFraction'
  | 'targetUtil'
  | 'minCapacity'
  | 'maxCapacity'
  | 'cooldownMs'
  | 'scaleStepPct'
  | 'warmupMs'
  | 'regions'
  | 'activeRegion'
  | 'failoverMs'
  | 'rateLimitRps'
  | 'burst'
  | 'errorThreshold'
  | 'windowMs'
  | 'openMs'
  | 'halfOpenProbes';

const FIELDS_BY_KIND: Record<NodeKind, Field[]> = {
  // The client generates load and decides how long to wait for an answer.
  // It serves nothing, so it has no capacity, service time, or queue.
  client: ['rps', 'timeoutMs', 'retries'],
  // A load balancer forwards; its own service time is near-zero but its
  // connection pool and backlog are real and can saturate.
  lb: ['capacity', 'serviceMs', 'queueLimit'],
  // The general workhorse: everything except cache hits and offered load.
  service: [
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
    'timeoutMs',
    'retries',
  ],
  // Only the cache has a hit rate. That single knob is the interesting one.
  cache: ['hitRate', 'capacity', 'serviceMs', 'serviceCv', 'queueLimit'],
  // A database is slots and service time. It does not retry on your behalf.
  db: ['capacity', 'serviceMs', 'serviceCv', 'queueLimit', 'errorRate'],
  // A queue is a buffer. Depth is the only thing that matters about it.
  queue: ['queueLimit', 'serviceMs'],
  // Workers drain a queue. No inbound queue limit of their own.
  worker: ['capacity', 'serviceMs', 'serviceCv', 'errorRate'],
  // The three knobs that trade read scale against staleness, plus the
  // per-replica service cost.
  replica: [
    'replicaCount',
    'replicationLagMs',
    'readFraction',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Partition count and per-shard slots set the ceiling; hotKeyFraction
  // is the knob that destroys it.
  shard: [
    'shardCount',
    'shardCapacity',
    'hotKeyFraction',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // A controller has no request-path knobs at all: every field it exposes is
  // about the control loop it runs on the node it watches.
  autoscaler: [
    'targetUtil',
    'minCapacity',
    'maxCapacity',
    'cooldownMs',
    'scaleStepPct',
    'warmupMs',
  ],
  // Which region serves, how many there are, and what an outage costs.
  region: ['regions', 'activeRegion', 'failoverMs'],
  // A CDN is a cache whose whole story is the hit rate: how much load never
  // reaches you. Capacity and service time are shown because a saturated
  // edge is still a real failure mode.
  cdn: ['hitRate', 'capacity', 'serviceMs', 'queueLimit'],
  // A limiter has exactly two knobs, and the pair is the lesson: sustained
  // rate, and how much burst you forgive on top of it.
  ratelimiter: ['rateLimitRps', 'burst'],
  // The four knobs of a breaker are the four questions it answers: how bad,
  // measured over how long, shut for how long, and reopened on what evidence.
  breaker: ['errorThreshold', 'windowMs', 'openMs', 'halfOpenProbes'],
};

/** Kinds whose throughput ceiling is capacity x (1000 / serviceMs). */
const HAS_THROUGHPUT_CEILING: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'lb',
  'service',
  'cache',
  'db',
  'worker',
]);

/**
 * One line on what the kind is for. This is the text that used to sit under
 * every palette row, where it forced the rail to 260px and left it mostly
 * empty. It belongs here, shown only for the one kind actually selected.
 */
const KIND_BLURB: Record<NodeKind, string> = {
  client:
    'Offers load and waits for an answer. Its timeout decides when a slow reply becomes a failure.',
  lb: 'Spreads requests across its targets. Its own pool and backlog can saturate before theirs do.',
  service:
    'The workhorse. Capacity slots x service time sets the ceiling everything else queues behind.',
  cache:
    'Answers hits without touching downstream. The hit rate is the knob that matters here.',
  db: 'Slots and service time. It does not retry for you, so its queue is where pressure shows.',
  queue:
    'A buffer. Depth is the whole story: it absorbs bursts up to the limit, then sheds.',
  worker:
    'Drains a queue at its own pace. Too few workers and the backlog never recovers.',
  replica:
    'Reads scale with the replica count, but a read can arrive before the last write has propagated. Watch the stale rate as you raise the lag.',
  shard:
    'Splits data across partitions by key, so capacity adds up — until one key gets hot and a single shard has to carry it alone.',
  autoscaler:
    'Watches one node and adds capacity when it runs hot. New capacity takes warmup time to arrive, so load always leads it.',
  region:
    'Sends traffic to one region at a time. If that region dies, failover costs you a full outage window before the next one takes over.',
  cdn: 'An edge cache in front of everything. At a 0.9 hit rate your origin sees a tenth of the traffic — the cheapest capacity you will ever add.',
  ratelimiter:
    'A token bucket. Refuses excess traffic instantly instead of queueing it, which is what stops a busy system turning into a dead one.',
  breaker:
    'Watches its downstream and stops calling it once it is failing. Cutting the traffic to zero is what gives a struggling dependency room to recover.',
};

/* ------------------------------------------------------------------ *
 * Field descriptors: label, unit, control shape, bounds.
 *
 * EVERY field carries a `unit`, including sliders. A slider's unit is
 * folded into its `display` string (`120ms`, `45%`, `12/s`) rather than
 * printed twice; the separate `unit` key is what the multi-edit summary
 * and the aria description use, so it is never absent.
 * ------------------------------------------------------------------ */

interface SliderSpec {
  control: 'slider';
  label: string;
  /** Stated for a11y and the multi-select summary; the display folds it in. */
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Renders the live value shown to the right of the track. */
  display: (v: number) => string;
}

interface NumberSpec {
  control: 'number';
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

type FieldSpec = SliderSpec | NumberSpec;

const FIELD_SPECS: Record<Field, FieldSpec> = {
  rps: {
    control: 'slider',
    label: 'Offered load',
    unit: 'requests per second',
    min: 1,
    max: 5000,
    step: 1,
    display: (v) => formatRate(v),
  },
  capacity: {
    control: 'number',
    label: 'Capacity',
    unit: 'slots',
    min: 1,
    max: 4096,
    step: 1,
  },
  serviceMs: {
    control: 'slider',
    label: 'Service time',
    unit: 'milliseconds',
    min: 0.1,
    max: 500,
    step: 0.1,
    display: (v) => formatMs(v),
  },
  serviceCv: {
    control: 'slider',
    label: 'Service variance',
    unit: 'coefficient of variation',
    min: 0,
    max: 2,
    step: 0.05,
    display: (v) => (v === 0 ? 'fixed' : `cv ${v.toFixed(2)}`),
  },
  queueLimit: {
    control: 'number',
    label: 'Queue limit',
    unit: 'reqs',
    min: 0,
    max: 20000,
    step: 1,
  },
  hitRate: {
    control: 'slider',
    label: 'Hit rate',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  errorRate: {
    control: 'slider',
    label: 'Error rate',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.005,
    display: (v) => formatPct(v),
  },
  timeoutMs: {
    control: 'slider',
    label: 'Timeout',
    unit: 'milliseconds',
    min: 0,
    max: 5000,
    step: 10,
    display: (v) => (v === 0 ? 'none' : formatMs(v)),
  },
  retries: {
    control: 'number',
    label: 'Retries',
    unit: 'attempts',
    min: 0,
    max: 10,
    step: 1,
  },
  replicaCount: {
    control: 'number',
    label: 'Replicas',
    unit: 'nodes',
    min: 1,
    max: 64,
    step: 1,
  },
  replicationLagMs: {
    control: 'slider',
    label: 'Replication lag',
    unit: 'milliseconds',
    min: 0,
    max: 2000,
    step: 5,
    display: (v) => (v === 0 ? 'synchronous' : formatMs(v)),
  },
  readFraction: {
    control: 'slider',
    label: 'Read fraction',
    unit: 'percent of traffic',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  shardCount: {
    control: 'number',
    label: 'Shards',
    unit: 'partitions',
    min: 1,
    max: 64,
    step: 1,
  },
  shardCapacity: {
    control: 'number',
    label: 'Slots per shard',
    unit: 'slots',
    min: 1,
    max: 512,
    step: 1,
  },
  hotKeyFraction: {
    control: 'slider',
    label: 'Hot key share',
    unit: 'percent onto one shard',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => (v === 0 ? 'even' : formatPct(v)),
  },
  targetUtil: {
    control: 'slider',
    label: 'Target utilisation',
    unit: 'percent',
    min: 0.1,
    max: 0.95,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  minCapacity: {
    control: 'number',
    label: 'Min capacity',
    unit: 'slots',
    min: 1,
    max: 512,
    step: 1,
  },
  maxCapacity: {
    control: 'number',
    label: 'Max capacity',
    unit: 'slots',
    min: 1,
    max: 512,
    step: 1,
  },
  cooldownMs: {
    control: 'slider',
    label: 'Cooldown',
    unit: 'milliseconds',
    min: 0,
    max: 30000,
    step: 250,
    display: (v) => formatMs(v),
  },
  scaleStepPct: {
    control: 'slider',
    label: 'Scale step',
    unit: 'percent of capacity',
    min: 0.05,
    max: 1,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  warmupMs: {
    control: 'slider',
    label: 'Warmup delay',
    unit: 'milliseconds',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'instant' : formatMs(v)),
  },
  regions: {
    control: 'number',
    label: 'Regions',
    unit: 'regions',
    min: 1,
    max: 8,
    step: 1,
  },
  activeRegion: {
    control: 'number',
    label: 'Active region',
    unit: 'index',
    min: 0,
    max: 7,
    step: 1,
  },
  failoverMs: {
    control: 'slider',
    label: 'Failover time',
    unit: 'milliseconds',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'instant' : formatMs(v)),
  },
  rateLimitRps: {
    control: 'slider',
    label: 'Rate limit',
    unit: 'requests per second',
    min: 0,
    max: 2000,
    step: 5,
    display: (v) => (v === 0 ? 'unlimited' : formatRate(Math.round(v))),
  },
  burst: {
    control: 'number',
    label: 'Burst',
    unit: 'tokens',
    min: 1,
    max: 5000,
    step: 1,
  },
  errorThreshold: {
    control: 'slider',
    label: 'Error threshold',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  windowMs: {
    control: 'slider',
    label: 'Error window',
    unit: 'milliseconds',
    min: 200,
    max: 30000,
    step: 100,
    display: (v) => formatMs(v),
  },
  openMs: {
    control: 'slider',
    label: 'Open for',
    unit: 'milliseconds',
    min: 100,
    max: 60000,
    step: 100,
    display: (v) => formatMs(v),
  },
  halfOpenProbes: {
    control: 'number',
    label: 'Half-open probes',
    unit: 'requests',
    min: 1,
    max: 50,
    step: 1,
  },
};

/**
 * Grouping WITHIN a kind's field list.
 *
 * A replica shows seven knobs. Three are about replication and four are
 * the ordinary server knobs underneath it, and reading them as one flat
 * list of seven is what makes a panel feel like a form. The order of
 * FIELDS_BY_KIND is preserved inside each group, and a group with no
 * fields for this kind is not rendered — so this never introduces a knob
 * a kind does not have, which is the invariant that matters.
 */
const FIELD_GROUPS: { title: string; fields: ReadonlySet<Field> }[] = [
  {
    // The knob that teaches this kind's lesson goes first, alone.
    title: 'Behaviour',
    fields: new Set<Field>([
      'rps',
      'hitRate',
      'replicaCount',
      'replicationLagMs',
      'readFraction',
      'shardCount',
      'shardCapacity',
      'hotKeyFraction',
      'targetUtil',
      'minCapacity',
      'maxCapacity',
      'cooldownMs',
      'scaleStepPct',
      'warmupMs',
      'regions',
      'activeRegion',
      'failoverMs',
      'rateLimitRps',
      'burst',
      'errorThreshold',
      'windowMs',
      'openMs',
      'halfOpenProbes',
    ]),
  },
  {
    title: 'Capacity',
    fields: new Set<Field>(['capacity', 'serviceMs', 'serviceCv', 'queueLimit']),
  },
  {
    title: 'Failure',
    fields: new Set<Field>(['errorRate', 'timeoutMs', 'retries']),
  },
];

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function SliderRow({
  spec,
  value,
  mixed,
  onChange,
}: {
  spec: SliderSpec;
  value: number;
  /** True when a multi-selection disagrees on this field. */
  mixed?: boolean;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="ins-field">
      <div className="ins-field-head">
        <label className="row-k" htmlFor={id}>
          {spec.label}
        </label>
        <span className={mixed ? 'row-v ins-mixed' : 'row-v'}>
          {mixed ? 'mixed' : spec.display(value)}
        </span>
      </div>
      <input
        id={id}
        className="slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        aria-describedby={`${id}-u`}
        aria-valuetext={mixed ? 'mixed' : spec.display(value)}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span id={`${id}-u`} className="sr-only">
        {spec.unit}
      </span>
    </div>
  );
}

function NumberRow({
  spec,
  value,
  mixed,
  onChange,
}: {
  spec: NumberSpec;
  value: number;
  mixed?: boolean;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="ins-field-row">
      <label className="row-k" htmlFor={id}>
        {spec.label}
      </label>
      <span className="ins-number-wrap">
        <input
          id={id}
          className="ins-number"
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          placeholder={mixed ? '—' : undefined}
          data-mixed={mixed || undefined}
          onChange={(e) => {
            const raw = Number(e.currentTarget.value);
            if (!Number.isFinite(raw)) return;
            const clamped = Math.min(
              spec.max,
              Math.max(spec.min, Math.round(raw)),
            );
            onChange(clamped);
          }}
        />
        <span className="label ins-unit">{spec.unit}</span>
      </span>
    </div>
  );
}

/**
 * One live readout. `tone` is a health class or undefined — at 'ok' the value
 * stays neutral, so a healthy panel carries no colour at all and --warn /
 * --danger keep their meaning for when they do appear.
 */
function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="ins-stat">
      <span className="row-k">{label}</span>
      <span className={tone ? `row-v ${tone}` : 'row-v'}>{value}</span>
    </div>
  );
}

/**
 * A ratio rendered as a multiple: `3.8x`, `0.6x`, `<0.1x`.
 *
 * Rule 1 applies here as it does to every other readout: a node running at
 * twenty times its ceiling has a headroom of 0.05, and `0.0x` would say it has
 * none to spare when what it actually has is a deficit. Below the display step
 * it degrades to a bound rather than to zero.
 */
function formatMultiple(v: number): string {
  if (!Number.isFinite(v) || v < 0) return NA;
  if (v === 0) return '0x';
  if (v < 0.1) return '<0.1x';
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, '')}x`;
  return `${formatCount(v)}x`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ins-section">
      <h2 className="label ins-section-title">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A utilisation meter. Length is the primary channel and colour the
 * secondary one, so the reading survives both a colourblind student and a
 * greyscale screenshot. Width is clamped into 0..1 before it reaches CSS,
 * so an oversubscribed node pins the bar at full rather than overflowing
 * its track.
 */
function Meter({ value, tone }: { value: number; tone?: string }) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const pct = Math.min(1, safe) * 100;
  return (
    <div
      className={tone ? `ins-meter ${tone}` : 'ins-meter'}
      role="img"
      aria-label={`Utilisation ${formatPct(value)}`}
    >
      <div className="ins-meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Multi-selection helpers
 * ------------------------------------------------------------------ */

/** Read a config field, falling back to the kind's own default. */
function readField(node: SimNode, field: Field): number {
  const v = node.config[field];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const d = defaultConfig(node.kind)[field];
  return typeof d === 'number' && Number.isFinite(d) ? d : 0;
}

/**
 * The common value of `field` across every node, or null when they
 * disagree. Null is what drives the `mixed` display — a multi-edit must
 * never invent a value that no selected node actually holds.
 */
function commonValue(nodes: readonly SimNode[], field: Field): number | null {
  if (nodes.length === 0) return null;
  const first = readField(nodes[0]!, field);
  for (let i = 1; i < nodes.length; i += 1) {
    if (readField(nodes[i]!, field) !== first) return null;
  }
  return first;
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

export interface InspectorProps {
  /**
   * The single selected node, or null. Unchanged, so the existing shell
   * call site keeps working exactly as it does today.
   */
  node: SimNode | null;
  stats: NodeStats | null;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;

  /* ---- multi-selection: all optional, all additive ---------------- *
   * The canvas rewrite made a multi-selection reachable, but the shell
   * still resolves a selection of one down to `node`. These props let it
   * hand over the whole selection instead, WITHOUT any of them being
   * required — omit them and the panel behaves exactly as before.
   * ------------------------------------------------------------------ */

  /**
   * Every selected node. When this holds two or more, it takes precedence
   * over `node` and the panel renders the multi-selection view.
   */
  selectedNodes?: readonly SimNode[];
  /** Count of selected EDGES, for the summary line. Nodes come from above. */
  selectedEdgeCount?: number;
  /**
   * Apply one config patch to many nodes at once. Optional: without it a
   * multi-selection is still summarised, just not editable.
   */
  onChangeMany?: (ids: readonly string[], patch: Partial<NodeConfig>) => void;
  /** Delete the whole selection. Falls back to per-node `onDelete`. */
  onDeleteMany?: (ids: readonly string[]) => void;
}

export function Inspector({
  node,
  stats,
  onChange,
  onDelete,
  onRename,
  selectedNodes,
  selectedEdgeCount = 0,
  onChangeMany,
  onDeleteMany,
}: InspectorProps) {
  /**
   * The selection this panel is actually describing. `selectedNodes` wins
   * when it carries a real multi-selection; otherwise the panel falls back
   * to the single `node` prop the shell passes today.
   */
  const nodes = useMemo<readonly SimNode[]>(() => {
    if (selectedNodes && selectedNodes.length > 0) return selectedNodes;
    return node ? [node] : [];
  }, [selectedNodes, node]);

  const multi = nodes.length > 1;

  /* Nothing selected. Edges may still be, so the empty state reports that
     rather than claiming the canvas selection is empty when it is not. */
  if (nodes.length === 0) {
    return (
      <aside className="ins" aria-label="Inspector">
        <div className="ins-scroll scroll">
          {selectedEdgeCount > 0 ? (
            <>
              <p className="ins-empty">
                {selectedEdgeCount === 1
                  ? '1 connection selected.'
                  : `${selectedEdgeCount} connections selected.`}
              </p>
              <p className="ins-empty ins-empty-hint">
                Connections carry no settings yet. Press Delete to remove them.
              </p>
            </>
          ) : (
            <p className="ins-empty">
              Select a component on the canvas to configure it.
            </p>
          )}
        </div>
      </aside>
    );
  }

  if (multi) {
    return (
      <MultiInspector
        nodes={nodes}
        edgeCount={selectedEdgeCount}
        onChange={onChange}
        onChangeMany={onChangeMany}
        onDelete={onDelete}
        onDeleteMany={onDeleteMany}
      />
    );
  }

  return (
    <SingleInspector
      node={nodes[0]!}
      stats={stats}
      onChange={onChange}
      onDelete={onDelete}
      onRename={onRename}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Single-node view
 * ------------------------------------------------------------------ */

function SingleInspector({
  node,
  stats,
  onChange,
  onDelete,
  onRename,
}: {
  node: SimNode;
  stats: NodeStats | null;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
}) {
  const fields = FIELDS_BY_KIND[node.kind];
  const cfg = node.config;

  // Derived ceiling: how many requests per second this node can finish if
  // every slot stays busy. Recomputed live as capacity/serviceMs move.
  const showCeiling = HAS_THROUGHPUT_CEILING.has(node.kind) && cfg.serviceMs > 0;
  const maxThroughput = showCeiling ? cfg.capacity * (1000 / cfg.serviceMs) : 0;

  // Headroom answers "is this the bottleneck?" without reading a chart:
  // the ceiling divided by what is actually arriving. Below 1.0x the node
  // cannot keep up, which is why it is toned by the same load thresholds.
  const arrivals = stats?.arrivalRate ?? 0;
  const headroom =
    showCeiling && arrivals > 0 && maxThroughput > 0
      ? maxThroughput / arrivals
      : null;

  const serviceMsLabel =
    cfg.serviceMs < 10 ? cfg.serviceMs.toFixed(1) : String(Math.round(cfg.serviceMs));

  /* Group this kind's fields. A group with nothing in it is dropped, so a
     ratelimiter shows one group and a replica shows two — the filtering
     invariant is preserved because the groups only ever PARTITION the
     kind's own list, never extend it. */
  const grouped = FIELD_GROUPS.map((g) => ({
    title: g.title,
    fields: fields.filter((f) => g.fields.has(f)),
  })).filter((g) => g.fields.length > 0);

  const util = stats?.utilization ?? 0;
  const utilTone = toneClass(healthOfLoad(util));

  return (
    <aside className="ins" aria-label="Inspector">
      <div className="ins-scroll scroll">
        <header className="ins-head">
          <input
            className="ins-title"
            type="text"
            value={node.label}
            spellCheck={false}
            aria-label="Node name"
            onChange={(e) => onRename(node.id, e.currentTarget.value)}
          />
          <span className="label ins-kind">{KIND_NAME[node.kind]}</span>
        </header>

        <p className="ins-blurb">{KIND_BLURB[node.kind]}</p>

        {/* Utilisation gets a meter rather than another number in a list:
            it is the one value that answers "is this the problem". Clients
            serve nothing, so they have no utilisation to show. */}
        {stats && node.kind !== 'client' ? (
          <div className="ins-util">
            <div className="ins-util-head">
              <span className="label">Utilisation</span>
              <span className={utilTone ? `num num-md ${utilTone}` : 'num num-md'}>
                {formatPct(util)}
              </span>
            </div>
            <Meter value={util} tone={utilTone} />
          </div>
        ) : null}

        {grouped.map((group) => (
          <Section key={group.title} title={group.title}>
            <div className="ins-fields">
              {group.fields.map((field) => {
                const spec = FIELD_SPECS[field];
                // Fields that only some kinds read are optional on NodeConfig,
                // so a node saved by an older build can be missing one. Fall
                // back to this kind's default rather than to the spec's
                // minimum, which would silently show the student a value that
                // is not the one the engine is actually running with.
                const value = readField(node, field);
                return spec.control === 'slider' ? (
                  <SliderRow
                    key={field}
                    spec={spec}
                    value={value}
                    onChange={(v) => onChange(node.id, { [field]: v })}
                  />
                ) : (
                  <NumberRow
                    key={field}
                    spec={spec}
                    value={value}
                    onChange={(v) => onChange(node.id, { [field]: v })}
                  />
                );
              })}
            </div>
          </Section>
        ))}

        {showCeiling && (
          <Section title="Derived">
            <div className="ins-stats">
              <StatRow label="Max throughput" value={formatRate(maxThroughput)} />
              <p className="ins-expr">
                {formatCount(cfg.capacity)} slots x 1000/{serviceMsLabel}ms
              </p>
              {headroom !== null && (
                <StatRow
                  label="Headroom"
                  value={formatMultiple(headroom)}
                  tone={toneClass(healthOfLoad(arrivals / maxThroughput))}
                />
              )}
            </div>
          </Section>
        )}

        <Section title="Live">
          {stats ? (
            <div className="ins-stats">
              <StatRow label="In flight" value={formatCount(stats.inFlight)} />
              <StatRow
                label={node.kind === 'queue' ? 'Backlog' : 'Queued'}
                value={formatCount(stats.queued)}
              />
              <StatRow label="Throughput" value={formatRate(stats.throughput)} />
              <StatRow label="Arrivals" value={formatRate(stats.arrivalRate)} />
              {(node.kind === 'cache' || node.kind === 'cdn') && (
                <StatRow label="Observed hit rate" value={formatPct(stats.hitRate)} />
              )}
              <StatRow label="p50" value={formatMs(stats.p50)} />
              <StatRow label="p95" value={formatMs(stats.p95)} />
              <StatRow
                label="p99"
                value={formatMs(stats.p99)}
                tone={toneClass(healthOfLatency(stats.p99))}
              />
              <StatRow
                label="Errors"
                value={formatPct(stats.errorRate)}
                tone={toneClass(healthOfErr(stats.errorRate))}
              />
              {stats.shedRate > 0 && (
                <StatRow
                  label="Shed"
                  value={formatRate(stats.shedRate)}
                  tone="is-danger"
                />
              )}
              {stats.timeoutRate > 0 && (
                <StatRow
                  label="Timed out"
                  value={formatRate(stats.timeoutRate)}
                  tone="is-danger"
                />
              )}
              <StatRow label="Completed" value={formatCount(stats.totalCompleted)} />
              <StatRow label="Failed" value={formatCount(stats.totalFailed)} />
            </div>
          ) : (
            <p className="ins-blurb">No traffic through this node yet.</p>
          )}
        </Section>
      </div>

      <div className="ins-foot">
        <button
          type="button"
          className="btn btn-danger ins-delete"
          onClick={() => onDelete(node.id)}
        >
          Delete component
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Multi-selection view
 *
 * Two cases, and they are genuinely different:
 *
 *   SAME KIND    every selected node exposes the same knobs, so the panel
 *                shows those knobs and writes each edit to all of them.
 *                A knob the nodes disagree on reads `mixed` and stays
 *                mixed until the student moves it — moving it is the act
 *                that means "make them all this".
 *
 *   MIXED KINDS  there is no shared knob list, so offering one would be a
 *                lie. The panel becomes a manifest: what is selected, how
 *                many of each, and the one action that always applies.
 * ------------------------------------------------------------------ */

function MultiInspector({
  nodes,
  edgeCount,
  onChange,
  onChangeMany,
  onDelete,
  onDeleteMany,
}: {
  nodes: readonly SimNode[];
  edgeCount: number;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onChangeMany?: (ids: readonly string[], patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onDeleteMany?: (ids: readonly string[]) => void;
}) {
  const ids = useMemo(() => nodes.map((n) => n.id), [nodes]);

  /** Count per kind, in the order the kinds first appear in the selection. */
  const byKind = useMemo(() => {
    const counts = new Map<NodeKind, number>();
    for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    return [...counts.entries()];
  }, [nodes]);

  const sameKind = byKind.length === 1;
  const kind = sameKind ? byKind[0]![0] : null;

  /**
   * Write one patch to every selected node. Prefers the batch callback so
   * the shell can fold the edit into a single state update; falls back to
   * per-node calls, which is correct but produces N updates.
   */
  const applyAll = useCallback(
    (patch: Partial<NodeConfig>) => {
      if (onChangeMany) {
        onChangeMany(ids, patch);
        return;
      }
      for (const id of ids) onChange(id, patch);
    },
    [ids, onChange, onChangeMany],
  );

  const deleteAll = useCallback(() => {
    if (onDeleteMany) {
      onDeleteMany(ids);
      return;
    }
    for (const id of ids) onDelete(id);
  }, [ids, onDelete, onDeleteMany]);

  const fields = kind ? FIELDS_BY_KIND[kind] : [];
  const grouped = FIELD_GROUPS.map((g) => ({
    title: g.title,
    fields: fields.filter((f) => g.fields.has(f)),
  })).filter((g) => g.fields.length > 0);

  return (
    <aside className="ins" aria-label="Inspector">
      <div className="ins-scroll scroll">
        <header className="ins-head">
          <p className="ins-multi-title">
            <span className="num num-md">{formatCount(nodes.length)}</span>{' '}
            <span className="ins-multi-word">
              {nodes.length === 1 ? 'component' : 'components'}
            </span>
            {edgeCount > 0 ? (
              <>
                {' + '}
                <span className="num num-md">{formatCount(edgeCount)}</span>{' '}
                <span className="ins-multi-word">
                  {edgeCount === 1 ? 'connection' : 'connections'}
                </span>
              </>
            ) : null}
          </p>
          <span className="label ins-kind">
            {sameKind ? KIND_NAME[kind!] : 'Mixed selection'}
          </span>
        </header>

        {/* The manifest. It is the whole content when kinds differ, and a
            useful confirmation of what you grabbed when they do not. */}
        <ul className="ins-manifest">
          {byKind.map(([k, n]) => (
            <li key={k} className="ins-manifest-row">
              <span className="row-k">{KIND_NAME[k]}</span>
              <span className="row-v">{formatCount(n)}</span>
            </li>
          ))}
        </ul>

        {sameKind ? (
          <>
            <p className="ins-blurb">
              Editing a value below applies it to all{' '}
              {formatCount(nodes.length)} selected. A knob these components
              disagree on reads <em>mixed</em> until you move it.
            </p>

            {grouped.map((group) => (
              <Section key={group.title} title={group.title}>
                <div className="ins-fields">
                  {group.fields.map((field) => {
                    const spec = FIELD_SPECS[field];
                    const shared = commonValue(nodes, field);
                    const mixed = shared === null;
                    /* When the nodes disagree, the control still needs a
                       position. It shows the FIRST node's value but labels
                       itself `mixed`, so nothing claims the others hold it —
                       and the moment the student moves it, the value becomes
                       real for every one of them. */
                    const value = shared ?? readField(nodes[0]!, field);
                    return spec.control === 'slider' ? (
                      <SliderRow
                        key={field}
                        spec={spec}
                        value={value}
                        mixed={mixed}
                        onChange={(v) => applyAll({ [field]: v })}
                      />
                    ) : (
                      <NumberRow
                        key={field}
                        spec={spec}
                        value={value}
                        mixed={mixed}
                        onChange={(v) => applyAll({ [field]: v })}
                      />
                    );
                  })}
                </div>
              </Section>
            ))}
          </>
        ) : (
          <p className="ins-blurb">
            These components expose different settings, so there is nothing
            common to edit. Select one at a time to configure it, or delete
            the whole selection below.
          </p>
        )}
      </div>

      <div className="ins-foot">
        <button
          type="button"
          className="btn btn-danger ins-delete"
          onClick={deleteAll}
        >
          Delete {formatCount(nodes.length)} selected
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * TrafficControl
 *
 * The RPS slider is the primary control of the app. The underlying range
 * is 1..5000, but a linear slider would spend 90% of its travel above
 * 500rps where nothing new happens. The position is mapped exponentially
 * so the low end -- where the interesting knee usually is -- is reachable.
 * ------------------------------------------------------------------ */

const RPS_MIN = 1;
const RPS_MAX = 5000;
const LOG_MIN = Math.log(RPS_MIN);
const LOG_MAX = Math.log(RPS_MAX);
/** Slider travel in discrete steps. Finer than 1-per-rps at the low end. */
const SLIDER_STEPS = 1000;

/** Slider position (0..SLIDER_STEPS) -> real requests per second. */
function positionToRps(pos: number): number {
  const t = pos / SLIDER_STEPS;
  const rps = Math.exp(LOG_MIN + t * (LOG_MAX - LOG_MIN));
  // Round to something a student can actually read and reproduce.
  if (rps < 20) return Math.round(rps);
  if (rps < 200) return Math.round(rps / 5) * 5;
  if (rps < 1000) return Math.round(rps / 10) * 10;
  return Math.round(rps / 50) * 50;
}

/** Real requests per second -> slider position (0..SLIDER_STEPS). */
function rpsToPosition(rps: number): number {
  const safe = Number.isFinite(rps) ? rps : RPS_MIN;
  const clamped = Math.min(RPS_MAX, Math.max(RPS_MIN, safe));
  const t = (Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return Math.round(t * SLIDER_STEPS);
}

/**
 * Scale marks, placed at their true log position rather than spread evenly.
 * An evenly-spaced 1/10/100/1k/5k row lies about where the thumb will land:
 * 1k sits at 69% of the travel, not 75%.
 */
const SCALE_MARKS = [1, 10, 100, 1000, 5000];

export interface TrafficControlProps {
  rps: number;
  onRpsChange: (rps: number) => void;
  running: boolean;
  onToggleRun: () => void;
  onStep: () => void;
  onReset: () => void;
  system: SystemStats;
  /** Requests actually lost per second, from the engine's per-reason counters. */
  lost: number;
}

export function TrafficControl({
  rps,
  onRpsChange,
  running,
  onToggleRun,
  onStep,
  onReset,
  system,
  lost,
}: TrafficControlProps) {
  const sliderId = useId();

  const p99Tone = toneClass(healthOfLatency(system.p99));
  const errTone = toneClass(healthOfErr(system.errorRate));

  // Traffic that actually FAILED, while it is failing. Deliberately not
  // `offered - goodput`: that gap is mostly in-flight work and is largest
  // during warm-up, so using it made a healthy system flash a red
  // "Dropped 10/s" next to an error rate of exactly zero. `errorRate` is
  // the engine's own fraction of requests that errored or were shed.
  const dropped = Number.isFinite(lost) ? Math.max(0, lost) : 0;
  const showDropped = dropped > 0.5;

  return (
    <div className="traffic">
      {/* Cause. The only thing on screen the student directly controls, and
          therefore the only input that gets a hero-sized number. */}
      <div className="traffic-load">
        <div className="traffic-load-head">
          <label className="label" htmlFor={sliderId}>
            Offered load
          </label>
          <span className="traffic-load-readout">
            <span className="num num-hero">{formatRateBare(rps)}</span>
            <span className="label traffic-load-unit">rps</span>
          </span>
        </div>
        <div className="traffic-load-track">
          <input
            id={sliderId}
            className="slider"
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={rpsToPosition(rps)}
            aria-valuetext={`${Math.round(rps)} requests per second`}
            onChange={(e) => onRpsChange(positionToRps(Number(e.currentTarget.value)))}
          />
          <div className="traffic-scale" aria-hidden="true">
            {SCALE_MARKS.map((m) => (
              <span
                key={m}
                className="num traffic-scale-mark"
                style={{ left: `${(rpsToPosition(m) / SLIDER_STEPS) * 100}%` }}
              >
                {m >= 1000 ? `${m / 1000}k` : m}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="traffic-spacer" />

      {/* Effect. p99 is the number students should watch, so it carries the
          only other hero, toned by the same threshold as the chart line. */}
      <div className="traffic-headline">
        <div className="traffic-metric">
          <span className="label">System p99</span>
          <span className={p99Tone ? `num num-hero ${p99Tone}` : 'num num-hero'}>
            {formatMs(system.p99)}
          </span>
        </div>

        <div className="traffic-metric-group">
          <div className="traffic-metric">
            <span className="label">Goodput</span>
            <span className="num num-md">{formatRate(system.goodputRps)}</span>
          </div>
          <div className="traffic-metric">
            <span className="label">Errors</span>
            <span className={errTone ? `num num-md ${errTone}` : 'num num-md'}>
              {formatPct(system.errorRate)}
            </span>
          </div>
          {showDropped && (
            <div className="traffic-metric">
              <span className="label">Dropped</span>
              <span className="num num-md is-danger">{formatRate(dropped)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="traffic-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onToggleRun}
          aria-pressed={running}
        >
          {running ? 'Pause' : 'Play'}
        </button>
        {/* Stepping is only meaningful against a stopped clock, and it
            pauses on its own, so the control states what it will do. */}
        <button type="button" className="btn" onClick={onStep}>
          Step
        </button>
        <button type="button" className="btn" onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
