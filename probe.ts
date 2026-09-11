import { Engine } from './src/sim/engine';
import { makeNode } from './src/sim/presets';
import type { Topology } from './src/sim/types';

const HOSTILE: [string, unknown][] = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['1e9', 1e9],
  ['-4', -4],
];

const FIELDS: [string, string][] = [
  ['partitions', 'streambroker'],
  ['partitions', 'pubsub'],
  ['renditions', 'transcoder'],
  ['cpuMsCap', 'transcoder'],
  ['halfOpenProbes', 'breaker'],
  ['errorThreshold', 'breaker'],
  ['windowMs', 'breaker'],
  ['openMs', 'breaker'],
  ['batchSize', 'cron'],
  ['intervalMs', 'cron'],
  ['maxConcurrency', 'lambda'],
  ['coldStartMs', 'lambda'],
  ['keepWarmMs', 'lambda'],
  ['bulkheadMax', 'bulkhead'],
  ['traversalDepth', 'graphdb'],
  ['shardCapacity', 'shard'],
  ['hotKeyFraction', 'shard'],
  ['replicationLagMs', 'replica'],
  ['readFraction', 'replica'],
  ['indexSizeK', 'vectordb'],
  ['recallTarget', 'vectordb'],
  ['indexMs', 'searchindex'],
  ['indexLagMs', 'searchindex'],
  ['rangeQueryFraction', 'timeseriesdb'],
  ['rangeQueryMs', 'timeseriesdb'],
  ['connectionMs', 'websocket'],
  ['authFailRate', 'apigateway'],
  ['outlierAfter', 'sidecar'],
  ['flushDelayMs', 'writebehind'],
  ['edgeShare', 'edgecompute'],
  ['lowPriorityShare', 'loadshedder'],
  ['priorityReserve', 'loadshedder'],
  ['prefixRps', 'apigateway'],
  ['lockMs', 'writebehind'],
];

function topo(kind: string, field: string, value: unknown): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 60 };
  const target = { ...makeNode(kind as never, 200, 0), id: 'target' };
  target.config = { ...target.config, [field]: value } as typeof target.config;
  const sink = { ...makeNode('service', 400, 0), id: 'sink' };
  const sink2 = { ...makeNode('service', 400, 120), id: 'sink2' };
  return {
    nodes: [client, target, sink, sink2],
    edges: [
      { id: 'e1', from: 'client', to: 'target', weight: 1 },
      { id: 'e2', from: 'target', to: 'sink', weight: 1 },
      { id: 'e3', from: 'target', to: 'sink2', weight: 1 },
    ],
  };
}

function hasNaN(v: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof v === 'number') return Number.isNaN(v);
  if (Array.isArray(v)) return v.some((x) => hasNaN(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.values(v).some((x) => hasNaN(x, depth + 1));
  return false;
}

const [wantField, wantLabel] = [process.argv[2], process.argv[3]];
for (const [field, kind] of FIELDS) {
  for (const [label, value] of HOSTILE) {
    if (field !== wantField || label !== wantLabel) continue;
    const t0 = performance.now();
    let verdict = 'ok';
    try {
      const engine = new Engine(topo(kind, field, value), 7);
      let nan = false;
      for (let i = 0; i < 120; i++) {
        engine.advance(1000 / 60);
        if (i % 20 === 0 && hasNaN(engine.snapshot())) nan = true;
      }
      if (hasNaN(engine.snapshot())) nan = true;
      verdict = nan ? 'NaN-IN-SNAPSHOT' : 'ok';
    } catch (e) {
      verdict = `THROW ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 60)}`;
    }
    const ms = Math.round(performance.now() - t0);
    {
      console.log(`${kind}.${field} = ${label.padEnd(10)} -> ${verdict}  (${ms}ms)`);
    }
  }
}
console.log('--- probe done');
