import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeStats, Topology } from './types';

/*
 * None of the autoscaler's knobs is among the nine config numbers
 * `isTopology` checks, so a shared link, a `.breakscale` file and a restored
 * session can all hand the controller a value that is not a number. What it
 * does with one is a property of the controller.
 *
 * The reading that matters is not the knob, it is whether the fleet still
 * grows: a controller that quietly stops controlling looks exactly like a
 * design that did not need to scale.
 */

function topology(patch: Record<string, unknown>): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 400 };
  const svc = { ...makeNode('service', 200, 0), id: 'svc' };
  svc.config = {
    ...svc.config,
    capacity: 2,
    serviceMs: 40,
    instances: 1,
  } as typeof svc.config;
  const auto = { ...makeNode('autoscaler', 200, 160), id: 'auto' };
  auto.config = { ...auto.config, ...patch } as typeof auto.config;
  return {
    nodes: [client, svc, auto],
    edges: [
      { id: 'e1', from: 'client', to: 'svc', weight: 1 },
      { id: 'e2', from: 'auto', to: 'svc', weight: 1, control: true },
    ],
  };
}

function run(patch: Record<string, unknown>) {
  const engine = new Engine(topology(patch), 7);
  // Thirty simulated seconds: several cooldowns, so the controller has had
  // every chance to act.
  for (let i = 0; i < 1800; i += 1) engine.advance(1000 / 60);
  const snapshot = engine.snapshot();
  return {
    auto: snapshot.nodes['auto'] as NodeStats,
    svc: snapshot.nodes['svc'] as NodeStats,
  };
}

const KNOBS = [
  'targetUtil',
  'minCapacity',
  'maxCapacity',
  'scaleStepPct',
  'cooldownMs',
  'warmupMs',
] as const;

describe('an autoscaler given a knob that is not a number', () => {
  const baseline = run({});

  it('scales the fleet in the baseline design', () => {
    // Anchors the rest: this load genuinely needs more than one instance.
    expect(baseline.svc.instances).toBeGreaterThan(5);
    expect(baseline.svc.totalCompleted).toBeGreaterThan(5000);
  });

  for (const key of KNOBS) {
    it(`still scales when ${key} is NaN`, () => {
      // Before this change targetUtil, scaleStepPct and warmupMs each left
      // the fleet at one instance and the design served 1520 requests where
      // the baseline serves 6756.
      const { svc } = run({ [key]: Number.NaN });
      expect(svc.instances).toBeGreaterThan(5);
      expect(svc.totalCompleted).toBeGreaterThan(4000);
    });
  }

  // Where the module's documented fallback is also what the node carries,
  // a NaN is indistinguishable from the value it replaced -- which is the
  // sharpest available statement that the guard changed nothing real.
  for (const key of ['targetUtil', 'minCapacity', 'scaleStepPct'] as const) {
    it(`is identical to the baseline when ${key} is NaN`, () => {
      const { svc } = run({ [key]: Number.NaN });
      expect(svc.instances).toBe(baseline.svc.instances);
      expect(svc.totalCompleted).toBe(baseline.svc.totalCompleted);
    });
  }

  it('publishes a setpoint that is a number', () => {
    const { auto } = run({ targetUtil: Number.NaN });
    expect(Number.isNaN(auto.setpoint as number)).toBe(false);
  });

  it('publishes a target instance count that is a number', () => {
    const { auto } = run({ scaleStepPct: Number.NaN });
    expect(Number.isNaN(auto.targetInstances as number)).toBe(false);
  });

  it('leaves a design the editor can produce exactly where it was', () => {
    // The knobs a reader sets are read the same way they always were, so a
    // design that names all six is untouched by the guard.
    const explicit = run({
      targetUtil: 0.7,
      minCapacity: 1,
      maxCapacity: 12,
      cooldownMs: 3000,
      scaleStepPct: 0.5,
      warmupMs: 4000,
    });
    expect(explicit.svc.instances).toBe(baseline.svc.instances);
    expect(explicit.svc.totalCompleted).toBe(baseline.svc.totalCompleted);
  });
});
