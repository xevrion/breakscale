import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from './types';

export interface Preset {
  id: string;
  name: string;
  description: string;
  topology: Topology;
}

/**
 * Defaults for config fields that only some kinds read.
 *
 * Every `case` below returns a literal for the knobs that kind actually
 * exposes; these fill in the rest. Keeping them in one spread means adding a
 * field to NodeConfig does not force an edit to all the existing cases.
 */
const EXTRA_DEFAULTS = {
  // replica: a 3-node read replica set, 50ms behind, mostly-read traffic.
  replicaCount: 3,
  replicationLagMs: 50,
  readFraction: 0.9,
  // shard: 4 partitions, keys spread evenly (no hot key) until you make one.
  shardCount: 4,
  shardCapacity: 4,
  hotKeyFraction: 0,
} satisfies Partial<NodeConfig>;

/** Sensible starting knobs for a freshly dropped node of each kind. */
export function defaultConfig(kind: NodeKind): NodeConfig {
  return { ...EXTRA_DEFAULTS, ...baseConfig(kind) };
}

/** Per-kind knobs. Fields a kind does not care about come from EXTRA_DEFAULTS. */
function baseConfig(kind: NodeKind): Omit<NodeConfig, keyof typeof EXTRA_DEFAULTS> {
  switch (kind) {
    case 'client':
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 1000,
        retries: 0,
        rps: 50,
      };
    case 'lb':
      return {
        capacity: 256,
        serviceMs: 0.5,
        serviceCv: 0.2,
        queueLimit: 1024,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'service':
      return {
        capacity: 8,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'cache':
      return {
        capacity: 32,
        serviceMs: 3,
        serviceCv: 0.4,
        queueLimit: 256,
        hitRate: 0.8,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'db':
      return {
        capacity: 6,
        serviceMs: 30,
        serviceCv: 0.7,
        queueLimit: 32,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'queue':
      return {
        capacity: 1,
        serviceMs: 1,
        serviceCv: 0.2,
        queueLimit: 5000,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'worker':
      return {
        capacity: 4,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'replica':
      // Reads fan across the replicas, so per-replica capacity is modest.
      return {
        capacity: 4,
        serviceMs: 20,
        serviceCv: 0.6,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'shard':
      // Per-shard slots live in shardCapacity; `capacity` is unused here.
      return {
        capacity: 4,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 32,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'cdn':
      // An edge PoP: very fast, very high hit rate, lots of concurrency.
      // At hitRate 0.92 the origin behind it sees 8% of the offered load.
      return {
        capacity: 256,
        serviceMs: 2,
        serviceCv: 0.3,
        queueLimit: 2048,
        hitRate: 0.92,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'ratelimiter':
      // A doorman: refusing costs nothing, so no service time and no slots.
      // 100 rps sustained with one second of burst headroom.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rateLimitRps: 100,
        burst: 100,
      };
    case 'breaker':
      // Trips once half the downstream calls in a 5s window fail, stays open
      // 3s, then lets 3 probes decide whether to close.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        errorThreshold: 0.5,
        windowMs: 5000,
        openMs: 3000,
        halfOpenProbes: 3,
      };
    case 'autoscaler':
      // Holds its target at 70% utilisation, steps by half the current
      // capacity, and waits 3s between decisions. The 10s warmup is the knob
      // worth playing with: it is deliberately long enough that the lag
      // between load arriving and capacity answering is visible on the graph
      // rather than being something you have to take on faith.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        targetUtil: 0.7,
        minCapacity: 1,
        maxCapacity: 32,
        cooldownMs: 3000,
        scaleStepPct: 0.5,
        warmupMs: 10000,
      };
    case 'region':
      // Two regions, serving from the first. The 5s failover is long enough
      // to see as a real outage on the error graph and short enough that a
      // student does not think the simulation has hung.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        regions: 2,
        activeRegion: 0,
        failoverMs: 5000,
      };
    default:
      return {
        capacity: 1,
        serviceMs: 10,
        serviceCv: 0.5,
        queueLimit: 32,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
  }
}

const DEFAULT_LABEL: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load Balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
  replica: 'Read Replicas',
  shard: 'Sharded Store',
  cdn: 'CDN',
  ratelimiter: 'Rate Limiter',
  breaker: 'Circuit Breaker',
  autoscaler: 'Autoscaler',
  region: 'Region',
};

let nodeCounter = 0;

export function makeNode(kind: NodeKind, x: number, y: number, label?: string): SimNode {
  nodeCounter += 1;
  return {
    id: `${kind}-${nodeCounter}`,
    kind,
    label: label ?? DEFAULT_LABEL[kind],
    x,
    y,
    config: defaultConfig(kind),
  };
}

/* ------------------------------------------------------------------ *
 * Preset construction helpers
 * ------------------------------------------------------------------ */

function node(
  id: string,
  kind: NodeKind,
  label: string,
  x: number,
  y: number,
  overrides: Partial<NodeConfig> = {},
): SimNode {
  return {
    id,
    kind,
    label,
    x,
    y,
    config: { ...defaultConfig(kind), ...overrides },
  };
}

function edge(from: string, to: string, weight = 1): SimEdge {
  return { id: `${from}->${to}`, from, to, weight };
}

/* ------------------------------------------------------------------ *
 * 1. Single Server
 *    service: 8 slots / 25ms  -> 320 rps
 *    db:      6 slots / 30ms  -> 200 rps  <- first bottleneck
 *    default 50 rps, knee around 4x.
 * ------------------------------------------------------------------ */

const singleServer: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 50, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', 340, 200, {
      capacity: 8,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
    node('db', 'db', 'Database', 660, 200, {
      capacity: 6,
      serviceMs: 30,
      serviceCv: 0.7,
      queueLimit: 48,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db')],
};

/* ------------------------------------------------------------------ *
 * 2. Load Balanced
 *    3 services: 3 x (6 slots / 25ms) = 720 rps
 *    shared db:  12 slots / 25ms      = 480 rps <- bottleneck anyway
 *    default 140 rps, db bites around 3.4x.
 * ------------------------------------------------------------------ */

const loadBalanced: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 220, { rps: 140, timeoutMs: 2000 }),
    node('lb', 'lb', 'Load Balancer', 260, 220, { capacity: 512, serviceMs: 0.5 }),
    node('api1', 'service', 'API 1', 500, 80, {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('api2', 'service', 'API 2', 500, 220, {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('api3', 'service', 'API 3', 500, 360, {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('db', 'db', 'Database', 800, 220, {
      capacity: 12,
      serviceMs: 25,
      serviceCv: 0.7,
      queueLimit: 96,
    }),
  ],
  edges: [
    edge('client', 'lb'),
    edge('lb', 'api1'),
    edge('lb', 'api2'),
    edge('lb', 'api3'),
    edge('api1', 'db'),
    edge('api2', 'db'),
    edge('api3', 'db'),
  ],
};

/* ------------------------------------------------------------------ *
 * 3. Cache Aside
 *    cache: 64 slots / 2ms -> effectively unlimited
 *    db:    4 slots / 30ms -> 133 rps, but only (1 - hitRate) reaches it.
 *    At hitRate 0.85 and 200 rps offered the db sees ~30 rps.
 *    Drop hitRate to ~0.3 and the db is instantly over its 133 rps ceiling.
 * ------------------------------------------------------------------ */

const cacheAside: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 200, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', 280, 200, {
      capacity: 24,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('cache', 'cache', 'Cache', 550, 200, {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.4,
      hitRate: 0.85,
      queueLimit: 512,
    }),
    node('db', 'db', 'Database', 820, 200, {
      capacity: 4,
      serviceMs: 30,
      serviceCv: 0.7,
      queueLimit: 32,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'cache'), edge('cache', 'db')],
};

/* ------------------------------------------------------------------ *
 * 4. Async Workers
 *    api:     24 slots / 8ms  -> 3000 rps (never the bottleneck)
 *    queue:   ack ~1ms, 5000 deep
 *    workers: 6 slots / 30ms  -> 200 rps drain rate <- the real ceiling
 *    default 120 rps drains fine; push past 200 and the backlog grows
 *    without the client ever seeing an error, until the buffer fills.
 * ------------------------------------------------------------------ */

const asyncWorkers: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 120, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', 260, 200, {
      capacity: 24,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('queue', 'queue', 'Message Queue', 500, 200, {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('worker', 'worker', 'Workers', 730, 200, {
      capacity: 6,
      serviceMs: 30,
      serviceCv: 0.6,
    }),
    node('db', 'db', 'Database', 860, 380, {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.7,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('client', 'api'),
    edge('api', 'queue'),
    edge('queue', 'worker'),
    edge('worker', 'db'),
  ],
};

/* ------------------------------------------------------------------ *
 * 5. Retry Storm
 *    db: 4 slots / 40ms -> 100 rps ceiling.
 *    The api timeout (250ms) sits comfortably above the db's uncongested
 *    tail latency (~110ms at low load), so retries fire only once real
 *    queueing develops -- not from service-time variance alone. Below the
 *    ceiling each request needs one attempt and load passes through 1:1.
 *    Once queueing pushes past 250ms, every request starts issuing all 3
 *    attempts, tripling the offered load onto a db already at its limit,
 *    and the system collapses. Stable to ~90 rps (2x), collapses ~110 (2.4x).
 * ------------------------------------------------------------------ */

const retryStorm: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 45, timeoutMs: 3000 }),
    node('api', 'service', 'API Server', 340, 200, {
      capacity: 32,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 256,
      timeoutMs: 250,
      retries: 2,
    }),
    node('db', 'db', 'Database', 680, 200, {
      capacity: 4,
      serviceMs: 40,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db')],
};

/* ================================================================== *
 * Grid geometry for the presets below.
 *
 * Canvas draws a node as NODE_W=184 x NODE_H=88 anchored at (x, y). A column
 * pitch of 260 leaves 76px of horizontal gutter for the edge to be visible,
 * and a row pitch of 130 leaves 42px vertically. Every preset places nodes on
 * COL(i) / ROW(j) so no two boxes can overlap by construction, and the
 * verifier asserts it rather than trusting the arithmetic.
 * ================================================================== */

const COL0 = 40;
const COL_PITCH = 260;
const ROW0 = 60;
const ROW_PITCH = 130;

/** x of grid column i (0-based), left-to-right. */
const COL = (i: number) => COL0 + i * COL_PITCH;
/** y of grid row j (0-based), top-to-bottom. */
const ROW = (j: number) => ROW0 + j * ROW_PITCH;

/* ------------------------------------------------------------------ *
 * 6. CDN + Origin
 *    cdn:    256 slots / 2ms  -> effectively unbounded
 *    origin:   3 slots / 25ms -> 120 rps ceiling
 *    At hitRate 0.90 and 400 rps offered the origin sees ~40 rps: a third of
 *    its ceiling. At 4x it sees ~160 rps and is over the ceiling, which is
 *    the same collapse a student can trigger at 1x just by dragging the hit
 *    rate down -- the point being that the origin was never sized for the
 *    traffic the CDN was absorbing.
 * ------------------------------------------------------------------ */

const cdnOrigin: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 400, timeoutMs: 2000 }),
    node('cdn', 'cdn', 'CDN Edge', COL(1), ROW(1), {
      capacity: 256,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 2048,
    }),
    node('origin', 'service', 'Origin Server', COL(2), ROW(1), {
      capacity: 3,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
    node('db', 'db', 'Database', COL(3), ROW(1), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
  ],
  edges: [edge('client', 'cdn'), edge('cdn', 'origin'), edge('origin', 'db')],
};

/* ------------------------------------------------------------------ *
 * 7. Rate Limited API
 *    limiter: 200 rps sustained, 200-token burst
 *    api:       6 slots / 25ms -> 240 rps ceiling
 *    The limiter is set just under what the api can actually serve, so at 1x
 *    (150 rps) every request is admitted and nothing is refused: the limiter
 *    is invisible until it is needed.
 *
 *    What it buys is NOT extra goodput -- measured at 600 rps offered, the
 *    limiter serves 200 rps where removing it serves 234. It buys LATENCY for
 *    the requests that do get through:
 *
 *      600 rps    goodput   p50     p99    api queue
 *      limiter     200.0    36ms    80ms      0
 *      no limiter  234.4   235ms   292ms     46
 *
 *    Without the limiter every caller waits behind a 46-deep queue for an
 *    answer that mostly arrives too late to be useful. With it, the system
 *    says no quickly to some so it can say yes quickly to the rest. That
 *    trade -- a lower ceiling in exchange for a flat, predictable latency --
 *    is the whole argument for admission control, and it is why the honest
 *    comparison is p50, not throughput.
 * ------------------------------------------------------------------ */

const rateLimitedApi: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 150, timeoutMs: 2000 }),
    node('limiter', 'ratelimiter', 'Rate Limiter', COL(1), ROW(1), {
      rateLimitRps: 200,
      burst: 200,
    }),
    node('api', 'service', 'API Server', COL(2), ROW(1), {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 48,
    }),
    node('db', 'db', 'Database', COL(3), ROW(1), {
      capacity: 12,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
  ],
  edges: [edge('client', 'limiter'), edge('limiter', 'api'), edge('api', 'db')],
};

/* ------------------------------------------------------------------ *
 * 8. Circuit Breaker
 *    payments: 4 slots / 30ms -> 133 rps ceiling, and it is the dependency
 *    that goes bad. The breaker trips once half the calls in a 4s window
 *    fail, stays open 3s, then probes.
 *    At 1x (100 rps) the dependency is inside its ceiling and the circuit
 *    stays closed all run. At 4x it is 3x oversubscribed, its queue fills,
 *    the shed rate crosses the error threshold and the breaker trips -- after
 *    which requests fail in microseconds instead of waiting out a timeout.
 *    Injecting a `crash` or raising errorRate on payments trips it on demand.
 * ------------------------------------------------------------------ */

const circuitBreaker: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 100, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 24,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
      timeoutMs: 600,
    }),
    node('breaker', 'breaker', 'Circuit Breaker', COL(2), ROW(1), {
      errorThreshold: 0.5,
      windowMs: 4000,
      openMs: 3000,
      halfOpenProbes: 3,
    }),
    node('payments', 'service', 'Payments API', COL(3), ROW(1), {
      capacity: 4,
      serviceMs: 30,
      serviceCv: 0.6,
      queueLimit: 32,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'breaker'), edge('breaker', 'payments')],
};

/* ------------------------------------------------------------------ *
 * 9. Read Replicas
 *    replicas: 3 x 4 slots / 20ms -> 600 rps of READ capacity
 *    primary:      4 slots / 20ms -> 200 rps of WRITE capacity
 *    At 85% reads and 300 rps offered that is 255 reads against 600 and 45
 *    writes against 200: comfortable. At 4x the reads blow past 600 while the
 *    writes are still inside their own ceiling, so adding replicas is the fix
 *    for one and does nothing at all for the other.
 *    The 60ms replication lag is what makes stale reads visible without
 *    needing an unrealistic write rate.
 * ------------------------------------------------------------------ */

const readReplicas: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 300, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 32,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    node('replicas', 'replica', 'Replica Set', COL(2), ROW(1), {
      capacity: 4,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 128,
      replicaCount: 3,
      replicationLagMs: 60,
      readFraction: 0.85,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'replicas')],
};

/* ------------------------------------------------------------------ *
 * 10. Sharded Database
 *     4 shards x 4 slots / 25ms -> 160 rps PER SHARD, 640 rps total.
 *     At 400 rps spread evenly by key each shard carries ~100 of its 160 and
 *     the store is fine. The whole lesson is in hotKeyFraction: push it to
 *     0.8 and shard 0 alone is offered 320 rps against its own 160, so it
 *     pins at 100% and sheds while the node-level utilisation meter -- the
 *     mean across shards -- still reads comfortable.
 * ------------------------------------------------------------------ */

const shardedDatabase: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 400, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 32,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    node('shards', 'shard', 'Sharded Store', COL(2), ROW(1), {
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 4,
      shardCapacity: 4,
      hotKeyFraction: 0,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'shards')],
};

/* ------------------------------------------------------------------ *
 * 11. Autoscaling Service
 *     api: 9 slots / 25ms -> 360 rps, against 250 rps offered. That is 69%
 *     utilisation, which is deliberately the controller's own setpoint: at
 *     1x the autoscaler has already converged and holds the size steady, so
 *     the system is stable and the student sees a controller at rest.
 *
 *     The lesson is what happens when you MOVE the load. Raise the client's
 *     rps and the capacity graph does not follow immediately: the controller
 *     waits out its 3s cooldown, decides, and then the new slots take a
 *     further 4s to warm up. Requests fail in that gap, and the gap is the
 *     whole point -- an autoscaler is a lagging controller, not a shield.
 *     Scale-DOWN is instant, as it is in reality, which is why the recovery
 *     looks nothing like the climb.
 *
 *     maxCapacity 16 -> 640 rps ceiling, so 4x (1000 rps) outruns the
 *     autoscaler no matter how patient it is: past some point the answer is
 *     not more of the same box.
 * ------------------------------------------------------------------ */

const autoscalingService: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 250, timeoutMs: 3000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 9,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 256,
    }),
    node('db', 'db', 'Database', COL(2), ROW(1), {
      capacity: 24,
      serviceMs: 8,
      serviceCv: 0.6,
      queueLimit: 128,
    }),
    // The controller sits below the node it watches, wired to it by the edge
    // that names its target. It is not in the request path: traffic sent INTO
    // an autoscaler is refused, because a controller is not a hop.
    node('scaler', 'autoscaler', 'Autoscaler', COL(1), ROW(2), {
      targetUtil: 0.7,
      minCapacity: 4,
      maxCapacity: 16,
      cooldownMs: 3000,
      scaleStepPct: 0.5,
      warmupMs: 4000,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db'), edge('scaler', 'api')],
};

/* ------------------------------------------------------------------ *
 * 12. Multi-Region Failover
 *     Two regions, each 10 slots / 25ms -> 400 rps. Only ONE serves traffic
 *     at a time, so the pair buys availability and not one request per second
 *     of extra capacity -- which is why 4x (1000 rps) melts the active region
 *     while the standby sits at zero.
 *     Crash `us-api` (or cut the edge to it) and traffic lands on `eu-api`
 *     after the 5s failover window, during which every request fails as
 *     'region-down'. Set failoverMs to 0 to see the cutover no real system
 *     gets, or to 30000 to feel what a slow one costs.
 * ------------------------------------------------------------------ */

const multiRegion: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 250, timeoutMs: 2000 }),
    node('router', 'region', 'Region Router', COL(1), ROW(1), {
      regions: 2,
      activeRegion: 0,
      failoverMs: 5000,
    }),
    node('us-api', 'service', 'US API', COL(2), ROW(0), {
      capacity: 10,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('eu-api', 'service', 'EU API', COL(2), ROW(2), {
      capacity: 10,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('us-db', 'db', 'US Database', COL(3), ROW(0), {
      capacity: 16,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
    node('eu-db', 'db', 'EU Database', COL(3), ROW(2), {
      capacity: 16,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
  ],
  // Edge ORDER is region index: the first edge out of the router is region 0.
  edges: [
    edge('client', 'router'),
    edge('router', 'us-api'),
    edge('router', 'eu-api'),
    edge('us-api', 'us-db'),
    edge('eu-api', 'eu-db'),
  ],
};

/* ------------------------------------------------------------------ *
 * 13. Full Stack
 *     The showcase. Every tier in one picture, each sized so that the thing
 *     that breaks first is the thing a real system breaks first.
 *
 *     600 rps offered, and here is where it goes:
 *       cdn     hitRate 0.70   -> 30% miss, so ~180 rps reach the LB
 *       lb      -> 2 api, ~90 rps each
 *       api     2 x 12 slots / 8ms  -> 3000 rps, never the bottleneck
 *       cache   hitRate 0.60   -> 40% miss, so ~72 rps reach the shards
 *       shards  4 x 2 slots / 25ms  -> 320 rps total, 80 rps per shard
 *       queue   -> workers 6 / 25ms -> 240 rps of async drain
 *
 *     Both paths are sized to have real headroom at 1x and to run out of it
 *     by 4x, but they run out DIFFERENTLY, and that contrast is the lesson:
 *
 *       - the synchronous path (cache -> shards) fails LOUDLY. The shards
 *         saturate, sheds start, and the client sees errors and a fat tail.
 *       - the asynchronous path (queue -> workers) fails QUIETLY. The workers
 *         saturate too, but the queue absorbs the excess, so the client is
 *         still acknowledged instantly while an invisible backlog grows.
 *
 *     A student who watches only the error rate sees half the failure. The
 *     queue depth is the other half, and it is the half that takes hours to
 *     drain after the spike is over.
 * ------------------------------------------------------------------ */

const fullStack: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 600, timeoutMs: 3000 }),
    node('cdn', 'cdn', 'CDN Edge', COL(1), ROW(1), {
      capacity: 256,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.7,
      queueLimit: 2048,
    }),
    node('lb', 'lb', 'Load Balancer', COL(2), ROW(1), { capacity: 512, serviceMs: 0.5 }),
    node('api1', 'service', 'API 1', COL(3), ROW(0), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('api2', 'service', 'API 2', COL(3), ROW(2), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('cache', 'cache', 'Cache', COL(4), ROW(0), {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.4,
      hitRate: 0.6,
      queueLimit: 512,
    }),
    node('shards', 'shard', 'Sharded Store', COL(5), ROW(0), {
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 4,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('queue', 'queue', 'Job Queue', COL(4), ROW(2), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('workers', 'worker', 'Workers', COL(5), ROW(2), {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
    }),
  ],
  edges: [
    edge('client', 'cdn'),
    edge('cdn', 'lb'),
    edge('lb', 'api1'),
    edge('lb', 'api2'),
    // Each api reads through the cache AND books async work. Both edges are
    // taken for every request: a 'service' fans out to all its downstreams.
    edge('api1', 'cache'),
    edge('api1', 'queue'),
    edge('api2', 'cache'),
    edge('api2', 'queue'),
    edge('cache', 'shards'),
    edge('queue', 'workers'),
  ],
};

export const PRESETS: Preset[] = [
  {
    id: 'single-server',
    name: 'Single Server',
    description: 'One service in front of one database. Latency climbs sharply as the database fills up.',
    topology: singleServer,
  },
  {
    id: 'load-balanced',
    name: 'Load Balanced',
    description: 'Three servers share the load, but they all still talk to the same database.',
    topology: loadBalanced,
  },
  {
    id: 'cache-aside',
    name: 'Cache Aside',
    description: 'The cache absorbs most reads. Lower the hit rate and the database takes the whole load.',
    topology: cacheAside,
  },
  {
    id: 'async-workers',
    name: 'Async Workers',
    description: 'Requests are acknowledged instantly and buffered. Watch the backlog grow when workers fall behind.',
    topology: asyncWorkers,
  },
  {
    id: 'retry-storm',
    name: 'Retry Storm',
    description: 'A short timeout with retries in front of a small database. Retries multiply the load that caused them.',
    topology: retryStorm,
  },
  {
    id: 'cdn-origin',
    name: 'CDN + Origin',
    description: 'The CDN answers most requests at the edge, so only a trickle reaches the origin. Drop the hit rate and watch the origin melt.',
    topology: cdnOrigin,
  },
  {
    id: 'rate-limited-api',
    name: 'Rate Limited API',
    description: 'A limiter refuses excess traffic at the door. It serves slightly less, but what it does serve stays fast instead of queueing.',
    topology: rateLimitedApi,
  },
  {
    id: 'circuit-breaker',
    name: 'Circuit Breaker',
    description: 'A breaker watches a failing dependency and stops calling it. Break the payments API and watch the circuit trip, then recover.',
    topology: circuitBreaker,
  },
  {
    id: 'read-replicas',
    name: 'Read Replicas',
    description: 'Replicas scale reads but not writes, and a read can arrive before the write it should have seen.',
    topology: readReplicas,
  },
  {
    id: 'sharded-database',
    name: 'Sharded Database',
    description: 'Four partitions share the load evenly until one key gets hot, and then a single shard melts while the average still looks healthy.',
    topology: shardedDatabase,
  },
  {
    id: 'autoscaling-service',
    name: 'Autoscaling Service',
    description: 'Capacity chases the load, but new servers take time to boot, so requests fail in the gap between the two.',
    topology: autoscalingService,
  },
  {
    id: 'multi-region',
    name: 'Multi-Region Failover',
    description: 'Two regions, one serving. Crash the active one and every request fails until failover lands.',
    topology: multiRegion,
  },
  {
    id: 'full-stack',
    name: 'Full Stack',
    description: 'Every tier at once: edge cache, load balancer, services, cache, shards, and a queue of async work behind it all.',
    topology: fullStack,
  },
];
