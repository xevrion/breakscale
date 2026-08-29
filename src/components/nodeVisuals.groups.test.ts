import { describe, expect, it } from 'vitest';
import { KIND_GROUPS, KIND_ICON, groupOfKind } from './nodeVisuals';
import type { NodeKind } from '../sim/types';

/**
 * Guards the taxonomy, which two surfaces now read.
 *
 * KIND_GROUPS decides both what the rail lists and what the canvas ledger
 * counts. A kind missing from it is silent in each: the rail simply does not
 * offer it, and the ledger's breakdown quietly sums to less than the total
 * beside it. Nothing in a typecheck or a build says so, because a kind not
 * mentioned anywhere is not a type error.
 *
 * KIND_ICON is used as the roster of kinds rather than a hand-written list,
 * because it is a `Record<NodeKind, ...>` and so the typechecker already
 * forces it to be exhaustive. Adding a kind therefore fails here until it is
 * given a group, which is the point.
 */
const ALL_KINDS = Object.keys(KIND_ICON) as NodeKind[];

describe('the kind taxonomy', () => {
  it('gives every kind a group', () => {
    const ungrouped = ALL_KINDS.filter((k) => groupOfKind(k) === undefined);
    expect(ungrouped).toEqual([]);
  });

  it('puts no kind in two groups', () => {
    const seen = new Map<NodeKind, string[]>();
    for (const group of KIND_GROUPS) {
      for (const kind of group.kinds) {
        seen.set(kind, [...(seen.get(kind) ?? []), group.id]);
      }
    }
    const duplicated = [...seen.entries()].filter(([, groups]) => groups.length > 1);
    expect(duplicated).toEqual([]);
  });

  it('lists no kind that does not exist', () => {
    const known = new Set<string>(ALL_KINDS);
    const unknown = KIND_GROUPS.flatMap((g) => g.kinds).filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  /**
   * The ledger prints `id`, not `title`, because "specialised stores" does not
   * fit a corner that also holds two totals and a clock. That only reads as
   * English while every id stays one lowercase word.
   */
  it('keeps every id printable as a name', () => {
    for (const group of KIND_GROUPS) {
      expect(group.id).toMatch(/^[a-z]+$/);
    }
  });
});
