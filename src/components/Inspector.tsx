import { useId } from 'react';
import type { NodeConfig, NodeKind, NodeStats, SimNode, SystemStats } from '../sim/types';
import { formatMs, formatPct, formatRate } from './format';
import './Inspector.css';

/* ------------------------------------------------------------------ *
 * Which knobs actually apply to which kind.
 *
 * This is the whole point of the panel: a cache shows hitRate, a db does
 * not; a client shows the load it offers and how long it waits; a queue
 * shows only how deep it may get. Nine knobs on every node would make the
 * app look configurable and feel meaningless.
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
  | 'retries';

const FIELDS_BY_KIND: Record<NodeKind, Field[]> = {
  // The client generates load and decides how long to wait for an answer.
  // It serves nothing, so it has no capacity, service time, or queue.
  client: ['rps', 'timeoutMs', 'retries'],
  // A load balancer forwards; its own service time is near-zero but its
  // connection pool and backlog are real and can saturate.
  lb: ['capacity', 'serviceMs', 'queueLimit'],
  // The general workhorse: everything except cache hits and offered load.
  service: ['capacity', 'serviceMs', 'serviceCv', 'queueLimit', 'errorRate', 'timeoutMs', 'retries'],
  // Only the cache has a hit rate. That single knob is the interesting one.
  cache: ['capacity', 'serviceMs', 'serviceCv', 'hitRate', 'queueLimit'],
  // A database is slots and service time. It does not retry on your behalf.
  db: ['capacity', 'serviceMs', 'serviceCv', 'queueLimit', 'errorRate'],
  // A queue is a buffer. Depth is the only thing that matters about it.
  queue: ['queueLimit', 'serviceMs'],
  // Workers drain a queue. No inbound queue limit of their own.
  worker: ['capacity', 'serviceMs', 'serviceCv', 'errorRate'],
};

/** Kinds whose throughput ceiling is capacity x (1000 / serviceMs). */
const HAS_THROUGHPUT_CEILING: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'lb',
  'service',
  'cache',
  'db',
  'worker',
]);

const KIND_LABEL: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load Balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
};

/* ------------------------------------------------------------------ *
 * Field descriptors: label, unit, control shape, bounds.
 * ------------------------------------------------------------------ */

interface SliderSpec {
  control: 'slider';
  label: string;
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
    min: 1,
    max: 5000,
    step: 1,
    display: (v) => `${formatRate(v)}/s`,
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
    min: 0.1,
    max: 500,
    step: 0.1,
    display: (v) => formatMs(v),
  },
  serviceCv: {
    control: 'slider',
    label: 'Service variance',
    min: 0,
    max: 2,
    step: 0.05,
    display: (v) => v.toFixed(2),
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
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  errorRate: {
    control: 'slider',
    label: 'Error rate',
    min: 0,
    max: 1,
    step: 0.005,
    display: (v) => formatPct(v),
  },
  timeoutMs: {
    control: 'slider',
    label: 'Timeout',
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
};

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function SliderRow({
  spec,
  value,
  onChange,
}: {
  spec: SliderSpec;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-head">
        <label className="field-label" htmlFor={id}>
          {spec.label}
        </label>
        <span className="field-value">{spec.display(value)}</span>
      </div>
      <input
        id={id}
        className="slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}

function NumberRow({
  spec,
  value,
  onChange,
}: {
  spec: NumberSpec;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="field field-inline">
      <label className="field-label" htmlFor={id}>
        {spec.label}
      </label>
      <div className="number-wrap">
        <input
          id={id}
          className="number"
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          onChange={(e) => {
            const raw = Number(e.currentTarget.value);
            if (!Number.isFinite(raw)) return;
            const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(raw)));
            onChange(clamped);
          }}
        />
        <span className="field-unit">{spec.unit}</span>
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className={tone ? `stat-value tone-${tone}` : 'stat-value'}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Thresholds. Shared with TrafficControl so the two agree on colour.
 * ------------------------------------------------------------------ */

function utilizationTone(u: number): 'ok' | 'warn' | 'danger' {
  if (u >= 0.9) return 'danger';
  if (u >= 0.7) return 'warn';
  return 'ok';
}

function errorTone(rate: number): 'ok' | 'warn' | 'danger' {
  if (rate >= 0.05) return 'danger';
  if (rate >= 0.005) return 'warn';
  return 'ok';
}

function latencyTone(p99: number): 'ok' | 'warn' | 'danger' {
  if (p99 >= 1000) return 'danger';
  if (p99 >= 250) return 'warn';
  return 'ok';
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

export interface InspectorProps {
  node: SimNode | null;
  stats: NodeStats | null;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
}

export function Inspector({ node, stats, onChange, onDelete, onRename }: InspectorProps) {
  if (!node) {
    return (
      <aside className="inspector">
        <p className="inspector-empty">Select a node to configure it.</p>
      </aside>
    );
  }

  const fields = FIELDS_BY_KIND[node.kind];
  const cfg = node.config;

  // Derived ceiling: how many requests per second this node can finish if
  // every slot stays busy. Recomputed live as capacity/serviceMs move.
  const showCeiling = HAS_THROUGHPUT_CEILING.has(node.kind) && cfg.serviceMs > 0;
  const maxThroughput = showCeiling ? cfg.capacity * (1000 / cfg.serviceMs) : 0;

  return (
    <aside className="inspector">
      <header className="inspector-head">
        <input
          className="title-input"
          type="text"
          value={node.label}
          spellCheck={false}
          aria-label="Node name"
          onChange={(e) => onRename(node.id, e.currentTarget.value)}
        />
        <span className="kind-tag">{KIND_LABEL[node.kind]}</span>
      </header>

      <section className="section">
        {fields.map((field) => {
          const spec = FIELD_SPECS[field];
          const value = cfg[field];
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
      </section>

      {showCeiling && (
        <p className="derived">
          Max throughput ={' '}
          <span className="derived-expr">
            {cfg.capacity} x 1000/{cfg.serviceMs < 10 ? cfg.serviceMs.toFixed(1) : Math.round(cfg.serviceMs)}
          </span>{' '}
          = <span className="derived-result">{formatRate(maxThroughput)}/s</span>
        </p>
      )}

      <div className="section-rule" />

      <section className="section">
        {stats ? (
          <div className="stat-list">
            {node.kind !== 'client' && (
              <StatRow
                label="Utilization"
                value={formatPct(stats.utilization)}
                tone={utilizationTone(stats.utilization)}
              />
            )}
            <StatRow label="In flight" value={formatRate(stats.inFlight)} />
            <StatRow
              label={node.kind === 'queue' ? 'Backlog' : 'Queued'}
              value={formatRate(stats.queued)}
            />
            <StatRow label="Throughput" value={`${formatRate(stats.throughput)}/s`} />
            <StatRow label="Arrivals" value={`${formatRate(stats.arrivalRate)}/s`} />
            {node.kind === 'cache' && (
              <StatRow label="Observed hit rate" value={formatPct(stats.hitRate)} />
            )}
            <StatRow label="p50" value={formatMs(stats.p50)} />
            <StatRow label="p95" value={formatMs(stats.p95)} />
            <StatRow label="p99" value={formatMs(stats.p99)} />
            <StatRow
              label="Errors"
              value={formatPct(stats.errorRate)}
              tone={errorTone(stats.errorRate)}
            />
            {stats.shedRate > 0 && (
              <StatRow label="Shed" value={`${formatRate(stats.shedRate)}/s`} tone="danger" />
            )}
            {stats.timeoutRate > 0 && (
              <StatRow
                label="Timed out"
                value={`${formatRate(stats.timeoutRate)}/s`}
                tone="danger"
              />
            )}
          </div>
        ) : (
          <p className="stats-idle">No traffic yet.</p>
        )}
      </section>

      <div className="section-rule" />

      <button type="button" className="btn btn-danger" onClick={() => onDelete(node.id)}>
        Delete node
      </button>
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
  const clamped = Math.min(RPS_MAX, Math.max(RPS_MIN, rps));
  const t = (Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return Math.round(t * SLIDER_STEPS);
}

export interface TrafficControlProps {
  rps: number;
  onRpsChange: (rps: number) => void;
  running: boolean;
  onToggleRun: () => void;
  onReset: () => void;
  system: SystemStats;
}

export function TrafficControl({
  rps,
  onRpsChange,
  running,
  onToggleRun,
  onReset,
  system,
}: TrafficControlProps) {
  const sliderId = useId();

  return (
    <div className="traffic">
      <div className="traffic-load">
        <div className="load-head">
          <label className="load-label" htmlFor={sliderId}>
            Offered load
          </label>
          <div className="load-readout">
            <span className="load-value">{formatRate(rps)}</span>
            <span className="load-unit">req/s</span>
          </div>
        </div>
        <input
          id={sliderId}
          className="slider slider-primary"
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={rpsToPosition(rps)}
          onChange={(e) => onRpsChange(positionToRps(Number(e.currentTarget.value)))}
        />
        <div className="load-scale">
          <span>1</span>
          <span>10</span>
          <span>100</span>
          <span>1k</span>
          <span>5k</span>
        </div>
      </div>

      <div className="traffic-actions">
        <button type="button" className="btn btn-primary" onClick={onToggleRun}>
          {running ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="btn" onClick={onReset}>
          Reset
        </button>
      </div>

      <div className="headline">
        <div className="headline-primary">
          <span className="headline-label">p99 latency</span>
          <span className={`headline-value tone-${latencyTone(system.p99)}`}>
            {formatMs(system.p99)}
          </span>
        </div>
        <div className="headline-secondary">
          <div className="headline-item">
            <span className="headline-label">Goodput</span>
            <span className="headline-sub">{formatRate(system.goodputRps)}/s</span>
          </div>
          <div className="headline-item">
            <span className="headline-label">Errors</span>
            <span className={`headline-sub tone-${errorTone(system.errorRate)}`}>
              {formatPct(system.errorRate)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
