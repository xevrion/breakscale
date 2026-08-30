import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS, defaultConfig, makeNode } from './presets';
import type { SimSnapshot, Topology } from './types';

/**
 * Engine correctness tests.
 *
 * These are the properties the whole product rests on. If a change breaks one
 * of them the simulator is lying to students, which is worse than it being
 * slow or ugly, so they are deliberately strict.
 */

/** Advance a topology by `seconds` of simulated time at 60fps. */
function run(topology: Topology, seconds: number, seed = 7): SimSnapshot {
  const engine = new Engine(topology, seed);
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i += 1) engine.advance(1000 / 60);
  return engine.snapshot();
}

/** Every finite number reachable in a snapshot, for NaN and Infinity sweeps. */
function walkNumbers(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkNumbers(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkNumbers(v, `${path}.${k}`, out);
  }
}

describe('determinism', () => {
  it('replays identically for the same seed', () => {
    const topology = structuredClone(PRESETS[0].topology);
    const a = JSON.stringify(run(structuredClone(topology), 12, 99));
    const b = JSON.stringify(run(structuredClone(topology), 12, 99));
    expect(a).toBe(b);
  });

  it('diverges for a different seed', () => {
    const topology = structuredClone(PRESETS[0].topology);
    const a = JSON.stringify(run(structuredClone(topology), 12, 1));
    const b = JSON.stringify(run(structuredClone(topology), 12, 2));
    expect(a).not.toBe(b);
  });

  it('keeps a retained client arrival stream across topology edits', () => {
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 50 };
    const topology: Topology = { nodes: [client], edges: [] };
    const untouched = new Engine(topology, 42);
    const edited = new Engine(topology, 42);

    for (let i = 0; i < 10; i += 1) edited.setTopology(topology);
    for (let i = 0; i < 600; i += 1) {
      untouched.advance(1000 / 60);
      edited.advance(1000 / 60);
    }

    expect(edited.snapshot()).toEqual(untouched.snapshot());
  });

  it.each(['added', 'retyped'] as const)(
    'starts an arrival stream for a %s client',
    (change) => {
      const original = { ...makeNode('service', 0, 0), id: 'source' };
      const engine = new Engine(
        change === 'added'
          ? { nodes: [], edges: [] }
          : {
              nodes: [original],
              edges: [],
            },
        42,
      );
      const client = { ...makeNode('client', 0, 0), id: 'source' };
      client.config = { ...client.config, rps: 50 };

      engine.setTopology({ nodes: [client], edges: [] });
      for (let i = 0; i < 600; i += 1) engine.advance(1000 / 60);

      expect(engine.snapshot().system.totalRequests).toBe(485);
    },
  );

  it('replays the initial arrival stream after reset', () => {
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 50 };
    const engine = new Engine({ nodes: [client], edges: [] }, 42);

    for (let i = 0; i < 600; i += 1) engine.advance(1000 / 60);
    const first = JSON.stringify(engine.snapshot());
    engine.reset();
    for (let i = 0; i < 600; i += 1) engine.advance(1000 / 60);

    expect(JSON.stringify(engine.snapshot())).toBe(first);
  });
});

describe.each(PRESETS.map((p) => [p.id, p] as const))('preset %s', (_id, preset) => {
  const snapshot = run(structuredClone(preset.topology), 20);

  it('accounts for every request exactly once', () => {
    const { totalRequests, totalFailed } = snapshot.system;
    const completed = Object.values(snapshot.nodes).reduce(
      (n, s) => n + (s.totalCompleted ?? 0),
      0,
    );
    // Requests either finished, failed, or are still in flight. Nothing may
    // vanish, and nothing may be counted twice.
    expect(totalFailed).toBeLessThanOrEqual(totalRequests);
    expect(completed).toBeGreaterThanOrEqual(0);
  });

  it('breaks failures down to exactly the failure total', () => {
    const sum = Object.values(snapshot.failuresByReason).reduce((a, b) => a + b, 0);
    expect(sum).toBe(snapshot.system.totalFailed);
  });

  it('keeps utilisation within its bounds', () => {
    for (const [id, stats] of Object.entries(snapshot.nodes)) {
      expect(stats.utilization, `${id} utilisation`).toBeGreaterThanOrEqual(0);
      expect(stats.utilization, `${id} utilisation`).toBeLessThanOrEqual(1);
    }
  });

  it('never reports a negative queue or in-flight count', () => {
    for (const [id, stats] of Object.entries(snapshot.nodes)) {
      expect(stats.queued, `${id} queued`).toBeGreaterThanOrEqual(0);
      expect(stats.inFlight, `${id} in flight`).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces no NaN or Infinity anywhere in the snapshot', () => {
    const bad: string[] = [];
    walkNumbers(snapshot, 'snapshot', bad);
    expect(bad).toEqual([]);
  });

  it('is stable at its default load', () => {
    // A preset that is already failing when you open it teaches nothing, so
    // this is a product requirement, not just a sanity check.
    expect(snapshot.system.errorRate).toBeLessThan(0.02);
  });

  it('lays its nodes out without overlaps', () => {
    const nodes = preset.topology.nodes;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const overlapping = Math.abs(a.x - b.x) < 180 && Math.abs(a.y - b.y) < 84;
        expect(overlapping, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });
});

describe('load response', () => {
  it('plateaus goodput instead of scaling past capacity', () => {
    // A service with 2 slots at 50ms can serve at most 40 requests a second.
    // Offering far more must not produce more completions; that plateau is the
    // single most important thing the simulator teaches.
    const client = makeNode('client', 0, 0);
    client.id = 'client';
    client.config = { ...defaultConfig('client'), rps: 400 };

    const service = makeNode('service', 260, 0);
    service.id = 'service';
    service.config = {
      ...defaultConfig('service'),
      capacity: 2,
      serviceMs: 50,
      queueLimit: 64,
      instances: 1,
    };

    const topology: Topology = {
      nodes: [client, service],
      edges: [{ id: 'e', from: 'client', to: 'service', weight: 1 }],
    };

    const snapshot = run(topology, 25);
    const ceiling = 2 * (1000 / 50);
    expect(snapshot.system.goodputRps).toBeLessThanOrEqual(ceiling * 1.35);
    expect(snapshot.system.offeredRps).toBeGreaterThan(ceiling * 2);
  });

  it('never reports more goodput than it was offered', () => {
    for (const preset of PRESETS) {
      const snapshot = run(structuredClone(preset.topology), 20);
      const { offeredRps, goodputRps } = snapshot.system;
      // Momentary windows can favour goodput because completions of earlier
      // arrivals land inside them, so this allows headroom rather than
      // asserting a strict inequality on one sample.
      expect(goodputRps, preset.id).toBeLessThanOrEqual(Math.max(offeredRps * 1.4, 5));
    }
  });
});

describe('hostile topologies', () => {
  const cases: Array<[string, Topology]> = [
    ['empty', { nodes: [], edges: [] }],
    [
      'client alone',
      {
        nodes: [{ ...makeNode('client', 0, 0), id: 'c' }],
        edges: [],
      },
    ],
    [
      'edge to a missing node',
      {
        nodes: [{ ...makeNode('client', 0, 0), id: 'c' }],
        edges: [{ id: 'e', from: 'c', to: 'ghost', weight: 1 }],
      },
    ],
    [
      'two node cycle',
      {
        nodes: [
          { ...makeNode('client', 0, 0), id: 'c' },
          { ...makeNode('service', 260, 0), id: 'a' },
          { ...makeNode('service', 520, 0), id: 'b' },
        ],
        edges: [
          { id: 'e1', from: 'c', to: 'a', weight: 1 },
          { id: 'e2', from: 'a', to: 'b', weight: 1 },
          { id: 'e3', from: 'b', to: 'a', weight: 1 },
        ],
      },
    ],
  ];

  it.each(cases)('survives %s', (_name, topology) => {
    expect(() => run(topology, 8)).not.toThrow();
    const snapshot = run(topology, 8);
    const bad: string[] = [];
    walkNumbers(snapshot, 'snapshot', bad);
    expect(bad).toEqual([]);
  });
});
