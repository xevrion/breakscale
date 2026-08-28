import { describe, expect, it } from 'vitest';
import { DERIVED_NOTE, applySize, deriveFromSize, isSizedKind } from './derive';
import type { VendorSize } from './types';
import { defaultConfig } from '../../sim/presets';

/**
 * The derivation is the one place in vendor mode that is a MODEL rather
 * than a citation, so these assertions are mostly about what it refuses to
 * claim. AGENTS.md forbids a plausible-looking number, and a mapping from
 * vCPUs to behaviour is exactly the shape such a number takes.
 */

const size = (over: Partial<VendorSize> = {}): VendorSize => ({
  name: 'test.large',
  vcpu: 4,
  memory: 16,
  memoryUnit: 'GiB',
  source: 'https://example.invalid/spec',
  ...over,
});

describe('what a size implies', () => {
  it('scales capacity with the vCPU count', () => {
    expect(deriveFromSize('service', size({ vcpu: 8 }))?.capacity).toBe(8);
    expect(deriveFromSize('service', size({ vcpu: 2 }))?.capacity).toBe(2);
  });

  it('never derives a service time', () => {
    // The whole lesson: a bigger machine runs MORE requests at once, it does
    // not make one faster. Deriving latency from hardware would teach the
    // opposite of what the simulator exists to teach.
    expect(deriveFromSize('service', size())?.serviceMs).toBeNull();
  });

  it('leaves service time alone when a size is applied', () => {
    const before = defaultConfig('db');
    const after = applySize('db', before, size({ vcpu: 16 }));
    expect(after.serviceMs).toBe(before.serviceMs);
    expect(after.capacity).toBe(16);
  });

  it('prefers a published connection ceiling over the rule of thumb', () => {
    // maxConnections is a real number the vendor states, so where it exists
    // it beats our own guess rather than being averaged with it.
    const d = deriveFromSize('db', size({ vcpu: 64, maxConnections: 10 }));
    expect(d?.capacity).toBe(10);
  });

  it('ignores a connection ceiling that is larger than the vCPU estimate', () => {
    const d = deriveFromSize('db', size({ vcpu: 4, maxConnections: 5000 }));
    expect(d?.capacity).toBe(4);
  });

  it('never returns a capacity below one', () => {
    // A component that can serve nothing is a broken diagram, not a small one.
    expect(deriveFromSize('service', size({ vcpu: 0.5 }))?.capacity).toBe(1);
  });
});

describe('what it refuses to say', () => {
  it.each(['cdn', 'queue', 'pubsub', 'lambda', 'objectstore', 'ratelimiter'] as const)(
    'declines to size a %s, which has no vCPU a student picks',
    (kind) => {
      expect(isSizedKind(kind)).toBe(false);
      expect(deriveFromSize(kind, size())).toBeNull();
    },
  );

  it('leaves an unsizeable component completely untouched', () => {
    const before = defaultConfig('cdn');
    expect(applySize('cdn', before, size())).toBe(before);
  });

  it('declines a size with no usable vCPU figure', () => {
    // Better to say nothing than to invent a slot count from a missing spec.
    expect(deriveFromSize('service', size({ vcpu: 0 }))).toBeNull();
    expect(deriveFromSize('service', size({ vcpu: Number.NaN }))).toBeNull();
  });
});

describe('the caveat', () => {
  it('says the number is ours, not the vendor’s', () => {
    // The text is the feature. If it ever stops saying this, the app is
    // presenting a model as a measurement.
    expect(DERIVED_NOTE).toMatch(/not a figure the vendor publishes/i);
    expect(DERIVED_NOTE).toMatch(/estimate/i);
  });
});
