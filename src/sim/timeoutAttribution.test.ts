import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { defaultConfig } from './presets';
import type { NodeKind, SimNode, Topology } from './types';

/**
 * Who owns a timeout, and what the failure rate counts.
 *
 * Two rules, one owner each. `onTimeout` owns the `timeouts` counter, because
 * giving up is what that counter means and that hook is the only place that
 * knows which node's deadline elapsed. `resolve` owns the ROOT's
 * `totalFailed`, because it books every reason alike and is the only place
 * that sees the request end.
 *
 * They used to overlap. `resolve` also booked the timeout, so a client calling
 * its dependency directly was credited twice by two different code paths for
 * one dead request: its timeout rate outran the load it was offering, and its
 * `totalFailed` came out at nearly twice what the system booked.
 *
 * Separately, `errorRate` left timeouts out of both halves of its ratio, so
 * the cell the canvas labels "failing" was the failure rate among requests
 * that did not time out. A caller losing a quarter of its traffic read 0%.
 */

const n = (id: string, kind: NodeKind, cfg = {}): SimNode =>
  ({
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...cfg },
  }) as SimNode;

/** The client calls its dependency directly, so the client is the one that gives up. */
const direct: Topology = {
  nodes: [
    n('c', 'client', { rps: 50, timeoutMs: 20 }),
    n('s', 'service', { serviceMs: 200 }),
  ],
  edges: [{ id: 'c->s', from: 'c', to: 's', weight: 1 }],
};

/** A node below the root gives up instead, and the failure propagates. */
const throughApi: Topology = {
  nodes: [
    n('c', 'client', { rps: 50, timeoutMs: 500 }),
    n('a', 'service', { serviceMs: 5, timeoutMs: 20, capacity: 64 }),
    n('d', 'db', { serviceMs: 200 }),
  ],
  edges: [
    { id: 'c->a', from: 'c', to: 'a', weight: 1 },
    { id: 'a->d', from: 'a', to: 'd', weight: 1 },
  ],
};

/** Some requests beat the deadline and some do not, so the true loss is partial. */
const partial: Topology = {
  nodes: [
    n('c', 'client', { rps: 40, timeoutMs: 40 }),
    n('s', 'service', { serviceMs: 40, serviceCv: 1.2, capacity: 8 }),
  ],
  edges: [{ id: 'c->s', from: 'c', to: 's', weight: 1 }],
};

function run(topology: Topology, seconds = 30) {
  const engine = new Engine(topology, 42);
  for (let i = 0; i < Math.round((seconds * 1000) / (1000 / 60)); i += 1) {
    engine.advance(1000 / 60);
  }
  return engine.snapshot();
}

describe('a timeout is booked once', () => {
  it('does not double the root when the root is the caller', () => {
    const s = run(direct);
    expect(s.nodes['c']!.totalFailed).toBe(s.system.totalFailed);
  });

  it('still books the root when a node below it gave up', () => {
    const s = run(throughApi);
    expect(s.nodes['c']!.totalFailed).toBe(s.system.totalFailed);
  });

  it('keeps a node from failing more often than the whole system did', () => {
    for (const topology of [direct, throughApi, partial]) {
      const s = run(topology);
      for (const stats of Object.values(s.nodes)) {
        expect(stats.totalFailed).toBeLessThanOrEqual(s.system.totalFailed);
      }
    }
  });

  it('does not let a client time out faster than it offers load', () => {
    const c = run(direct).nodes['c']!;
    expect(c.timeoutRate).toBeLessThanOrEqual(c.arrivalRate + 1);
  });
});

describe('the timeout lands on whichever node gave up', () => {
  it('credits the client when the client is the one waiting', () => {
    expect(run(direct).nodes['c']!.timeoutRate).toBeGreaterThan(0);
  });

  it('credits the middle node, and not the client, when that is who waited', () => {
    const s = run(throughApi);
    expect(s.nodes['a']!.timeoutRate).toBeGreaterThan(0);
    expect(s.nodes['c']!.timeoutRate).toBe(0);
  });
});

describe('the failure rate counts timeouts', () => {
  it('tracks the traffic actually lost', () => {
    const c = run(partial).nodes['c']!;
    const lost = 1 - c.throughput / c.arrivalRate;

    expect(c.shedRate).toBe(0);
    expect(c.timeoutRate).toBeGreaterThan(0);
    expect(c.errorRate).toBeGreaterThan(lost - 0.1);
    expect(c.errorRate).toBeLessThan(lost + 0.1);
  });

  it('sees a middle node losing everything to its dependency', () => {
    expect(run(throughApi).nodes['a']!.errorRate).toBeGreaterThan(0.9);
  });

  it('eases off as the deadline gets more generous', () => {
    const tight = run(partial).nodes['c']!.errorRate;
    const loose = run({
      ...partial,
      nodes: [n('c', 'client', { rps: 40, timeoutMs: 200 }), partial.nodes[1]!],
    }).nodes['c']!.errorRate;

    expect(tight).toBeGreaterThan(loose);
  });

  it('stays inside its bounds', () => {
    for (const topology of [direct, throughApi, partial]) {
      for (const stats of Object.values(run(topology).nodes)) {
        expect(stats.errorRate).toBeGreaterThanOrEqual(0);
        expect(stats.errorRate).toBeLessThanOrEqual(1);
      }
    }
  });
});
