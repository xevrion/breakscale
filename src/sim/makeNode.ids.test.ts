import { describe, expect, it } from 'vitest';
import { makeNode } from './presets';

describe('makeNode', () => {
  it('never reuses an id that is already on the canvas', () => {
    // A design restored after a reload carries ids minted by an earlier
    // session, while the module counter has restarted from zero.
    const taken = new Set(Array.from({ length: 10 }, (_, i) => `service-${i + 1}`));
    const added = makeNode('service', 0, 0, undefined, taken);
    expect(taken.has(added.id)).toBe(false);
    expect(added.id).toMatch(/^service-\d+$/);
  });

  it('keeps minting distinct ids across repeated adds', () => {
    const taken = new Set<string>(['cache-1', 'cache-2', 'cache-3']);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const n = makeNode('cache', 0, 0, undefined, taken);
      expect(taken.has(n.id)).toBe(false);
      expect(seen.has(n.id)).toBe(false);
      seen.add(n.id);
      taken.add(n.id);
    }
  });
});
