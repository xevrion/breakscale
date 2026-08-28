/**
 * The load slider must never look interactive while doing nothing.
 *
 * It writes `rps` onto client nodes. With no client on the canvas there is
 * nothing to write to, so the handler returned early and the controlled input
 * snapped back to its old value: a slider that moved under the pointer and
 * then refused to stay put, with no reason given. Deleting the client from any
 * example reached it, as did restoring a saved design that had none.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRESETS } from './sim/presets';
import type { Topology } from './sim/types';

/** The App's own rule for the disabled state, kept in step by this test. */
function hasTrafficSource(t: Topology): boolean {
  return t.nodes.some((n) => n.kind === 'client');
}

/** Total offered load, as the header derives it. */
function clientRps(t: Topology): number {
  return t.nodes
    .filter((n) => n.kind === 'client')
    .reduce((sum, c) => sum + c.config.rps, 0);
}

describe('offered load control', () => {
  it('every preset ships a traffic source', () => {
    // A preset that opened with no client would present a dead slider on
    // first load, which is the worst version of this bug: nothing the reader
    // did caused it.
    for (const preset of PRESETS) {
      expect(hasTrafficSource(preset.topology), preset.id).toBe(true);
      expect(clientRps(preset.topology), preset.id).toBeGreaterThan(0);
    }
  });

  it('reports no traffic source once the clients are gone', () => {
    const stripped: Topology = {
      ...PRESETS[0]!.topology,
      nodes: PRESETS[0]!.topology.nodes.filter((n) => n.kind !== 'client'),
    };
    expect(hasTrafficSource(stripped)).toBe(false);
    expect(clientRps(stripped)).toBe(0);
  });

  it('reports the absence rather than a zero', () => {
    // AGENTS.md: a component with no meaningful value for a metric shows
    // something else, never a plausible-looking number. With no client there
    // is no offered load, and "0 requests / sec" claims a measurement that
    // was never taken. It also outranked the explanation beneath the slider,
    // so a reader dragging a dead control read the zero as the answer.
    const ui = readFileSync(
      new URL('./components/Inspector.tsx', import.meta.url),
      'utf8',
    );
    expect(ui.includes('No traffic source')).toBe(true);
    // The figure is rendered only on the branch that HAS a source: the
    // sentence comes first in the ternary, the number after it.
    const sentence = ui.indexOf('No traffic source');
    const figure = ui.indexOf('formatRateBare(rps)');
    expect(sentence).toBeGreaterThan(-1);
    expect(figure).toBeGreaterThan(sentence);
    expect(ui.includes('noTrafficSource ?')).toBe(true);
  });

  it('a canvas with components but no client still has no traffic source', () => {
    // Distinct from an empty canvas, and the case the original `empty` flag
    // missed: there is plenty to look at, and still nothing to drive it.
    const stripped: Topology = {
      ...PRESETS[0]!.topology,
      nodes: PRESETS[0]!.topology.nodes.filter((n) => n.kind !== 'client'),
    };
    expect(stripped.nodes.length).toBeGreaterThan(0);
    expect(hasTrafficSource(stripped)).toBe(false);
  });
});
