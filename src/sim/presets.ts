import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from './types';

export interface Preset {
  id: string;
  name: string;
  description: string;
  topology: Topology;
}

/** Sensible starting knobs for a freshly dropped node of each kind. */
export function defaultConfig(kind: NodeKind): NodeConfig {
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
];
