import { describe, expect, it } from 'vitest';
import { defaultConfig } from './presets';
import { suggestionFor } from './suggestions';
import type { NodeKind } from './types';

describe('suggestionFor', () => {
  it('points a cold cache at hit rate before capacity', () => {
    const cfg = { ...defaultConfig('cache'), hitRate: 0.4 };
    expect(suggestionFor('cache', cfg)).toMatch(/hit rate/i);
  });

  it('points a well-hit cache at capacity instead', () => {
    const cfg = { ...defaultConfig('cache'), hitRate: 0.95 };
    expect(suggestionFor('cache', cfg)).toMatch(/instances|capacity/i);
  });

  it('never tells a database to just get bigger', () => {
    const cfg = defaultConfig('db');
    const text = suggestionFor('db', cfg)!;
    expect(text).not.toMatch(/add (more )?(capacity|instances)/i);
  });

  it('offers nothing for kinds with no throughput ceiling', () => {
    const kindsWithoutCeiling: NodeKind[] = [
      'queue',
      'autoscaler',
      'ratelimiter',
      'client',
    ];
    for (const kind of kindsWithoutCeiling) {
      expect(suggestionFor(kind, defaultConfig(kind))).toBeNull();
    }
  });

  it('has a suggestion for every kind with a throughput ceiling', () => {
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
      expect(suggestionFor(kind, defaultConfig(kind))).toBeTruthy();
    }
  });
});
