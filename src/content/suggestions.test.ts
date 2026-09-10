import { describe, expect, it } from 'vitest';
import { suggestionFor } from './suggestions';
import type { NodeKind } from '../sim/types';

/**
 * The bar these guard is not "some text came back". It is that the two kinds
 * with a tempting-but-wrong obvious fix do not offer it: a db told to get
 * bigger, and a cache told to raise its hit rate, are both advice that moves
 * nothing for the node actually over its ceiling.
 */
describe('suggestionFor', () => {
  it('never tells a database to just get bigger', () => {
    const text = suggestionFor('db')!;
    expect(text).not.toMatch(/add (more )?(capacity|instances)/i);
    expect(text).toMatch(/reaching it/i);
  });

  it('tells a saturated cache that hit rate is not the lever', () => {
    // A hit and a miss both occupy a slot for serviceMs, so hit rate changes
    // what the cache forwards, never what it has to get through.
    const text = suggestionFor('cache')!;
    expect(text).toMatch(/hit rate will not help/i);
  });

  it('offers nothing for kinds with no throughput ceiling', () => {
    const kindsWithoutCeiling: NodeKind[] = [
      'queue',
      'autoscaler',
      'ratelimiter',
      'client',
    ];
    for (const kind of kindsWithoutCeiling) {
      expect(suggestionFor(kind)).toBeNull();
    }
  });

  it('has a suggestion for every kind with a throughput ceiling', () => {
    // Mirrors HAS_THROUGHPUT_CEILING in Inspector.tsx: the suggestion is only
    // ever reachable for these, because headroom is only defined for these.
    const kindsWithCeiling: NodeKind[] = [
      'lb',
      'service',
      'cache',
      'db',
      'worker',
      'objectstore',
      'coldstorage',
      'retryqueue',
      'transcoder',
      'edgecompute',
      'apigateway',
      'sidecar',
    ];
    for (const kind of kindsWithCeiling) {
      expect(suggestionFor(kind)).toBeTruthy();
    }
  });
});
