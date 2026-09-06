import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeStats, NodeKind, Topology } from './types';

/*
 * A broker builds one ring buffer per partition, and `partitions` is not one
 * of the nine config numbers `isTopology` checks. A shared link, a
 * `.breakscale` file and a restored session therefore carry whatever it says
 * into that loop, so what the engine does with a count the inspector could
 * never set is a property of the engine.
 */

function topology(kind: NodeKind, partitions: unknown): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 60 };
  const log = { ...makeNode(kind, 200, 0), id: 'log' };
  log.config = { ...log.config, partitions } as typeof log.config;
  const worker = { ...makeNode('worker', 400, 0), id: 'worker' };
  return {
    nodes: [client, log, worker],
    edges: [
      { id: 'e1', from: 'client', to: 'log', weight: 1 },
      { id: 'e2', from: 'log', to: 'worker', weight: 1 },
    ],
  };
}

function statsFor(kind: NodeKind, partitions: unknown): NodeStats {
  const engine = new Engine(topology(kind, partitions), 7);
  for (let i = 0; i < 60; i += 1) engine.advance(1000 / 60);
  return engine.snapshot().nodes['log'] as NodeStats;
}

describe('the partition count a broker will act on', () => {
  it('runs a log whose partition count is infinite', () => {
    // One Int32Array is pushed per partition, so the loop that builds them
    // does not fail on Infinity, it never reaches its end.
    const start = performance.now();
    expect(() => statsFor('streambroker', Number.POSITIVE_INFINITY)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('runs a log whose partition count is larger than the editor can set', () => {
    const start = performance.now();
    const stats = statsFor('streambroker', 1e9);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(stats.perInstance?.length ?? 0).toBeLessThanOrEqual(64);
  });

  it('runs a topic whose partition count is infinite', () => {
    const start = performance.now();
    expect(() => statsFor('pubsub', Number.POSITIVE_INFINITY)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('still falls back to four partitions when the field is absent', () => {
    const stats = statsFor('streambroker', undefined);
    expect(stats.perInstance?.length ?? 0).toBe(4);
  });

  it('leaves a partition count the editor can set exactly where it was', () => {
    // The cap is the inspector's own maximum, so nothing a reader can build
    // moves: eight partitions are still eight partitions.
    const stats = statsFor('streambroker', 8);
    expect(stats.perInstance?.length ?? 0).toBe(8);
  });
});
