import { describe, expect, it } from 'vitest';
import { GLOSSARY, GLOSSARY_BY_ID, searchGlossary } from './glossary';

/**
 * The glossary is the product's teaching voice, so its house style is enforced
 * here rather than left to review. A definition that quietly drifts into
 * jargon, or a cross-reference that points nowhere, undoes the reason the
 * tooltips exist.
 */

describe('glossary data', () => {
  it('has no duplicate ids', () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every cross-reference', () => {
    const broken: string[] = [];
    for (const entry of GLOSSARY) {
      for (const ref of entry.see ?? []) {
        if (!GLOSSARY_BY_ID.has(ref)) broken.push(`${entry.id} -> ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps the short definition short and unpunctuated', () => {
    for (const entry of GLOSSARY) {
      expect(entry.short.length, `${entry.id} short`).toBeLessThanOrEqual(60);
      expect(entry.short.endsWith('.'), `${entry.id} short ends with a period`).toBe(
        false,
      );
    }
  });

  it('explains why every term matters', () => {
    for (const entry of GLOSSARY) {
      // A bare definition is trivia. The `why` is the part that teaches, so it
      // has to be a real sentence rather than a placeholder.
      expect(entry.why.length, `${entry.id} why`).toBeGreaterThan(40);
    }
  });

  it('uses no em dashes', () => {
    const offenders = GLOSSARY.filter(
      (e) => e.short.includes('—') || e.why.includes('—'),
    ).map((e) => e.id);
    expect(offenders).toEqual([]);
  });
});

describe('glossary search', () => {
  it('ranks an exact term above an incidental mention', () => {
    // Typing "p99" must return p99 itself, not the several entries whose
    // explanations happen to discuss it.
    expect(searchGlossary('p99')[0].id).toBe('p99');
    expect(searchGlossary('rps')[0].id).toBe('rps');
  });

  it('matches aliases', () => {
    expect(searchGlossary('median')[0].id).toBe('p50');
    expect(searchGlossary('tail latency')[0].id).toBe('p99');
  });

  it('returns everything for an empty query', () => {
    expect(searchGlossary('').length).toBe(GLOSSARY.length);
    expect(searchGlossary('   ').length).toBe(GLOSSARY.length);
  });

  it('returns nothing for a term it does not know', () => {
    expect(searchGlossary('zzzzznotarealterm')).toEqual([]);
  });
});
