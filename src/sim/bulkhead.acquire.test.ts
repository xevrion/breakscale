import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { Topology } from './types';

function snapshotAfter(topology: Topology, seconds: number) {
  const engine = new Engine(topology, 7);
  for (let i = 0; i < seconds * 60; i += 1) engine.advance(1000 / 60);
  return engine.snapshot();
}

describe('bulkhead acquire mode', () => {
  it('waits for a slot, then times out the acquire without occupying that slot', () => {
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 40, timeoutMs: 2000 };
    const pool = { ...makeNode('bulkhead', 100, 0), id: 'pool' };
    pool.config = {
      ...pool.config,
      bulkheadMax: 1,
      bulkheadMode: 'wait',
      acquireQueueMax: 3,
      acquireTimeoutMs: 100,
    };
    const database = { ...makeNode('db', 200, 0), id: 'database' };
    database.config = {
      ...database.config,
      serviceMs: 500,
      capacity: 1,
      queueLimit: 10,
    };
    const snapshot = snapshotAfter(
      {
        nodes: [client, pool, database],
        edges: [
          { id: 'client-pool', from: 'client', to: 'pool', weight: 1 },
          { id: 'pool-database', from: 'pool', to: 'database', weight: 1 },
        ],
      },
      2,
    );
    const stats = snapshot.nodes.pool!;
    expect(stats.bulkheadInFlight).toBe(1);
    expect(stats.bulkheadWaiting).toBeLessThanOrEqual(3);
    expect(stats.bulkheadAcquireTimeoutRate).toBeGreaterThan(0);
    expect(snapshot.failuresByReason['acquire-timeout']).toBeGreaterThan(0);
  });
});
