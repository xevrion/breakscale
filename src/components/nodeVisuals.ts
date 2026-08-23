import type { NodeKind } from '../sim/types';

/**
 * Shared, non-component values used by both the canvas and the palette.
 * They live outside both component modules so each file exports only
 * components, which is what React Fast Refresh requires to hot-update a
 * module instead of forcing a full reload.
 */

/** MIME type the palette sets on dragstart and the canvas checks for on drop. */
export const NODE_DND_MIME = 'application/x-sys-sim-node';

/* ------------------------------------------------------------------ *
 * Kind glyphs. Small, flat, inline, single-stroke. No colored squares.
 * Each is drawn in a 16x16 box, stroke inherits currentColor.
 * ------------------------------------------------------------------ */

export const GLYPH: Record<NodeKind, string> = {
  // person: head + shoulders
  client: 'M8 3.2a2.4 2.4 0 1 1 0 4.8a2.4 2.4 0 0 1 0-4.8M3.2 13.2a4.8 4.8 0 0 1 9.6 0',
  // fan-out: one trunk splitting into three
  lb: 'M2 8h3.5M5.5 8L10 3.6M5.5 8h4.5M5.5 8L10 12.4M13.2 3.6h.6M13.2 8h.6M13.2 12.4h.6',
  // server: two stacked units
  service: 'M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM4.5 5.5h.6M4.5 10.5h.6',
  // lightning: fast path
  cache: 'M9.2 2L4.4 9h3.2l-0.8 5L12 7H8.8z',
  // cylinder
  db: 'M3 4.2c0-1.2 2.2-2.2 5-2.2s5 1 5 2.2-2.2 2.2-5 2.2-5-1-5-2.2M3 4.2v7.6c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4.2M3 8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2',
  // stacked items waiting in line
  queue: 'M2.5 4h11M2.5 8h11M2.5 12h7',
  // gear-ish: a cog reduced to a ring plus teeth
  worker:
    'M8 5.4a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 0 1 0-5.2M8 2v1.6M8 12.4V14M14 8h-1.6M3.6 8H2M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1M12.2 12.2l-1.1-1.1M4.9 4.9L3.8 3.8',
};

/** Glyphs drawn as filled shapes rather than strokes. */
export const FILLED_GLYPHS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'client',
  'cache',
]);
