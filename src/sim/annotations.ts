/**
 * Canvas annotations: notes and sections.
 *
 * These are documentation, not simulation. The engine never sees them, they
 * carry no traffic and they cannot fail. They exist so a thirty-node diagram
 * of a real company's architecture can say which part is the edge tier and
 * which part is the async pipeline, and so a design shared as a link arrives
 * already explained.
 *
 * They live in their own module rather than in types.ts because the engine
 * has no business knowing about them. `Topology` gains one optional field and
 * nothing else changes; every existing topology stays valid.
 */

/** A free-standing piece of text placed anywhere on the canvas. */
export interface Note {
  id: string;
  kind: 'note';
  text: string;
  x: number;
  y: number;
  /**
   * Wrap width in world units. Height follows from the text, so a note never
   * has a stale height stored against content that has since changed.
   */
  width: number;
  /**
   * Relative size. Notes serve two different jobs: a heading that titles a
   * whole diagram, and a small aside next to one component. One scale would
   * make one of those wrong.
   */
  size: 'sm' | 'md' | 'lg';
}

/**
 * A labelled rectangle drawn behind a group of nodes, to mark a tier.
 *
 * Purely spatial: a section does not own the nodes inside it and nothing is
 * reparented. A node is "in" a section only in the sense that it happens to
 * sit within its bounds, which means dragging a node in or out needs no
 * bookkeeping and can never corrupt the topology.
 */
export interface Section {
  id: string;
  kind: 'section';
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Index into the section palette rather than a raw colour, so sections
   * restyle with the theme instead of pinning a hex value into saved designs
   * that would then clash after any redesign.
   */
  tone: number;
}

export type Annotation = Note | Section;

/** Sections render behind nodes; notes render in front. */
export function isSection(a: Annotation): a is Section {
  return a.kind === 'section';
}

export function isNote(a: Annotation): a is Note {
  return a.kind === 'note';
}

export const NOTE_DEFAULT_WIDTH = 220;
export const SECTION_MIN_WIDTH = 120;
export const SECTION_MIN_HEIGHT = 90;

/** How many tones the section palette offers. Kept small on purpose. */
export const SECTION_TONE_COUNT = 6;

let counter = 0;

export function makeNote(x: number, y: number, text = 'Note'): Note {
  counter += 1;
  return {
    id: `note-${counter}`,
    kind: 'note',
    text,
    x,
    y,
    width: NOTE_DEFAULT_WIDTH,
    size: 'md',
  };
}

export function makeSection(
  x: number,
  y: number,
  width = 320,
  height = 220,
  label = 'Section',
): Section {
  counter += 1;
  return {
    id: `section-${counter}`,
    kind: 'section',
    label,
    x,
    y,
    width: Math.max(width, SECTION_MIN_WIDTH),
    height: Math.max(height, SECTION_MIN_HEIGHT),
    tone: counter % SECTION_TONE_COUNT,
  };
}

/**
 * Validate annotations arriving from a saved design, a pasted link or an
 * imported file.
 *
 * Everything here crosses a trust boundary, so nothing is assumed. A single
 * malformed entry is dropped rather than allowed to throw, because a truncated
 * share link must still open the design it can recover instead of showing a
 * blank screen.
 */
export function sanitizeAnnotations(input: unknown): Annotation[] {
  if (!Array.isArray(input)) return [];
  const out: Annotation[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id ? a.id : null;
    if (!id || seen.has(id)) continue;

    const x = num(a.x);
    const y = num(a.y);
    if (x === null || y === null) continue;

    if (a.kind === 'note') {
      const text = typeof a.text === 'string' ? a.text : '';
      // An empty note is invisible and unselectable, so it would be a piece of
      // litter the reader cannot remove. Drop it.
      if (!text.trim()) continue;
      const width = num(a.width);
      out.push({
        id,
        kind: 'note',
        text: text.slice(0, 2000),
        x,
        y,
        width: clamp(width ?? NOTE_DEFAULT_WIDTH, 80, 900),
        size: a.size === 'sm' || a.size === 'lg' ? a.size : 'md',
      });
      seen.add(id);
    } else if (a.kind === 'section') {
      const width = num(a.width);
      const height = num(a.height);
      const tone = num(a.tone);
      out.push({
        id,
        kind: 'section',
        label: typeof a.label === 'string' ? a.label.slice(0, 200) : '',
        x,
        y,
        width: clamp(width ?? 320, SECTION_MIN_WIDTH, 4000),
        height: clamp(height ?? 220, SECTION_MIN_HEIGHT, 4000),
        tone:
          tone === null
            ? 0
            : ((Math.floor(tone) % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) %
              SECTION_TONE_COUNT,
      });
      seen.add(id);
    }
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
