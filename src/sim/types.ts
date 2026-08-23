export type NodeKind =
  | 'client'
  | 'lb'
  | 'service'
  | 'cache'
  | 'db'
  | 'queue'
  | 'worker';

/** Tunable knobs per node kind. Not every field applies to every kind. */
export interface NodeConfig {
  /** Number of parallel request slots (threads / connections / shards). */
  capacity: number;
  /** Mean service time in ms for one request. */
  serviceMs: number;
  /** Coefficient of variation of service time. 0 = deterministic, 1 = exponential. */
  serviceCv: number;
  /** Max queued requests before shedding load. */
  queueLimit: number;
  /** Fraction of reads answered without hitting downstream. Cache only. */
  hitRate: number;
  /** Probability a request fails on its own (bad deploy, bug). */
  errorRate: number;
  /** ms after which the caller gives up. 0 = no timeout. */
  timeoutMs: number;
  /** Retries on failure/timeout. */
  retries: number;
  /** Client only: requests per second offered to the system. */
  rps: number;
}

export interface SimNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  config: NodeConfig;
}

export interface SimEdge {
  id: string;
  from: string;
  to: string;
  /** Share of traffic leaving `from` that takes this edge (relative weight). */
  weight: number;
}

export interface Topology {
  nodes: SimNode[];
  edges: SimEdge[];
}

/** Rolling stats for one node over the last window. */
export interface NodeStats {
  /** Requests currently being served. */
  inFlight: number;
  /** Requests waiting for a slot. */
  queued: number;
  /** Completed requests per second. */
  throughput: number;
  /** Offered load per second (including those later dropped). */
  arrivalRate: number;
  /** Fraction of slots busy, 0..1. Can exceed 1 conceptually if oversubscribed. */
  utilization: number;
  p50: number;
  p95: number;
  p99: number;
  /** Fraction of requests that errored or were shed, 0..1. */
  errorRate: number;
  /** Requests dropped due to a full queue, per second. */
  shedRate: number;
  /** Requests that exceeded the caller's timeout, per second. */
  timeoutRate: number;
  /** Cache hit fraction observed this window (cache nodes only). */
  hitRate: number;
  /** Total completed since sim start. */
  totalCompleted: number;
  /** Total failed since sim start. */
  totalFailed: number;
}

/** End-to-end results measured at the client. */
export interface SystemStats {
  timeMs: number;
  offeredRps: number;
  goodputRps: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  totalRequests: number;
  totalFailed: number;
}

export type FailureReason = 'error' | 'shed' | 'timeout' | 'no-route' | 'depth';

export interface SimSnapshot {
  system: SystemStats;
  nodes: Record<string, NodeStats>;
  /** Recent history for sparklines, newest last. */
  history: HistoryPoint[];
  /** Per-edge requests/sec, keyed by edge id. */
  edgeFlow: Record<string, number>;
  failuresByReason: Record<FailureReason, number>;
}

export interface HistoryPoint {
  t: number;
  p50: number;
  p95: number;
  p99: number;
  goodput: number;
  offered: number;
  errorRate: number;
}
