import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_KINDS } from '../../src/clipboard';
import { WIRE_FIELDS } from '../../src/share/wire';
import { buildTopology } from './design';
import { buildReadme, extractFieldDocs } from './readme';
import { DEFAULT_RUN, runDesign } from './run';

const types = readFileSync(new URL('../../src/sim/types.ts', import.meta.url), 'utf8');
const docs = extractFieldDocs(types);
const readme = buildReadme(docs);

describe('read_me', () => {
  it('describes every setting a design can carry', () => {
    const undocumented = WIRE_FIELDS.filter((f) => !docs[f]);
    expect(undocumented).toEqual([]);
  });

  it('lists every component', () => {
    for (const kind of NODE_KINDS) expect(readme).toContain(`- \`${kind}\``);
  });

  // A model copies the example, so it has to be accepted and it has to
  // show what it claims: the limiter refusing, the backend comfortable.
  it('has an example that runs the way it is meant to', () => {
    const json = readme.match(/```json\n([\s\S]*?)\n```/)?.[1];
    const r = buildTopology(JSON.parse(json ?? 'null'));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const { snapshot } = runDesign(r.topology, DEFAULT_RUN);
    expect(snapshot.failuresByReason.throttled).toBeGreaterThan(0);
    expect(snapshot.failuresByReason.shed).toBe(0);
    expect(snapshot.nodes.db?.utilization).toBeLessThan(0.9);
  });
});
