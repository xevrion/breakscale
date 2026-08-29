import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS } from './presets';
import { CHALLENGES } from './challenges';
import { applyLoad, evaluate } from './challenge';
import type { Challenge } from './challenge';
import type { SimSnapshot, Topology } from './types';

/**
 * A brief has to be both losable and winnable.
 *
 * The two ways a challenge is worthless are symmetrical: one you pass without
 * touching anything teaches nothing, and one with no reachable answer teaches
 * less than that and makes the reader think the tool is broken. Both are
 * asserted here against the real engine, so a change to a preset or to the
 * simulation cannot quietly turn a brief into either.
 */

function play(challenge: Challenge, edit?: (t: Topology) => void): SimSnapshot {
  const preset = PRESETS.find((p) => p.id === challenge.presetId)!;
  const topology = structuredClone(preset.topology);
  applyLoad(topology, challenge.loadRps);
  edit?.(topology);
  const engine = new Engine(topology, 42);
  for (let i = 0; i < 60 * 90; i += 1) engine.advance(1000 / 60);
  return engine.snapshot();
}

const nodeOfKind = (t: Topology, kind: string) => t.nodes.find((n) => n.kind === kind)!;

describe('challenges', () => {
  it('every challenge names a preset that exists', () => {
    for (const c of CHALLENGES) {
      expect(
        PRESETS.some((p) => p.id === c.presetId),
        c.id,
      ).toBe(true);
    }
  });

  it('every challenge fails as the preset ships', () => {
    // The whole point. A brief that is already satisfied is a form to fill in.
    for (const c of CHALLENGES) {
      expect(evaluate(c, play(c)).passed, `${c.id} should not pass untouched`).toBe(
        false,
      );
    }
  });

  it('hold the line is won by giving the database more slots', () => {
    const c = CHALLENGES.find((x) => x.id === 'hold-the-line')!;
    const after = play(c, (t) => {
      nodeOfKind(t, 'db').config.capacity += 4;
    });
    expect(evaluate(c, after).passed).toBe(true);
  });

  it('more machines is won by instances, and NOT by a bigger machine', () => {
    // This is the lesson the brief exists for, so both halves are asserted:
    // scaling the single database up leaves the errors exactly where they
    // were, and running more of them clears them.
    const c = CHALLENGES.find((x) => x.id === 'more-machines')!;
    const bigger = play(c, (t) => {
      nodeOfKind(t, 'db').config.capacity = 12;
    });
    expect(evaluate(c, bigger).passed, 'a bigger database must not be the answer').toBe(
      false,
    );

    const more = play(c, (t) => {
      nodeOfKind(t, 'db').config.instances = 3;
    });
    expect(evaluate(c, more).passed).toBe(true);
  });

  it('stop the storm is won by widening what the retries land on', () => {
    const c = CHALLENGES.find((x) => x.id === 'stop-the-storm')!;
    const after = play(c, (t) => {
      t.nodes.find((n) => n.id === 'db')!.config.capacity = 8;
    });
    expect(evaluate(c, after).passed).toBe(true);
  });

  it('every brief teaches something once it is passed', () => {
    // The lesson is the reason this is not a puzzle. A brief that ends at
    // "passed" leaves the reader with a number that works here and nowhere
    // else.
    for (const c of CHALLENGES) {
      expect(c.lesson.length, `${c.id} lesson`).toBeGreaterThan(120);
      expect(c.hints.length, `${c.id} hints`).toBeGreaterThan(1);
    }
  });

  it('no hint gives the answer away in its first line', () => {
    // The first hint is a direction, not a solution. If it names the field to
    // change, the brief is a reading exercise.
    for (const c of CHALLENGES) {
      expect(c.hints[0]!.length, `${c.id} first hint`).toBeLessThan(140);
    }
  });

  it('keep it warm has two honest answers', () => {
    // Either raise the hit rate so fewer requests reach the database, or give
    // the database enough machines to take what does. A brief with one
    // permitted answer teaches a trick; this one teaches the tradeoff.
    const c = CHALLENGES.find((x) => x.id === 'keep-it-warm')!;

    const warmer = play(c, (t) => {
      nodeOfKind(t, 'cache').config.hitRate = 0.95;
    });
    expect(evaluate(c, warmer).passed, 'a warmer cache should pass').toBe(true);

    const wider = play(c, (t) => {
      nodeOfKind(t, 'db').config.instances = 3;
    });
    expect(evaluate(c, wider).passed, 'more database machines should pass').toBe(true);
  });

  it('reports which goal failed, not just that one did', () => {
    // "Failed" on its own is worse than no challenge: the reader has to be
    // told which condition broke and by how much.
    const c = CHALLENGES.find((x) => x.id === 'stop-the-storm')!;
    const result = evaluate(c, play(c));
    expect(result.passed).toBe(false);
    expect(result.goals).toHaveLength(c.goals.length);
    for (const g of result.goals) expect(Number.isFinite(g.actual)).toBe(true);
  });
});

describe('evaluate', () => {
  it('never passes a dead system on latency alone', () => {
    // With no goodput there are no completed requests to take a percentile
    // of, so p99 reads 0 and would satisfy any "under 200ms" goal. A total
    // outage must not score as the best possible latency.
    const dead = {
      system: { p99: 0, p95: 0, errorRate: 1, goodputRps: 0 },
    } as unknown as SimSnapshot;
    const c: Challenge = {
      id: 't',
      name: 't',
      brief: 't',
      presetId: 'single-server',
      loadRps: 100,
      goals: [{ metric: 'p99', max: 200 }],
      hints: ['t'],
      lesson: 't',
    };
    const result = evaluate(c, dead);
    expect(result.passed).toBe(false);
    expect(result.goals[0]!.met).toBe(false);
  });

  it('splits the offered load across every traffic source', () => {
    const preset = PRESETS.find((p) => p.id === 'load-balanced')!;
    const t = structuredClone(preset.topology);
    applyLoad(t, 600);
    const clients = t.nodes.filter((n) => n.kind === 'client');
    const total = clients.reduce((sum, c) => sum + c.config.rps, 0);
    expect(total).toBe(600);
  });
});
