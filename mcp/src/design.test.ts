import { describe, expect, it } from 'vitest';
import { PRESETS, defaultConfig } from '../../src/sim/presets';
import { buildTopology } from './design';

const chain = {
  nodes: [
    { id: 'users', kind: 'client', config: { rps: 400 } },
    { id: 'api', kind: 'service' },
    { id: 'db', kind: 'db', config: { capacity: 12 } },
  ],
  edges: [
    { from: 'users', to: 'api' },
    { from: 'api', to: 'db' },
  ],
};

describe('buildTopology', () => {
  it('fills defaults and lays nodes out left to right', () => {
    const r = buildTopology(chain);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const [users, api, db] = r.topology.nodes;
    expect(api?.config).toEqual(defaultConfig('service'));
    expect(db?.config.capacity).toBe(12);
    expect(api?.label).toBe('Service');
    expect(users!.x).toBeLessThan(api!.x);
    expect(api!.x).toBeLessThan(db!.x);
    expect(r.topology.edges.map((e) => e.id)).toEqual(['users->api', 'api->db']);
  });

  it('accepts every example as a .breakscale file, unchanged', () => {
    for (const p of PRESETS) {
      const r = buildTopology({ app: 'breakscale', version: 1, topology: p.topology });
      if (!r.ok) throw new Error(`${p.id}: ${r.errors.join('; ')}`);
      expect(r.topology.nodes).toEqual(p.topology.nodes);
      expect(r.topology.edges).toEqual(p.topology.edges);
    }
  });

  it('reports every problem at once, each naming what to change', () => {
    const r = buildTopology({
      nodes: [
        { id: 'users', kind: 'client' },
        { id: 'front', kind: 'loadbalancer' },
        { id: 'cache', kind: 'cache', config: { hitrate: 0.9, capacity: -2 } },
        { id: 'cache', kind: 'db' },
      ],
      edges: [{ from: 'users', to: 'lb' }],
    });
    if (r.ok) throw new Error('accepted a broken design');
    expect(r.errors).toEqual([
      `node 'front' has kind "loadbalancer", which is not a component. Did you mean 'lb'?`,
      `node 'cache' (cache) has no setting 'hitrate'. Did you mean 'hitRate'?`,
      `node 'cache': 'capacity' must be a number, 0 or more; got -2.`,
      `Two nodes share the id 'cache'. Ids must be unique.`,
      `edges[0] goes from 'users' to 'lb', but there is no node 'lb'.`,
    ]);
  });

  it('marks an autoscaler edge as control, the way the examples draw it', () => {
    const r = buildTopology({
      nodes: [
        { id: 'api', kind: 'service' },
        { id: 'scaler', kind: 'autoscaler' },
      ],
      edges: [{ from: 'scaler', to: 'api' }],
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.topology.edges[0]?.control).toBe(true);
  });

  // The engine reads worker -> queue as the worker draining that queue,
  // which turns "publishes to" into a loop that starves the real consumer.
  it('refuses a worker wired into a queue, and says what to draw instead', () => {
    const r = buildTopology({
      nodes: [
        { id: 'jobs', kind: 'queue' },
        { id: 'w', kind: 'worker' },
        { id: 'next', kind: 'queue' },
      ],
      edges: [
        { from: 'jobs', to: 'w' },
        { from: 'w', to: 'next' },
      ],
    });
    if (r.ok) throw new Error('accepted a worker publishing straight into a queue');
    expect(r.errors[0]).toContain(`put a service between them`);
  });

  it('keeps positions it was given', () => {
    const r = buildTopology({
      nodes: [
        { id: 'a', kind: 'client', x: 500, y: 300 },
        { id: 'b', kind: 'service', x: 900, y: 300 },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.topology.nodes.map((n) => [n.x, n.y])).toEqual([
      [500, 300],
      [900, 300],
    ]);
  });

  it('survives a cycle', () => {
    const r = buildTopology({
      nodes: [
        { id: 'svc', kind: 'service' },
        { id: 'retry', kind: 'retryqueue' },
      ],
      edges: [
        { from: 'svc', to: 'retry' },
        { from: 'retry', to: 'svc' },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty design', () => {
    expect(buildTopology({ nodes: [] }).ok).toBe(false);
    expect(buildTopology('nodes').ok).toBe(false);
  });
});
