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
  // replica set: one primary with copies trailing behind it
  replica:
    'M2 5.2c0-1 1.7-1.8 3.8-1.8s3.8.8 3.8 1.8-1.7 1.8-3.8 1.8S2 6.2 2 5.2M2 5.2v5.6c0 1 1.7 1.8 3.8 1.8s3.8-.8 3.8-1.8V5.2M11 5.6h1.2M11 8h2M11 10.4h1.2',
  // shard set: one store sliced into partitions, one filling up
  shard: 'M2.5 3.5h11v9h-11zM6.2 3.5v9M9.8 3.5v9M3.4 10.6h1.9M7.1 6.9h1.9M10.7 10.6h1.9',
  // controller: a dial with an arrow stepping up, plus the level it drives
  autoscaler:
    'M2.5 12.5h11M4.5 12.5V9.2M7.5 12.5V6.4M10.5 12.5V8M13.5 12.5V3.6M11.6 5.5L13.5 3.6l1.9 1.9',
  // two regions, one active: a globe split with the served half marked
  region:
    'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2M8 2v12M2.6 6h10.8M2.6 10h10.8',
  // edge cache: a cloud out at the edge, with the origin link behind it
  cdn: 'M4.8 11.4a2.4 2.4 0 0 1 .3-4.8a3.2 3.2 0 0 1 6.1-.7a2.2 2.2 0 0 1 .5 4.3zM4.8 11.4h6.9M8 11.4V14M6 14h4',
  // token bucket: a funnel metering drops through
  ratelimiter: 'M2.5 3h11L9.4 8v4.2L6.6 14V8zM14 4.6h1M14 7h1M14 9.4h1',
  // circuit breaker: a switch thrown open in the middle of a line
  breaker: 'M2 11h3.4M10.6 11H14M5.4 11a1 1 0 1 1 2 0a1 1 0 0 1-2 0M10.6 11a1 1 0 1 1-2 0a1 1 0 0 1 2 0M7.1 10.3L11 4.8',
};

/** Glyphs drawn as filled shapes rather than strokes. */
export const FILLED_GLYPHS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'client',
  'cache',
]);

/**
 * The box every path above is drawn in. The node header renders the glyph at
 * 14px, so the consumer scales by 14/16 rather than the paths being redrawn —
 * one number to change if the art is ever re-cut.
 */
export const GLYPH_BOX = 16;

/** Human-readable kind names. Used by the canvas, the palette and the inspector. */
export const KIND_NAME: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
  replica: 'Read replicas',
  shard: 'Sharded store',
  autoscaler: 'Autoscaler',
  region: 'Region',
  cdn: 'CDN',
  ratelimiter: 'Rate limiter',
  breaker: 'Circuit breaker',
};
