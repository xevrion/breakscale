/**
 * The shade palette: indices, wrapping, and the guarantee that a shade is
 * never a colour.
 *
 * The point of an index is that the stylesheet resolves it per theme, so a
 * section picked in the light theme is still readable in the dark one. A hex
 * stored on the annotation would defeat that, which is why the model has no
 * way to express one for a preset.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SECTION_TONE_COUNT, sanitizeAnnotations } from './sim/annotations';
import { PRESETS } from './sim/presets';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

const section = (tone: unknown) => [
  { id: 's', kind: 'section', label: 'T', x: 0, y: 0, width: 200, height: 120, tone },
];

describe('shade palette', () => {
  it('defines a stylesheet trio for every index the model allows', () => {
    // An index with no rule renders an unstyled frame, so the two counts
    // have to agree. This is the assertion that catches someone raising
    // SECTION_TONE_COUNT without adding the CSS.
    for (let i = 0; i < SECTION_TONE_COUNT; i += 1) {
      for (const role of ['fill', 'line', 'ink']) {
        expect(css.includes(`--ann-${i}-${role}:`), `--ann-${i}-${role}`).toBe(true);
      }
    }
  });

  it('has a canvas rule for every index', () => {
    const canvasCss = readFileSync(
      new URL('./components/Canvas.css', import.meta.url),
      'utf8',
    );
    for (let i = 0; i < SECTION_TONE_COUNT; i += 1) {
      expect(
        canvasCss.includes(`.cv-section[data-tone='${i}']`),
        `data-tone ${i}`,
      ).toBe(true);
    }
  });

  it('wraps an out-of-range index back into the palette', () => {
    // Wrapped rather than clamped, so a design saved when the palette was a
    // different size still lands on a real shade instead of piling every
    // stale index onto the last one.
    for (const [given, want] of [
      [SECTION_TONE_COUNT, 0],
      [SECTION_TONE_COUNT + 3, 3],
      [-1, SECTION_TONE_COUNT - 1],
      [-SECTION_TONE_COUNT - 1, SECTION_TONE_COUNT - 1],
    ]) {
      expect(sanitizeAnnotations(section(given))[0], `tone ${given}`).toMatchObject({
        tone: want,
      });
    }
  });

  it('falls back to a real shade when the index is not a number', () => {
    for (const junk of ['red', null, undefined, NaN, {}]) {
      const out = sanitizeAnnotations(section(junk))[0] as { tone: number };
      expect(Number.isInteger(out.tone)).toBe(true);
      expect(out.tone).toBeGreaterThanOrEqual(0);
      expect(out.tone).toBeLessThan(SECTION_TONE_COUNT);
    }
  });

  it('keeps every preset section inside the palette', () => {
    for (const p of PRESETS) {
      for (const a of p.topology.annotations ?? []) {
        if (a.kind !== 'section') continue;
        expect(a.tone, `${p.id} / ${a.label}`).toBeGreaterThanOrEqual(0);
        expect(a.tone, `${p.id} / ${a.label}`).toBeLessThan(SECTION_TONE_COUNT);
      }
    }
  });

  it('stores no literal colour on any preset annotation', () => {
    // Presets must stay theme-agnostic. A hex here would be a shade that
    // cannot follow the theme, which is the whole thing `tone` avoids.
    for (const p of PRESETS) {
      for (const a of p.topology.annotations ?? []) {
        expect(a, `${p.id} / ${a.id}`).not.toHaveProperty('color');
      }
    }
  });
});
