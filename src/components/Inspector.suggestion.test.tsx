// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { makeNode } from '../sim/presets';
import { suggestionFor } from '../content/suggestions';
import type { NodeKind, NodeStats } from '../sim/types';

/**
 * The suggestion is gated on headroom, and headroom is derived inside the
 * component from stats the engine produces. A unit test on suggestionFor can
 * only prove the strings; it cannot prove the node ever shows one, nor that a
 * healthy node stays quiet. These render the real panel and read the DOM.
 *
 * Kinds are exactly HAS_THROUGHPUT_CEILING in Inspector.tsx. Headroom is
 * undefined for every other kind, so no other kind can reach this section.
 */
const CEILING_KINDS: NodeKind[] = [
  'lb',
  'service',
  'cache',
  'db',
  'worker',
  'objectstore',
  'coldstorage',
  'retryqueue',
  'transcoder',
  'edgecompute',
  'apigateway',
  'sidecar',
];

/** Only the fields NodeStats requires; the panels read the rest as optional. */
function statsWith(arrivalRate: number): NodeStats {
  return {
    inFlight: 1,
    queued: 0,
    throughput: arrivalRate,
    arrivalRate,
    utilization: 0.99,
    errorRate: 0,
    shedRate: 0,
    timeoutRate: 0,
    hitRate: 0.8,
    totalCompleted: 0,
    totalFailed: 0,
    p50: 10,
    p95: 20,
    p99: 30,
    queueLimit: 256,
    staleReadRate: 0,
    maxShardUtilization: 0,
    minShardUtilization: 0,
    shardUtilization: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React only accepts act() from an environment that declares itself one.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function renderKind(kind: NodeKind, arrivalRate: number): void {
  const node = makeNode(kind, 0, 0);
  act(() =>
    root.render(
      <Inspector
        node={node}
        stats={statsWith(arrivalRate)}
        onChange={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
}

/** The rendered suggestion text, or null when the section is absent. */
function suggestionText(): string | null {
  return document.querySelector('.ins-suggestion')?.textContent?.trim() ?? null;
}

describe('the suggested fix in the inspector', () => {
  // Above the highest default ceiling in the list, so every kind lands below
  // 1.0x headroom without per-kind tuning. The load balancer sets that bar by
  // a wide margin: 256 slots at 0.5ms is 512k/s, where a db is 200/s.
  const OVERLOADED = 2_000_000;

  it.each(CEILING_KINDS)(
    'shows %s its own suggestion when it cannot keep up',
    (kind) => {
      renderKind(kind, OVERLOADED);
      expect(suggestionText()).toBe(suggestionFor(kind));
    },
  );

  it.each(CEILING_KINDS)('stays quiet for %s while it has headroom', (kind) => {
    // One request a second is under every default ceiling in the list.
    renderKind(kind, 1);
    expect(suggestionText()).toBeNull();
  });

  it('stays quiet when nothing is arriving, rather than reading 0 as overloaded', () => {
    // Headroom is null at zero arrivals. Treating that as "below 1.0x" would
    // tell a student to fix a node that is merely idle.
    renderKind('service', 0);
    expect(suggestionText()).toBeNull();
  });

  it('offers nothing for a kind with no throughput ceiling', () => {
    renderKind('queue', OVERLOADED);
    expect(suggestionText()).toBeNull();
  });

  it('does not tell an overloaded database to get bigger', () => {
    // The one suggestion the issue thread singles out as a trap.
    renderKind('db', OVERLOADED);
    expect(suggestionText()).not.toMatch(/add (more )?(capacity|instances)/i);
  });
});
