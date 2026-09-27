import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/sim/presets';
import { DEFAULT_RUN, describeRun, runDesign } from './run';

const single = PRESETS.find((p) => p.id === 'single-server')!.topology;

describe('runDesign', () => {
  it('says the same thing for the same seed', () => {
    const a = describeRun(single, runDesign(single, DEFAULT_RUN), DEFAULT_RUN);
    const b = describeRun(single, runDesign(single, DEFAULT_RUN), DEFAULT_RUN);
    expect(a).toBe(b);
  });

  it('stops at its budget and says so', () => {
    const opts = { ...DEFAULT_RUN, budgetMs: 0 };
    const run = runDesign(single, opts);
    expect(run.simulatedMs).toBe(0);
    expect(describeRun(single, run, opts)).toContain('stopped at 0s of 30s');
  });

  it('names the component that saturates', () => {
    const heavy = structuredClone(single);
    for (const n of heavy.nodes) if (n.kind === 'client') n.config.rps *= 4;
    const text = describeRun(heavy, runDesign(heavy, DEFAULT_RUN), DEFAULT_RUN);
    const first = text.split('\n').find((l) => l.startsWith('- '));
    expect(first).toMatch(/\(db, id '/);
  });
});
