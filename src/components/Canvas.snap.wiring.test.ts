import { describe, expect, it } from 'vitest';

/**
 * Guards the JOIN between the snap preference and the drags that obey it.
 *
 * `snapToGrid` spent its whole life as decoration: stored, defaulted,
 * sanitised on read and offered as a switch, while every drag picked its
 * rounding from the Ctrl key alone. Nothing failed, because a preference
 * nobody reads is not a type error, and the tests that mattered never
 * mounted the canvas.
 *
 * So the assertion is on the source rather than on behaviour: any placement
 * decision that keys on Ctrl WITHOUT going through snapsToGrid() has
 * reintroduced exactly that bug, and it would be silent again. Raw source via
 * Vite's glob for the same reason glossary.wiring.test.ts uses it, which is
 * that it runs under the browser tsconfig without pulling in node types.
 */
const SOURCES = import.meta.glob('./Canvas.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const CANVAS = Object.values(SOURCES)[0] ?? '';

/** Every line that decides where a gesture puts something. */
const PLACEMENT_LINES = CANVAS.split('\n').filter((line) =>
  /\bconst place\b/.test(line),
);

describe('the snap preference is actually wired', () => {
  it('finds the placement decisions at all', () => {
    // A rename that emptied this list would make every assertion below pass
    // by vacuum, which is the one way this test could rot into a no-op.
    expect(PLACEMENT_LINES.length).toBeGreaterThan(0);
  });

  it('routes every placement decision through snapsToGrid', () => {
    const bypassing = PLACEMENT_LINES.filter((l) => !l.includes('snapsToGrid'));
    expect(bypassing).toEqual([]);
  });

  it('never decides on the modifier alone', () => {
    const ctrlOnly = PLACEMENT_LINES.filter(
      (l) => /ctrlKey/.test(l) && !l.includes('snapsToGrid'),
    );
    expect(ctrlOnly).toEqual([]);
  });
});
