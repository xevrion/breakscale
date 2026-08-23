export type NodeKind =
  | 'client'
  | 'lb'
  | 'service'
  | 'cache'
  | 'db'
  | 'queue'
  | 'worker'
  | 'autoscaler'
  | 'region'
  | 'cdn'
  | 'ratelimiter'
  | 'breaker'
  | 'replica'
  | 'shard';

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

  /* ---- autoscaler ------------------------------------------------- *
   * An autoscaler is a controller, not a request path. It watches one
   * downstream node's utilisation and writes that node's `capacity`.
   * ------------------------------------------------------------------ */

  /**
   * Autoscaler only: utilisation the controller aims to hold the watched
   * node at, 0..1. Above it the controller scales up, below `targetUtil`
   * minus a dead band it scales down.
   */
  targetUtil?: number;
  /** Autoscaler only: floor on the watched node's capacity, in slots. */
  minCapacity?: number;
  /** Autoscaler only: ceiling on the watched node's capacity, in slots. */
  maxCapacity?: number;
  /**
   * Autoscaler only: ms the controller must wait after one decision before
   * it may make another. Models the metric/decision interval of a real
   * autoscaler and is the main knob that determines whether it oscillates.
   */
  cooldownMs?: number;
  /**
   * Autoscaler only: size of a single scaling step as a fraction of current
   * capacity, 0..1. 0.5 means "add or remove half the current slots".
   */
  scaleStepPct?: number;
  /**
   * Autoscaler only: ms between a scale-UP decision and the new slots
   * actually becoming usable (boot + warm-up). Scale-DOWN is immediate, as
   * it is in reality. This delay is what makes capacity lag load.
   */
  warmupMs?: number;

  /* ---- region ------------------------------------------------------ *
   * A region node is a failover switch in front of N downstream edges,
   * where edge index i is region i.
   * ------------------------------------------------------------------ */

  /**
   * Region only: how many of this node's outgoing edges are treated as
   * regions. Edge index i is region i; edges beyond `regions` are ignored.
   */
  regions?: number;
  /**
   * Region only: index of the region currently serving traffic, 0-based.
   * Set by the student, and advanced automatically by failover.
   */
  activeRegion?: number;
  /**
   * Region only: ms of downtime between the active region being detected as
   * failed and traffic actually landing on the next one. Requests arriving
   * during this window fail with 'region-down' -- failover is not free.
   */
  failoverMs?: number;

  /* ---- ratelimiter -------------------------------------------------- *
   * A token bucket in front of a downstream. It refills continuously in
   * simulated time, so admissions over T seconds converge on rate*T rather
   * than being quantised by any tick interval.
   * ------------------------------------------------------------------- */

  /**
   * Rate limiter only: sustained admission rate in tokens (requests) per
   * second. One token is spent per admitted request; the bucket refills at
   * exactly this many tokens per second of simulated time.
   */
  rateLimitRps?: number;
  /**
   * Rate limiter only: bucket size in tokens. This is the largest burst
   * admitted instantly from an idle limiter, and it is also the bucket's
   * refill ceiling. Defaults to `rateLimitRps` when unset.
   */
  burst?: number;

  /* ---- breaker ------------------------------------------------------ *
   * A circuit breaker wrapping its downstream. It watches the downstream's
   * error rate over a trailing window and, once that exceeds the threshold,
   * fails fast without calling downstream at all.
   * ------------------------------------------------------------------- */

  /**
   * Breaker only: downstream error fraction over the trailing window above
   * which the breaker trips OPEN, 0..1. 0.5 means "trip once half the
   * downstream calls in the window are failing".
   */
  errorThreshold?: number;
  /**
   * Breaker only: length of the trailing window over which the downstream
   * error fraction is measured, in ms. Outcomes older than this are
   * forgotten, so a recovered downstream stops holding old failures.
   */
  windowMs?: number;
  /**
   * Breaker only: ms the breaker stays OPEN (failing fast) before it moves
   * to HALF-OPEN and allows probe traffic through again.
   */
  openMs?: number;
  /**
   * Breaker only: number of probe requests admitted while HALF-OPEN. If all
   * of them succeed the breaker CLOSES; if any fails it re-OPENS
   * immediately and the remaining probes are not sent.
   */
  halfOpenProbes?: number;

  /* ---- cdn ---------------------------------------------------------- *
   * An edge cache in front of everything. It reuses `hitRate`, `serviceMs`
   * and `capacity` from the common knobs above; a miss costs a round trip to
   * whatever origin is wired downstream, which is where its teaching value
   * lives. It needs no extra config field of its own.
   * ------------------------------------------------------------------- */
  /* ---- replica: a read-replica set behind a primary ---------------- */

  /**
   * Number of read replicas in the set. Read capacity is
   * `replicaCount * capacity` slots; writes are serialised through the
   * primary's own `capacity` slots. Floored to at least 1.
   */
  replicaCount: number;
  /**
   * Replication lag in ms: how long a write takes to reach the replicas.
   * A read of a key issued less than this long after that key was written
   * is served from a replica that has not caught up yet, and is counted as
   * a stale read. 0 means synchronous replication and never goes stale.
   */
  replicationLagMs: number;
  /**
   * Fraction of traffic that is reads, 0..1. Reads go to the replicas (and
   * may be stale); the remainder are writes, which go to the primary and
   * then propagate.
   */
  readFraction: number;

  /* ---- shard: horizontal partitioning ------------------------------ */

  /**
   * Number of partitions. A request is routed to `key % shardCount`, so
   * each shard is an independent queue-and-servers unit. Floored to >= 1.
   */
  shardCount: number;
  /**
   * Parallel request slots *per shard*. Total capacity across the node is
   * `shardCount * shardCapacity`, but a single shard can only ever use its
   * own slots -- which is exactly why a hot key melts one shard.
   */
  shardCapacity: number;
  /**
   * Fraction of traffic forced onto one single shard, 0..1, regardless of
   * the request's own key. 0 spreads traffic by key as normal; 0.8 sends
   * 80% of it to shard 0 and leaves the rest nearly idle.
   */
  hotKeyFraction: number;

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

  /* ---- link characteristics (networking phase) ---------------------- *
   * All optional and absent from every topology today, so nothing changes
   * until one is set. Only latencyMs is implemented; the other two are
   * declared now so the shape does not have to churn later.
   * ------------------------------------------------------------------- */

  /**
   * Propagation delay across this link, in ms. A request crossing the edge
   * waits this long before it is offered to the target node. Undefined or 0
   * means an instantaneous hop, which is what every current preset uses.
   */
  latencyMs?: number;
  /**
   * DECLARED BUT UNUSED. Link capacity in requests/sec. The networking phase
   * will use this to queue and delay traffic once an edge is saturated;
   * today the engine ignores it entirely.
   */
  bandwidthRps?: number;
  /**
   * DECLARED BUT UNUSED. Fraction of requests the link drops, 0..1. The
   * networking phase will fail crossings against this; today the engine
   * ignores it entirely.
   */
  lossRate?: number;
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

  /* ---- autoscaler readouts ---------------------------------------- */

  /**
   * Autoscaler only: capacity in slots the controller has decided the
   * watched node should have. Differs from the watched node's live capacity
   * for `warmupMs` after a scale-up, which is exactly the lag worth seeing.
   */
  targetCapacity?: number;
  /**
   * Autoscaler only: true while a scale-up decision is booked but its slots
   * have not warmed up yet.
   */
  scaling?: boolean;
  /** Autoscaler only: the watched node's capacity right now, in slots. */
  watchedCapacity?: number;
  /** Autoscaler only: the watched node's smoothed utilisation, 0..1. */
  watchedUtil?: number;

  /* ---- region readouts -------------------------------------------- */

  /** Region only: index of the region serving traffic right now, 0-based. */
  activeRegion?: number;
  /** Region only: true while mid-failover, when traffic is being dropped. */
  failingOver?: boolean;
  /**
   * Fraction of reads served from a replica that had not yet caught up with
   * the latest write to that key, 0..1, over the current window. Replica
   * nodes only. Rises with replicationLagMs and with write volume.
   */
  staleReadRate: number;
  /**
   * Utilisation of the single busiest shard, 0..1. Shard nodes only. With a
   * hot key this pins at 1 while `utilization` (the mean across shards)
   * still looks healthy -- that gap is the lesson.
   */
  maxShardUtilization: number;
  /** Utilisation of the least busy shard, 0..1. Shard nodes only. */
  minShardUtilization: number;
  /**
   * Per-shard utilisation, 0..1, indexed by shard number. Shard nodes only;
   * empty for every other kind. Length tracks shardCount.
   */
  shardUtilization: number[];

  /* ---- cdn readouts ------------------------------------------------ */

  /**
   * CDN only: requests per second this edge cache had to fetch from origin
   * because they missed. This is the load that actually reaches your
   * servers; offered minus this is what the CDN absorbed. The observed hit
   * fraction is reported in the shared `hitRate` field above.
   */
  originFetchRate?: number;

  /* ---- ratelimiter readouts ---------------------------------------- */

  /** Rate limiter only: requests per second admitted (a token was spent). */
  admittedRate?: number;
  /** Rate limiter only: requests per second rejected as 'throttled'. */
  throttledRate?: number;
  /** Rate limiter only: tokens sitting in the bucket right now. */
  tokens?: number;

  /* ---- breaker readouts -------------------------------------------- */

  /** Breaker only: the circuit's current state. */
  breakerState?: 'closed' | 'open' | 'half-open';
  /**
   * Breaker only: downstream error fraction measured over the trailing
   * `windowMs`, 0..1. This is the quantity compared against
   * `errorThreshold` to decide whether to trip.
   */
  breakerErrorRate?: number;
  /** Breaker only: requests per second failed fast without calling downstream. */
  rejectedRate?: number;
  /** Breaker only: times the circuit has tripped OPEN since sim start. */
  breakerTrips?: number;
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

export type FailureReason =
  | 'error'
  | 'shed'
  | 'timeout'
  | 'no-route'
  | 'depth'
  /** Refused by a rate limiter: no token was available in its bucket. */
  | 'throttled'
  /** Refused by an open circuit breaker: failed fast without calling downstream. */
  | 'rejected'
  /** The node is crashed by an injected failure, or was in flight when it crashed. */
  | 'crashed'
  /** The edge the call needed is cut by an injected network partition. */
  | 'partitioned'
  /** No region was serving: the active one is down and failover has not landed. */
  | 'region-down';

/* ------------------------------------------------------------------ *
 * Failure injection
 *
 * A chaos control, not a component: any node can be given a fault without
 * rewiring the topology, and clearing it restores the node exactly.
 * ------------------------------------------------------------------ */

export type FailureKind =
  /** The node is dead: in-flight work fails now, new work fails on arrival. */
  | 'crash'
  /** The node still works, but every service time is multiplied by `factor`. */
  | 'slow'
  /** The node returns errors at `rate`, on top of its configured errorRate. */
  | 'errors'
  /** Named edges are cut: a request offered to one fails as 'partitioned'. */
  | 'partition';

/** Knobs for an injected failure. Which ones apply depends on the kind. */
export interface FailureOpts {
  /**
   * 'slow' only: multiplier applied to the node's service time. 3 means
   * every request there takes three times as long. Values below 1 are
   * clamped to 1, since a fault may not make a node faster.
   */
  factor?: number;
  /**
   * 'errors' only: fraction of requests forced to fail at this node, 0..1.
   * Rolled independently of, and in addition to, config.errorRate.
   */
  rate?: number;
  /**
   * 'partition' only: ids of the edges to cut. Omitted or empty means every
   * edge leaving the node, which is the "unplug this box" case.
   */
  edgeIds?: string[];
}

/** An injected failure as reported back to the UI. */
export interface ActiveFailure {
  /** Node the failure is attached to. */
  nodeId: string;
  kind: FailureKind;
  /** Simulated time in ms at which it was injected. */
  sinceMs: number;
  /** 'slow' only: the service-time multiplier in force. */
  factor?: number;
  /** 'errors' only: the forced failure fraction, 0..1. */
  rate?: number;
  /** 'partition' only: the edge ids actually cut. */
  edgeIds?: string[];
}

export interface SimSnapshot {
  system: SystemStats;
  nodes: Record<string, NodeStats>;
  /** Recent history for sparklines, newest last. */
  history: HistoryPoint[];
  /** Per-edge requests/sec, keyed by edge id. */
  edgeFlow: Record<string, number>;
  failuresByReason: Record<FailureReason, number>;
  /**
   * Injected failures in force right now, one entry per faulted node. Empty
   * on a healthy system, so the UI can render a chaos indicator from this
   * alone without asking the engine anything else.
   */
  activeFailures: ActiveFailure[];
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
