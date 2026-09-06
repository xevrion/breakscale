import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeStats, Topology } from './types';

/*
 * `regions` and `activeRegion` are not among the nine config numbers
 * `isTopology` checks, so a shared link, a `.breakscale` file and a restored
 * session carry whatever they say into the region switch.
 */

function topology(patch: Record<string, unknown>): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 60 };
  const region = { ...makeNode('region', 200, 0), id: 'r' };
  region.config = { ...region.config, ...patch } as typeof region.config;
  const east = { ...makeNode('service', 400, 0), id: 'east' };
  const west = { ...makeNode('service', 400, 120), id: 'west' };
  return {
    nodes: [client, region, east, west],
    edges: [
      { id: 'e1', from: 'client', to: 'r', weight: 1 },
      { id: 'e2', from: 'r', to: 'east', weight: 1 },
      { id: 'e3', from: 'r', to: 'west', weight: 1 },
    ],
  };
}

function run(patch: Record<string, unknown>) {
  const engine = new Engine(topology(patch), 7);
  for (let i = 0; i < 200; i += 1) engine.advance(1000 / 60);
  const snapshot = engine.snapshot();
  return {
    region: snapshot.nodes['r'] as NodeStats,
    east: snapshot.nodes['east'] as NodeStats,
    west: snapshot.nodes['west'] as NodeStats,
  };
}

describe('a region switch given numbers the editor cannot produce', () => {
  it('still routes when the active region is not a number', () => {
    // `Math.floor(NaN)` is NaN and every comparison against it is false, so
    // NaN used to be adopted as the live region -- and `out[NaN]` is nothing,
    // so the switch served no region at all.
    const { region, east, west } = run({ activeRegion: Number.NaN });
    expect(Number.isNaN(region.activeRegion as number)).toBe(false);
    expect(east.totalCompleted + west.totalCompleted).toBeGreaterThan(0);
    expect(region.totalFailed).toBe(0);
  });

  it('counts its regions when the declared count is not a number', () => {
    // The census loop runs `i < count`, which is false immediately for NaN,
    // so the node reported no healthy region while it was serving one.
    const { region } = run({ regions: Number.NaN });
    expect(Number.isNaN(region.regionsTotal as number)).toBe(false);
    expect(region.regionsHealthy).toBe(2);
  });

  it('keeps the readout and the routing agreeing', () => {
    // decorateStats builds the census from the same predicate pickEdge routes
    // with, so a node that is serving traffic cannot report zero healthy
    // regions. That is the invariant the NaN broke.
    const { region, east, west } = run({ regions: Number.NaN });
    expect(east.totalCompleted + west.totalCompleted).toBeGreaterThan(0);
    expect(region.regionsHealthy).toBeGreaterThan(0);
  });

  it('leaves a design the editor can produce exactly where it was', () => {
    const plain = run({});
    const explicit = run({ regions: 2, activeRegion: 0 });
    expect(plain.region.regionsTotal).toBe(2);
    expect(plain.region.activeRegion).toBe(0);
    expect(explicit.east.totalCompleted).toBe(plain.east.totalCompleted);
  });

  it('still honours a second region the student selected', () => {
    const { east, west } = run({ activeRegion: 1 });
    expect(west.totalCompleted).toBeGreaterThan(0);
    expect(east.totalCompleted).toBe(0);
  });
});
