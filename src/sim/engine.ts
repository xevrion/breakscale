import { behaviourFor, type ComponentBehaviour } from './behaviour';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import { MinHeap, type Timed } from './heap';
import { Rng } from './random';
import type {
  ActiveFailure,
  FailureKind,
  FailureOpts,
  FailureReason,
  HistoryPoint,
  NodeConfig,
  NodeStats,
  SimEdge,
  SimNode,
  SimSnapshot,
  SystemStats,
  Topology,
} from './types';

/* ------------------------------------------------------------------ *
 * Tuning constants
 * ------------------------------------------------------------------ */

/** Wall-clock delta is clamped to this so a backgrounded tab cannot death-spiral. */
const MAX_DELTA_MS = 100;
/** Hard ceiling on events processed per advance() call. */
const MAX_EVENTS_PER_ADVANCE = 60000;
/** Hop-depth ceiling; deeper resolves as FailureReason 'depth'. */
const MAX_HOP_DEPTH = 32;
/** Trailing window for latency percentiles. */
const LATENCY_WINDOW_MS = 5000;
/** Capacity of each latency ring buffer. */
const LATENCY_RING = 4096;
/** Max samples sorted per percentile computation; beyond this the window is strided. */
const PERCENTILE_SAMPLE_CAP = 512;
/** Trailing window for rate (per-second) measurements. */
const RATE_WINDOW_MS = 1000;
/** Number of buckets the rate window is split into. */
const RATE_BUCKETS = 10;
/** How often a HistoryPoint is appended. */
const HISTORY_INTERVAL_MS = 250;
/** How many HistoryPoints are retained (~60s). */
const HISTORY_MAX = 240;
/** Base delay before a retry is re-issued; doubles per attempt, with jitter. */
const RETRY_BASE_BACKOFF_MS = 25;
/** Guard so a runaway topology cannot allocate unbounded requests. */
const MAX_LIVE_REQUESTS = 200000;
/**
 * Size of the keyspace every client draws request keys from.
 *
 * Deliberately small. The point of a key is that collisions happen often
 * enough to be observable in a 30-second run: a read must frequently land on
 * a key that was just written (so replication lag produces visible stale
 * reads), and shard occupancy must be a meaningful distribution rather than
 * every request landing on its own partition. Drawn from the seeded RNG, so
 * the key stream is part of the deterministic replay.
 */
const KEYSPACE = 64;
/**
 * Shared empty vector for every kind that is not partitioned. snapshot() runs
 * at 10Hz over every node; handing them all one frozen array avoids an
 * allocation per node per frame for a field only shard nodes ever fill.
 */
const EMPTY_SHARDS: number[] = [];

/* ------------------------------------------------------------------ *
 * Event types
 * ------------------------------------------------------------------ */

const EV_ARRIVAL = 0;
const EV_SERVICE_DONE = 1;
const EV_TIMEOUT = 2;
const EV_WORKER_POLL = 3;
const EV_RETRY = 4;
/** A request finished traversing an edge with a latencyMs and is now offered. */
const EV_LINK_ARRIVE = 5;

interface Ev extends Timed {
  time: number;
  seq: number;
  kind: number;
  /** Node this event targets. */
  nodeId: string;
  /** Request this event concerns (null for arrivals / worker polls). */
  req: Req | null;
  /** Monotonic guard so a stale timer for a recycled request is ignored. */
  token: number;
}

/* ------------------------------------------------------------------ *
 * Request object (pooled)
 * ------------------------------------------------------------------ */

interface Req {
  /** Unique-per-incarnation id; bumped on every reuse so stale timers die. */
  token: number;
  /** Node currently handling this request. */
  nodeId: string;
  /** Parent request that issued this call, or null for a client root / queue message. */
  parent: Req | null;
  /** Number of child calls still outstanding. */
  pending: number;
  /** Largest latency reported by any resolved child (fan-out join). */
  maxChildMs: number;
  /** True once any child failed. */
  childFailed: boolean;
  /** Failure reason bubbled up from a child. */
  childReason: FailureReason;
  /** Simulated time this request entered its current node. */
  enterMs: number;
  /** Simulated time the root request was generated (client only). */
  rootStartMs: number;
  /** Hop depth from the client root. */
  hop: number;
  /** Which retry attempt this call represents at the parent. */
  attempt: number;
  /** True once the parent stopped waiting (timeout). Work continues, result discarded. */
  abandoned: boolean;
  /** Set while the request occupies a server slot, so release is idempotent. */
  holdingSlot: boolean;
  /** Edge this request traversed to reach nodeId, for edgeFlow accounting. */
  viaEdge: string;
  /** True when this request is a detached queue message being drained by a worker. */
  detached: boolean;
  /** Node that must be re-called on retry (the downstream target). */
  retryTarget: string;
  /** Attempt number for a scheduled retry. */
  retryAttempt: number;
  /** Own service time already spent at this node, part of parent latency accounting. */
  ownMs: number;
  /** Free-list link. */
  next: Req | null;
  /** Guards double resolution. */
  resolved: boolean;
  /**
   * Partition / cache key this request concerns. Drawn once by the client
   * from `KEYSPACE` and inherited unchanged by every downstream call, so a
   * shard or replica set several hops away partitions on the key the client
   * actually asked for. Kinds that do not partition by key ignore it.
   */
  key: number;
  /** True when this request is a write. Classified once, inherited downstream. */
  isWrite: boolean;
  /** Extra service time (ms) a behaviour asked for, consumed by serveWithin(). */
  extraServiceMs: number;
  /**
   * Callback a self-managing kind (a sharded store) registers via
   * serveWithin(), fired when this request's service time elapses so the
   * behaviour can release its own slot. Null for the ordinary path.
   */
  onDrained: ((ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void) | null;
}

/* ------------------------------------------------------------------ *
 * Rate counter: bucketed trailing window
 * ------------------------------------------------------------------ */

class RateCounter {
  private buckets = new Float64Array(RATE_BUCKETS);
  private stamps = new Float64Array(RATE_BUCKETS).fill(-1);
  private bucketMs = RATE_WINDOW_MS / RATE_BUCKETS;

  add(now: number, n: number): void {
    const stamp = Math.floor(now / this.bucketMs);
    const idx = ((stamp % RATE_BUCKETS) + RATE_BUCKETS) % RATE_BUCKETS;
    if (this.stamps[idx] !== stamp) {
      this.stamps[idx] = stamp;
      this.buckets[idx] = 0;
    }
    this.buckets[idx] += n;
  }

  /**
   * Events per second over the trailing window.
   *
   * Every counter divides by the SAME fixed span, so rates from different
   * counters stay comparable and their ratios mean something -- goodput can
   * never exceed offered just because one of them happened to be idle for
   * part of the window. The in-progress bucket is excluded rather than
   * scaled: a partially elapsed bucket read as if it were whole is what
   * makes a live rate flicker.
   */
  rate(now: number): number {
    const current = Math.floor(now / this.bucketMs);
    let total = 0;
    for (let i = 0; i < RATE_BUCKETS; i++) {
      const age = current - this.stamps[i];
      // Sum only the fully elapsed buckets. age === 0 is the bucket still
      // filling: reading a partially elapsed bucket as if it were whole is
      // what makes a live rate flicker at the sampling boundary.
      if (age > 0 && age < RATE_BUCKETS) {
        total += this.buckets[i];
      }
    }
    if (total === 0) return 0;
    // Divide by exactly the span the numerator covers. Two things this must
    // not do: divide by how many buckets happened to receive events (a quiet
    // bucket is a real zero and has to pull the average down, or bursty
    // traffic reads several times high), or include the in-progress bucket
    // the events could not have landed in (which under-reports every rate by
    // one bucket's worth). Every counter uses this same span, so goodput can
    // never exceed offered merely because one of them was briefly idle.
    const elapsedBuckets = Math.max(1, Math.min(RATE_BUCKETS - 1, current));
    return (total * 1000) / (elapsedBuckets * this.bucketMs);
  }

  reset(): void {
    this.buckets.fill(0);
    this.stamps.fill(-1);
  }
}

/* ------------------------------------------------------------------ *
 * Latency reservoir: ring buffer with timestamps, exact percentiles
 * ------------------------------------------------------------------ */

class LatencyRing {
  private vals = new Float64Array(LATENCY_RING);
  private times = new Float64Array(LATENCY_RING);
  private head = 0;
  private count = 0;
  private scratch = new Float64Array(LATENCY_RING);
  /** Monotonic count of samples ever added; part of the memo key. */
  private added = 0;
  private cacheTime = -1;
  private cacheAdded = -1;
  private cache0 = 0;
  private cache1 = 0;
  private cache2 = 0;

  add(now: number, v: number): void {
    this.vals[this.head] = v;
    this.times[this.head] = now;
    this.head = (this.head + 1) % LATENCY_RING;
    if (this.count < LATENCY_RING) this.count++;
    this.added++;
  }

  /**
   * Fills out[0..2] with p50/p95/p99 over the trailing window.
   *
   * Results are memoized per (time, sample count): snapshot() is polled at
   * 10Hz and asks every node for percentiles, but the underlying samples only
   * change when a request completes. Re-sorting an unchanged window would
   * dominate the frame budget.
   */
  percentiles(now: number, out: Float64Array): void {
    if (now === this.cacheTime && this.added === this.cacheAdded) {
      out[0] = this.cache0;
      out[1] = this.cache1;
      out[2] = this.cache2;
      return;
    }

    const cutoff = now - LATENCY_WINDOW_MS;
    const s = this.scratch;
    let n = 0;
    // Walk newest-first and stop at the window edge. Sampling is capped: a
    // few hundred points give the same percentiles as several thousand, and
    // this keeps snapshot() cheap at 10Hz under heavy traffic.
    const limit = this.count < PERCENTILE_SAMPLE_CAP ? this.count : PERCENTILE_SAMPLE_CAP;
    const stride = this.count > PERCENTILE_SAMPLE_CAP
      ? Math.floor(this.count / PERCENTILE_SAMPLE_CAP)
      : 1;
    for (let i = 0, taken = 0; taken < limit && i < this.count; i += stride) {
      const idx = (this.head - 1 - i + LATENCY_RING * 2) % LATENCY_RING;
      if (this.times[idx] < cutoff) break;
      s[n++] = this.vals[idx];
      taken++;
    }
    if (n === 0) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
    } else {
      // sort() on a subarray sorts in place over the shared buffer without
      // allocating a copy.
      const view = s.subarray(0, n);
      view.sort();
      out[0] = quantile(view, n, 0.5);
      out[1] = quantile(view, n, 0.95);
      out[2] = quantile(view, n, 0.99);
    }

    this.cacheTime = now;
    this.cacheAdded = this.added;
    this.cache0 = out[0];
    this.cache1 = out[1];
    this.cache2 = out[2];
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.added = 0;
    this.cacheTime = -1;
    this.cacheAdded = -1;
  }
}

function quantile(sorted: Float64Array, n: number, q: number): number {
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/* ------------------------------------------------------------------ *
 * Injected failures
 *
 * Chaos is engine state, not a component: it is attached to a node id, so a
 * node can be faulted and healed without the topology changing shape. The
 * engine keeps one record per faulted node, plus a flat Set of cut edge ids
 * so the send path can test a partition with a single Set lookup.
 * ------------------------------------------------------------------ */

interface Fault {
  kind: FailureKind;
  /** Simulated time the fault was injected. */
  sinceMs: number;
  /** 'slow': service-time multiplier, >= 1. */
  factor: number;
  /** 'errors': forced failure fraction, 0..1. */
  rate: number;
  /** 'partition': edge ids cut. Empty means "every edge leaving the node". */
  edgeIds: string[];
}

/* ------------------------------------------------------------------ *
 * Per-node runtime state
 * ------------------------------------------------------------------ */

interface NodeState {
  id: string;
  kind: SimNode['kind'];
  /**
   * This kind's behaviour, resolved once at buildNodes() time. The event loop
   * reads policy through this reference only -- there is no per-event map
   * lookup and no `kind === ...` test anywhere on the hot path.
   */
  behaviour: ComponentBehaviour;
  config: NodeConfig;
  /** Requests occupying a server slot right now. */
  busy: number;
  /** FIFO of requests waiting for a slot (service/db/worker) or buffered messages (queue). */
  waiting: Req[];
  /** Read cursor into `waiting`, so dequeue is O(1) without splice. */
  waitHead: number;
  /** Outgoing edges, resolved from the topology. */
  out: SimEdge[];
  /** Queue nodes that feed this worker. */
  sources: string[];
  /** Integrated busy-slot-milliseconds, for utilization. */
  busyMsAccum: number;
  /** Simulated time busyMsAccum was last integrated. */
  lastIntegrateMs: number;
  /** Rolling utilization sample, recomputed each stats tick. */
  utilization: number;

  arrivals: RateCounter;
  completions: RateCounter;
  errors: RateCounter;
  sheds: RateCounter;
  timeouts: RateCounter;
  hits: RateCounter;
  misses: RateCounter;

  latency: LatencyRing;

  totalCompleted: number;
  totalFailed: number;

  /** True once a worker poll event is scheduled, so we do not stack pollers. */
  pollScheduled: boolean;
  /**
   * Per-shard utilisation published by a self-partitioning behaviour, 0..1.
   * Empty for every kind that is not partitioned; the engine only copies it
   * into the snapshot and has no opinion about what a shard is.
   */
  shardUtil: number[];

  /**
   * Behaviour-private scratch state, allocated once from the behaviour's
   * initState() hook. The engine never reads or interprets it. This is what
   * lets a stateful kind (an autoscaler's cooldown clock, a region's failover
   * deadline, a token bucket) exist without NodeState growing a field per
   * kind -- the same thicket the registry refactor removed from the loop.
   */
  ext: unknown;

  /**
   * Behaviour-defined rate counters, created on first use. Namespaced per
   * node, so two behaviours can never collide over a name.
   */
  custom: Map<string, RateCounter> | null;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export class Engine implements BehaviourCtx {
  private topology: Topology;
  private seed: number;
  private rng: Rng;

  /** Current simulated time in ms. Part of BehaviourCtx; never written from outside. */
  now = 0;
  private seq = 0;
  private heap = new MinHeap<Ev>();

  private nodes = new Map<string, NodeState>();
  private clientIds: string[] = [];
  /**
   * Nodes whose behaviour declares onTick. Kept as a separate list so the
   * per-advance walk costs nothing at all while no such kind exists.
   */
  private tickNodes: NodeState[] = [];
  private edgeFlow = new Map<string, RateCounter>();

  private freeReq: Req | null = null;
  private freeEv: Ev[] = [];
  private liveRequests = 0;

  /** Root-level (end-to-end) measurements. */
  private sysLatency = new LatencyRing();
  private sysOffered = new RateCounter();
  private sysGood = new RateCounter();
  private sysFailed = new RateCounter();
  private totalRequests = 0;
  private totalFailed = 0;
  private failures: Record<FailureReason, number> = {
    error: 0,
    shed: 0,
    timeout: 0,
    'no-route': 0,
    depth: 0,
    throttled: 0,
    rejected: 0,
    crashed: 0,
    partitioned: 0,
    'region-down': 0,
  };

  /** Injected failures, keyed by node id. At most one fault per node. */
  private faults = new Map<string, Fault>();
  /**
   * Every edge id cut by an active partition, flattened out of `faults` so the
   * send path tests a partition with one Set lookup instead of walking faults.
   * Rebuilt whenever faults or the topology change.
   */
  private cutEdges = new Set<string>();
  /** Reused snapshot array for active failures. */
  private snapFailures: ActiveFailure[] = [];

  private history: HistoryPoint[] = [];
  private lastHistoryMs = 0;

  private pctScratch = new Float64Array(3);
  private nodePctScratch = new Float64Array(3);

  /** Reused snapshot containers so 10Hz polling does not churn the heap. */
  private snapNodes: Record<string, NodeStats> = {};
  private snapEdges: Record<string, number> = {};

  constructor(topology: Topology, seed = 1) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.topology = cloneTopology(topology);
    this.buildNodes(null);
  }

  /* ---------------- public API ---------------- */

  setTopology(t: Topology): void {
    const previous = this.nodes;
    this.topology = cloneTopology(t);
    this.buildNodes(previous);
    // Faults survive a topology edit, but a whole-node partition names its
    // edges implicitly, so the flattened set has to be recomputed against the
    // new wiring. A fault on a node that no longer exists is dropped.
    for (const nodeId of [...this.faults.keys()]) {
      if (!this.nodes.has(nodeId)) this.faults.delete(nodeId);
    }
    this.rebuildCutEdges();
  }

  updateNodeConfig(id: string, patch: Partial<NodeConfig>): void {
    const node = this.topology.nodes.find((n) => n.id === id);
    if (node) Object.assign(node.config, patch);
    const state = this.nodes.get(id);
    if (!state) return;
    Object.assign(state.config, patch);
    // A capacity increase may free up slots for waiting work immediately.
    this.pumpQueue(state);
  }

  /* ---------------- failure injection ---------------- *
   *
   * Chaos is a first-class engine operation rather than a component, so any
   * node in any topology can be faulted without rewiring anything. Each fault
   * intercepts at exactly one point in the request path, which is what makes
   * it compose with retries, timeouts and a circuit breaker for free:
   *
   *   crash      admit() refuses immediately, and in-flight work at the node
   *              is failed at injection time. The caller sees a failed call
   *              like any other, so its retry budget and its breaker's error
   *              window both observe it.
   *   slow       serviceTimeFor() multiplies the drawn service time. Nothing
   *              else changes, so the caller's timeout starts firing on its
   *              own -- which is the lesson.
   *   errors     onServiceComplete() rolls it after the node's own errorRate.
   *   partition  sendChild() refuses to cross a cut edge, so the CALLER sees
   *              the failure. That is what a network partition looks like
   *              from one side, and it leaves the target node untouched.
   * ------------------------------------------------------ */

  /**
   * Attach a fault to a node. One fault per node: injecting again replaces
   * whatever was there, so the UI never has to reason about stacking.
   */
  injectFailure(nodeId: string, kind: FailureKind, opts: FailureOpts = {}): void {
    if (!this.nodes.has(nodeId)) return;

    const fault: Fault = {
      kind,
      sinceMs: this.now,
      // A fault may not make a node faster, so a factor below 1 is clamped.
      factor: opts.factor !== undefined && opts.factor > 1 ? opts.factor : 1,
      rate: opts.rate !== undefined ? clamp01(opts.rate) : 1,
      edgeIds: opts.edgeIds ? opts.edgeIds.slice() : [],
    };
    this.faults.set(nodeId, fault);
    this.rebuildCutEdges();

    // A crash is retroactive: work already inside the node dies with it.
    // Without this the node would keep answering for one service time after
    // being killed, and a student watching the graph would see the failure
    // arrive late for no visible reason.
    if (kind === 'crash') this.killInFlight(nodeId);
  }

  /** Heal a node. Work that already failed stays failed; new work succeeds. */
  clearFailure(nodeId: string): void {
    if (!this.faults.delete(nodeId)) return;
    this.rebuildCutEdges();
    const state = this.nodes.get(nodeId);
    // A healed node may have callers' work waiting on it right now.
    if (state) this.pumpQueue(state);
  }

  /** Every fault in force, for the UI. */
  activeFailures(): ActiveFailure[] {
    const out: ActiveFailure[] = [];
    for (const [nodeId, f] of this.faults) {
      out.push(describeFault(nodeId, f));
    }
    return out;
  }

  /**
   * Fail everything the crashed node is holding: requests in service, and
   * requests queued behind them. Iterating a copy of the waiting list matters
   * because resolve() can re-enter the engine through the parent's retry path.
   */
  private killInFlight(nodeId: string): void {
    const state = this.nodes.get(nodeId);
    if (!state) return;

    const waiting: Req[] = [];
    for (let i = state.waitHead; i < state.waiting.length; i++) {
      const req = state.waiting[i];
      if (req) waiting.push(req);
    }
    state.waiting.length = 0;
    state.waitHead = 0;

    for (const req of waiting) {
      if (req.resolved) continue;
      // A buffered queue message has no caller to inform; it is simply lost,
      // which is what an unreplicated broker losing its disk looks like.
      state.totalFailed++;
      this.resolve(req, false, 'crashed', 0);
    }

    // Requests already in service are deliberately NOT unwound here. Each one
    // still holds a real slot, and its SERVICE_DONE event will release that
    // slot and then find the node crashed in onServiceComplete, failing it as
    // 'crashed'. Zeroing state.busy here instead would double-release those
    // slots and let the crashed node appear to have free capacity.
  }

  private rebuildCutEdges(): void {
    this.cutEdges.clear();
    for (const [nodeId, fault] of this.faults) {
      if (fault.kind !== 'partition') continue;
      if (fault.edgeIds.length > 0) {
        for (const id of fault.edgeIds) this.cutEdges.add(id);
        continue;
      }
      // No edge ids given: cut everything leaving the node.
      const state = this.nodes.get(nodeId);
      if (!state) continue;
      for (const edge of state.out) this.cutEdges.add(edge.id);
    }
  }

  advance(deltaMs: number): void {
    if (!(deltaMs > 0)) return;
    const dt = Math.min(deltaMs, MAX_DELTA_MS);
    const target = this.now + dt;
    let budget = MAX_EVENTS_PER_ADVANCE;

    for (;;) {
      const next = this.heap.peek();
      if (!next || next.time > target) break;
      if (budget-- <= 0) break;
      const ev = this.heap.pop()!;
      // Integrate utilization up to this event before state changes.
      this.now = ev.time;
      this.dispatch(ev);
      this.releaseEv(ev);
    }

    this.now = target;
    this.integrateAll();
    if (this.tickNodes.length > 0) this.runTicks(dt);
    this.maybeRecordHistory();
  }

  snapshot(): SimSnapshot {
    const now = this.now;
    this.sysLatency.percentiles(now, this.pctScratch);

    const system: SystemStats = {
      timeMs: now,
      offeredRps: this.sysOffered.rate(now),
      goodputRps: this.sysGood.rate(now),
      errorRate: 0,
      p50: this.pctScratch[0],
      p95: this.pctScratch[1],
      p99: this.pctScratch[2],
      totalRequests: this.totalRequests,
      totalFailed: this.totalFailed,
    };
    const failRate = this.sysFailed.rate(now);
    const done = system.goodputRps + failRate;
    system.errorRate = done > 0 ? failRate / done : 0;

    const nodeOut: Record<string, NodeStats> = this.snapNodes;
    for (const key of Object.keys(nodeOut)) {
      if (!this.nodes.has(key)) delete nodeOut[key];
    }

    for (const state of this.nodes.values()) {
      state.latency.percentiles(now, this.nodePctScratch);
      const completions = state.completions.rate(now);
      const errorsPerSec = state.errors.rate(now);
      const shedRate = state.sheds.rate(now);
      const timeoutRate = state.timeouts.rate(now);
      const hits = state.hits.rate(now);
      const misses = state.misses.rate(now);
      const resolved = completions + errorsPerSec + shedRate;

      // A fresh object per snapshot, deliberately. Mutating a reused entry in
      // place makes every memoised consumer see an unchanged reference and
      // skip its re-render, which silently freezes the canvas node readouts
      // at zero while the rest of the UI updates. At 10Hz over a handful of
      // nodes the allocation is irrelevant; the stale render is not.
      const entry: NodeStats = {
        inFlight: 0,
        queued: 0,
        throughput: 0,
        arrivalRate: 0,
        utilization: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        errorRate: 0,
        shedRate: 0,
        timeoutRate: 0,
        hitRate: 0,
        totalCompleted: 0,
        totalFailed: 0,
        staleReadRate: 0,
        maxShardUtilization: 0,
        minShardUtilization: 0,
        shardUtilization: EMPTY_SHARDS,
      };
      nodeOut[state.id] = entry;

      entry.inFlight = state.busy;
      entry.queued = state.waiting.length - state.waitHead;
      entry.throughput = completions;
      entry.arrivalRate = state.arrivals.rate(now);
      entry.utilization = state.utilization;
      entry.p50 = this.nodePctScratch[0];
      entry.p95 = this.nodePctScratch[1];
      entry.p99 = this.nodePctScratch[2];
      entry.errorRate = resolved > 0 ? (errorsPerSec + shedRate) / resolved : 0;
      entry.shedRate = shedRate;
      entry.timeoutRate = timeoutRate;
      entry.hitRate = hits + misses > 0 ? hits / (hits + misses) : 0;
      entry.totalCompleted = state.totalCompleted;
      entry.totalFailed = state.totalFailed;

      // Kind-specific readouts. Keeping this a hook means the snapshot loop
      // never grows a branch per kind, exactly as the event loop does not.
      if (state.behaviour.decorateStats) {
        state.behaviour.decorateStats(this, state, entry);
      }
    }

    const edgeOut: Record<string, number> = this.snapEdges;
    for (const key of Object.keys(edgeOut)) {
      if (!this.edgeFlow.has(key)) delete edgeOut[key];
    }
    for (const [id, counter] of this.edgeFlow) {
      edgeOut[id] = counter.rate(now);
    }

    return {
      system,
      nodes: nodeOut,
      history: this.history,
      edgeFlow: edgeOut,
      failuresByReason: this.failures,
      activeFailures: this.snapshotFailures(),
    };
  }

  /**
   * Injected failures, rebuilt into the reused array. Length is the number of
   * faulted nodes -- normally zero -- so this costs nothing on a healthy run.
   */
  private snapshotFailures(): ActiveFailure[] {
    const out = this.snapFailures;
    out.length = 0;
    for (const [nodeId, fault] of this.faults) {
      out.push(describeFault(nodeId, fault));
    }
    return out;
  }

  reset(): void {
    this.rng = new Rng(this.seed);
    this.now = 0;
    this.seq = 0;
    this.heap.clear();
    this.freeReq = null;
    this.freeEv.length = 0;
    this.liveRequests = 0;
    this.sysLatency.reset();
    this.sysOffered.reset();
    this.sysGood.reset();
    this.sysFailed.reset();
    this.totalRequests = 0;
    this.totalFailed = 0;
    this.failures = {
      error: 0,
      shed: 0,
      timeout: 0,
      'no-route': 0,
      depth: 0,
      throttled: 0,
      rejected: 0,
      crashed: 0,
      partitioned: 0,
      'region-down': 0,
    };
    this.history = [];
    this.lastHistoryMs = 0;
    this.snapNodes = {};
    this.snapEdges = {};
    // Chaos is part of the run, not of the topology: reset() must reproduce
    // the original trajectory from t=0, which it cannot do while a fault
    // injected mid-run is still in force.
    this.faults.clear();
    this.cutEdges.clear();
    this.snapFailures.length = 0;
    this.buildNodes(null);
  }

  /* ---------------- topology wiring ---------------- */

  private buildNodes(previous: Map<string, NodeState> | null): void {
    const next = new Map<string, NodeState>();
    this.clientIds = [];

    for (const node of this.topology.nodes) {
      const kept = previous?.get(node.id);
      let state: NodeState;
      if (kept && kept.kind === node.kind) {
        // Preserve in-flight work across a hot swap.
        state = kept;
        state.config = { ...node.config };
        state.out = [];
        state.sources = [];
      } else {
        state = createNodeState(node);
      }
      state.lastIntegrateMs = this.now;
      next.set(node.id, state);
      if (state.behaviour.generatesLoad) this.clientIds.push(node.id);
    }

    for (const edge of this.topology.edges) {
      const from = next.get(edge.from);
      const to = next.get(edge.to);
      if (!from || !to) continue;
      from.out.push(edge);
      // Structural wiring: a pull-based consumer drains whatever buffers feed
      // it. Both traits come off the behaviour, so a future kind that also
      // pulls (or also buffers) is wired up here with no edit.
      if (to.behaviour.pullsFromQueues && from.behaviour.buffersForConsumers) {
        to.sources.push(from.id);
      }
    }
    // A consumer may be drawn in either direction relative to its buffer;
    // treat an outgoing edge to a buffer as a pull source too.
    for (const state of next.values()) {
      if (!state.behaviour.pullsFromQueues) continue;
      for (const edge of state.out) {
        const target = next.get(edge.to);
        if (target && target.behaviour.buffersForConsumers && !state.sources.includes(target.id)) {
          state.sources.push(target.id);
        }
      }
    }

    // Drop state belonging to removed nodes: their in-flight requests are gone.
    if (previous) {
      for (const [id, state] of previous) {
        if (next.get(id) === state) continue;
        this.discardNodeState(state);
      }
    }

    this.nodes = next;

    const flow = new Map<string, RateCounter>();
    for (const edge of this.topology.edges) {
      flow.set(edge.id, this.edgeFlow.get(edge.id) ?? new RateCounter());
    }
    this.edgeFlow = flow;

    // Restart the generators/pollers; stale ones are ignored via node lookup.
    for (const id of this.clientIds) {
      this.scheduleArrival(id);
    }
    this.tickNodes = [];
    for (const state of this.nodes.values()) {
      state.pollScheduled = false;
      // Allocate behaviour-private state before anything can run. A node kept
      // across a hot swap keeps the state it already had, so an autoscaler
      // does not forget its cooldown because an unrelated node was moved.
      if (state.ext === null && state.behaviour.initState) {
        state.ext = state.behaviour.initState(state);
      }
      this.pumpQueue(state);
      if (state.behaviour.onTick) this.tickNodes.push(state);
    }
  }

  private discardNodeState(state: NodeState): void {
    for (let i = state.waitHead; i < state.waiting.length; i++) {
      const req = state.waiting[i];
      this.resolve(req, false, 'no-route', 0);
    }
    state.waiting.length = 0;
    state.waitHead = 0;
    state.busy = 0;
  }

  /* ---------------- event dispatch ---------------- */

  private dispatch(ev: Ev): void {
    const state = this.nodes.get(ev.nodeId);
    if (!state) return;

    switch (ev.kind) {
      case EV_ARRIVAL:
        this.onClientArrival(state);
        break;
      case EV_SERVICE_DONE:
        if (ev.req && ev.req.token === ev.token) this.onServiceDone(state, ev.req);
        break;
      case EV_TIMEOUT:
        if (ev.req && ev.req.token === ev.token) this.onTimeout(ev.req);
        break;
      case EV_WORKER_POLL:
        state.pollScheduled = false;
        this.pumpWorker(state);
        break;
      case EV_RETRY:
        if (ev.req && ev.req.token === ev.token) this.onRetry(state, ev.req);
        break;
      case EV_LINK_ARRIVE:
        // The request finished crossing an edge with a latencyMs and is only
        // now offered to the target. A caller that already gave up during the
        // crossing leaves a resolved request, which is dropped here.
        if (ev.req && ev.req.token === ev.token && !ev.req.resolved) {
          this.admit(state, ev.req);
        }
        break;
      default:
        break;
    }
  }

  /* ---------------- client ---------------- */

  private scheduleArrival(nodeId: string): void {
    const state = this.nodes.get(nodeId);
    if (!state || !state.behaviour.generatesLoad) return;
    const rps = state.config.rps;
    if (!(rps > 0)) {
      // Poll again shortly so raising the slider resumes traffic.
      this.push(this.now + 50, EV_ARRIVAL, nodeId, null, 0);
      return;
    }
    const gap = this.rng.exponential(1000 / rps);
    this.push(this.now + gap, EV_ARRIVAL, nodeId, null, 0);
  }

  private onClientArrival(state: NodeState): void {
    this.scheduleArrival(state.id);
    if (state.config.rps <= 0) return;
    if (this.liveRequests >= MAX_LIVE_REQUESTS) return;

    const root = this.acquireReq();
    root.nodeId = state.id;
    root.parent = null;
    root.rootStartMs = this.now;
    root.enterMs = this.now;
    root.hop = 0;
    root.attempt = 0;
    root.pending = 0;
    root.maxChildMs = 0;
    root.ownMs = 0;
    // Draw this request's key. Every downstream call inherits it, so the
    // whole chain agrees on which partition/record is being touched.
    root.key = Math.floor(this.rng.next() * KEYSPACE);

    this.totalRequests++;
    this.sysOffered.add(this.now, 1);
    state.arrivals.add(this.now, 1);

    this.dispatchDownstream(state, root);
  }

  /* ---------------- routing ---------------- */

  /**
   * Issue this node's downstream calls. For an lb exactly one edge is chosen;
   * for anything else every distinct downstream is called and joined.
   */
  private dispatchDownstream(state: NodeState, req: Req): void {
    if (req.hop >= MAX_HOP_DEPTH) {
      this.resolve(req, false, 'depth', req.ownMs);
      return;
    }

    const out = state.out;
    if (out.length === 0) {
      // Terminal node: nothing downstream, this call is done.
      this.resolve(req, true, 'error', req.ownMs);
      return;
    }

    const b = state.behaviour;
    const mode = b.route ? b.route(this, state, req) : 'all';

    if (mode === 'none') {
      this.completeNode(state, req, req.ownMs);
      return;
    }

    if (mode === 'one') {
      const edge = b.pickEdge
        ? b.pickEdge(this, state, req, out)
        : this.pickWeightedOrLeastLoaded(out);
      if (!edge) {
        // A kind whose pickEdge can decline for a reason of its own names it
        // here (a region node that has no healthy region reports
        // 'region-down', not a generic routing error). Read as a plain field,
        // so this stays a trait lookup rather than a kind test.
        const reason = state.behaviour.noRouteReason ?? 'no-route';
        if (reason !== 'no-route') {
          // A deliberate refusal by this node, so it owns the failure. A plain
          // 'no-route' stays uncredited: that is a wiring mistake by the
          // student, not something the node did.
          state.errors.add(this.now, 1);
          state.totalFailed++;
        }
        this.resolve(req, false, reason, req.ownMs);
        return;
      }
      req.pending = 1;
      this.sendChild(state, req, edge, 0);
      return;
    }

    req.pending = out.length;
    // Snapshot the count: a child may resolve synchronously (shed) and
    // decrement pending mid-loop.
    for (let i = 0; i < out.length; i++) {
      if (req.resolved) return;
      this.sendChild(state, req, out[i], 0);
    }
  }

  /**
   * The shared edge-selection policy: weighted-random when the weights differ,
   * least-loaded when they are all equal. Exposed on BehaviourCtx so a
   * behaviour can reuse it instead of reimplementing the tie-break.
   */
  pickWeightedOrLeastLoaded(out: readonly SimEdge[]): SimEdge | null {
    // A partitioned edge is not a candidate. This matters more than it looks:
    // the least-loaded rule below measures load at the TARGET, and a cut edge
    // delivers nothing, so its target is permanently the idlest thing in the
    // set. A dispatcher would therefore lock onto the one broken link and send
    // it every single request -- one cut edge would take down a load balancer
    // with three healthy peers. Excluding cut edges up front is what makes a
    // partition behave like a lost link rather than a black hole with gravity.
    //
    // `cutEdges` is empty on every healthy run, so this costs one Set size
    // check and nothing else.
    const cut = this.cutEdges;
    const anyCut = cut.size > 0;

    if (out.length === 1) return anyCut && cut.has(out[0].id) ? null : out[0];

    let total = 0;
    let uniform = true;
    let firstLive = -1;
    for (let i = 0; i < out.length; i++) {
      if (anyCut && cut.has(out[i].id)) continue;
      const w = out[i].weight > 0 ? out[i].weight : 0;
      total += w;
      if (firstLive < 0) firstLive = i;
      else if (Math.abs(out[i].weight - out[firstLive].weight) > 1e-9) uniform = false;
    }
    // Every edge is cut: there is no route, and the caller reports it as such.
    if (firstLive < 0) return null;

    if (uniform) {
      // Least-loaded: fewest queued+busy relative to capacity, ties by index.
      let best: SimEdge | null = null;
      let bestLoad = Infinity;
      for (let i = 0; i < out.length; i++) {
        if (anyCut && cut.has(out[i].id)) continue;
        const target = this.nodes.get(out[i].to);
        if (!target) continue;
        const depth = target.busy + (target.waiting.length - target.waitHead);
        const cap = target.config.capacity > 0 ? target.config.capacity : 1;
        const load = depth / cap;
        if (load < bestLoad) {
          bestLoad = load;
          best = out[i];
        }
      }
      return best ?? out[firstLive];
    }

    if (total <= 0) return out[firstLive];
    let r = this.rng.next() * total;
    let last = out[firstLive];
    for (let i = 0; i < out.length; i++) {
      if (anyCut && cut.has(out[i].id)) continue;
      const w = out[i].weight > 0 ? out[i].weight : 0;
      last = out[i];
      r -= w;
      if (r <= 0) return out[i];
    }
    return last;
  }

  private sendChild(parentState: NodeState, parent: Req, edge: SimEdge, attempt: number): void {
    const target = this.nodes.get(edge.to);
    if (!target) {
      this.childResolved(parent, false, 'no-route', 0);
      return;
    }

    // A partitioned link fails at the CALLER: the packet never arrives, so the
    // target node is untouched and sees no arrival at all. Reported through
    // childResolvedFrom rather than childResolved so the caller's retry budget
    // applies -- retrying across a cut link is exactly the behaviour that makes
    // a partition look like a slow outage rather than a clean failure.
    if (this.cutEdges.size > 0 && this.cutEdges.has(edge.id)) {
      parentState.errors.add(this.now, 1);
      parentState.totalFailed++;
      const stub = this.acquireReq();
      stub.attempt = attempt;
      stub.retryTarget = edge.id;
      stub.resolved = true;
      this.childResolvedFrom(stub, parent, false, 'partitioned', 0);
      this.recycle(stub);
      return;
    }

    const child = this.acquireReq();
    child.nodeId = target.id;
    child.parent = parent;
    child.rootStartMs = parent.rootStartMs;
    child.enterMs = this.now;
    child.hop = parent.hop + 1;
    child.attempt = attempt;
    child.viaEdge = edge.id;
    child.retryTarget = edge.id;
    child.detached = parent.detached;
    child.key = parent.key;
    child.isWrite = parent.isWrite;

    const counter = this.edgeFlow.get(edge.id);
    if (counter) counter.add(this.now, 1);

    // The caller's timeout bounds THIS attempt, not the whole retry budget:
    // each re-issued call gets a fresh deadline, exactly like a real client.
    // It is armed at send time, so link latency counts against the deadline
    // exactly as propagation delay does for a real caller.
    this.armTimeout(parentState, child);

    // Link propagation delay. Absent (the case for every topology today) this
    // is a plain synchronous admission and the event stream is unchanged.
    // bandwidthRps and lossRate are declared on SimEdge but not yet applied;
    // the networking phase adds them alongside this delay.
    const linkMs = edge.latencyMs;
    if (linkMs !== undefined && linkMs > 0) {
      this.push(this.now + linkMs, EV_LINK_ARRIVE, target.id, child, child.token);
      return;
    }

    this.admit(target, child);
  }

  /* ---------------- admission ---------------- */

  /** Offer a request to a node: shed, buffer, or start service. */
  private admit(state: NodeState, req: Req): void {
    state.arrivals.add(this.now, 1);

    // A crashed node accepts nothing. Checked before the behaviour runs, so a
    // crash takes a node out whatever kind it is, and the caller sees an
    // immediate failure it can retry (or that its breaker can count).
    const fault = this.faults.get(state.id);
    if (fault && fault.kind === 'crash') {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'crashed', 0);
      return;
    }

    const b = state.behaviour;
    const action = b.onAdmit ? b.onAdmit(this, state, req) : 'serve';

    if (action === 'handled') return;

    if (action === 'shed') {
      this.shed(state, req);
      return;
    }

    if (action === 'passthru') {
      // Effectively zero-capacity dispatchers: no queueing, immediate hand-off.
      req.ownMs = 0;
      this.beginZeroService(state, req);
      return;
    }

    const capacity = this.effectiveCapacity(state);
    if (state.busy < capacity) {
      this.startService(state, req);
      return;
    }

    if (this.queueDepth(state) >= this.effectiveQueueLimit(state)) {
      this.shed(state, req);
      return;
    }
    state.waiting.push(req);
  }

  /**
   * Draw one service time for a node, with any injected 'slow' fault applied.
   *
   * Every service-time draw in the engine goes through here, so a slow fault
   * cannot be bypassed by whichever path a kind happens to take. The RNG is
   * consumed identically whether or not a fault is present -- the multiplier
   * scales the drawn value rather than changing the distribution's parameters
   * -- which keeps a faulted run's random stream aligned with a healthy one.
   */
  private serviceTimeFor(state: NodeState): number {
    if (!(state.config.serviceMs > 0)) return 0;
    const ms = this.rng.serviceTime(state.config.serviceMs, state.config.serviceCv);
    const fault = this.faults.get(state.id);
    if (fault && fault.kind === 'slow') return ms * fault.factor;
    return ms;
  }

  /** Book a shed against a node and fail the call. */
  private shed(state: NodeState, req: Req): void {
    state.sheds.add(this.now, 1);
    state.totalFailed++;
    this.resolve(req, false, 'shed', 0);
  }

  /**
   * A buffering node acknowledges immediately: the caller's chain resolves as
   * a success right here, and the message is parked for the consumers. Called
   * by the queue behaviour, which has already checked the depth limit.
   */
  ackAndBuffer(stateLike: NodeStateLike, reqLike: ReqLike): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    const ackMs = this.serviceTimeFor(state);

    // Detach a buffered copy for the workers, then ack the caller.
    const msg = this.acquireReq();
    msg.nodeId = state.id;
    msg.parent = null;
    msg.rootStartMs = this.now;
    msg.enterMs = this.now;
    msg.hop = req.hop;
    msg.detached = true;
    state.waiting.push(msg);

    state.completions.add(this.now, 1);
    state.totalCompleted++;
    state.latency.add(this.now, ackMs);
    this.resolve(req, true, 'error', ackMs);

    // Wake any worker that feeds off this queue.
    this.wakeWorkersFor(state.id);
  }

  private wakeWorkersFor(queueId: string): void {
    for (const state of this.nodes.values()) {
      if (!state.behaviour.pullsFromQueues) continue;
      if (!state.sources.includes(queueId)) continue;
      this.pumpWorker(state);
    }
  }

  /** lb / client style pass-through with a tiny (possibly zero) service time. */
  private beginZeroService(state: NodeState, req: Req): void {
    const ms = this.serviceTimeFor(state);
    req.ownMs = ms;
    if (ms > 0) {
      state.busy++;
      req.holdingSlot = true;
      this.push(this.now + ms, EV_SERVICE_DONE, state.id, req, req.token);
    } else {
      this.onServiceComplete(state, req);
    }
  }

  private startService(state: NodeState, req: Req): void {
    state.busy++;
    req.holdingSlot = true;
    req.enterMs = this.now;
    const ms = this.serviceTimeFor(state);
    req.ownMs = ms;
    if (ms > 0) {
      this.push(this.now + ms, EV_SERVICE_DONE, state.id, req, req.token);
    } else {
      this.onServiceDone(state, req);
    }
  }

  private onServiceDone(state: NodeState, req: Req): void {
    // The slot is released the instant this node's own work finishes, even if
    // the caller already gave up — abandoned work burned the slot until now.
    this.releaseSlot(state, req);
    this.pumpQueue(state);
    // A self-managing kind (a sharded store) holds its slot bookkeeping in
    // `ext` rather than in state.busy, so it is told to free that slot here,
    // at exactly the moment the engine frees an ordinary one. Cleared first so
    // a recycled request can never re-fire a stale callback.
    const drained = req.onDrained;
    if (drained !== null) {
      req.onDrained = null;
      drained(this, state, req);
    }
    this.onServiceComplete(state, req);
  }

  private releaseSlot(state: NodeState, req: Req): void {
    if (!req.holdingSlot) return;
    req.holdingSlot = false;
    state.busy = Math.max(0, state.busy - 1);
  }

  /** Start serving whoever is next in line, if a slot is free. */
  private pumpQueue(state: NodeState): void {
    const mode = state.behaviour.pump;
    if (mode === 'none') return;
    if (mode === 'sources') {
      this.pumpWorker(state);
      return;
    }
    const capacity = this.effectiveCapacity(state);
    while (state.busy < capacity && state.waitHead < state.waiting.length) {
      const req = state.waiting[state.waitHead];
      state.waiting[state.waitHead] = undefined as unknown as Req;
      state.waitHead++;
      this.compactWaiting(state);
      if (req.resolved) continue;
      this.startService(state, req);
    }
  }

  /** Workers pull messages out of the queue nodes that feed them. */
  private pumpWorker(state: NodeState): void {
    const capacity = this.effectiveCapacity(state);
    while (state.busy < capacity) {
      const msg = this.takeFromSources(state);
      if (!msg) break;
      msg.nodeId = state.id;
      msg.enterMs = this.now;
      state.arrivals.add(this.now, 1);
      this.startService(state, msg);
    }
  }

  /** Round-robin-free deterministic pull: oldest message across feeding queues. */
  private takeFromSources(state: NodeState): Req | null {
    let best: NodeState | null = null;
    let bestTime = Infinity;
    for (let i = 0; i < state.sources.length; i++) {
      const q = this.nodes.get(state.sources[i]);
      if (!q || q.waitHead >= q.waiting.length) continue;
      const head = q.waiting[q.waitHead];
      if (head.enterMs < bestTime) {
        bestTime = head.enterMs;
        best = q;
      }
    }
    if (!best) return null;
    const msg = best.waiting[best.waitHead];
    best.waiting[best.waitHead] = undefined as unknown as Req;
    best.waitHead++;
    this.compactWaiting(best);
    return msg;
  }

  private compactWaiting(state: NodeState): void {
    if (state.waitHead > 64 && state.waitHead * 2 >= state.waiting.length) {
      state.waiting.splice(0, state.waitHead);
      state.waitHead = 0;
    }
  }

  /* ---------------- completion of a node's own work ---------------- */

  /** This node finished its own service; decide whether to call downstream. */
  private onServiceComplete(state: NodeState, req: Req): void {
    if (req.resolved) return;

    const fault = this.faults.get(state.id);

    // The node died while this request was in service. Its work is lost; the
    // slot it held has already been released by the normal path above, so the
    // accounting stays in one place.
    if (fault && fault.kind === 'crash') {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'crashed', req.ownMs);
      return;
    }

    // Independent per-attempt failure.
    if (state.config.errorRate > 0 && this.rng.next() < state.config.errorRate) {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'error', req.ownMs);
      return;
    }

    // Injected error rate, rolled after (and independently of) the node's own.
    // Two separate rolls rather than a combined probability, so clearing the
    // fault leaves the configured errorRate behaving exactly as before.
    if (fault && fault.kind === 'errors' && this.rng.next() < fault.rate) {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'error', req.ownMs);
      return;
    }

    const hook = state.behaviour.onServiceComplete;
    if (hook && hook(this, state, req) === 'complete') {
      this.completeNode(state, req, req.ownMs);
      return;
    }

    if (state.out.length === 0) {
      this.completeNode(state, req, req.ownMs);
      return;
    }

    this.dispatchDownstream(state, req);
  }

  /** Record this node's own latency and resolve the call upward. */
  private completeNode(state: NodeState, req: Req, latencyMs: number): void {
    state.completions.add(this.now, 1);
    state.totalCompleted++;
    state.latency.add(this.now, latencyMs);
    this.resolve(req, true, 'error', latencyMs);
  }

  /* ---------------- timeouts ---------------- */

  /**
   * Arm the caller's deadline on one outgoing call. `caller` supplies the
   * timeoutMs; `call` is the child request being bounded.
   */
  private armTimeout(caller: NodeState, call: Req): void {
    const t = caller.config.timeoutMs;
    if (!(t > 0)) return;
    this.push(this.now + t, EV_TIMEOUT, caller.id, call, call.token);
  }

  /**
   * The caller gave up on this call. The call itself is NOT cancelled: it
   * keeps its server slot and keeps running until its service time elapses.
   * Abandoned-but-still-running work is what makes a retry storm compound,
   * so it must stay on the books.
   */
  private onTimeout(call: Req): void {
    if (call.resolved) return;

    // Attribute the timeout to the caller that gave up.
    const parent = call.parent;
    const callerState = parent ? this.nodes.get(parent.nodeId) : null;
    if (callerState) {
      callerState.timeouts.add(this.now, 1);
      callerState.totalFailed++;
    }

    // Detach the call from its parent so its eventual completion is discarded,
    // then report the timeout upward (which may trigger a retry).
    call.parent = null;
    call.abandoned = true;

    if (parent && !parent.resolved) {
      this.childResolvedFrom(call, parent, false, 'timeout', this.now - call.enterMs);
    }
  }

  /* ---------------- resolution & join ---------------- */

  /**
   * Resolve one request. `latencyMs` is the latency this call contributes to
   * its parent (own service time plus the joined subtree).
   */
  private resolve(req: Req, ok: boolean, reason: FailureReason, latencyMs: number): void {
    if (req.resolved) return;
    req.resolved = true;

    const parent = req.parent;

    if (parent === null) {
      if (req.detached || req.abandoned) {
        // Either a queue message that finished its worker path, or work the
        // caller already timed out on. Nobody is waiting for this result.
        this.recycle(req);
        return;
      }
      // Root request measured at the client.
      const total = this.now - req.rootStartMs;
      const client = this.nodes.get(req.nodeId);
      if (ok) {
        this.sysGood.add(this.now, 1);
        this.sysLatency.add(this.now, total);
        if (client) {
          client.completions.add(this.now, 1);
          client.totalCompleted++;
          client.latency.add(this.now, total);
        }
      } else {
        this.sysFailed.add(this.now, 1);
        this.totalFailed++;
        this.failures[reason]++;
        if (client) {
          client.totalFailed++;
          if (reason === 'timeout') client.timeouts.add(this.now, 1);
          else if (reason === 'shed') client.sheds.add(this.now, 1);
          else client.errors.add(this.now, 1);
        }
      }
      this.recycle(req);
      return;
    }

    this.childResolvedFrom(req, parent, ok, reason, latencyMs);
    this.recycle(req);
  }

  /** A backoff delay elapsed: re-issue the failed downstream call. */
  private onRetry(state: NodeState, parent: Req): void {
    if (parent.resolved) return;
    const edge = state.out.find((e) => e.id === parent.retryTarget);
    if (!edge) {
      this.childResolved(parent, false, 'no-route', 0);
      return;
    }
    this.sendChild(state, parent, edge, parent.retryAttempt);
  }

  private childResolvedFrom(
    child: Req,
    parent: Req,
    ok: boolean,
    reason: FailureReason,
    latencyMs: number,
  ): void {
    if (parent.resolved) return; // Parent already gave up: discard the result.

    // Report the outcome to the caller's behaviour, for kinds that watch their
    // dependency's health. Deliberately BEFORE the retry decision, so a
    // breaker sees every individual attempt rather than only the last one --
    // a dependency failing three times and succeeding on the fourth retry is
    // three failures' worth of evidence, not zero. Purely observational: it
    // cannot change what happens next.
    const caller = this.nodes.get(parent.nodeId);
    if (caller && caller.behaviour.observesOutcome) {
      caller.behaviour.onDownstreamResult!(this, caller, child, ok, reason);
    }

    if (!ok) {
      const parentState = this.nodes.get(parent.nodeId);
      const retries = parentState ? Math.max(0, Math.floor(parentState.config.retries)) : 0;
      if (parentState && child.attempt < retries && reason !== 'depth' && reason !== 'no-route') {
        // Re-issue the same downstream call. This is real extra load.
        const edge = parentState.out.find((e) => e.id === child.retryTarget);
        if (edge) {
          const attempt = child.attempt + 1;
          // Exponential backoff with jitter. Without a delay a shed (which
          // fails in zero time) would let a request burn its whole retry
          // budget in the same instant, making the collapse infinitely sharp
          // instead of a progression the student can watch develop.
          const backoff = RETRY_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          const delay = backoff * (0.5 + this.rng.next());
          parent.retryTarget = edge.id;
          parent.retryAttempt = attempt;
          this.push(this.now + delay, EV_RETRY, parentState.id, parent, parent.token);
          return;
        }
      }
    }

    this.childResolved(parent, ok, reason, latencyMs);
  }

  private childResolved(
    parent: Req,
    ok: boolean,
    reason: FailureReason,
    latencyMs: number,
  ): void {
    if (parent.resolved) return;

    if (!ok && !parent.childFailed) {
      parent.childFailed = true;
      parent.childReason = reason;
    }
    if (latencyMs > parent.maxChildMs) parent.maxChildMs = latencyMs;

    parent.pending--;
    if (parent.pending > 0) return;

    const parentState = this.nodes.get(parent.nodeId);
    const total = parent.ownMs + parent.maxChildMs;

    if (parent.childFailed) {
      // Same as above: resolve() books the client's failure itself.
      if (parentState && parentState.behaviour.creditsJoinCompletion) parentState.totalFailed++;
      this.resolve(parent, false, parent.childReason, total);
      return;
    }

    // A client is credited once, in resolve(), where end-to-end latency is
    // measured. Counting it here as well would double every root request.
    if (parentState && parentState.behaviour.creditsJoinCompletion) {
      parentState.completions.add(this.now, 1);
      parentState.totalCompleted++;
      parentState.latency.add(this.now, total);
    }
    this.resolve(parent, true, 'error', total);
  }

  /* ---------------- BehaviourCtx surface ---------------- *
   *
   * The small, deliberate set of engine operations a behaviour may drive.
   * Everything a behaviour needs goes through here; nothing exposes the heap,
   * the request pool, or a writable clock, so a behaviour cannot desynchronise
   * the simulation.
   * ------------------------------------------------------ */

  /** One draw from the deterministic RNG. */
  roll(): number {
    return this.rng.next();
  }

  /** Queued (not yet in service) request count. */
  queueDepth(state: NodeStateLike): number {
    const s = state as NodeState;
    return s.waiting.length - s.waitHead;
  }

  effectiveQueueLimit(state: NodeStateLike): number {
    return Math.max(0, Math.floor(state.config.queueLimit));
  }

  effectiveCapacity(state: NodeStateLike): number {
    return Math.max(1, Math.floor(state.config.capacity));
  }

  countHit(state: NodeStateLike): void {
    (state as NodeState).hits.add(this.now, 1);
  }

  countMiss(state: NodeStateLike): void {
    (state as NodeState).misses.add(this.now, 1);
  }

  fail(req: ReqLike, reason: FailureReason, latencyMs: number): void {
    this.resolve(req as Req, false, reason, latencyMs);
  }

  /**
   * Refuse a request at a node with an arbitrary reason. This is the general
   * form of the engine's own shed path; the two differ only in which counter
   * is credited. Booked against `errors` rather than `sheds` because a
   * throttle or an open circuit is a deliberate refusal, not queue overflow.
   */
  reject(stateLike: NodeStateLike, req: ReqLike, reason: FailureReason): void {
    const state = stateLike as NodeState;
    state.errors.add(this.now, 1);
    state.totalFailed++;
    this.resolve(req as Req, false, reason, 0);
  }

  countCustom(stateLike: NodeStateLike, name: string, n: number): void {
    const state = stateLike as NodeState;
    let map = state.custom;
    if (!map) {
      map = new Map<string, RateCounter>();
      state.custom = map;
    }
    let counter = map.get(name);
    if (!counter) {
      counter = new RateCounter();
      map.set(name, counter);
    }
    counter.add(this.now, n);
  }

  counterRate(stateLike: NodeStateLike, name: string): number {
    const counter = (stateLike as NodeState).custom?.get(name);
    return counter ? counter.rate(this.now) : 0;
  }

  /* ---- controller surface ---- */

  utilizationOf(nodeId: string): number | null {
    const state = this.nodes.get(nodeId);
    return state ? state.utilization : null;
  }

  capacityOf(nodeId: string): number | null {
    const state = this.nodes.get(nodeId);
    return state ? this.effectiveCapacity(state) : null;
  }

  /**
   * Write a node's capacity. Both the runtime state and the stored topology
   * are updated, so the Inspector shows what the controller actually did
   * rather than the value the student last typed. Newly freed slots are
   * pumped immediately, exactly as a manual capacity change is.
   */
  setCapacity(nodeId: string, capacity: number): void {
    const next = Math.max(1, Math.floor(capacity));
    const state = this.nodes.get(nodeId);
    if (!state) return;
    if (state.config.capacity === next) return;
    state.config.capacity = next;
    const node = this.topology.nodes.find((n) => n.id === nodeId);
    if (node) node.config.capacity = next;
    this.pumpQueue(state);
  }

  isCrashed(nodeId: string): boolean {
    return this.faults.get(nodeId)?.kind === 'crash';
  }

  /**
   * Service a request on behalf of a behaviour that runs its own slot
   * discipline. Deliberately does NOT touch state.busy: for a sharded store
   * the meaningful occupancy is per-shard, and double-counting it in the
   * node-level counter would make `utilization` wrong. Everything after the
   * service time -- error roll, onServiceComplete, routing, completion -- is
   * the same path every other kind takes.
   */
  serveWithin(
    stateLike: NodeStateLike,
    reqLike: ReqLike,
    onDrained: (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void,
  ): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    req.enterMs = this.now;
    req.onDrained = onDrained;
    const ms =
      this.rng.serviceTime(state.config.serviceMs, state.config.serviceCv) + req.extraServiceMs;
    req.extraServiceMs = 0;
    req.ownMs = ms;
    if (ms > 0) {
      this.push(this.now + ms, EV_SERVICE_DONE, state.id, req, req.token);
    } else {
      this.onServiceDone(state, req);
    }
  }

  addServiceDelay(reqLike: ReqLike, extraMs: number): void {
    if (!(extraMs > 0)) return;
    (reqLike as Req).extraServiceMs += extraMs;
  }

  markWrite(reqLike: ReqLike, isWrite: boolean): void {
    (reqLike as Req).isWrite = isWrite;
  }

  /**
   * Store a per-shard utilisation vector for the snapshot. Copied rather than
   * retained, so a behaviour reusing its own scratch array cannot mutate what
   * the UI is about to read.
   */
  reportShardUtilization(stateLike: NodeStateLike, perShard: readonly number[]): void {
    const dst = (stateLike as NodeState).shardUtil;
    dst.length = perShard.length;
    for (let i = 0; i < perShard.length; i++) dst[i] = perShard[i];
  }

  isEdgeCut(edgeId: string): boolean {
    return this.cutEdges.has(edgeId);
  }

  /* ---------------- utilization integration ---------------- */

  private integrateAll(): void {
    for (const state of this.nodes.values()) {
      const dt = this.now - state.lastIntegrateMs;
      state.lastIntegrateMs = this.now;
      if (dt <= 0) continue;
      const capacity = this.effectiveCapacity(state);
      // A buffer's slot count is meaningless, so it reports zero utilisation.
      const instant = state.behaviour.servesRequests
        ? Math.min(state.busy / capacity, 1)
        : 0;
      // Exponential smoothing over roughly a 1s window.
      const alpha = 1 - Math.exp(-dt / 500);
      state.utilization += (instant - state.utilization) * alpha;
      state.busyMsAccum += state.busy * dt;
    }
  }

  /**
   * Autonomous per-advance work for kinds that act without a request arriving.
   * No current kind declares onTick, so tickNodes is empty and this is never
   * reached; it exists so an autoscaler or circuit breaker can be added as a
   * pure registry entry.
   */
  private runTicks(dtMs: number): void {
    for (let i = 0; i < this.tickNodes.length; i++) {
      const state = this.tickNodes[i];
      state.behaviour.onTick!(this, state, dtMs);
    }
  }

  /* ---------------- history ---------------- */

  private maybeRecordHistory(): void {
    while (this.now - this.lastHistoryMs >= HISTORY_INTERVAL_MS) {
      this.lastHistoryMs += HISTORY_INTERVAL_MS;
      const t = this.lastHistoryMs;
      this.sysLatency.percentiles(this.now, this.pctScratch);
      const good = this.sysGood.rate(this.now);
      const failed = this.sysFailed.rate(this.now);
      const done = good + failed;
      this.history.push({
        t,
        p50: this.pctScratch[0],
        p95: this.pctScratch[1],
        p99: this.pctScratch[2],
        goodput: good,
        offered: this.sysOffered.rate(this.now),
        errorRate: done > 0 ? failed / done : 0,
      });
      if (this.history.length > HISTORY_MAX) {
        this.history.splice(0, this.history.length - HISTORY_MAX);
      }
    }
  }

  /* ---------------- pools ---------------- */

  private push(time: number, kind: number, nodeId: string, req: Req | null, token: number): void {
    const ev = this.freeEv.pop();
    if (ev) {
      ev.time = time;
      ev.seq = this.seq++;
      ev.kind = kind;
      ev.nodeId = nodeId;
      ev.req = req;
      ev.token = token;
      this.heap.push(ev);
      return;
    }
    this.heap.push({ time, seq: this.seq++, kind, nodeId, req, token });
  }

  private releaseEv(ev: Ev): void {
    ev.req = null;
    if (this.freeEv.length < 4096) this.freeEv.push(ev);
  }

  private acquireReq(): Req {
    this.liveRequests++;
    const pooled = this.freeReq;
    if (pooled) {
      this.freeReq = pooled.next;
      pooled.next = null;
      pooled.token = (pooled.token + 1) | 0;
      pooled.nodeId = '';
      pooled.parent = null;
      pooled.pending = 0;
      pooled.maxChildMs = 0;
      pooled.childFailed = false;
      pooled.childReason = 'error';
      pooled.enterMs = 0;
      pooled.rootStartMs = 0;
      pooled.hop = 0;
      pooled.attempt = 0;
      pooled.abandoned = false;
      pooled.holdingSlot = false;
      pooled.viaEdge = '';
      pooled.detached = false;
      pooled.retryTarget = '';
      pooled.retryAttempt = 0;
      pooled.ownMs = 0;
      pooled.resolved = false;
      pooled.key = 0;
      pooled.isWrite = false;
      pooled.extraServiceMs = 0;
      pooled.onDrained = null;
      return pooled;
    }
    return {
      token: 1,
      nodeId: '',
      parent: null,
      pending: 0,
      maxChildMs: 0,
      childFailed: false,
      childReason: 'error',
      enterMs: 0,
      rootStartMs: 0,
      hop: 0,
      attempt: 0,
      abandoned: false,
      holdingSlot: false,
      viaEdge: '',
      detached: false,
      retryTarget: '',
      retryAttempt: 0,
      ownMs: 0,
      next: null,
      resolved: false,
      key: 0,
      isWrite: false,
      extraServiceMs: 0,
      onDrained: null,
    };
  }

  private recycle(req: Req): void {
    this.liveRequests--;
    // Bump the token so any timer still referencing this incarnation is stale.
    req.token = (req.token + 1) | 0;
    req.parent = null;
    req.next = this.freeReq;
    this.freeReq = req;
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function createNodeState(node: SimNode): NodeState {
  return {
    id: node.id,
    kind: node.kind,
    behaviour: behaviourFor(node.kind),
    config: { ...node.config },
    busy: 0,
    waiting: [],
    waitHead: 0,
    out: [],
    sources: [],
    busyMsAccum: 0,
    lastIntegrateMs: 0,
    utilization: 0,
    arrivals: new RateCounter(),
    completions: new RateCounter(),
    errors: new RateCounter(),
    sheds: new RateCounter(),
    timeouts: new RateCounter(),
    hits: new RateCounter(),
    misses: new RateCounter(),
    latency: new LatencyRing(),
    totalCompleted: 0,
    totalFailed: 0,
    pollScheduled: false,
    shardUtil: [],
    ext: null,
    custom: null,
  };
}

/**
 * Project an internal Fault into the public ActiveFailure shape, carrying only
 * the knobs that actually apply to its kind so the UI does not render a
 * meaningless "factor 1" against a crash.
 */
function describeFault(nodeId: string, f: Fault): ActiveFailure {
  const out: ActiveFailure = { nodeId, kind: f.kind, sinceMs: f.sinceMs };
  if (f.kind === 'slow') out.factor = f.factor;
  else if (f.kind === 'errors') out.rate = f.rate;
  else if (f.kind === 'partition') out.edgeIds = f.edgeIds.slice();
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function cloneTopology(t: Topology): Topology {
  return {
    nodes: t.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: t.edges.map((e) => ({ ...e })),
  };
}
