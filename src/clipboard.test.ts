import { describe, expect, it } from 'vitest';
import {
  buildClipboardText,
  cloneSubgraph,
  freshId,
  isTopology,
  parseClipboardText,
  selectionSubgraph,
} from './clipboard';
import type { Topology, NodeConfig, SimNode } from './sim/types';

/* ------------------------------------------------------------------ *
 * Fixtures. A three-node chain with one edge inside a would-be selection
 * and one crossing its boundary, which is exactly the shape the
 * edge-dropping rule exists for.
 * ------------------------------------------------------------------ */

const CONFIG: NodeConfig = {
  capacity: 8,
  serviceMs: 25,
  serviceCv: 0.6,
  queueLimit: 64,
  hitRate: 0,
  errorRate: 0,
  timeoutMs: 0,
  retries: 0,
  rps: 0,
  instances: 1,
  replicaCount: 3,
  replicationLagMs: 50,
  readFraction: 0.9,
  shardCount: 4,
  shardCapacity: 4,
  hotKeyFraction: 0,
};

function node(id: string, x = 0, y = 0): SimNode {
  return { id, kind: 'service', label: id, x, y, config: { ...CONFIG } };
}

function topo(): Topology {
  return {
    nodes: [
      node('service-1', 0, 0),
      node('service-2', 240, 0),
      node('service-3', 480, 0),
    ],
    edges: [
      { id: 'service-1->service-2', from: 'service-1', to: 'service-2', weight: 1 },
      { id: 'service-2->service-3', from: 'service-2', to: 'service-3', weight: 1 },
    ],
  };
}

describe('selectionSubgraph', () => {
  it('keeps edges between selected nodes and drops boundary-crossing ones', () => {
    const sub = selectionSubgraph(topo(), new Set(['service-1', 'service-2']));
    expect(sub).not.toBeNull();
    expect(sub!.nodes.map((n) => n.id)).toEqual(['service-1', 'service-2']);
    // service-2->service-3 crosses out of the selection and must not travel.
    expect(sub!.edges.map((e) => e.id)).toEqual(['service-1->service-2']);
  });

  it('returns null for a selection with no nodes', () => {
    expect(selectionSubgraph(topo(), new Set())).toBeNull();
    // A lone edge id is not a pasteable thing either.
    expect(selectionSubgraph(topo(), new Set(['service-1->service-2']))).toBeNull();
  });

  it('returns copies, not references into the topology', () => {
    const t = topo();
    const sub = selectionSubgraph(t, new Set(['service-1']))!;
    sub.nodes[0]!.x = 999;
    sub.nodes[0]!.config.capacity = 999;
    expect(t.nodes[0]!.x).toBe(0);
    expect(t.nodes[0]!.config.capacity).toBe(8);
  });
});

describe('clipboard round trip', () => {
  it('serialises and parses back the same subgraph', () => {
    const text = buildClipboardText(topo(), new Set(['service-1', 'service-2']));
    expect(text).not.toBeNull();
    const back = parseClipboardText(text!);
    expect(back).not.toBeNull();
    expect(back!.nodes.map((n) => n.id)).toEqual(['service-1', 'service-2']);
    expect(back!.edges.map((e) => e.id)).toEqual(['service-1->service-2']);
  });

  it('returns null rather than throwing on garbage', () => {
    // The paste path is untrusted input; none of these may throw.
    expect(parseClipboardText('not json at all')).toBeNull();
    expect(parseClipboardText('')).toBeNull();
    expect(parseClipboardText('42')).toBeNull();
    expect(parseClipboardText('"a string"')).toBeNull();
    expect(parseClipboardText('{"totally":"unrelated"}')).toBeNull();
    expect(parseClipboardText('[1,2,3]')).toBeNull();
  });

  it('rejects structurally invalid payloads', () => {
    // A node of an unknown kind.
    const badKind = JSON.stringify({
      nodes: [{ ...node('x-1'), kind: 'mainframe' }],
      edges: [],
    });
    expect(parseClipboardText(badKind)).toBeNull();

    // An edge pointing at a node the payload does not carry.
    const dangling = JSON.stringify({
      nodes: [node('service-1')],
      edges: [{ id: 'service-1->ghost', from: 'service-1', to: 'ghost', weight: 1 }],
    });
    expect(parseClipboardText(dangling)).toBeNull();

    // A config field replaced with something non-numeric.
    const brokenCfg = node('service-1');
    (brokenCfg.config as unknown as Record<string, unknown>).capacity = 'lots';
    expect(
      parseClipboardText(JSON.stringify({ nodes: [brokenCfg], edges: [] })),
    ).toBeNull();

    // NaN and Infinity do not survive JSON, but a hand-built payload could
    // hold null in a numeric slot.
    const nullX = { ...node('service-1'), x: null };
    expect(
      parseClipboardText(JSON.stringify({ nodes: [nullX], edges: [] })),
    ).toBeNull();
  });

  it('isTopology rejects duplicate node ids', () => {
    expect(
      isTopology({ nodes: [node('service-1'), node('service-1')], edges: [] }),
    ).toBe(false);
  });
});

describe('cloneSubgraph', () => {
  it('mints ids that collide with nothing in the topology', () => {
    const t = topo();
    const sub = selectionSubgraph(t, new Set(['service-1', 'service-2']))!;
    const clones = cloneSubgraph(sub, t, 16, 16);
    const existing = new Set(t.nodes.map((n) => n.id));
    for (const n of clones.nodes) {
      expect(existing.has(n.id)).toBe(false);
      expect(n.kind).toBe('service');
    }
    // The two fresh ids must also differ from each other.
    expect(new Set(clones.nodes.map((n) => n.id)).size).toBe(2);
  });

  it('remaps internal edges to the fresh ids and keeps the id shape', () => {
    const t = topo();
    const sub = selectionSubgraph(t, new Set(['service-1', 'service-2']))!;
    const clones = cloneSubgraph(sub, t, 0, 0);
    expect(clones.edges).toHaveLength(1);
    const e = clones.edges[0]!;
    const ids = clones.nodes.map((n) => n.id);
    expect(ids).toContain(e.from);
    expect(ids).toContain(e.to);
    expect(e.id).toBe(`${e.from}->${e.to}`);
    expect(e.weight).toBe(1);
  });

  it('applies the offset and carries config and label over', () => {
    const t = topo();
    t.nodes[0]!.label = 'checkout';
    t.nodes[0]!.config.capacity = 42;
    const sub = selectionSubgraph(t, new Set(['service-1']))!;
    const clones = cloneSubgraph(sub, t, 16, 24);
    expect(clones.nodes[0]!.x).toBe(16);
    expect(clones.nodes[0]!.y).toBe(24);
    expect(clones.nodes[0]!.label).toBe('checkout');
    expect(clones.nodes[0]!.config.capacity).toBe(42);
    // And the clone's config is its own object, not shared with the source.
    clones.nodes[0]!.config.capacity = 1;
    expect(t.nodes[0]!.config.capacity).toBe(42);
  });

  it('never trusts ids arriving from a foreign clipboard', () => {
    // A payload whose ids ALREADY exist here (copied from another tab).
    const t = topo();
    const foreign = {
      nodes: [node('service-1', 100, 100)],
      edges: [],
    };
    const clones = cloneSubgraph(foreign, t, 0, 0);
    expect(clones.nodes[0]!.id).not.toBe('service-1');
    expect(t.nodes.some((n) => n.id === clones.nodes[0]!.id)).toBe(false);
  });

  it('preserves node order, so callers may map source i to clone i', () => {
    const t = topo();
    const sub = selectionSubgraph(t, new Set(['service-1', 'service-3']))!;
    const clones = cloneSubgraph(sub, t, 0, 0);
    expect(clones.nodes.map((n) => n.x)).toEqual(sub.nodes.map((n) => n.x));
  });
});

describe('freshId (palette-add dedup, issue #46)', () => {
  it('two mints of the same kind against an existing topology produce unique ids', () => {
    const existing: Topology = {
      nodes: [
        { ...node('client', 0, 0), kind: 'client', id: 'client' },
        { ...node('service-1'), kind: 'service', id: 'service-1' },
        { ...node('db', 480, 0), kind: 'db', id: 'db' },
      ],
      edges: [],
    };

    const used = new Set(existing.nodes.map((n) => n.id));
    const id1 = freshId('cache', used);
    const id2 = freshId('cache', used);

    expect(id1).not.toBe(id2);
    expect(new Set([...existing.nodes.map((n) => n.id), id1, id2]).size).toBe(5);
  });

  it('skips ids already present in the topology', () => {
    const existing: Topology = {
      nodes: [node('cache-1', 0, 0)],
      edges: [],
    };
    // Simulate: topology already has cache-1 (from an earlier add).
    // A second palette-add of cache must NOT mint cache-1 again.
    const used = new Set(existing.nodes.map((n) => n.id));
    const id = freshId('cache', used);
    expect(id).toBe('cache-2');
  });

  it('result passes isTopology (no duplicate ids)', () => {
    const base: Topology = {
      nodes: [
        { ...node('client', 0, 0), kind: 'client', id: 'client' },
        { ...node('service-1'), kind: 'service', id: 'service-1' },
        { ...node('db', 480, 0), kind: 'db', id: 'db' },
      ],
      edges: [],
    };
    const used = new Set(base.nodes.map((n) => n.id));
    const id1 = freshId('cache', used);
    const id2 = freshId('cache', used);
    const after: Topology = {
      nodes: [
        ...base.nodes,
        { ...node(id1, 240, 100), kind: 'cache', id: id1 },
        { ...node(id2, 240, 200), kind: 'cache', id: id2 },
      ],
      edges: [],
    };
    expect(isTopology(after)).toBe(true);
  });
});
