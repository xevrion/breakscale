import { describe, expect, it } from 'vitest';
import { freshId, isTopology } from './clipboard';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * Guards the wiring between handleAddNode and the live topology mirror.
 *
 * Issue #46: `makeNode` uses a module counter that resets on load, so two
 * palette-adds of the same kind produce duplicate ids. The fix mints ids
 * via `freshId` against `topoLiveRef.current`. A stale-closure bug (reading
 * the React `topology` binding instead of the live ref) causes two rapid
 * adds to drop the first node, because the second add spreads the same
 * pre-add snapshot.
 *
 * The source assertion catches regressions that the behavioral test cannot:
 * a refactor could reintroduce the stale closure while keeping the id mint,
 * and the behavioral test (which cannot simulate React scheduling) would
 * still pass.
 */

const SOURCES = import.meta.glob('./App.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const APP_SRC = Object.values(SOURCES)[0] ?? '';

/**
 * Extract the handleAddNode callback body from App.tsx source.
 *
 * Finds `const handleAddNode = useCallback(` and captures everything up to
 * the matching dep array closing paren.
 */
function extractHandleAddNode(src: string): string {
  const marker = 'const handleAddNode = useCallback(';
  const start = src.indexOf(marker);
  if (start === -1) return '';
  let depth = 0;
  let i = start + marker.length;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    if (src[i] === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  return src.slice(start, i + 1);
}

describe('handleAddNode wiring (issue #46)', () => {
  const body = extractHandleAddNode(APP_SRC);

  it('finds handleAddNode in App.tsx', () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it('builds the next topology from topoLiveRef.current, not the React topology binding', () => {
    expect(body).toContain('topoLiveRef.current');
    expect(body).not.toMatch(/\.\.\.\s*topology\b/);
    expect(body).not.toMatch(/topology\.nodes/);
  });

  it('mints the id via freshId', () => {
    expect(body).toContain('freshId');
  });

  it('does not list topology in its dependency array', () => {
    const depsMatch = body.match(/\},\s*\[([^\]]*)\]/);
    expect(depsMatch).not.toBeNull();
    const deps = depsMatch![1]!;
    expect(deps).not.toMatch(/\btopology\b/);
  });
});

/**
 * Behavioral test: two sequential palette-adds against the default preset
 * (ids: client, api, db) with no intervening React render. Simulates the
 * actual #46 path as a pure function.
 */

function simulateAddNode(
  topo: Topology,
  kind: Parameters<typeof makeNode>[0],
  x: number,
  y: number,
): { topology: Topology; nodeId: string } {
  const node = makeNode(kind, x, y);
  node.id = freshId(kind, new Set(topo.nodes.map((n) => n.id)));
  const next: Topology = { ...topo, nodes: [...topo.nodes, node] };
  return { topology: next, nodeId: node.id };
}

describe('two sequential palette-adds (issue #46 behavioral)', () => {
  const DEFAULT_PRESET: Topology = {
    nodes: [
      makeNode('client', 0, 0),
      makeNode('service', 240, 0),
      makeNode('db', 480, 0),
    ],
    edges: [
      { id: 'client-1->service-2', from: 'client-1', to: 'service-2', weight: 1 },
      { id: 'service-2->db-3', from: 'service-2', to: 'db-3', weight: 1 },
    ],
  };

  it('both nodes survive, ids are unique, isTopology accepts the result', () => {
    const after1 = simulateAddNode(DEFAULT_PRESET, 'cache', 240, 240);
    const after2 = simulateAddNode(after1.topology, 'cache', 240, 360);

    expect(after2.topology.nodes).toHaveLength(5);
    expect(after1.nodeId).not.toBe(after2.nodeId);

    const allIds = after2.topology.nodes.map((n) => n.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    expect(isTopology(after2.topology)).toBe(true);
  });

  it('second add does not drop the first (stale-closure regression)', () => {
    const after1 = simulateAddNode(DEFAULT_PRESET, 'cache', 240, 240);
    const after2 = simulateAddNode(after1.topology, 'cache', 240, 360);

    expect(after2.topology.nodes.some((n) => n.id === after1.nodeId)).toBe(true);
    expect(after2.topology.nodes.some((n) => n.id === after2.nodeId)).toBe(true);
  });
});
