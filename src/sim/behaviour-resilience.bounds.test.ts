import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeStats, Topology } from './types';

/*
 * The transcoder's ladder is a loop that runs once per rendition per
 * outgoing edge per finished job, and `renditions` is not one of the nine
 * config numbers `isTopology` checks. A shared link, a `.breakscale` file
 * and a restored session carry whatever it says into that loop.
 */

function topology(renditions: unknown): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 30 };
  const farm = { ...makeNode('transcoder', 200, 0), id: 'farm' };
  farm.config = { ...farm.config, renditions, serviceMs: 20 } as typeof farm.config;
  const store = { ...makeNode('objectstore', 400, 0), id: 'store' };
  return {
    nodes: [client, farm, store],
    edges: [
      { id: 'e1', from: 'client', to: 'farm', weight: 1 },
      { id: 'e2', from: 'farm', to: 'store', weight: 1 },
    ],
  };
}

/**
 * The ladder is observable as write amplification on the store behind the
 * farm: one artifact lands there per rendition per finished job, which is
 * the lesson the component exists to teach.
 */
function outputsFor(renditions: unknown): {
  ms: number;
  farm: NodeStats;
  uploads: number;
} {
  const start = performance.now();
  const engine = new Engine(topology(renditions), 7);
  for (let i = 0; i < 120; i += 1) engine.advance(1000 / 60);
  const snapshot = engine.snapshot();
  return {
    ms: performance.now() - start,
    farm: snapshot.nodes['farm'] as NodeStats,
    uploads: (snapshot.nodes['store'] as NodeStats).totalCompleted,
  };
}

describe('the rendition ladder the transcoder will act on', () => {
  it('runs a farm whose ladder is infinite', () => {
    // `Infinity >= 1` is true and `Math.floor` leaves it alone, so the emit
    // loop had no end for it.
    const { ms } = outputsFor(Number.POSITIVE_INFINITY);
    expect(ms).toBeLessThan(2000);
  });

  it('runs a farm whose ladder is longer than the editor can set', () => {
    const { ms } = outputsFor(1e9);
    expect(ms).toBeLessThan(2000);
  });

  it('still encodes three renditions when the field is absent', () => {
    // Between the two and four ladders, which is what a fallback of three
    // means in the only place the number is visible.
    const { uploads } = outputsFor(undefined);
    expect(uploads).toBeGreaterThan(outputsFor(2).uploads);
    expect(uploads).toBeLessThan(outputsFor(4).uploads);
  });

  it('leaves a ladder the editor can set exactly where it was', () => {
    // The ceiling is the inspector's own maximum, so the amplification a
    // reader can build is untouched: four renditions still write more to the
    // store than two do, and the farm still finishes jobs.
    const four = outputsFor(4);
    const two = outputsFor(2);
    expect(four.uploads).toBeGreaterThan(two.uploads);
    expect(four.farm.totalCompleted).toBeGreaterThan(0);
  });
});
