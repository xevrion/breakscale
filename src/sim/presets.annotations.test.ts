/**
 * Geometry rules for preset annotations.
 *
 * Annotation coordinates are written by hand in a source file and only make
 * sense once they are on screen. These assertions are the half that can be
 * checked without a browser: that no section overlaps another, that no note
 * sits on top of a node, and that every section frames whole nodes rather
 * than clipping them. Reading the numbers cannot catch these; a loop can.
 */

import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';
import { Engine } from './engine';
import { isNote, isSection } from './annotations';
import type { Annotation, Note, Section } from './annotations';
import { layoutNote } from '../components/annotationLayout';
import type { SimNode } from './types';

/** Canvas draws a node this size, anchored at (x, y). Mirrors Canvas.tsx. */
const NODE_W = 184;
const NODE_H = 88;

/**
 * The label plate renders ABOVE the frame, spanning y-28 to y-4, so a
 * section's true visual top is higher than its stored y. Clearance is
 * measured against that, not against the rectangle.
 */
const SEC_LABEL_H = 24;
const SEC_LABEL_GAP = 4;
const SECTION_VISUAL_TOP = SEC_LABEL_H + SEC_LABEL_GAP;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const nodeRect = (n: SimNode): Rect => ({ x: n.x, y: n.y, w: NODE_W, h: NODE_H });

const sectionRect = (s: Section): Rect => ({
  x: s.x,
  y: s.y,
  w: s.width,
  h: s.height,
});

/** A note's height is derived from its wrapped text, never stored. */
function noteRect(n: Note): Rect {
  const { height } = layoutNote(n.text, n.width, n.size);
  return { x: n.x, y: n.y, w: n.width, h: height };
}

/** Strict overlap: rectangles that merely share an edge do not count. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Minimum whitespace a note keeps from any frame or box, in world px. */
const NOTE_CLEARANCE = 16;

/** `r` expanded by `pad` on every side. */
function grow(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Every preset, paired with its annotations (most may still have none). */
const annotated = PRESETS.map(
  (p) => [p.id, p, (p.topology.annotations ?? []) as Annotation[]] as const,
);

describe.each(annotated)('preset %s annotations', (_id, preset, annotations) => {
  const sections = annotations.filter(isSection);
  const notes = annotations.filter(isNote);
  const nodes = preset.topology.nodes;

  it('gives every annotation a unique id', () => {
    const ids = annotations.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never overlaps one section with another', () => {
    for (let i = 0; i < sections.length; i += 1) {
      for (let j = i + 1; j < sections.length; j += 1) {
        const a = sections[i]!;
        const b = sections[j]!;
        expect(
          overlaps(sectionRect(a), sectionRect(b)),
          `section "${a.label}" overlaps "${b.label}"`,
        ).toBe(false);
      }
    }
  });

  it('leaves room above each section for its label plate', () => {
    // The plate is drawn above the frame, so it can collide with a node or
    // another section sitting immediately overhead even when the rectangles
    // themselves are clear of each other.
    for (const s of sections) {
      const plate: Rect = {
        x: s.x,
        y: s.y - SECTION_VISUAL_TOP,
        w: s.width,
        h: SEC_LABEL_H,
      };
      for (const n of nodes) {
        expect(
          overlaps(plate, nodeRect(n)),
          `label of "${s.label}" collides with node ${n.id}`,
        ).toBe(false);
      }
      for (const other of sections) {
        if (other.id === s.id) continue;
        expect(
          overlaps(plate, sectionRect(other)),
          `label of "${s.label}" collides with section "${other.label}"`,
        ).toBe(false);
      }
    }
  });

  it('frames whole nodes rather than clipping them', () => {
    // A node half inside a section silently does not travel when the section
    // is dragged, so a partial overlap is a bug rather than a style choice.
    for (const s of sections) {
      for (const n of nodes) {
        const r = nodeRect(n);
        if (!overlaps(sectionRect(s), r)) continue;
        expect(
          contains(sectionRect(s), r),
          `section "${s.label}" clips node ${n.id}`,
        ).toBe(true);
      }
    }
  });

  it('never puts a note on top of a node', () => {
    for (const note of notes) {
      for (const n of nodes) {
        expect(
          overlaps(noteRect(note), nodeRect(n)),
          `note "${note.text.slice(0, 32)}" overlaps node ${n.id}`,
        ).toBe(false);
      }
    }
  });

  it('keeps a readable gap between a note and a section', () => {
    // Not merely non-overlapping: a note four pixels off a frame reads as
    // touching it at any zoom, and the reader attaches the text to the wrong
    // group. Demand real whitespace instead.
    for (const note of notes) {
      for (const s of sections) {
        expect(
          overlaps(grow(noteRect(note), NOTE_CLEARANCE), sectionRect(s)),
          `note "${note.text.slice(0, 32)}" crowds section "${s.label}"`,
        ).toBe(false);
      }
    }
  });

  it('keeps a readable gap between a note and a node', () => {
    for (const note of notes) {
      for (const n of nodes) {
        expect(
          overlaps(grow(noteRect(note), NOTE_CLEARANCE), nodeRect(n)),
          `note "${note.text.slice(0, 32)}" crowds node ${n.id}`,
        ).toBe(false);
      }
    }
  });

  it('never puts a note on top of another note', () => {
    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        const a = notes[i]!;
        const b = notes[j]!;
        expect(
          overlaps(noteRect(a), noteRect(b)),
          `note "${a.text.slice(0, 24)}" overlaps "${b.text.slice(0, 24)}"`,
        ).toBe(false);
      }
    }
  });

  it('places every note on the 8px grid', () => {
    // A note floats in whitespace, so it can and should sit on the grid the
    // canvas snaps to; otherwise it visibly jumps the first time it is
    // dragged. Sections are exempt on purpose: ROW_PITCH is 130 and
    // COL_PITCH is 260, so the node grid is not a multiple of 8, and a
    // section that hugs its nodes cannot also be grid-aligned. Framing the
    // nodes correctly matters more than surviving a drag unmoved.
    for (const a of notes) {
      expect(a.x % 8, `${a.id} x`).toBe(0);
      expect(a.y % 8, `${a.id} y`).toBe(0);
    }
  });

  it('writes copy in the house style', () => {
    for (const a of annotations) {
      const text = a.kind === 'note' ? a.text : a.label;
      expect(text.includes('—'), `${a.id} uses an em dash`).toBe(false);
      expect(text.trim(), `${a.id} is blank`).not.toBe('');
    }
  });
});

describe('annotations are inert', () => {
  it('produces byte-identical snapshots with and without them', () => {
    // The engine must never read an annotation. This is the assertion that
    // makes "adding a note cannot change a number" a fact rather than a
    // claim: same seed, same topology, one with its annotations stripped,
    // and the two snapshots compared in full.
    for (const preset of PRESETS) {
      const withAnns = structuredClone(preset.topology);
      const without = structuredClone(preset.topology);
      delete (without as { annotations?: unknown }).annotations;

      const a = new Engine(withAnns, 42);
      const b = new Engine(without, 42);
      for (let i = 0; i < 200; i += 1) {
        a.advance(16);
        b.advance(16);
      }
      expect(JSON.stringify(a.snapshot()), preset.id).toBe(
        JSON.stringify(b.snapshot()),
      );
    }
  });
});
