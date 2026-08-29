import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS } from './presets';
import type { Topology } from './types';

/**
 * The retry storm's collapse point, pinned.
 *
 * This preset's own copy told the reader to "drag past about 2.4x", and a
 * source comment claimed it was stable to 2x. Neither survived measurement:
 * it is steady at 1.8x and mostly gone by 1.9x. Copy that overstates where a
 * system breaks is worse than no copy, because a student who drags to the
 * stated number and finds a corpse learns the wrong lesson about the
 * mechanism.
 *
 * The failure rate at the knee is deliberately NOT asserted tightly. The
 * onset is stochastic: whether the queue tips over depends on the timing of
 * the first slow batch, so seeds land anywhere from 40% to 95%. That spread
 * is honest behaviour and the copy describes a range because of it.
 */

const preset = PRESETS.find((p) => p.id === 'retry-storm')!;

function failureRate(rps: number, seed: number, seconds = 120): number {
  const topology: Topology = structuredClone(preset.topology);
  topology.nodes.find((n) => n.id === 'client')!.config.rps = rps;
  const engine = new Engine(topology, seed);
  for (let i = 0; i < 60 * seconds; i += 1) engine.advance(1000 / 60);
  const s = engine.snapshot().system;
  return (s.totalFailed / s.totalRequests) * 100;
}

const SEEDS = [1, 42, 7, 2024];

describe('retry storm collapse', () => {
  it('is completely stable at 80 rps on every seed', () => {
    for (const seed of SEEDS) {
      expect(failureRate(80, seed), `seed ${seed}`).toBe(0);
    }
  });

  it('has begun collapsing at 85 rps on every seed', () => {
    // The knee. Every seed loses a substantial share; none is still healthy.
    for (const seed of SEEDS) {
      expect(failureRate(85, seed), `seed ${seed}`).toBeGreaterThan(30);
    }
  });

  it('is essentially dead by 90 rps', () => {
    for (const seed of SEEDS) {
      expect(failureRate(90, seed), `seed ${seed}`).toBeGreaterThan(40);
    }
  });

  it('states the collapse point in its own note', () => {
    // The teaching copy has to agree with the engine, which is the whole
    // reason this file exists.
    const note = preset.topology.annotations?.find((a) => a.id === 'rt-note-storm');
    const text = note && 'text' in note ? (note.text as string) : '';
    expect(text).toContain('80');
    expect(text).not.toContain('2.4x');
  });
});
