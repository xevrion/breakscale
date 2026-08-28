/**
 * Colour and font validation on the annotation trust boundary.
 *
 * A colour reaches the DOM as a style value, and it arrives from a share
 * link, a pasted design or an imported file. Everything hostile here is a
 * string someone could put in a URL, so these are the cases that matter far
 * more than the happy path.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeAnnotations } from './annotations';

const noteWith = (extra: Record<string, unknown>) => [
  { id: 'n1', kind: 'note', text: 'hello', x: 0, y: 0, width: 200, ...extra },
];

const sectionWith = (extra: Record<string, unknown>) => [
  {
    id: 's1',
    kind: 'section',
    label: 'Tier',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    tone: 1,
    ...extra,
  },
];

const firstNote = (input: unknown[]) => sanitizeAnnotations(input)[0];

describe('annotation colour', () => {
  it.each([
    ['#fff', '#fff'],
    ['#1a2b3c', '#1a2b3c'],
    ['#1a2b3cdd', '#1a2b3cdd'],
    ['rgb(12, 34, 56)', 'rgb(12, 34, 56)'],
    ['rgba(12,34,56,0.5)', 'rgba(12,34,56,0.5)'],
    ['hsl(210 40% 50%)', 'hsl(210 40% 50%)'],
    ['tomato', 'tomato'],
  ])('accepts %s', (input, expected) => {
    expect(firstNote(noteWith({ color: input }))).toMatchObject({ color: expected });
  });

  it.each([
    ['red; position: fixed'],
    ['url(https://example.com/x.png)'],
    ['expression(alert(1))'],
    ['rgb(0,0,0) !important'],
    ['</style><script>alert(1)</script>'],
    ['var(--secret)'],
    ['#12'],
    ['#1234567'],
    [''],
    ['   '],
  ])('drops hostile value %s rather than passing it through', (input) => {
    expect(firstNote(noteWith({ color: input }))).not.toHaveProperty('color');
  });

  it('drops a colour that is not a string', () => {
    expect(firstNote(noteWith({ color: 0xff0000 }))).not.toHaveProperty('color');
  });

  it('drops an absurdly long value before matching it', () => {
    expect(firstNote(noteWith({ color: `#${'a'.repeat(200)}` }))).not.toHaveProperty(
      'color',
    );
  });

  it('applies the same rule to a section', () => {
    expect(sanitizeAnnotations(sectionWith({ color: '#0a0a0a' }))[0]).toMatchObject({
      color: '#0a0a0a',
    });
    expect(
      sanitizeAnnotations(sectionWith({ color: 'red;evil' }))[0],
    ).not.toHaveProperty('color');
  });

  it('leaves an annotation with no colour following the theme', () => {
    expect(firstNote(noteWith({}))).not.toHaveProperty('color');
  });
});

describe('annotation font', () => {
  it.each(['sans', 'hand', 'serif', 'mono'])('accepts %s', (f) => {
    expect(firstNote(noteWith({ font: f }))).toMatchObject({ font: f });
  });

  it('drops a family we have no measurable stack for', () => {
    // "marker" was offered once and removed: it resolved to the same face as
    // serif on a typical machine, so the picker showed two identical
    // buttons. A design saved while it existed must not resurrect it.
    expect(firstNote(noteWith({ font: 'marker' }))).not.toHaveProperty('font');
    // Painting in a face we cannot measure wraps the note to the wrong width.
    expect(firstNote(noteWith({ font: 'Papyrus' }))).not.toHaveProperty('font');
    expect(firstNote(noteWith({ font: 42 }))).not.toHaveProperty('font');
  });
});
