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

export function makeNode(
  kind: NodeKind,
  x: number,
  y: number,
  label?: string,
): SimNode {
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
    node('lb', 'lb', 'Load Balancer', COL(2), ROW(1), {
      capacity: 512,
      serviceMs: 0.5,
    }),
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
    node('lb', 'lb', 'Load Balancer', COL(1), ROW(1), {
      capacity: 512,
      serviceMs: 0.5,
    }),
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

/* ------------------------------------------------------------------ *
 * Discord: Real-Time Chat
 *
 * A simplified public reconstruction, not insider knowledge. It is based
 * on what Discord has published:
 *
 *   - "How Discord Stores Trillions of Messages" (discord.com/blog):
 *     messages partitioned BY CHANNEL in Cassandra, later ScyllaDB, and
 *     the hot-partition problem when one channel gets very active. The
 *     `scylla` shard node models exactly that: shards are channel
 *     partitions and hotKeyFraction is "one huge channel".
 *   - "How Discord Scaled Elixir to 5,000,000 Concurrent Users" and
 *     "Real time communication at scale with Elixir at Discord"
 *     (discord.com/blog, elixir-lang.org/blog): a gateway tier holding
 *     millions of persistent websockets, session processes per client,
 *     one guild process fanning every message out to every connected
 *     session. The fan-out topic and the Gateway Push pods model the
 *     guild-process-to-gateway leg of that fan-out.
 *   - "How Discord Handles Two and Half Million Concurrent Voice Users
 *     using WebRTC" (discord.com/blog): voice is its own fleet of SFU
 *     servers, discovered separately, on a path that never touches the
 *     text pipeline.
 *
 * What it leaves out: presence updates (a larger firehose than messages),
 * the Rust data services and request coalescing in front of ScyllaDB,
 * permission checks, and the true fan-out multiplier (a delivery per
 * MEMBER, not per gateway pod). Every number is illustrative, chosen to
 * reproduce the relative behaviour, and none is a Discord figure.
 *
 * The arithmetic at 1x:
 *
 *   CONNECTIONS  30 conn/s x 40s sessions = 1200 held against a ceiling
 *                of 4 instances x 400 = 1600 (75%). The gateway's meter
 *                is CONNECTIONS, not requests: at 2x it wants 2400 held
 *                and refuses everything past 1600 as conn-refused. That
 *                difference is the whole lesson of the gateway tier.
 *   MESSAGES     80 msg/s -> rate limiter (200 rps, Discord's API rate
 *                limits are famous) -> message API -> three children:
 *                  scylla   6 channel shards x 2 slots / 40ms = 50/s per
 *                           shard, 300/s total; ~13/s per shard at 1x.
 *                           Set hotKeyFraction to ~0.7 and one shard is
 *                           offered 56/s against its own 50: the hot
 *                           channel melts while the mean looks fine.
 *                  fan-out  one publish becomes one delivery per gateway
 *                           push pod (3 today), all detached: the sender
 *                           is long gone. Each pod does 15ms of push work
 *                           per message (2 slots -> 133/s); at 2x the
 *                           admitted 160 msg/s exceed that and the push
 *                           tier sheds deliveries LOUDLY on its own
 *                           meters while the senders' error rate shows
 *                           NOTHING. Members just stop seeing messages;
 *                           that silence is why fan-out is hard.
 *                  search   acked into a queue, indexed asynchronously
 *                           (writes pay ~68ms each at the index).
 *   MEDIA        120 fetch/s, 90% absorbed by the CDN; the object store
 *                sees ~12/s of misses.
 *   VOICE        20 joins/s across 2 SFU servers (400/s each): a
 *                separate path that stays healthy while text melts.
 * ------------------------------------------------------------------ */

const discord: Topology = {
  nodes: [
    // Connection lane: capacity here is held connections, not rps.
    node('conn', 'client', 'New Connections', COL(0), ROW(0), {
      rps: 30,
      timeoutMs: 3000,
    }),
    node('gateway', 'websocket', 'Gateway (WS)', COL(1), ROW(0), {
      capacity: 400,
      instances: 4,
      serviceMs: 5,
      serviceCv: 0.4,
      connectionMs: 40000,
    }),
    node('sessions', 'service', 'Session Servers', COL(2), ROW(0), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),

    // Message lane.
    node('senders', 'client', 'Message Senders', COL(0), ROW(2), {
      rps: 80,
      timeoutMs: 2500,
    }),
    node('limiter', 'ratelimiter', 'API Rate Limit', COL(1), ROW(2), {
      rateLimitRps: 200,
      burst: 200,
    }),
    node('msg-api', 'service', 'Message API', COL(2), ROW(2), {
      capacity: 16,
      serviceMs: 6,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('fanout', 'pubsub', 'Guild Fan-out', COL(3), ROW(1), { serviceMs: 0.5 }),
    node('push-a', 'service', 'Gateway Push A', COL(4), ROW(0), {
      capacity: 2,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('push-b', 'service', 'Gateway Push B', COL(4), ROW(1), {
      capacity: 2,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('push-c', 'service', 'Gateway Push C', COL(4), ROW(2), {
      capacity: 2,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    // Messages are partitioned by channel; a shard here IS a channel range.
    node('scylla', 'shard', 'Message Store', COL(3), ROW(2), {
      serviceMs: 40,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 6,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('search-q', 'queue', 'Index Queue', COL(3), ROW(3), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('indexer', 'worker', 'Search Indexer', COL(4), ROW(3), {
      capacity: 4,
      serviceMs: 12,
      serviceCv: 0.5,
    }),
    node('search', 'searchindex', 'Message Search', COL(5), ROW(3), {
      readFraction: 0.15,
    }),

    // Media lane: attachments behind a CDN.
    node('media', 'client', 'Media Fetch', COL(0), ROW(4), {
      rps: 120,
      timeoutMs: 2000,
    }),
    node('cdn', 'cdn', 'Media CDN', COL(1), ROW(4), {
      capacity: 256,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 2048,
    }),
    node('blobs', 'objectstore', 'Attachments', COL(2), ROW(4)),

    // Voice lane: a separate fleet entirely.
    node('voice', 'client', 'Voice Joins', COL(0), ROW(5), {
      rps: 20,
      timeoutMs: 3000,
    }),
    node('rtc', 'lb', 'RTC Discovery', COL(1), ROW(5), {
      capacity: 256,
      serviceMs: 0.5,
    }),
    node('sfu-a', 'service', 'Voice Server A', COL(2), ROW(5), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('sfu-b', 'service', 'Voice Server B', COL(2), ROW(6), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('conn', 'gateway'),
    edge('gateway', 'sessions'),
    edge('senders', 'limiter'),
    edge('limiter', 'msg-api'),
    // A message write fans to all three: the store decides the sender's
    // fate; the fan-out and the index pipeline ack instantly and fail,
    // when they fail, where the sender cannot see it.
    edge('msg-api', 'scylla'),
    edge('msg-api', 'fanout'),
    edge('msg-api', 'search-q'),
    edge('fanout', 'push-a'),
    edge('fanout', 'push-b'),
    edge('fanout', 'push-c'),
    edge('search-q', 'indexer'),
    edge('indexer', 'search'),
    edge('media', 'cdn'),
    edge('cdn', 'blobs'),
    edge('voice', 'rtc'),
    edge('rtc', 'sfu-a'),
    edge('rtc', 'sfu-b'),
  ],
};

/* ------------------------------------------------------------------ *
 * Uber: Ride Dispatch
 *
 * A simplified public reconstruction, not insider knowledge. Based on
 * what Uber has published:
 *
 *   - "H3: Uber's Hexagonal Hierarchical Spatial Index" (uber.com/blog/h3)
 *     and their dispatch talks: driver locations land in a geospatial
 *     index sharded by cell/region, and matching reads the cells around
 *     the rider. The `geo` shard node is that index; hotKeyFraction is
 *     "everyone is downtown on Friday night".
 *   - "Real-time Data Infrastructure at Uber" (arxiv.org/abs/2104.00087):
 *     Kafka carries the event firehose; the surge pricing pipeline
 *     consumes trip and status events through Kafka into a streaming job
 *     and writes multipliers to a key-value sink store that pricing
 *     reads; M3 is the metrics store consuming the same stream.
 *   - "Brief History of Scaling Uber" (highscalability.com) and Uber's
 *     own posts on DISCO and Ringpop: a dispatch service split from an
 *     edge gateway, matching as its own latency-critical system, trip
 *     state in Schemaless (a replicated MySQL-backed store).
 *
 * What it leaves out: Ringpop's peer sharding, ETA routing graphs, the
 * ML inside surge, driver session state, and several dozen real
 * services. Every number is illustrative, not an Uber figure.
 *
 * The arithmetic at 1x:
 *
 *   WRITE SIDE   400 location pings/s from drivers, acked by ingest in
 *                ~3ms and published to the stream. Three consumer groups
 *                read it independently:
 *                  geo writer  keeps the location index fresh. Ceiling
 *                              ~750/s (12 partitions x ~16ms per update
 *                              including the shard write): comfortable at
 *                              430/s, hopeless at 4x (1630/s), where its
 *                              CONSUMER LAG grows and eventually ages out
 *                              of retention. A lagging geo writer means
 *                              dispatch is matching on stale positions,
 *                              and nothing on the rider path says so.
 *                  surge       recomputes multipliers into the surge KV
 *                              store that pricing reads.
 *                  M3          the metrics firehose, appends are cheap.
 *   READ SIDE    30 rider requests/s through the edge gateway, 3:1 to
 *                dispatch vs trip status. Dispatch fans to the geo index
 *                (2 slots x 6 region shards / 10ms = 200/s per shard),
 *                ETA, pricing and the offer push. Raise hotKeyFraction
 *                on the geo index to pile the city into one region cell.
 *   TRIPS        trip writes go to a replicated store (reads scale,
 *                writes do not) and to the payment processor: 4 slots at
 *                ~200ms is a 20/s ceiling against ~7.5/s at 1x. At 4x it
 *                saturates and the breaker in front of it trips, failing
 *                fast instead of queueing behind a 200ms dependency.
 * ------------------------------------------------------------------ */

const uber: Topology = {
  nodes: [
    // Rider read side.
    node('riders', 'client', 'Rider Apps', COL(0), ROW(1), {
      rps: 30,
      timeoutMs: 3000,
    }),
    node('gw', 'apigateway', 'Edge Gateway', COL(1), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      rateLimitRps: 200,
      burst: 200,
      authFailRate: 0.005,
    }),
    node('match', 'service', 'Dispatch', COL(2), ROW(0), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('eta', 'service', 'Maps ETA', COL(3), ROW(0), {
      capacity: 8,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('push', 'service', 'Offer Push', COL(4), ROW(0), {
      capacity: 4,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('pricing', 'service', 'Dynamic Pricing', COL(3), ROW(1), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 64,
    }),
    // The sink store the surge pipeline writes and pricing reads.
    node('surge-kv', 'db', 'Surge KV Store', COL(4), ROW(1), {
      capacity: 16,
      serviceMs: 4,
      serviceCv: 0.5,
      queueLimit: 128,
    }),

    // Trip state and payments.
    node('trips', 'service', 'Trip Service', COL(2), ROW(2), {
      capacity: 8,
      serviceMs: 12,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('trip-db', 'replica', 'Trip Store', COL(3), ROW(2), {
      capacity: 4,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
      replicaCount: 2,
      replicationLagMs: 50,
      readFraction: 0.7,
    }),
    node('pay-brk', 'breaker', 'Payment Breaker', COL(3), ROW(3), {
      errorThreshold: 0.5,
      windowMs: 4000,
      openMs: 3000,
      halfOpenProbes: 3,
    }),
    node('payments', 'service', 'Payments', COL(4), ROW(3), {
      capacity: 4,
      serviceMs: 200,
      serviceCv: 0.5,
      queueLimit: 16,
      errorRate: 0.01,
    }),

    // Driver write side: the firehose.
    node('drivers', 'client', 'Driver Pings', COL(0), ROW(4), {
      rps: 400,
      timeoutMs: 2000,
    }),
    node('ingest', 'service', 'Location Ingest', COL(1), ROW(4), {
      capacity: 24,
      serviceMs: 3,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    node('kafka', 'streambroker', 'Kafka Event Bus', COL(2), ROW(4), {
      serviceMs: 0.5,
      serviceCv: 0.2,
      partitions: 12,
      queueLimit: 4000,
    }),
    node('geo-upd', 'service', 'Geo Updater', COL(3), ROW(4), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    // Sharded by region cell: one shard is one slice of the city.
    node('geo', 'shard', 'Geo Index (H3)', COL(4), ROW(4), {
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 32,
      shardCount: 6,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('surge-w', 'service', 'Surge Pipeline', COL(3), ROW(5), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('m3', 'timeseriesdb', 'M3 Metrics', COL(3), ROW(6), {
      rangeQueryFraction: 0.02,
      rangeQueryMs: 120,
    }),
  ],
  edges: [
    edge('riders', 'gw'),
    // The gateway's route table: 3 parts dispatch, 1 part trip state.
    edge('gw', 'match', 3),
    edge('gw', 'trips', 1),
    // Matching fans to everything it needs to answer one request.
    edge('match', 'geo'),
    edge('match', 'eta'),
    edge('match', 'pricing'),
    edge('match', 'push'),
    edge('pricing', 'surge-kv'),
    edge('trips', 'trip-db'),
    edge('trips', 'pay-brk'),
    // Trip events join the same stream the location pings ride.
    edge('trips', 'kafka'),
    edge('pay-brk', 'payments'),
    edge('drivers', 'ingest'),
    edge('ingest', 'kafka'),
    // Each broker edge is an independent consumer group with its own lag.
    edge('kafka', 'geo-upd'),
    edge('kafka', 'surge-w'),
    edge('kafka', 'm3'),
    edge('geo-upd', 'geo'),
    edge('surge-w', 'surge-kv'),
  ],
};

/* ------------------------------------------------------------------ *
 * 17. Netflix (public reconstruction)
 *
 * A simplified model built from what Netflix has published, not insider
 * knowledge. Sources a student can read:
 *   - Open Connect: openconnect.netflix.com and the APNIC write-up
 *     (blog.apnic.net/2018/06/20/netflix-content-distribution-through-
 *     open-connect/). Netflix states ~95% of its traffic is served from
 *     OCA appliances peered directly with residential ISPs.
 *   - Zuul 2 gateway and prioritised load shedding at the gateway:
 *     netflixtechblog.com ("Open Sourcing Zuul 2", "Keeping Netflix
 *     Reliable Using Prioritized Load Shedding").
 *   - EVCache (memcached tier) in front of Cassandra for viewing data:
 *     netflixtechblog.com EVCache posts.
 *   - Hystrix circuit breakers and bulkheads: github.com/Netflix/Hystrix.
 *   - Cosmos / VES encoding pipeline: netflixtechblog.com ("The Netflix
 *     Cosmos Platform", "Rebuilding Netflix Video Processing Pipeline
 *     with Microservices").
 * Left out: Eureka discovery, the hundreds of real microservices, A/B
 * infra, per-title encode ladders. All numbers are illustrative, chosen
 * for believable relative behaviour, not Netflix production figures.
 *
 * The traffic picture, 1x:
 *   STREAMING  1500 rps of segment fetches -> OCA at hitRate 0.96, so
 *              only ~60 rps ever touch the S3 fill origin. This lane is
 *              ~86% of all offered traffic and it never enters "the
 *              cloud" at all, which is the whole point of Open Connect.
 *   CONTROL    240 rps of device API calls -> Zuul (auth + route table,
 *              3:2 play vs browse).
 *     play     PlayAPI fans to: Hystrix breaker -> DRM licensing
 *              (5 slots / 18ms = 278 rps ceiling: the knee), EVCache at
 *              0.9 in front of a 4-shard Cassandra ring, the Keystone
 *              stream (viewing history consumer: 6 partitions x
 *              1000/20ms = 300/s ceiling), and Atlas telemetry appends.
 *     browse   Browse API -> a 10-wide Hystrix bulkhead ->
 *              Personalisation (8 slots / 20ms = 400 rps) -> precomputed
 *              recs out of EVCache (0.97; the offline recompute is not
 *              modelled).
 *   ENCODING   2 masters/s -> Cosmos queue -> VES farm (2 boxes x 2
 *              jobs / 1.5s = 2.7 jobs/s) -> encodes land in the same S3
 *              origin the OCAs fill from. Completely separate from
 *              serving, exactly as published.
 *
 * What breaks, and how:
 *   4x: licensing sheds ~50%, the breaker trips and flaps, and PlayAPI
 *   fails fast (loud). Personalisation saturates and the bulkhead caps
 *   it (loud but contained). Keystone's history consumer lags ~270
 *   msg/s and then drops out of retention (quiet). The VES backlog
 *   grows without bound (quiet). Meanwhile the OCA lane, 6000 rps of
 *   it, shrugs: streaming keeps working while the control plane burns.
 *   At 1x, drag the OCA hit rate down instead and watch the fill origin
 *   absorb a load it was never sized for.
 * ------------------------------------------------------------------ */

const netflix: Topology = {
  nodes: [
    // Streaming lane: the bytes. Most of the system's traffic, none of
    // its cloud. An OCA is an ISP-embedded cache; its misses fill from S3.
    node('viewers', 'client', 'Stream Viewers', COL(0), ROW(0), {
      rps: 1500,
      timeoutMs: 2500,
    }),
    node('oca', 'cdn', 'Open Connect OCA', COL(1), ROW(0), {
      capacity: 512,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.96,
      queueLimit: 4096,
    }),
    node('s3', 'objectstore', 'S3 Origin (fill)', COL(3), ROW(0)),
    // Encoding lane: one master in, many encodes out, fed by a queue and
    // priced in seconds. Its output lands in the same S3 the OCAs fill from.
    node('studio', 'client', 'Studio Ingest', COL(0), ROW(1), {
      rps: 2,
      timeoutMs: 3000,
    }),
    node('cosmosq', 'queue', 'Cosmos Job Queue', COL(1), ROW(1), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('ves', 'transcoder', 'VES Encode Farm', COL(2), ROW(1), {
      instances: 2,
      capacity: 2,
      serviceMs: 1500,
      serviceCv: 0.3,
    }),
    node('atlas', 'timeseriesdb', 'Atlas Telemetry', COL(3), ROW(1), {
      capacity: 16,
      serviceMs: 1.5,
      serviceCv: 0.4,
      queueLimit: 1024,
      rangeQueryFraction: 0.03,
      rangeQueryMs: 120,
    }),
    // Control plane: the API calls. Two orders of magnitude less traffic
    // than streaming, and where all the complexity lives.
    node('capi', 'client', 'Device API Calls', COL(0), ROW(3), {
      rps: 240,
      timeoutMs: 2500,
    }),
    node('zuul', 'apigateway', 'Zuul 2 Gateway', COL(1), ROW(3), {
      capacity: 96,
      serviceMs: 2,
      serviceCv: 0.3,
      queueLimit: 512,
      rateLimitRps: 1200,
      burst: 600,
      authFailRate: 0.005,
    }),
    node('playapi', 'service', 'PlayAPI', COL(2), ROW(2), {
      capacity: 16,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
      timeoutMs: 600,
    }),
    node('hystrix', 'breaker', 'Hystrix Breaker', COL(3), ROW(2), {
      errorThreshold: 0.4,
      windowMs: 4000,
      openMs: 4000,
      halfOpenProbes: 3,
    }),
    // 5 slots / 18ms = 278 rps: the deliberate knee of the play path.
    node('license', 'service', 'DRM License Svc', COL(4), ROW(2), {
      capacity: 5,
      serviceMs: 18,
      serviceCv: 0.5,
      queueLimit: 24,
    }),
    node('evcache', 'cache', 'EVCache (viewing)', COL(3), ROW(3), {
      capacity: 48,
      serviceMs: 1,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 512,
    }),
    node('cassandra', 'shard', 'Cassandra Ring', COL(4), ROW(3), {
      serviceMs: 35,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 4,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('keystone', 'streambroker', 'Keystone Pipeline', COL(3), ROW(4), {
      serviceMs: 1,
      partitions: 6,
      queueLimit: 4000,
    }),
    node('history', 'service', 'Viewing History', COL(4), ROW(4), {
      capacity: 6,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 48,
    }),
    node('browse', 'service', 'Browse API', COL(2), ROW(5), {
      capacity: 12,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('recsbh', 'bulkhead', 'Recs Bulkhead', COL(3), ROW(5), {
      bulkheadMax: 10,
    }),
    node('recs', 'service', 'Personalisation', COL(4), ROW(5), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 48,
    }),
    // Precomputed offline; the read path almost never misses. The
    // recompute pipeline itself is deliberately out of frame.
    node('evrecs', 'cache', 'EVCache (recs)', COL(5), ROW(5), {
      capacity: 48,
      serviceMs: 1,
      serviceCv: 0.3,
      hitRate: 0.97,
      queueLimit: 256,
    }),
  ],
  edges: [
    edge('viewers', 'oca'),
    edge('oca', 's3'),
    edge('studio', 'cosmosq'),
    edge('cosmosq', 'ves'),
    edge('ves', 's3'),
    edge('capi', 'zuul'),
    // Zuul's route table: 3 parts playback control, 2 parts browsing.
    edge('zuul', 'playapi', 3),
    edge('zuul', 'browse', 2),
    // PlayAPI fans out to everything a real playback start touches:
    // entitlement/licensing behind its breaker, viewing state through
    // EVCache, an event onto Keystone, a telemetry append into Atlas.
    edge('playapi', 'hystrix'),
    edge('hystrix', 'license'),
    edge('playapi', 'evcache'),
    edge('evcache', 'cassandra'),
    edge('playapi', 'keystone'),
    edge('playapi', 'atlas'),
    // Keystone's one modelled consumer group: the history writer.
    edge('keystone', 'history'),
    edge('browse', 'recsbh'),
    edge('recsbh', 'recs'),
    edge('recs', 'evrecs'),
  ],
};

/* ------------------------------------------------------------------ *
 * 18. Spotify (public reconstruction)
 *
 * A simplified model built from what Spotify has published, not insider
 * knowledge. Sources a student can read:
 *   - Event delivery: engineering.atspotify.com "Spotify's Event
 *     Delivery - The Road to the Cloud" (2016): ~700k events/s through
 *     Kafka, later Google Cloud Pub/Sub.
 *   - Personalisation: engineering.atspotify.com "Personalization at
 *     Spotify using Cassandra" (2015): Kafka logs, batch pipelines,
 *     Cassandra profile/metadata stores feeding Discover Weekly.
 *   - Playlists and libraries on Cassandra; search on Elasticsearch;
 *     audio from object storage via CDN (various Spotify engineering
 *     posts and talks).
 * Left out: the real GCP migration, Ogg/bitrate ladders, P2P history,
 * hundreds of squads' services. All numbers are illustrative, chosen
 * for believable relative behaviour, not Spotify production figures.
 *
 * The traffic picture, 1x:
 *   AUDIO      1100 rps of segment fetches -> CDN at hitRate 0.82 (a
 *              music catalogue has a long tail), so ~200 rps fall
 *              through to GCS audio storage (64 slots / 90ms = 710 rps
 *              ceiling). Fully separate from the metadata path.
 *   METADATA   220 rps of app calls -> gateway (700 rps bucket, 1% bad
 *              auth) -> route table: 35% metadata (cache 0.9 over a
 *              240 rps DB), 20% search (Elasticsearch-style index:
 *              searches 8ms, writes +60ms and searchable 2s late), 25%
 *              playlists, 20% home/recs.
 *   PLAYLISTS  the write-heavy path. 45% of playlist traffic is writes
 *              against a replica set whose primary has 3 slots / 30ms =
 *              100 writes/s, while reads spread over 3 replicas
 *              (300 rps). Replication lag 150ms: add a song, read the
 *              playlist back, and it is not there yet.
 *   RECS       Home/Discover reads Taste Vectors (a 1M-vector ANN index
 *              at 0.9 recall: ~50ms/query, 320 rps ceiling). Every 20s
 *              the Discover Weekly batch (cron -> queue -> feature
 *              pipeline, ~266 jobs/s for about a second) WRITES the
 *              same index, driving it to ~97% while the burst drains,
 *              so online p99 spikes on the batch clock. Batch and
 *              serving sharing a store is the lesson.
 *   EVENTS     600 events/s fired at the Event Delivery broker
 *              (8 partitions). Royalty & Reporting can drain 8 x
 *              1000/6ms = 1333/s; the analytics store drains in ~1.5ms
 *              appends. Both keep up at 1x.
 *
 * What breaks, and how:
 *   4x: 4400 rps of audio pushes ~790 rps of misses into a 710 rps GCS
 *   ceiling, and the audio path saturates and sheds (loud). The gateway bucket
 *   refuses ~180 rps of app calls (loud, at the front door). Playlist
 *   WRITES pin the primary at 100% while its read replicas idle, the
 *   replica lesson in company clothing. Events run at 2400/s against a
 *   1333/s consumer: Royalty lags, then loses data out of retention,
 *   while Analytics next to it keeps up (quiet). At 1x, crash the CDN,
 *   or watch p99 on the recs path breathe with the 20s batch cycle.
 * ------------------------------------------------------------------ */

const spotify: Topology = {
  nodes: [
    // Audio lane: bytes from blob storage through an edge cache.
    node('listeners', 'client', 'Listeners (audio)', COL(0), ROW(0), {
      rps: 1100,
      timeoutMs: 2500,
    }),
    node('audiocdn', 'cdn', 'Audio CDN', COL(1), ROW(0), {
      capacity: 384,
      serviceMs: 3,
      serviceCv: 0.3,
      hitRate: 0.82,
      queueLimit: 4096,
    }),
    // A shortish queue on purpose: when misses outrun the 710 rps
    // ceiling the store should refuse loudly, not buffer for seconds.
    node('gcs', 'objectstore', 'GCS Audio Storage', COL(2), ROW(0), {
      queueLimit: 256,
    }),
    // Metadata/control lane: the app's API calls.
    node('app', 'client', 'App Clients', COL(0), ROW(2), {
      rps: 220,
      timeoutMs: 2500,
    }),
    node('gw', 'apigateway', 'API Gateway', COL(1), ROW(2), {
      capacity: 96,
      serviceMs: 2,
      serviceCv: 0.3,
      queueLimit: 512,
      rateLimitRps: 700,
      burst: 350,
      authFailRate: 0.01,
    }),
    node('meta', 'service', 'Metadata Service', COL(2), ROW(1), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('metacache', 'cache', 'Metadata Cache', COL(3), ROW(1), {
      capacity: 48,
      serviceMs: 1,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 512,
    }),
    node('cassmeta', 'db', 'Track Metadata DB', COL(4), ROW(1), {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('search', 'service', 'Search API', COL(2), ROW(2), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 64,
    }),
    node('es', 'searchindex', 'Search Index (ES)', COL(3), ROW(2), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
      indexMs: 60,
      indexLagMs: 2000,
      readFraction: 0.95,
    }),
    node('playlist', 'service', 'Playlist Service', COL(2), ROW(3), {
      capacity: 10,
      serviceMs: 7,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    // Write-heavy: 45% writes serialise through a 3-slot / 30ms primary
    // (100 writes/s) while reads spread across 3 replicas (300 reads/s).
    node('pldb', 'replica', 'Playlist Store', COL(3), ROW(3), {
      capacity: 3,
      serviceMs: 30,
      serviceCv: 0.6,
      queueLimit: 64,
      replicaCount: 3,
      replicationLagMs: 150,
      readFraction: 0.55,
    }),
    node('recs', 'service', 'Home & Discover Feed', COL(2), ROW(4), {
      capacity: 10,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('vecs', 'vectordb', 'Taste Vectors', COL(3), ROW(4), {
      capacity: 16,
      serviceMs: 0.5,
      serviceCv: 0.4,
      queueLimit: 128,
      indexSizeK: 1000,
      recallTarget: 0.9,
    }),
    // Discover Weekly: a batch pipeline that exists entirely outside the
    // request path, except that its output lands in the store the online
    // path reads. The cron burst every 20s is the weekly job on a clock a
    // student can actually watch.
    node('wkcron', 'cron', 'Discover Weekly Batch', COL(0), ROW(5), {
      intervalMs: 20000,
      batchSize: 300,
    }),
    node('featq', 'queue', 'Feature Job Queue', COL(1), ROW(5), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    // 8 slots / 22ms = ~360 writes/s of drain: deliberately faster than
    // the vector store can absorb on top of its online reads, so each
    // burst briefly queues the store and the online path feels it.
    node('featwork', 'worker', 'Feature Pipeline', COL(2), ROW(5), {
      instances: 2,
      capacity: 4,
      serviceMs: 22,
      serviceCv: 0.4,
    }),
    // Event lane: the firehose. Producers are acked in ~1ms; each
    // outgoing edge of the broker is an independent consumer group.
    node('events', 'client', 'Event Firehose', COL(0), ROW(6), {
      rps: 600,
      timeoutMs: 1500,
    }),
    node('kafka', 'streambroker', 'Event Delivery', COL(1), ROW(6), {
      serviceMs: 1,
      partitions: 8,
      queueLimit: 6000,
    }),
    node('royalty', 'service', 'Royalty & Reporting', COL(2), ROW(6), {
      capacity: 12,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('analytics', 'timeseriesdb', 'Analytics Store', COL(2), ROW(7), {
      capacity: 16,
      serviceMs: 1.5,
      serviceCv: 0.4,
      queueLimit: 1024,
      // Pure ingest: appends only. A range query costs ~80x an append
      // here, and with the broker delivering at most `partitions`
      // messages at once, per-delivery cost is exactly what sets a
      // consumer group's ceiling. Keeping this group cheap is what lets
      // it keep up while Royalty, at 6ms per message, falls behind.
      rangeQueryFraction: 0,
      rangeQueryMs: 120,
    }),
  ],
  edges: [
    edge('listeners', 'audiocdn'),
    edge('audiocdn', 'gcs'),
    edge('app', 'gw'),
    // The gateway's route table: metadata 35%, search 20%, playlists
    // 25%, home/recs 20%.
    edge('gw', 'meta', 7),
    edge('gw', 'search', 4),
    edge('gw', 'playlist', 5),
    edge('gw', 'recs', 4),
    edge('meta', 'metacache'),
    edge('metacache', 'cassmeta'),
    edge('search', 'es'),
    edge('playlist', 'pldb'),
    edge('recs', 'vecs'),
    edge('wkcron', 'featq'),
    edge('featq', 'featwork'),
    edge('featwork', 'vecs'),
    edge('events', 'kafka'),
    // Two independent consumer groups: royalties, and raw analytics.
    edge('kafka', 'royalty'),
    edge('kafka', 'analytics'),
  ],
};

/* ------------------------------------------------------------------ *
 * Twitter/X: the timeline fan-out
 *
 * Based on: Raffi Krikorian, "Timelines at Scale" (QCon 2012,
 * infoq.com/presentations/Twitter-Timeline-Scalability) and the Twitter
 * engineering blog ("The Infrastructure Behind Twitter: Scale"). The
 * published design: a home timeline is PRECOMPUTED. Writing a tweet
 * fans out, one Redis timeline insert per follower, so that reading a
 * timeline is one cheap cache fetch. Roughly 300k timeline reads/s were
 * served against ~4.6k tweet writes/s, and the write path, not the
 * read path, is where the machines went. Celebrity accounts break the
 * scheme: one tweet by an account with millions of followers is
 * millions of timeline writes, so celebrities are EXCLUDED from fanout
 * and merged in at read time instead (the hybrid). Left out: the
 * hybrid read merge itself (here a cache miss rebuilds from the graph
 * and tweet store, which is the same shape), ranking, ads, DMs. All
 * numbers are illustrative, scaled to this simulator, not Twitter's.
 *
 * The traffic picture, 1x:
 *   READ   300 rps -> gateway -> timeline service -> timeline cache at
 *          hitRate 0.92. A miss rebuilds: social graph (who do I
 *          follow) + sharded tweet store, joined. Reads are CHEAP.
 *   SEARCH 1/6 of gateway traffic -> blender -> Earlybird-style index,
 *          which also ingests every tweet from the firehose group.
 *   WRITE  30 rps of tweets through a per-account rate limit (90 rps)
 *          -> write API -> sharded tweet store + the firehose broker.
 *          The fanout group is the expensive half: each delivery costs
 *          ~120ms (look up followers in the graph, insert into every
 *          follower's timeline), and the broker's 8 partitions cap the
 *          group at 8 in flight, ~55/s of drain.
 *   CELEB  every 20s a cron drops a 200-message celebrity burst
 *          straight onto the firehose: one famous tweet, 200 fanout
 *          jobs. At 1x the group drains it (~12s) just before the next.
 *
 * What breaks, and how:
 *   2x: tweets 60/s + bursts exceed the ~55/s fanout ceiling. Consumer
 *   lag on the fanout group grows and never drains: timelines go STALE
 *   while every read still returns fast and green. That is the fanout
 *   trade: reads cannot tell you the write path is drowning; only the
 *   lag can. 4x: the write limiter starts refusing tweets (loud), the
 *   search index saturates, and retention eventually starts dropping
 *   fanout messages entirely. The read row barely notices any of it.
 * ------------------------------------------------------------------ */

const twitter: Topology = {
  nodes: [
    // Read row: the cheap half. The whole point of fanout-on-write is
    // that this row is one cache hit deep for 92% of requests.
    node('readers', 'client', 'Timeline Readers', COL(0), ROW(1), {
      rps: 300,
      timeoutMs: 2000,
    }),
    node('gw', 'apigateway', 'API Gateway', COL(1), ROW(1), {
      capacity: 64,
      serviceMs: 1.5,
      serviceCv: 0.3,
      rateLimitRps: 2500,
      burst: 2500,
      authFailRate: 0,
    }),
    node('tlsvc', 'service', 'Timeline Service', COL(2), ROW(1), {
      capacity: 16,
      serviceMs: 5,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('tlcache', 'cache', 'Timeline Cache (Redis)', COL(3), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      serviceCv: 0.4,
      hitRate: 0.92,
      queueLimit: 256,
    }),
    // A miss rebuilds the timeline the slow way: fetch the follow graph
    // and the tweets, join both. This is also the shape of the hybrid
    // celebrity merge, so it stands in for that too.
    node('tweetstore', 'shard', 'Tweet Store (sharded)', COL(4), ROW(1), {
      shardCount: 4,
      shardCapacity: 4,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
    node('socialgraph', 'graphdb', 'Social Graph', COL(5), ROW(2), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.5,
      traversalDepth: 2,
      queueLimit: 64,
    }),
    // Search: the blender fans queries to the index the firehose feeds.
    // readFraction 0.6 approximates the query:ingest mix it sees.
    node('searchsvc', 'service', 'Search Blender', COL(2), ROW(0), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('searchindex', 'searchindex', 'Earlybird Index', COL(4), ROW(0), {
      capacity: 8,
      serviceMs: 8,
      indexMs: 60,
      indexLagMs: 800,
      readFraction: 0.6,
      queueLimit: 64,
    }),
    // Write row: the expensive half. A per-account limiter (write rate
    // limits are real and visible on the platform), the write API
    // persisting to the shard ring, and the firehose broker.
    node('tweeters', 'client', 'Tweet Writers', COL(0), ROW(3), {
      rps: 30,
      timeoutMs: 2500,
    }),
    node('wlimit', 'ratelimiter', 'Write Rate Limit', COL(1), ROW(3), {
      rateLimitRps: 90,
      burst: 120,
    }),
    node('writeapi', 'service', 'Tweet Write API', COL(2), ROW(3), {
      capacity: 8,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('firehose', 'streambroker', 'Tweet Firehose', COL(3), ROW(3), {
      serviceMs: 1,
      partitions: 8,
      queueLimit: 4000,
    }),
    // The fanout group. 120ms per delivery is the follower-list lookup
    // plus one timeline insert per follower, priced as one job. The
    // broker's 8 partitions cap the group at 8 deliveries in flight,
    // which is the ceiling that matters, not this node's slot count.
    node('fanout', 'service', 'Fanout Workers', COL(4), ROW(3), {
      instances: 4,
      capacity: 4,
      serviceMs: 120,
      serviceCv: 0.4,
      queueLimit: 64,
    }),
    node('tlstore', 'service', 'Timeline Store (Redis)', COL(5), ROW(3), {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.3,
      queueLimit: 512,
    }),
    // One celebrity tweet is not one message: it is a burst of fanout
    // jobs. 200 every 20s here; the real number would be millions,
    // which is exactly why the real system stopped fanning them out.
    node('celebrity', 'cron', 'Celebrity Tweet', COL(2), ROW(4), {
      intervalMs: 20000,
      batchSize: 200,
    }),
    node('pushsvc', 'service', 'Push Notifications', COL(4), ROW(4), {
      capacity: 6,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('readers', 'gw'),
    // The gateway's route table: 5 parts timeline, 1 part search.
    edge('gw', 'tlsvc', 5),
    edge('gw', 'searchsvc', 1),
    edge('tlsvc', 'tlcache'),
    edge('tlcache', 'tweetstore'),
    edge('tlcache', 'socialgraph'),
    edge('searchsvc', 'searchindex'),
    edge('tweeters', 'wlimit'),
    edge('wlimit', 'writeapi'),
    edge('writeapi', 'tweetstore'),
    edge('writeapi', 'firehose'),
    edge('celebrity', 'firehose'),
    // Each broker edge is an independent consumer group: fanout is the
    // expensive one, search ingest and push notifications keep up.
    edge('firehose', 'fanout'),
    edge('firehose', 'searchindex'),
    edge('firehose', 'pushsvc'),
    edge('fanout', 'socialgraph'),
    edge('fanout', 'tlstore'),
  ],
};

/* ------------------------------------------------------------------ *
 * Stripe: correctness over availability
 *
 * Based on: Stripe's published engineering posts, "Scaling your API
 * with rate limiters" (stripe.com/blog/rate-limiters: request rate
 * limiters plus load shedders that keep critical methods working while
 * non-critical traffic is dropped), "Designing robust and predictable
 * APIs with idempotency" (stripe.com/blog/idempotency), the Stripe
 * docs on webhook retries with exponential backoff, and their ledger
 * writeups (a double-entry, append-only ledger as the source of
 * truth). Left out: the payment-intent state machine, settlement and
 * payouts clearing, multi-region, Radar's real feature stores. All
 * numbers are illustrative, not Stripe production figures.
 *
 * The shape of the lesson: a payments API is the one system in this
 * app where "just retry it" and "just shed it" are both wrong on the
 * money path. So every protection here is about REFUSING CLEANLY:
 *   - duplicate retries hit the idempotency store (a cache at
 *     hitRate 0.08: ~8% of arriving charges are retried duplicates
 *     answered from the stored response, never charged twice),
 *   - the external card networks live behind a circuit breaker; when
 *     they brown out, charges fail FAST and DEFINITIVELY instead of
 *     hanging in a state nobody can bill from,
 *   - webhooks are delivered off a retry queue with backoff; endpoints
 *     fail 12% of the time and the failures land on a dead-letter
 *     shelf instead of vanishing,
 *   - dashboards read LEDGER REPLICAS through their own limiter, so
 *     reporting load can never queue behind the money.
 *
 * The traffic picture, 1x: 100 rps of charges (gateway limiter at
 * 250), ~92 reach the payment service; each charge joins fraud check
 * (30ms) -> breaker -> card networks (250ms, the slow external truth),
 * a ledger write (15ms), and an event onto the broker. 120 rps of
 * dashboard reads fan over 3 ledger replicas. Every 25s a payout batch
 * of 150 jobs shares the ledger primary: watch its queue breathe.
 *
 * What breaks, and how: at 4x the gateway sheds ~150 rps of charges at
 * the door (loud, clean, and exactly what the rate-limiter post says
 * to do), the card-network pool runs ~90% hot so p99 stretches, and
 * dashboards are throttled to their 150 rps budget while the ledger
 * never queues. Inject an 'errors' fault on Card Networks and the breaker trips:
 * charges fail fast, nothing double-bills, webhooks drain the failures
 * with retries. Crash the Ledger and charges stop entirely while
 * dashboards keep serving off the replicas: availability is the thing
 * this system is DESIGNED to give up first.
 * ------------------------------------------------------------------ */

const stripe: Topology = {
  nodes: [
    node('merchants', 'client', 'Merchant API Calls', COL(0), ROW(1), {
      rps: 100,
      timeoutMs: 4000,
    }),
    // The front door from the rate-limiter post: a token bucket that
    // sheds excess API traffic before it can queue behind the money.
    node('gw', 'apigateway', 'API Gateway', COL(1), ROW(1), {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.3,
      rateLimitRps: 250,
      burst: 250,
      authFailRate: 0.01,
    }),
    // Idempotency-Key dedupe: a hit is a retried duplicate answered
    // from the stored response. The 8% hit rate is the duplicate share.
    node('idem', 'cache', 'Idempotency Keys', COL(2), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.08,
      queueLimit: 128,
    }),
    node('paysvc', 'service', 'Payment Service', COL(3), ROW(1), {
      capacity: 16,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    // Radar runs IN the charge path: scoring is worth 30ms of latency
    // on every charge because the alternative is charging fraudsters.
    node('fraud', 'service', 'Radar Fraud Check', COL(4), ROW(0), {
      capacity: 12,
      serviceMs: 30,
      serviceCv: 0.5,
      timeoutMs: 1500,
      queueLimit: 64,
    }),
    node('breaker', 'breaker', 'Network Breaker', COL(5), ROW(0), {
      errorThreshold: 0.5,
      windowMs: 5000,
      openMs: 4000,
      halfOpenProbes: 3,
    }),
    // The slow external truth: a card authorisation is a quarter of a
    // second somewhere you do not control and cannot blindly retry.
    node('cardnet', 'service', 'Card Networks (external)', COL(6), ROW(0), {
      capacity: 72,
      serviceMs: 250,
      serviceCv: 0.35,
      errorRate: 0.01,
      queueLimit: 128,
    }),
    node('ledger', 'db', 'Ledger (double-entry)', COL(4), ROW(1), {
      capacity: 8,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('events', 'streambroker', 'Payment Events', COL(4), ROW(3), {
      serviceMs: 1,
      partitions: 4,
      queueLimit: 4000,
    }),
    // Webhooks, per the docs: redeliver with backoff, then give up
    // onto a shelf you can inspect, because merchant endpoints fail.
    node('webhookq', 'retryqueue', 'Webhook Delivery', COL(5), ROW(3), {
      capacity: 8,
      serviceMs: 3,
      serviceCv: 0.3,
      timeoutMs: 1000,
      retries: 2,
      queueLimit: 2000,
    }),
    node('merchantep', 'service', 'Merchant Endpoints', COL(6), ROW(3), {
      capacity: 8,
      serviceMs: 40,
      serviceCv: 0.6,
      errorRate: 0.12,
      queueLimit: 64,
    }),
    node('tsdb', 'timeseriesdb', 'Billing Metrics', COL(5), ROW(4), {
      capacity: 16,
      rangeQueryFraction: 0.02,
      rangeQueryMs: 120,
    }),
    // Payouts arrive on a clock, not on demand, and share the ledger
    // primary with live charges: watch its queue breathe every 25s.
    node('payoutcron', 'cron', 'Payout Batch', COL(2), ROW(3), {
      intervalMs: 25000,
      batchSize: 150,
    }),
    node('payoutsvc', 'service', 'Payout Jobs', COL(3), ROW(3), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 256,
    }),
    // Reporting reads never touch the primary: replicas plus their own
    // limiter mean dashboard load is structurally unable to slow money.
    node('dashboards', 'client', 'Dashboard Readers', COL(0), ROW(4), {
      rps: 120,
      timeoutMs: 2000,
    }),
    node('dlimit', 'ratelimiter', 'Reporting Limiter', COL(1), ROW(4), {
      rateLimitRps: 150,
      burst: 200,
    }),
    node('reportsvc', 'service', 'Reporting API', COL(2), ROW(4), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('replica', 'replica', 'Ledger Replicas', COL(3), ROW(4), {
      capacity: 4,
      serviceMs: 20,
      serviceCv: 0.6,
      replicaCount: 3,
      replicationLagMs: 400,
      readFraction: 1,
      queueLimit: 96,
    }),
  ],
  edges: [
    edge('merchants', 'gw'),
    edge('gw', 'idem'),
    edge('idem', 'paysvc'),
    // A charge is a JOIN of three branches: the authorisation chain,
    // the ledger write, and the event publish. All must land.
    edge('paysvc', 'fraud'),
    edge('paysvc', 'ledger'),
    edge('paysvc', 'events'),
    edge('fraud', 'breaker'),
    edge('breaker', 'cardnet'),
    edge('events', 'webhookq'),
    edge('events', 'tsdb'),
    edge('webhookq', 'merchantep'),
    edge('payoutcron', 'payoutsvc'),
    edge('payoutsvc', 'ledger'),
    edge('dashboards', 'dlimit'),
    edge('dlimit', 'reportsvc'),
    edge('reportsvc', 'replica'),
  ],
};

/* ------------------------------------------------------------------ *
 * WhatsApp: store-and-forward at absurd scale
 *
 * Based on: Rick Reed's Erlang Factory talks ("1 Million is so 2011",
 * "That's Billion with a B: scaling to the next level") and the
 * HighScalability writeup of them. The published facts this models:
 * a famously TINY system (hundreds of servers for hundreds of millions
 * of users), Erlang gateways holding about 2 MILLION tcp connections
 * per box, message routing that does almost nothing per message (with
 * end-to-end encryption the server cannot even read them), and
 * STORE-AND-FORWARD as the whole reliability story: a message to an
 * offline phone is not an error, it parks in that user's offline queue
 * (Mnesia) and is delivered when they reconnect. Media rides a
 * completely separate HTTP path into blob storage. Left out: group
 * fanout (priced into routing cost here), multi-device, presence
 * broadcast, the real Mnesia partitioning. Numbers are illustrative,
 * scaled to this simulator.
 *
 * The traffic picture, 1x:
 *   SEND    400 rps -> the Erlang router (1.5ms: the chat core idles
 *           at ~1% busy, which IS the famous lesson: simple beats big)
 *           -> recipient lookup: 70% online, pushed immediately; 30%
 *           offline, acked and parked in the offline store. The drain
 *           worker (200/s ceiling) redelivers as phones reconnect.
 *   CONNECT 45 conn/s held ~30s: ~1350 of the gateway's 1800 held
 *           connections in use. Connections, not requests, are the
 *           scarce thing, exactly as at Discord, and this box is run
 *           deliberately hot because that was the whole cost model.
 *   MEDIA   uploads and downloads on their own HTTP lane: blob store
 *           behind a cache, never touching the chat core.
 *   MIDNIGHT every 30s a 600-message burst (everyone texting at once,
 *           the published New Year's Eve peak pattern) hits the router.
 *
 * What breaks, and how: senders essentially CANNOT fail; that is what
 * store-and-forward means. At 4x the offline share (~490/s) outruns
 *   the 200/s reconnect drain and undelivered messages pile up by the
 * hundreds per second with zero sender-visible errors: the graph to
 * watch is the offline queue depth, not the error rate. Meanwhile the
 * gateway hits its connection ceiling and REFUSES new phones (loud,
 * conn-refused), the one place this system says no. Crash the offline
 * store and you lose exactly the parked messages: the queue is the
 * durability story. The router never breaks; it was never the
 * bottleneck, and that is the point.
 * ------------------------------------------------------------------ */

const whatsapp: Topology = {
  nodes: [
    node('phones', 'client', 'Message Senders', COL(0), ROW(1), {
      rps: 400,
      timeoutMs: 2000,
    }),
    // The chat core: one Erlang hop. With E2E encryption the server
    // just moves ciphertext, so per-message cost is close to nothing,
    // and the node runs practically idle at any load this app offers.
    node('router', 'service', 'Erlang Router', COL(1), ROW(1), {
      capacity: 48,
      serviceMs: 1.5,
      serviceCv: 0.3,
      queueLimit: 512,
    }),
    // Weighted split standing in for a presence lookup: 7 of 10
    // recipients are online right now, 3 are not.
    node('lookup', 'lb', 'Recipient Lookup (70% online)', COL(2), ROW(1), {
      capacity: 256,
      serviceMs: 0.5,
    }),
    node('push', 'service', 'Push to Connected', COL(3), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    // Store-and-forward: the offline message is ACKED to the sender
    // and parked. Losing this node loses exactly the parked messages.
    node('offlineq', 'queue', 'Offline Store (Mnesia)', COL(3), ROW(2), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 20000,
    }),
    node('drain', 'worker', 'Deliver on Reconnect', COL(4), ROW(2), {
      capacity: 4,
      serviceMs: 20,
      serviceCv: 0.5,
    }),
    node('midnight', 'cron', 'Midnight Spike', COL(0), ROW(2), {
      intervalMs: 30000,
      batchSize: 600,
    }),
    // The connection tier: what a gateway box actually rations. The
    // real boxes held ~2M tcp connections each; 1800 here, run at 75%
    // on purpose, because connection count WAS the capacity plan.
    node('churn', 'client', 'Phones Connecting', COL(0), ROW(0), {
      rps: 45,
      timeoutMs: 2000,
    }),
    node('wsgw', 'websocket', 'Chat Gateway (Erlang)', COL(1), ROW(0), {
      capacity: 1800,
      serviceMs: 4,
      serviceCv: 0.4,
      connectionMs: 30000,
    }),
    node('session', 'db', 'Session Store (Mnesia)', COL(2), ROW(0), {
      capacity: 16,
      serviceMs: 3,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    // Media: its own HTTP lane, exactly as published. Bytes never
    // touch the chat core.
    node('mediaup', 'client', 'Media Uploads', COL(0), ROW(3), {
      rps: 25,
      timeoutMs: 4000,
    }),
    node('mediasvc', 'service', 'Media HTTP Service', COL(1), ROW(3), {
      capacity: 12,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('blob', 'objectstore', 'Media Blob Store', COL(2), ROW(3), {
      capacity: 64,
      serviceMs: 90,
      serviceCv: 0.4,
      queueLimit: 512,
    }),
    node('mediadl', 'client', 'Media Downloads', COL(0), ROW(4), {
      rps: 80,
      timeoutMs: 2500,
    }),
    node('mediacdn', 'cdn', 'Media Cache', COL(1), ROW(4), {
      capacity: 128,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.6,
      queueLimit: 1024,
    }),
  ],
  edges: [
    edge('phones', 'router'),
    edge('midnight', 'router'),
    edge('router', 'lookup'),
    // The split that makes store-and-forward visible: online messages
    // push through, offline ones park. Weights are the 70/30 mix.
    edge('lookup', 'push', 7),
    edge('lookup', 'offlineq', 3),
    edge('offlineq', 'drain'),
    edge('churn', 'wsgw'),
    edge('wsgw', 'session'),
    edge('mediaup', 'mediasvc'),
    edge('mediasvc', 'blob'),
    edge('mediadl', 'mediacdn'),
    edge('mediacdn', 'blob'),
  ],
};

export const PRESETS: Preset[] = [
  {
    id: 'single-server',
    name: 'Single Server',
    description:
      'One service in front of one database. Latency climbs sharply as the database fills up.',
    topology: singleServer,
  },
  {
    id: 'load-balanced',
    name: 'Load Balanced',
    description:
      'Three servers share the load, but they all still talk to the same database.',
    topology: loadBalanced,
  },
  {
    id: 'cache-aside',
    name: 'Cache Aside',
    description:
      'The cache absorbs most reads. Lower the hit rate and the database takes the whole load.',
    topology: cacheAside,
  },
  {
    id: 'async-workers',
    name: 'Async Workers',
    description:
      'Requests are acknowledged instantly and buffered. Watch the backlog grow when workers fall behind.',
    topology: asyncWorkers,
  },
  {
    id: 'retry-storm',
    name: 'Retry Storm',
    description:
      'A short timeout with retries in front of a small database. Retries multiply the load that caused them.',
    topology: retryStorm,
  },
  {
    id: 'cdn-origin',
    name: 'CDN + Origin',
    description:
      'The CDN answers most requests at the edge, so only a trickle reaches the origin. Drop the hit rate and watch the origin melt.',
    topology: cdnOrigin,
  },
  {
    id: 'rate-limited-api',
    name: 'Rate Limited API',
    description:
      'A limiter refuses excess traffic at the door. It serves slightly less, but what it does serve stays fast instead of queueing.',
    topology: rateLimitedApi,
  },
  {
    id: 'circuit-breaker',
    name: 'Circuit Breaker',
    description:
      'A breaker watches a failing dependency and stops calling it. Break the payments API and watch the circuit trip, then recover.',
    topology: circuitBreaker,
  },
  {
    id: 'read-replicas',
    name: 'Read Replicas',
    description:
      'Replicas scale reads but not writes, and a read can arrive before the write it should have seen.',
    topology: readReplicas,
  },
  {
    id: 'sharded-database',
    name: 'Sharded Database',
    description:
      'Four partitions share the load evenly until one key gets hot, and then a single shard melts while the average still looks healthy.',
    topology: shardedDatabase,
  },
  {
    id: 'autoscaling-service',
    name: 'Autoscaling Service',
    description:
      'Capacity chases the load, but new servers take time to boot, so requests fail in the gap between the two.',
    topology: autoscalingService,
  },
  {
    id: 'multi-region',
    name: 'Multi-Region Failover',
    description:
      'Two regions, one serving. Crash the active one and every request fails until failover lands.',
    topology: multiRegion,
  },
  {
    id: 'full-stack',
    name: 'Full Stack',
    description:
      'Every tier at once: edge cache, load balancer, services, cache, shards, and a queue of async work behind it all.',
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
  {
    id: 'discord',
    name: 'Discord: Real-Time Chat',
    description:
      'A simplified reconstruction of Discord from their engineering blog; numbers are illustrative. The gateway runs out of connections, not requests; one message fans out to every gateway pod, and at 2x the push tier sheds deliveries the senders never see; make one channel hot and its store shard melts alone. Voice rides its own servers.',
    topology: discord,
  },
  {
    id: 'uber',
    name: 'Uber: Ride Dispatch',
    description:
      'A simplified reconstruction of Uber from their published architecture; numbers are illustrative. Driver pings outnumber rider requests 13 to 1 and ride a Kafka-style stream; at 4x the geo consumer lags and dispatch matches on stale positions without a single rider-facing error. Crash the payment processor and the breaker contains it.',
    topology: uber,
  },
  {
    id: 'netflix',
    name: 'Netflix: Streaming at Scale',
    description:
      'A simplified reconstruction of Netflix from their tech blog; numbers are illustrative. Open Connect appliances inside ISPs serve ~96% of the bytes, so streaming barely touches the cloud; the control plane behind Zuul is where 4x hurts: licensing trips its Hystrix breaker, the recs bulkhead fills, Keystone quietly falls behind, and the encode farm backlog grows while viewers stream on.',
    topology: netflix,
  },
  {
    id: 'spotify',
    name: 'Spotify: Music + Discovery',
    description:
      'A simplified reconstruction of Spotify from their engineering blog; numbers are illustrative. Audio flows from object storage through a CDN, apart from the metadata path. Playlist writes pin a replica primary while its read replicas idle, the event firehose outruns the royalty consumer at 4x, and every 20s the Discover Weekly batch writes the same vector index the home feed reads, so p99 breathes on the batch clock.',
    topology: spotify,
  },
  {
    id: 'twitter',
    name: 'Twitter/X: Timeline Fan-out',
    description:
      'A simplified reconstruction of the Twitter timeline from Raffi Krikorian\'s "Timelines at Scale" talk; numbers are illustrative. Tweets fan out on write into precomputed timelines, so reads are one cache hit; every 20s a celebrity tweet dumps 200 fanout jobs on the firehose. Past 2x the fanout group never catches up again: reads stay green while timelines quietly go stale, and only the consumer lag tells the truth.',
    topology: twitter,
  },
  {
    id: 'stripe',
    name: 'Stripe: Correctness over Availability',
    description:
      'A simplified reconstruction of Stripe from their published posts on rate limiters, idempotency and the ledger; numbers are illustrative. Duplicate retries answer from the idempotency store, a breaker fails charges fast when the card networks brown out, webhooks redeliver onto a dead-letter shelf, and at 4x the gateway sheds excess charges at the door while dashboards throttle against their replicas. Crash the ledger: charges stop dead, dashboards keep reading, and that ordering is the design.',
    topology: stripe,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp: Store and Forward',
    description:
      "A simplified reconstruction of WhatsApp from Rick Reed's Erlang scaling talks; numbers are illustrative. The chat core is deliberately tiny and nearly idle: one routing hop, then online recipients get pushed and offline ones park in the Mnesia store until they reconnect, so senders essentially cannot fail. At 4x undelivered messages pile up by the hundreds per second with zero errors, and the gateway runs out of held connections, not requests. Watch the queue depth, not the error rate.",
    topology: whatsapp,
  },
];
