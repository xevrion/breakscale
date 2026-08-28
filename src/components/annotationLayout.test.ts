import { describe, expect, it } from 'vitest';

/**
 * The pure geometry behind canvas annotations: note text wrapping (whose
 * measured widths drive both the SVG rendering and the marquee hit test)
 * and section resizing (whose clamps are what keep a frame from inverting
 * through its own far edge).
 *
 * These run in the node environment, where textMetrics has no canvas and
 * degrades to its deterministic per-character estimate; the invariants
 * pinned here (line count monotonicity, containment, clamping) hold under
 * any monotonic measure, which is exactly why they are the things asserted
 * rather than pixel-exact wrap points.
 */
import {
  NOTE_SIZES,
  TAB,
  TAB_SIZE,
  applyTab,
  layoutNote,
  noteStyle,
  resizeRect,
  handleAnchor,
  wrapText,
} from './annotationLayout';
import { measureText } from './textMetrics';

const style = noteStyle('md');

describe('wrapText', () => {
  it('keeps short text on one line', () => {
    expect(wrapText('hello world', 10_000, style)).toEqual(['hello world']);
  });

  it('honours explicit newlines, including empty lines', () => {
    expect(wrapText('a\n\nb', 10_000, style)).toEqual(['a', '', 'b']);
  });

  it('wraps on spaces so every line fits the width', () => {
    const text = 'one two three four five six seven eight nine ten';
    const width = measureText('one two three', style) + 1;
    const lines = wrapText(text, width, style);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureText(line, style)).toBeLessThanOrEqual(width);
    }
    // Nothing is lost or reordered by the wrap.
    expect(lines.join(' ').split(' ').filter(Boolean)).toEqual(text.split(' '));
  });

  it('character-breaks a single word wider than the note', () => {
    const word = 'x'.repeat(200);
    const width = measureText('x'.repeat(20), style);
    const lines = wrapText(word, width, style);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureText(line, style)).toBeLessThanOrEqual(width);
    }
    expect(lines.join('')).toBe(word);
  });
});

describe('layoutNote', () => {
  it('derives height from the wrapped line count', () => {
    const l = layoutNote('a\nb\nc', 10_000, 'md');
    expect(l.lines).toHaveLength(3);
    expect(l.height).toBe(3 * NOTE_SIZES.md.line);
  });

  it('never reports less than one line of height', () => {
    const l = layoutNote('a', 10_000, 'lg');
    expect(l.height).toBe(NOTE_SIZES.lg.line);
  });

  it('uses the size-specific metrics', () => {
    expect(layoutNote('a', 100, 'sm').font).toBe(NOTE_SIZES.sm.font);
    expect(layoutNote('a', 100, 'lg').lineH).toBe(NOTE_SIZES.lg.line);
  });
});

describe('resizeRect', () => {
  const origin = { x: 100, y: 200, w: 300, h: 240 };
  const id = (v: number) => v;
  const snap8 = (v: number) => Math.round(v / 8) * 8;

  it('a se corner drag moves only the far edges', () => {
    const r = resizeRect(origin, 'se', 40, 24, id, 120, 90);
    expect(r).toEqual({ x: 100, y: 200, w: 340, h: 264 });
  });

  it('a nw corner drag moves only the near edges', () => {
    const r = resizeRect(origin, 'nw', 16, 8, id, 120, 90);
    expect(r).toEqual({ x: 116, y: 208, w: 284, h: 232 });
  });

  it('a side handle moves one axis and leaves the other alone', () => {
    const r = resizeRect(origin, 'e', 50, 999, id, 120, 90);
    expect(r).toEqual({ x: 100, y: 200, w: 350, h: 240 });
  });

  it('clamps to the minimum by pinning the moving edge', () => {
    // Drag the east edge far past the west edge: the frame stops at the
    // minimum with its static (west) edge untouched, never inverting.
    const r = resizeRect(origin, 'e', -1000, 0, id, 120, 90);
    expect(r).toEqual({ x: 100, y: 200, w: 120, h: 240 });
    // And from the west, the EAST edge is the anchor.
    const r2 = resizeRect(origin, 'w', 1000, 0, id, 120, 90);
    expect(r2.x + r2.w).toBe(origin.x + origin.w);
    expect(r2.w).toBe(120);
  });

  it('snaps only the moving edges', () => {
    const r = resizeRect(origin, 'se', 3, 3, snap8, 120, 90);
    // Static corner untouched even by a snap that would move it.
    expect(r.x).toBe(100);
    expect(r.y).toBe(200);
    // Moving edges land on the grid.
    expect((r.x + r.w) % 8).toBe(0);
    expect((r.y + r.h) % 8).toBe(0);
  });
});

describe('handleAnchor', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };

  it('places corners and side midpoints', () => {
    expect(handleAnchor(rect, 'nw')).toEqual({ x: 0, y: 0 });
    expect(handleAnchor(rect, 'se')).toEqual({ x: 100, y: 50 });
    expect(handleAnchor(rect, 'n')).toEqual({ x: 50, y: 0 });
    expect(handleAnchor(rect, 'w')).toEqual({ x: 0, y: 25 });
  });
});

describe('applyTab', () => {
  it('indents at the caret rather than moving focus', () => {
    // Tab in a note is formatting, not navigation. The alternative is that a
    // half-written note commits itself and the caret lands on a toolbar
    // button, which is what a bare textarea does and is always wrong here.
    expect(applyTab({ value: 'abc', start: 0, end: 0 }, false)).toEqual({
      value: `${TAB}abc`,
      start: TAB_SIZE,
      end: TAB_SIZE,
    });
  });

  it('replaces the selection rather than inserting beside it', () => {
    expect(applyTab({ value: 'abcdef', start: 1, end: 4 }, false)).toEqual({
      value: `a${TAB}ef`,
      start: 1 + TAB_SIZE,
      end: 1 + TAB_SIZE,
    });
  });

  it('outdents only the caret line, and only its leading spaces', () => {
    const value = 'one\n    two';
    // Caret sits inside the second line's indent.
    const out = applyTab({ value, start: 8, end: 8 }, true);
    expect(out.value).toBe('one\n  two');
    expect(out.start).toBe(8 - TAB_SIZE);
  });

  it('returns the state untouched when there is nothing to outdent', () => {
    // Identity, so the caller can skip pushing a draft that did not change.
    const state = { value: 'flush left', start: 4, end: 4 };
    expect(applyTab(state, true)).toBe(state);
  });

  it('outdents a partial indent without eating the text', () => {
    // One space where TAB_SIZE is two: remove the one that is there, and
    // stop, rather than running on into the word.
    const out = applyTab({ value: ' x', start: 2, end: 2 }, true);
    expect(out.value).toBe('x');
    expect(out.start).toBe(1);
  });

  it('indents the first line correctly when it is not the first line', () => {
    const value = 'a\nb';
    expect(applyTab({ value, start: 3, end: 3 }, false).value).toBe(`a\nb${TAB}`);
  });

  it('never inserts a literal tab', () => {
    // SVG text has no tab stops: a real \t measures as nothing and would be
    // an indent that exists in the model and is invisible on the canvas.
    const out = applyTab({ value: '', start: 0, end: 0 }, false);
    expect(out.value.includes('\t')).toBe(false);
    expect(out.value).toBe(TAB);
  });
});
