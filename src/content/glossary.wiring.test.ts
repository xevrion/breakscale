import { describe, expect, it } from 'vitest';
import { GLOSSARY_BY_ID } from './glossary';
import { KIND_TERM } from '../components/nodeVisuals';

/**
 * Guards the JOIN between the interface and the glossary.
 *
 * `Term` renders its children unchanged when handed an id the glossary does
 * not know. That is the right runtime behaviour — a typo must never blank out
 * a number a student is reading — but it makes a broken wiring completely
 * silent: the label simply stops being explainable, and nothing in a
 * typecheck, a build or a screenshot says so.
 *
 * This is not hypothetical. These assertions were written after eight
 * glossary entries were lost to a concurrent edit. The app still compiled,
 * still built, still rendered, and five labels had quietly lost their
 * explanations. Only reading the live DOM caught it.
 *
 * Vite's glob import is used rather than `node:fs` so the test runs under the
 * browser-targeted tsconfig without pulling in Node type definitions, which
 * would mean a new dependency.
 */

/** Every component source, as raw text. */
const SOURCES = import.meta.glob('../components/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Literal ids handed to a <Term>, a `term=` prop, or a `term:` field. */
function referencedIds(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const patterns = [
    /<Term\s+id="([a-z0-9-]+)"/g,
    /\bterm="([a-z0-9-]+)"/g,
    /\bterm:\s*'([a-z0-9-]+)'/g,
    /\bcaptionTerm="([a-z0-9-]+)"/g,
    /\bunitTerm="([a-z0-9-]+)"/g,
  ];

  for (const [path, src] of Object.entries(SOURCES)) {
    if (path.includes('.test.')) continue;
    const name = path.split('/').pop() ?? path;
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const id = m[1]!;
        const where = found.get(id);
        if (where) where.add(name);
        else found.set(id, new Set([name]));
      }
    }
  }
  return found;
}

describe('glossary wiring', () => {
  it('resolves every term id the interface references', () => {
    const broken: string[] = [];
    for (const [id, files] of referencedIds()) {
      if (!GLOSSARY_BY_ID.has(id)) {
        broken.push(`${id} (used in ${[...files].join(', ')})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('scans a meaningful number of references', () => {
    // A guard on the guard: if a refactor changed the shape of the call
    // sites, the scan above would find nothing and pass vacuously.
    expect(referencedIds().size).toBeGreaterThan(30);
  });

  it('gives every component kind an explanation', () => {
    const broken = Object.entries(KIND_TERM).filter(
      ([, id]) => !GLOSSARY_BY_ID.has(id),
    );
    expect(broken).toEqual([]);
  });
});
