// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SAVED,
  deleteDesign,
  listDesigns,
  renameDesign,
  saveDesign,
} from './savedDesigns';
import { defaultConfig } from './sim/presets';
import type { NodeKind, Topology } from './sim/types';

/**
 * A row this build cannot open must survive a write.
 *
 * Every mutation here is read, change, write, and the read drops what it
 * cannot parse. That is right for display and wrong for storage: a row dropped
 * on the way in used to be a row deleted on the way out, so saving an
 * unrelated design erased someone else's permanently, with nothing said.
 *
 * The rows used below carry duplicate node ids, which is the shape a
 * palette-add produces after a reload, so this is the case that actually
 * happens rather than a hand-corrupted fixture.
 */

const KEY = 'breakscale.designs.v1';

const node = (id: string, kind: NodeKind) => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  config: defaultConfig(kind),
});

/** Rejected by isTopology: two nodes share an id. */
const unreadable = {
  nodes: [node('client', 'client'), node('cache-1', 'cache'), node('cache-1', 'cache')],
  edges: [],
} as unknown as Topology;

const healthy: Topology = { nodes: [node('client', 'client')], edges: [] };

function seed(rows: unknown[]): void {
  localStorage.setItem(KEY, JSON.stringify(rows));
}

const rawRows = (): Record<string, unknown>[] =>
  JSON.parse(localStorage.getItem(KEY) ?? '[]') as Record<string, unknown>[];

const rawNames = (): unknown[] => rawRows().map((e) => e.name);

beforeEach(() => {
  localStorage.clear();
  seed([
    { id: 'a', name: 'Week 3 coursework', topology: unreadable, savedAt: 1 },
    { id: 'b', name: 'Fine one', topology: healthy, savedAt: 2 },
  ]);
});

describe('a design this build cannot open', () => {
  it('is kept off the shelf, because it cannot be shown', () => {
    expect(listDesigns().map((d) => d.name)).toEqual(['Fine one']);
  });

  it('survives an unrelated save', () => {
    expect(saveDesign('Something new', healthy).ok).toBe(true);
    expect(rawNames()).toContain('Week 3 coursework');
  });

  it('survives deleting a different design', () => {
    deleteDesign('b');
    expect(rawNames()).toContain('Week 3 coursework');
  });

  it('survives renaming a different design', () => {
    expect(renameDesign('b', 'Renamed')).toBe(true);
    expect(rawNames()).toContain('Week 3 coursework');
  });

  it('survives being saved over by name, which only replaces what it matches', () => {
    saveDesign('Fine one', healthy);
    expect(rawNames()).toContain('Week 3 coursework');
    expect(listDesigns()).toHaveLength(1);
  });

  it('comes back byte for byte, so a later build can still open it', () => {
    const before = rawRows().find((e) => e.id === 'a');
    saveDesign('Something new', healthy);
    const after = rawRows().find((e) => e.id === 'a');
    expect(after).toEqual(before);
  });
});

describe('the readable half is unaffected', () => {
  it('still saves, renames and deletes normally', () => {
    expect(saveDesign('Second', healthy).ok).toBe(true);
    expect(
      listDesigns()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['Fine one', 'Second']);
    expect(renameDesign('b', 'Renamed')).toBe(true);
    expect(
      listDesigns()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['Renamed', 'Second']);
    deleteDesign('b');
    expect(listDesigns().map((d) => d.name)).toEqual(['Second']);
  });

  it('still evicts the oldest at the cap, counting only what it can open', () => {
    localStorage.clear();
    seed([{ id: 'x', name: 'unopenable', topology: unreadable, savedAt: 0 }]);
    for (let i = 0; i < MAX_SAVED; i += 1) saveDesign(`d${i}`, healthy);

    expect(listDesigns()).toHaveLength(MAX_SAVED);
    const last = saveDesign('one more', healthy);
    expect(last.ok && last.evicted).toBe('d0');
    expect(listDesigns()).toHaveLength(MAX_SAVED);
    expect(rawNames()).toContain('unopenable');
  });
});

describe('rows nobody can open do not grow without limit', () => {
  it('keeps at most MAX_SAVED of them', () => {
    localStorage.clear();
    seed(
      Array.from({ length: MAX_SAVED + 15 }, (_, i) => ({
        id: `u${i}`,
        name: `u${i}`,
        topology: unreadable,
        savedAt: i,
      })),
    );
    saveDesign('mine', healthy);
    expect(rawRows()).toHaveLength(MAX_SAVED + 1);
  });
});
