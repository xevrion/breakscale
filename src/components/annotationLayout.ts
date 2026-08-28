/**
 * Pure geometry for canvas annotations: note text layout and section resize.
 *
 * Kept out of Canvas.tsx for the same reason pointerInput.ts is: everything
 * here is plain values in, plain values out, so the maths that decides where
 * a note wraps and where a resized edge lands can be unit tested without a
 * DOM. Canvas.tsx consumes these; it does not restate them.
 */

import { baselineIn, measureText } from './textMetrics';
import type { TextStyle } from './textMetrics';
import type { AnnotationFont, Note } from '../sim/annotations';

/** Drag payload type for the palette's annotation rows. */
export const ANN_DND_MIME = 'application/x-breakscale-annotation';

/**
 * The text a freshly placed note is born with. Shared by the shell (which
 * creates the note) and the canvas (which opens the editor over it with
 * this draft pre-selected), so the two can never disagree about what the
 * student is replacing.
 */
export const NEW_NOTE_TEXT = 'Note';

/** Default section frame, in world px. Grid multiples of the canvas's 8px. */
export const NEW_SECTION_W = 320;
export const NEW_SECTION_H = 224;

/**
 * The three note scales. `sm` is an aside next to one component, `md` is
 * ordinary commentary, `lg` is a diagram heading. Line heights are fixed
 * pixel values rather than a ratio so the SVG rendering and the in-place
 * editor (an HTML textarea with line-height set to exactly this) can agree
 * to the pixel about where every line sits.
 */
export interface NoteSizeSpec {
  font: number;
  line: number;
  weight: number;
}

export const NOTE_SIZES: Record<Note['size'], NoteSizeSpec> = {
  sm: { font: 12, line: 17, weight: 450 },
  md: { font: 16, line: 22, weight: 450 },
  lg: { font: 24, line: 32, weight: 550 },
};

/**
 * The text style a note is measured and painted in.
 *
 * The family is part of the style rather than fixed, because the wrap has to
 * happen in the same face the browser will paint: a hand-drawn face is wider
 * per character than the UI sans, so measuring in sans and painting in hand
 * overruns the note's stored width.
 */
export function noteStyle(size: Note['size'], font?: AnnotationFont): TextStyle {
  const spec = NOTE_SIZES[size];
  return { size: spec.font, weight: spec.weight, family: font ?? 'sans' };
}

/**
 * Break `line` against `width` until the remainder fits, pushing each full
 * slice. Only reached by a single word wider than the note, where wrapping
 * on spaces has nothing left to give; a character break keeps the text
 * inside the stored width instead of painting out of the note's bounds.
 */
function breakOverflow(
  line: string,
  width: number,
  style: TextStyle,
  out: string[],
): string {
  while (line.length > 1 && measureText(line, style) > width) {
    let cut = line.length - 1;
    while (cut > 1 && measureText(line.slice(0, cut), style) > width) cut -= 1;
    out.push(line.slice(0, cut));
    line = line.slice(cut);
  }
  return line;
}

/**
 * Word-wrap `text` to `width` CSS px in `style`, honouring explicit
 * newlines. Widths come from the same measureText cache the node labels
 * use, so the wrap agrees with what the browser will actually paint.
 */
export function wrapText(text: string, width: number, style: TextStyle): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const cand = line === '' ? word : `${line} ${word}`;
      if (line !== '' && measureText(cand, style) > width) {
        lines.push(line);
        line = breakOverflow(word, width, style, lines);
      } else {
        line = breakOverflow(cand, width, style, lines);
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface NoteLayout {
  lines: string[];
  font: number;
  lineH: number;
  weight: number;
  /**
   * Total height in world px. DERIVED from the text on every call, never
   * stored: the model deliberately holds no height, so it can never go
   * stale against edited content.
   */
  height: number;
  /** y of the first line's baseline, matching a text box of lineH boxes. */
  baseline: number;
}

export function layoutNote(
  text: string,
  width: number,
  size: Note['size'],
  font?: AnnotationFont,
): NoteLayout {
  const spec = NOTE_SIZES[size];
  const style = noteStyle(size, font);
  const lines = wrapText(text, width, style);
  return {
    lines,
    font: spec.font,
    lineH: spec.line,
    weight: spec.weight,
    height: Math.max(spec.line, lines.length * spec.line),
    // Centre the glyphs in their line box the way CSS line-height does, from
    // the face's OWN measured ascent and descent. A fixed 0.8em was close
    // enough while every note was set in the UI sans; Caveat's box is a tenth
    // of an em shallower, which is a visible drop at the `lg` size.
    baseline: baselineIn(spec.line, style),
  };
}

/* ------------------------------------------------------------------ *
 * Section resize
 * ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Compass handle names; a corner moves two edges, a side moves one. */
export type ResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_DIRS: readonly ResizeDir[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

/**
 * Apply a drag of (dx, dy) world px from the handle `dir` to `origin`.
 *
 * Only the edges the handle owns move; each moving edge is passed through
 * `place` (the grid snap, or Math.round when the snap is bypassed), so the
 * two static edges never shift under a resize. Minimums are enforced by
 * pinning the MOVING edge against the static one, which means a section
 * dragged through its own far edge stops at the minimum instead of
 * inverting.
 */
export function resizeRect(
  origin: Rect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  place: (v: number) => number,
  minW: number,
  minH: number,
): Rect {
  let x0 = origin.x;
  let y0 = origin.y;
  let x1 = origin.x + origin.w;
  let y1 = origin.y + origin.h;
  if (dir.includes('w')) x0 = place(origin.x + dx);
  if (dir.includes('e')) x1 = place(origin.x + origin.w + dx);
  if (dir.includes('n')) y0 = place(origin.y + dy);
  if (dir.includes('s')) y1 = place(origin.y + origin.h + dy);
  if (x1 - x0 < minW) {
    if (dir.includes('w')) x0 = x1 - minW;
    else x1 = x0 + minW;
  }
  if (y1 - y0 < minH) {
    if (dir.includes('n')) y0 = y1 - minH;
    else y1 = y0 + minH;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Handle anchor position on a rect, in world px. */
export function handleAnchor(rect: Rect, dir: ResizeDir): { x: number; y: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const x = dir.includes('w') ? rect.x : dir.includes('e') ? rect.x + rect.w : cx;
  const y = dir.includes('n') ? rect.y : dir.includes('s') ? rect.y + rect.h : cy;
  return { x, y };
}
