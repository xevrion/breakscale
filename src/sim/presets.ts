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
  // Every scalable kind starts as a single machine. Present explicitly rather
  // than left undefined so the Inspector has something to show and a student
  // can see that "1" is a choice, not an absence -- the engine treats the two
  // identically.
  instances: 1,
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
      // Adds and removes INSTANCES to hold its target at 70% utilisation,
      // stepping by half the current fleet.
      //
      // THE TIMINGS, on a human scale. A student drags the load slider up and
      // this is what they should see, measured rather than guessed:
      //
      //   t+0.0s  load arrives; utilisation climbs and pins at 1.0
      //   t+~3s   cooldown expires, the controller decides and books machines
      //           (phase 'cooldown' -> 'warming', ghost instances appear)
      //   t+~7s   the machines boot and start serving (warmupMs=4000 later);
      //           utilisation falls back toward the setpoint
      //
      // So: something visibly happens within about three seconds, and the
      // whole arc completes in under ten. 4s of warmup is the balance point.
      // Shorter and the lag stops being legible -- capacity looks like it
      // answers instantly, which teaches the opposite of the truth. Much
      // longer (the previous default was 10s) and a student watching a live
      // graph concludes the component is broken before it ever acts.
      //
      // cooldownMs 3000 < warmupMs 4000 is deliberate and is the documented
      // oscillation regime: the controller can want a second step while the
      // first is still booting. It does not thrash, because a booked scale-up
      // blocks further decisions, but the fleet does hunt around the setpoint
      // rather than settling dead on it -- which is what real ones do.
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
        // In INSTANCES, not slots: between 1 and 12 machines.
        minCapacity: 1,
        maxCapacity: 12,
        cooldownMs: 3000,
        scaleStepPct: 0.5,
        warmupMs: 4000,
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
    case 'objectstore':
      // Blob storage: every request pays a high flat latency, but the pool
      // is wide. 64 slots / 90ms -> ~710 rps of ceiling at ~90ms each,
      // which is "effectively unlimited" next to any database in this app.
      return {
        capacity: 64,
        serviceMs: 90,
        serviceCv: 0.4,
        queueLimit: 1024,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'searchindex':
      // Searches are cheap (8ms); a write pays +60ms of indexing on top and
      // becomes searchable only 1.5s after it commits. At the default 90/10
      // read mix the mean cost is ~14ms -> 12 slots gives ~850 rps.
      return {
        capacity: 12,
        serviceMs: 8,
        serviceCv: 0.5,
        queueLimit: 128,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        indexMs: 60,
        indexLagMs: 1500,
      };
    case 'timeseriesdb':
      // Appends cost 1.5ms; a range query pays +120ms. At 5% range queries
      // the mean is ~7.5ms -> 16 slots gives ~2100 rps of mixed traffic,
      // which is the "metrics firehose" headroom the kind exists to show.
      return {
        capacity: 16,
        serviceMs: 1.5,
        serviceCv: 0.4,
        queueLimit: 1024,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rangeQueryFraction: 0.05,
        rangeQueryMs: 120,
      };
    case 'graphdb':
      // Depth 2 (friends-of-friends) costs 3x the base 6ms -> 18ms mean,
      // 8 slots -> ~440 rps. Each extra hop of depth divides that by 3.
      return {
        capacity: 8,
        serviceMs: 6,
        serviceCv: 0.5,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        traversalDepth: 2,
      };
    case 'coldstorage':
      // Archival: SECONDS per retrieval, deliberately few slots. 24 slots /
      // 2.8s is ~8.5 rps -- fine for a trickle of restores, hopeless for
      // anything shaped like online traffic. Callers need a long timeout.
      return {
        capacity: 24,
        serviceMs: 2800,
        serviceCv: 0.3,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'vectordb':
      // Mean query cost is serviceMs * log2(2 + indexSizeK) / (1 - recall):
      // 0.5ms * ~10 * 10 = ~50ms at one million vectors and 0.9 recall, so
      // 16 slots gives ~320 rps. Pushing recall to 0.99 costs 10x that.
      return {
        capacity: 16,
        serviceMs: 0.5,
        serviceCv: 0.4,
        queueLimit: 128,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        indexSizeK: 1000,
        recallTarget: 0.9,
      };
    case 'streambroker':
      // A partitioned log: 1ms producer ack, 4 partitions, and queueLimit is
      // RETENTION in messages. Per consumer group the parallelism ceiling is
      // the partition count, so throughput per group = 4 x (1000/consumerMs).
      return {
        capacity: 1,
        serviceMs: 1,
        serviceCv: 0.2,
        queueLimit: 2000,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        partitions: 4,
      };
    case 'pubsub':
      // A topic: near-instant ack, then one delivery per subscriber edge.
      // No knobs of its own; the amplification comes from the wiring.
      return {
        capacity: 1,
        serviceMs: 0.5,
        serviceCv: 0.2,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'websocket':
      // Capacity is CONNECTIONS HELD: 400 per instance, held ~30s each, so
      // by Little's law it saturates at about 13 new connections/sec per
      // instance. The 5ms serviceMs is only the handshake.
      return {
        capacity: 400,
        serviceMs: 5,
        serviceCv: 0.4,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        connectionMs: 30000,
      };
    case 'apigateway':
      // The front door: 2ms of auth/routing work per request, a 300 rps
      // token bucket with one second of burst headroom, and 1% bad auth.
      return {
        capacity: 64,
        serviceMs: 2,
        serviceCv: 0.3,
        queueLimit: 256,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rateLimitRps: 300,
        burst: 300,
        authFailRate: 0.01,
      };
    case 'sidecar':
      // The proxy tax: 2ms on every request, in exchange for 2 retries, a
      // 500ms per-attempt deadline, and outlier ejection after 5 straight
      // downstream failures (3s ejection, matching the breaker's openMs).
      return {
        capacity: 32,
        serviceMs: 2,
        serviceCv: 0.2,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 500,
        retries: 2,
        rps: 0,
        outlierAfter: 5,
        openMs: 3000,
      };
    case 'lambda':
      // Serverless: 25ms of work when warm, +350ms cold start, instances kept
      // warm 12s, at most 40 running at once (beyond that the platform
      // throttles; there is no queue). `capacity` is unused here.
      return {
        capacity: 1,
        serviceMs: 25,
        serviceCv: 0.5,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        coldStartMs: 350,
        keepWarmMs: 12000,
        maxConcurrency: 40,
      };
    case 'cron':
      // A batch job: every 20s it dumps 50 requests down each outgoing edge
      // at once. Not a request path; requests wired INTO it are refused.
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
        intervalMs: 20000,
        batchSize: 50,
      };
    case 'bulkhead':
      // A pool of 8 concurrent calls. Refusing is free, so no slots, no
      // queue, no service time: the pool count is the whole component.
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
        bulkheadMax: 8,
      };
    case 'retryqueue':
      // Delivery concurrency of 8 at ~3ms dispatch cost. Each failed
      // delivery gets 2 redeliveries with backoff before it dead-letters;
      // the 1s per-attempt deadline is what turns a hung consumer into a
      // retryable failure instead of a stuck message.
      return {
        capacity: 8,
        serviceMs: 3,
        serviceCv: 0.3,
        queueLimit: 2000,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 1000,
        retries: 2,
        rps: 0,
      };
    case 'transcoder':
      // Batch regime: 1.2 SECONDS per job, two jobs per box. One instance
      // is 2 * (1000/1200) = ~1.7 jobs/s; feed it from a queue and size the
      // farm against the arrival rate, because a structural deficit grows
      // the backlog forever.
      return {
        capacity: 2,
        serviceMs: 1200,
        serviceCv: 0.4,
        queueLimit: 8,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'edgecompute':
      // A PoP function: ~1ms, lots of concurrency, and it can fully answer
      // 30% of requests without the origin ever hearing about them.
      return {
        capacity: 64,
        serviceMs: 1,
        serviceCv: 0.3,
        queueLimit: 512,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        edgeShare: 0.3,
      };
    case 'writebehind':
      // `capacity` is the dirty buffer (memory, not threads): up to 256
      // acknowledged writes held at once. At the 200ms flush residence
      // that supports ~1280 writes/s before the buffer itself fills.
      // Every write in it is lost if this node crashes.
      return {
        capacity: 256,
        serviceMs: 1,
        serviceCv: 0.3,
        queueLimit: 512,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        flushDelayMs: 200,
      };
    case 'loadshedder':
      // Admits 300 rps sustained. 30% of the key space is best-effort
      // traffic, and 30% of the bucket is reserved for the rest, so under
      // saturation the best-effort tier is dropped first.
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
        rateLimitRps: 300,
        burst: 300,
        lowPriorityShare: 0.3,
        priorityReserve: 0.3,
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
  objectstore: 'Object Storage',
  searchindex: 'Search Index',
  timeseriesdb: 'Time-Series DB',
  graphdb: 'Graph Database',
  coldstorage: 'Cold Storage',
  vectordb: 'Vector Database',
  streambroker: 'Stream Broker',
  pubsub: 'Pub/Sub Topic',
  websocket: 'WebSocket Gateway',
  apigateway: 'API Gateway',
  sidecar: 'Sidecar Proxy',
  lambda: 'Lambda',
  cron: 'Cron Job',
  bulkhead: 'Bulkhead',
  retryqueue: 'Retry Queue',
  transcoder: 'Transcoder',
  edgecompute: 'Edge Compute',
  writebehind: 'Write-Behind Cache',
  loadshedder: 'Load Shedder',
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

/**
 * A CONTROL edge: "`from` acts on `to`". Carries no requests -- the engine
 * leaves control edges out of every routing set -- and exists so a
 * supervisory relationship is stated in the topology rather than inferred
 * from a wire that looks exactly like a traffic path.
 */
function control(from: string, to: string): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1, control: true };
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
 *     api: 3 INSTANCES x 3 slots each = 9 slots / 25ms -> 360 rps, against
 *     250 rps offered. That is 69% utilisation, which is deliberately the
 *     controller's own setpoint: at 1x the autoscaler has already converged
 *     and holds the fleet steady, so the system is stable and the student
 *     sees a controller at rest.
 *
 *     RETUNED for the instance model. It used to be one node with `capacity:
 *     9` and the controller moved that 9 up and down -- arithmetically the
 *     same system, but the thing being added was a thread, which is invisible
 *     and is not what "autoscaling" means to anyone. The fleet is now three
 *     machines of three slots: same 9 slots, same 360 rps, same 69% at 1x,
 *     but now the number the controller moves is a number of MACHINES and the
 *     canvas can draw them appearing.
 *
 *     The lesson is what happens when you MOVE the load. Raise the client's
 *     rps and capacity does not follow immediately: the controller waits out
 *     its 3s cooldown, decides, and then the new machines take a further 4s
 *     to boot. Requests fail in that gap, and the gap is the whole point --
 *     an autoscaler is a lagging controller, not a shield. Scale-DOWN is
 *     instant, as it is in reality, which is why the recovery looks nothing
 *     like the climb.
 *
 *     maxCapacity 5 instances -> 15 slots -> 600 rps ceiling, so 4x
 *     (1000 rps) outruns the autoscaler no matter how patient it is: past
 *     some point the answer is not more of the same box. (Under the old
 *     slot-based reading this bound was `maxCapacity: 16` slots for the same
 *     640 rps; the ceiling is what was preserved, not the integer.)
 * ------------------------------------------------------------------ */

const autoscalingService: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 250, timeoutMs: 3000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      // Three slots on one machine; three machines running right now.
      capacity: 3,
      instances: 3,
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
    // The controller sits below the node it scales, joined to it by a CONTROL
    // edge. That edge names its target and carries no requests -- the engine
    // keeps control edges out of routing entirely, so this is a supervisory
    // relationship the topology states outright rather than something a
    // student has to infer from a wire that looks like every other wire.
    node('scaler', 'autoscaler', 'Autoscaler', COL(1), ROW(2), {
      targetUtil: 0.7,
      // In INSTANCES: never fewer than 2 machines, never more than 5.
      minCapacity: 2,
      maxCapacity: 5,
      cooldownMs: 3000,
      scaleStepPct: 0.5,
      warmupMs: 4000,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db'), control('scaler', 'api')],
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

/* ------------------------------------------------------------------ *
 * 14. Specialised Stores
 *     Every request finds the store built for it, and the arithmetic of
 *     WHY each store exists is visible in the meters.
 *
 *     240 rps offered, split three ways by the LB (~80 rps per API):
 *       search-api -> searchindex   80 rps at a 90/10 search/write mix.
 *                     Mean cost ~14ms against 12 slots -> ~850 rps ceiling.
 *                     Writes pay +60ms of indexing and are searchable only
 *                     1.5s after commit; the stale-search rate IS that lag.
 *       recs-api   -> vectordb + graphdb. The vector index costs ~50ms per
 *                     query at 1M vectors and 0.9 recall (16 slots ->
 *                     320 rps ceiling: the knee of this preset), the graph
 *                     runs friend-of-friend at depth 2 (~18ms -> 440 rps).
 *       media-api  -> objectstore. 90ms flat, 64 slots -> ~710 rps: high
 *                     latency, near-unlimited throughput. Not a database.
 *       every api  -> timeseriesdb. All 240 rps of metrics appends land
 *                     there and use ~11% of it; range queries are the only
 *                     thing that can hurt it, and that is a slider.
 *
 *     A separate 6 rps batch client archives through a queue into cold
 *     storage (24 slots / 2.8s -> ~8.5 rps ceiling, ~70% busy at 1x).
 *
 *     At 4x the two paths fail in character: the vector index saturates
 *     LOUDLY (sheds, client errors) while the archive pipeline fails
 *     QUIETLY -- the batch client is still acknowledged instantly while
 *     cold storage sheds the restores behind the queue.
 * ------------------------------------------------------------------ */

const specialisedStores: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 240, timeoutMs: 3000 }),
    node('batch', 'client', 'Batch Jobs', COL(0), ROW(3), { rps: 6, timeoutMs: 2000 }),
    node('lb', 'lb', 'Load Balancer', COL(1), ROW(1), { capacity: 512, serviceMs: 0.5 }),
    node('archive-q', 'queue', 'Archive Queue', COL(1), ROW(3), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('search-api', 'service', 'Search API', COL(2), ROW(0), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('recs-api', 'service', 'Recs API', COL(2), ROW(1), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('media-api', 'service', 'Media API', COL(2), ROW(2), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('archiver', 'worker', 'Archiver', COL(2), ROW(3), {
      capacity: 2,
      serviceMs: 40,
      serviceCv: 0.4,
    }),
    node('search', 'searchindex', 'Search Index', COL(3), ROW(0)),
    // 12 slots at ~50ms per query is a 240 rps ceiling: a third used at 1x,
    // and the first thing to saturate at 4x, which makes the vector index
    // the knee of the whole preset.
    node('vectors', 'vectordb', 'Vector Index', COL(3), ROW(1), { capacity: 12 }),
    node('blobs', 'objectstore', 'Object Storage', COL(3), ROW(2)),
    node('glacier', 'coldstorage', 'Cold Storage', COL(3), ROW(3)),
    node('social', 'graphdb', 'Social Graph', COL(4), ROW(0)),
    node('metrics', 'timeseriesdb', 'Metrics Store', COL(4), ROW(2)),
  ],
  edges: [
    edge('client', 'lb'),
    edge('lb', 'search-api'),
    edge('lb', 'recs-api'),
    edge('lb', 'media-api'),
    // Each API talks to its own store AND emits a metric append; a service
    // fans out to all its downstreams, so the metrics edge is taken for
    // every request, which is exactly what instrumentation does.
    edge('search-api', 'search'),
    edge('search-api', 'metrics'),
    edge('recs-api', 'vectors'),
    edge('recs-api', 'social'),
    edge('recs-api', 'metrics'),
    edge('media-api', 'blobs'),
    edge('media-api', 'metrics'),
    // The archive path: acknowledged at the queue, drained at the
    // archiver's pace, paid for in seconds at the cold tier.
    edge('batch', 'archive-q'),
    edge('archive-q', 'archiver'),
    edge('archiver', 'glacier'),
  ],
};

/* ------------------------------------------------------------------ *
 * 15. Event-Driven Backend
 *
 * The messaging tier in one picture, with the arithmetic worked out:
 *
 *   client 60 rps -> apigateway (300 rps bucket, 1% bad auth, 2ms)
 *     routes 3:1 -> api service (16 slots / 10ms = 1600 rps ceiling) ~44 rps
 *                -> lambda (25ms warm, +350ms cold, 40 concurrent)   ~15 rps
 *   api fans out to:
 *     stream broker (4 partitions, retention 2000):
 *       group A -> indexer  (4 slots / 55ms -> ~72/s; 4 partitions x
 *                  1000/55 = ~72/s -- keeps up at 1x, lags visibly at 2x+)
 *       group B -> billing  (4 slots / 12ms -> ~330/s; never behind)
 *     pub/sub topic -> push, audit, metrics (1 publish = 3 deliveries;
 *       audit is deliberately slow (2 slots / 40ms = 50/s) so at ~44 rps it
 *       runs hot without touching the other subscribers)
 *   chat client 30 conn/s -> websocket gateway (400 connection slots,
 *       8s sessions -> ~240 held, 60% full at 1x; 4x offers 120 conn/s =
 *       960 wanted and the gateway refuses everything past 400)
 *       -> sidecar (2ms tax, 2 retries, eject after 5) -> chat service
 *   cron: every 15s, 40 requests at once -> lambda -> shared db. The warm
 *       pool (~1-2 instances) cannot cover a burst of 40, so nearly every
 *       burst invocation pays the cold start, and the db (8 slots / 20ms =
 *       400/s) absorbs a spike that shows up in interactive latency.
 * ------------------------------------------------------------------ */

const eventDriven: Topology = {
  nodes: [
    node('client', 'client', 'API Clients', 40, 140, { rps: 60, timeoutMs: 2500 }),
    node('gw', 'apigateway', 'API Gateway', 250, 140, {
      capacity: 64,
      serviceMs: 2,
      // 60 rps of interactive traffic fits comfortably; at 4x the door is
      // exactly what refuses the excess, which is its job and its lesson.
      rateLimitRps: 150,
      burst: 150,
      authFailRate: 0.01,
    }),
    node('api', 'service', 'API Service', 470, 140, {
      capacity: 16,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('broker', 'streambroker', 'Event Stream', 700, 60, {
      serviceMs: 1,
      partitions: 4,
      queueLimit: 2000,
    }),
    node('indexer', 'service', 'Search Indexer', 930, 20, {
      capacity: 4,
      serviceMs: 55,
      serviceCv: 0.6,
      queueLimit: 32,
    }),
    node('billing', 'service', 'Billing', 930, 130, {
      capacity: 4,
      serviceMs: 12,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('topic', 'pubsub', 'Fan-out Topic', 700, 230, { serviceMs: 0.5 }),
    node('push', 'service', 'Push Notifs', 930, 240, {
      capacity: 4,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('audit', 'service', 'Audit Log', 930, 350, {
      capacity: 2,
      serviceMs: 40,
      serviceCv: 0.6,
      queueLimit: 24,
    }),
    node('metrics', 'service', 'Metrics', 930, 460, {
      capacity: 4,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 32,
    }),
    node('chat', 'client', 'Chat Clients', 40, 420, { rps: 30, timeoutMs: 2000 }),
    node('ws', 'websocket', 'WS Gateway', 250, 420, {
      capacity: 400,
      serviceMs: 5,
      connectionMs: 8000,
    }),
    node('mesh', 'sidecar', 'Chat Sidecar', 470, 420, {
      capacity: 32,
      serviceMs: 2,
      timeoutMs: 500,
      retries: 2,
      outlierAfter: 5,
      openMs: 3000,
    }),
    node('chatsvc', 'service', 'Chat Service', 690, 420, {
      capacity: 8,
      serviceMs: 12,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('cron', 'cron', 'Nightly Report', 40, 560, {
      intervalMs: 15000,
      batchSize: 40,
    }),
    node('fn', 'lambda', 'Report Fn', 300, 560, {
      serviceMs: 25,
      serviceCv: 0.5,
      coldStartMs: 350,
      keepWarmMs: 10000,
      maxConcurrency: 30,
    }),
    node('db', 'db', 'Database', 560, 560, {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('client', 'gw'),
    // The gateway's route table: 3 parts interactive API, 1 part function.
    edge('gw', 'api', 3),
    edge('gw', 'fn', 1),
    edge('api', 'broker'),
    edge('api', 'topic'),
    // Each broker edge is an independent consumer group.
    edge('broker', 'indexer'),
    edge('broker', 'billing'),
    // Each topic edge is one more delivery per publish.
    edge('topic', 'push'),
    edge('topic', 'audit'),
    edge('topic', 'metrics'),
    edge('chat', 'ws'),
    edge('ws', 'mesh'),
    edge('mesh', 'chatsvc'),
    edge('cron', 'fn'),
    edge('fn', 'db'),
  ],
};

/* ------------------------------------------------------------------ *
 * Resilient Delivery
 *     The resilience tier in one picture: every way a system can fail
 *     ON PURPOSE instead of by surprise.
 *
 *     Sync path, 240 rps offered:
 *       shedder   admits 700 rps sustained; 30% of keys are best-effort.
 *                 Invisible at 1x, and at 4x it drops the best-effort tier
 *                 first while the important traffic keeps its tokens.
 *       api       16 slots / 6ms -> 2600 rps, never the bottleneck.
 *       bulkhead  12 concurrent calls around recommendations. At 240 rps
 *                 a 15ms dependency holds ~3.6 in flight on average, and
 *                 the pool is sized at 3x that mean because concurrency is
 *                 Poisson: a pool at the mean would clip ordinary bursts.
 *                 Slow the dependency (inject 'slow') and the pool fills
 *                 within one round trip, after which the excess fails in
 *                 microseconds instead of queueing.
 *       recs      6 slots / 15ms -> 400 rps ceiling behind the bulkhead.
 *       writebehind  acks every write in ~1ms and holds it dirty for
 *                 200ms before the flush lands on the db: a standing
 *                 population of ~50 acknowledged-but-unwritten rows.
 *                 Crash it and watch exactly that many failures appear.
 *       retryqueue -> notify   the notification service fails 15% of
 *                 calls, so ~40/s are redelivered with backoff and only
 *                 the 0.34% that fail three straight attempts dead-letter:
 *                 failures with somewhere to go, counted on the shelf.
 *
 *     Batch path, 3 uploads/s:
 *       encode queue -> transcoder farm, 2 boxes x 2 jobs / 1.2s = 3.3
 *       jobs/s of drain against 3.0 offered. ~90% utilised at 1x; at 4x
 *       the 12 jobs/s deficit grows the backlog by ~9 jobs every second,
 *       and no amount of waiting drains it. Scale `instances` to fix it.
 * ------------------------------------------------------------------ */

const resilientDelivery: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 240, timeoutMs: 2500 }),
    node('shedder', 'loadshedder', 'Load Shedder', COL(1), ROW(1), {
      rateLimitRps: 700,
      burst: 700,
      lowPriorityShare: 0.3,
      priorityReserve: 0.3,
    }),
    node('api', 'service', 'API Server', COL(2), ROW(1), {
      capacity: 16,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('bulkhead', 'bulkhead', 'Recs Bulkhead', COL(3), ROW(0), {
      bulkheadMax: 12,
    }),
    node('recs', 'service', 'Recommendations', COL(4), ROW(0), {
      capacity: 6,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('writebuf', 'writebehind', 'Write-Behind Cache', COL(3), ROW(1), {
      capacity: 256,
      serviceMs: 1,
      serviceCv: 0.3,
      queueLimit: 512,
      flushDelayMs: 200,
    }),
    node('db', 'db', 'Database', COL(4), ROW(1), {
      capacity: 12,
      serviceMs: 15,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
    node('retryq', 'retryqueue', 'Notify Queue', COL(3), ROW(2), {
      capacity: 8,
      serviceMs: 3,
      serviceCv: 0.3,
      queueLimit: 2000,
      timeoutMs: 1000,
      retries: 2,
    }),
    node('notify', 'service', 'Notification Service', COL(4), ROW(2), {
      capacity: 6,
      serviceMs: 12,
      serviceCv: 0.5,
      errorRate: 0.15,
      queueLimit: 48,
    }),
    node('uploader', 'client', 'Upload Client', COL(0), ROW(3), {
      rps: 3,
      timeoutMs: 4000,
    }),
    node('encodeq', 'queue', 'Encode Queue', COL(1), ROW(3), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('transcoder', 'transcoder', 'Transcoder Farm', COL(2), ROW(3), {
      instances: 2,
      capacity: 2,
      serviceMs: 1200,
      serviceCv: 0.3,
    }),
  ],
  edges: [
    edge('client', 'shedder'),
    edge('shedder', 'api'),
    // The api fans out to all three: recommendations behind their own
    // bulkhead, writes into the write-behind buffer, and a notification
    // job into the retry queue. Both delivery nodes ack instantly, so
    // the client's fate rides on the recommendations path alone.
    edge('api', 'bulkhead'),
    edge('api', 'writebuf'),
    edge('api', 'retryq'),
    edge('bulkhead', 'recs'),
    edge('writebuf', 'db'),
    edge('retryq', 'notify'),
    edge('uploader', 'encodeq'),
    edge('encodeq', 'transcoder'),
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
  {
    id: 'specialised-stores',
    name: 'Specialised Stores',
    description:
      'Search, vectors, graph, blobs, metrics and an archive tier, each store built for one job. Watch which one saturates first, and which fails without a sound.',
    topology: specialisedStores,
  },
  {
    id: 'event-driven',
    name: 'Event-Driven Backend',
    description:
      'A stream with two consumer groups, a fan-out topic, a websocket tier, a sidecar, a lambda and a cron burst. Watch consumer lag grow, cold starts spike on the quarter-minute, and connections, not requests, run out.',
    topology: eventDriven,
  },
  {
    id: 'resilient-delivery',
    name: 'Resilient Delivery',
    description:
      'Failing on purpose: a shedder drops the traffic that matters least, a bulkhead contains a slow dependency, retried deliveries land on a dead letter shelf, and a write-behind buffer trades durability for speed.',
    topology: resilientDelivery,
  },
];
