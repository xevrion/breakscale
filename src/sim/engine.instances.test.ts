import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeStats, Topology } from './types';

/*
 * `instances` reaches the engine from places that are not the inspector: a
 * shared link, a `.breakscale` file and a restored session all carry it
 * through, and `isTopology` checks nine core numbers and not this one. The
 * engine writes one array element per instance on every snapshot, so what it
 * does with a number the editor could never produce is a property of the
 * engine rather than of the form that fed it.
 */

function topology(instances: unknown): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 100 };
  const target = { ...makeNode('service', 200, 0), id: 'target' };
  target.config = { ...target.config, instances } as typeof target.config;
  return {
    nodes: [client, target],
    edges: [{ id: 'client->target', from: 'client', to: 'target', weight: 1 }],
  };
}

function unitsFor(instances: unknown): number {
  const engine = new Engine(topology(instances), 7);
  for (let i = 0; i < 30; i += 1) engine.advance(1000 / 60);
  const stats = engine.snapshot().nodes['target'] as NodeStats | undefined;
  return stats?.instances ?? -1;
}

describe('the instance count the engine will act on', () => {
  it('is one when the design carries no number at all', () => {
    expect(unitsFor(undefined)).toBe(1);
  });

  it('is one for a value that is not a number', () => {
    // Math.max(1, Math.floor(NaN)) is NaN, and `units.length = NaN` throws.
    expect(unitsFor(Number.NaN)).toBe(1);
    expect(unitsFor(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('is one for a count below one', () => {
    expect(unitsFor(0)).toBe(1);
    expect(unitsFor(-4)).toBe(1);
  });

  it('takes the whole machines out of a fractional count', () => {
    expect(unitsFor(2.7)).toBe(2);
  });

  it('stops at the ceiling the inspector offers, rather than allocating', () => {
    // A design asking for a billion machines used to allocate a billion array
    // elements on the first snapshot, which takes the tab with it.
    const started = Date.now();
    expect(unitsFor(1e9)).toBe(512);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
