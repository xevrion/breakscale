import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeStats, Topology } from './types';

/*
 * `shardCount`, `replicaCount` and `shardCapacity` size the structures the
 * data components keep on `state.ext`, and they reach the engine from places
 * that are not the inspector: a shared link, a `.breakscale` file and a
 * restored session all carry them through, and `isTopology` checks the nine
 * core config numbers and none of these three.
 *
 * So what the engine does with a number the sliders could never produce is a
 * property of the engine rather than of the form that fed it.
 */

function topology(kind: 'shard' | 'replica', patch: Record<string, unknown>): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 60 };
  const target = { ...makeNode(kind, 200, 0), id: 'target' };
  target.config = { ...target.config, ...patch } as typeof target.config;
  return {
    nodes: [client, target],
    edges: [{ id: 'client->target', from: 'client', to: 'target', weight: 1 }],
  };
}

function statsFor(
  kind: 'shard' | 'replica',
  patch: Record<string, unknown>,
): NodeStats {
  const engine = new Engine(topology(kind, patch), 7);
  for (let i = 0; i < 60; i += 1) engine.advance(1000 / 60);
  return engine.snapshot().nodes['target'] as NodeStats;
}

describe('the fleet counts the data components will act on', () => {
  it('runs a shard whose count is not a number', () => {
    // `Math.floor(NaN)` is NaN and NaN fails `n < min`, so the count used to
    // pass through to `new Array(count)`, which throws for it.
    expect(() => statsFor('shard', { shardCount: Number.NaN })).not.toThrow();
  });

  it('runs a shard whose count is larger than the editor can set', () => {
    // One queue array, one Int32Array and one Float64Array are built per
    // shard, so an unbounded count does not come back at all.
    const start = performance.now();
    const stats = statsFor('shard', { shardCount: 1e9 });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(stats.shardUtilization?.length).toBeLessThanOrEqual(64);
  });

  it('runs a shard whose count is infinite', () => {
    const stats = statsFor('shard', { shardCount: Number.POSITIVE_INFINITY });
    expect(stats.shardUtilization?.length).toBeLessThanOrEqual(64);
  });

  it('reports a real utilization for a shard capacity that is not a number', () => {
    // The capacity is the divisor of the utilization the panel prints, so a
    // count that is not a number reaches the reader as "NaN%".
    const stats = statsFor('shard', { shardCapacity: Number.NaN });
    expect(Number.isNaN(stats.utilization)).toBe(false);
    for (const u of stats.shardUtilization ?? []) expect(Number.isNaN(u)).toBe(false);
  });

  it('runs a replica set whose count is not a number', () => {
    // `instanceScratch` sets `array.length` from the count, which throws.
    expect(() => statsFor('replica', { replicaCount: Number.NaN })).not.toThrow();
  });

  it('runs a replica set whose count is infinite', () => {
    expect(() =>
      statsFor('replica', { replicaCount: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });

  it('runs a replica set whose count is larger than the editor can set', () => {
    const start = performance.now();
    const stats = statsFor('replica', { replicaCount: 1e9 });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(stats.perInstance?.length ?? 0).toBeLessThanOrEqual(65);
  });

  it('leaves a count the editor can set exactly where it was', () => {
    // The ceilings are the inspector's own maxima, so nothing a reader can
    // build moves: eight shards are still eight shards.
    const stats = statsFor('shard', { shardCount: 8 });
    expect(stats.shardUtilization?.length).toBe(8);
  });
});
