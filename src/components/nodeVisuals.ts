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
 * Kind glyphs.
 *
 * All fourteen are cut on ONE grid so they read as a family rather than as
 * fourteen separately-sourced icons. The rules every path obeys:
 *
 *   BOX        16x16 (GLYPH_BOX). Nothing is drawn outside it.
 *   LIVE AREA  a 12x12 field inset at 2..14. Every mark stays inside it, so
 *              no glyph optically outweighs another by simply being bigger.
 *   GEOMETRY   coordinates land on the 1px grid or its .5 midpoints, which is
 *              what keeps a 1.5px stroke crisp instead of smeared across two
 *              device pixels at 100% zoom.
 *   STROKE     one weight for all fourteen, applied by the consumer, with
 *              round caps and joins. No glyph sets its own weight.
 *   FILL       none. The previous set mixed filled and stroked art, so
 *              `client` and `cache` read as heavy blobs beside twelve light
 *              line drawings. FILLED_GLYPHS is now empty and the whole set is
 *              stroked, which is the single biggest reason it now coheres.
 *
 * Each glyph is a diagram of the component's BEHAVIOUR, not a picture of a
 * physical object: the thing a student should learn is what it does to
 * traffic. Where two kinds are related (db/replica/shard, cache/cdn) the
 * shared idea is drawn with a shared shape and the difference is the only
 * thing that changes.
 * ------------------------------------------------------------------ */

export const GLYPH: Record<NodeKind, string> = {
  /* Traffic ORIGIN: a cursor/arrow leaving toward the system. Not a person —
     a person implies one human, and this node is a load generator. */
  client: 'M3 3l4.5 10 1.8-4.2L13.5 7z',

  /* FAN-OUT: one inbound trunk split across three outbound branches.
     Only the OUTER two branches carry arrowheads. A third arrowhead on the
     middle branch is geometrically symmetric but lands right on the trunk
     junction, and at 18px the three heads merge into an unreadable knot —
     verified by rendering. Two heads establish the direction for all three. */
  lb: 'M2 8h3.5M5.5 8V4h4.5M5.5 8h4.5M5.5 8v4h4.5M10 4l-1.5-1.4M10 4l-1.5 1.4M10 12l-1.5-1.4M10 12l-1.5 1.4',

  /* COMPUTE: a stacked pair of units. The status pip on each is what makes it
     a running service rather than a generic box. */
  service: 'M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM4.5 5.5h.01M4.5 10.5h.01',

  /* FAST LOOKUP: a store shape (matching db's width) crossed by a bolt. The
     shared silhouette says "it holds data"; the bolt says "and it is fast". */
  cache: 'M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M9.6 6.6L6.6 9.9h2.2l-.6 3.1 3-3.4H9z',

  /* DURABLE STORE: the canonical cylinder. Two rings = the reference shape
     that replica and shard both quote. */
  db: 'M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M13 8c0 1.1-2.2 2-5 2s-5-.9-5-2',

  /* BUFFER: items queued left-to-right with the head leaving. Decreasing bar
     lengths read as depth without needing a container. */
  queue: 'M2.5 4.5h11M2.5 8h8M2.5 11.5h5M12.5 8h1',

  /* BACKGROUND CONSUMER: pulls off a queue (the stub at left) and processes.
     The ring is work in progress; it is deliberately NOT a cog with teeth,
     which at 14px turned into a grey smudge. */
  worker: 'M2 8h2.5M12 5.2a4 4 0 1 1-4-2.2M12 3v2.4h-2.4',

  /* READ REPLICAS: the db cylinder, duplicated. One primary in front, copies
     stacked behind it — offset rather than redrawn, so the family is obvious. */
  replica:
    'M2.5 4.2c0-.8 1.6-1.5 3.6-1.5s3.6.7 3.6 1.5-1.6 1.5-3.6 1.5-3.6-.7-3.6-1.5M2.5 4.2v5.1c0 .6.9 1.1 2.2 1.4M6.4 7.4c0-.8 1.6-1.5 3.6-1.5s3.6.7 3.6 1.5-1.6 1.5-3.6 1.5-3.6-.7-3.6-1.5M6.4 7.4v4.4c0 .8 1.6 1.5 3.6 1.5s3.6-.7 3.6-1.5V7.4',

  /* PARTITIONED STORE: one logical store cut into three vertical shards, each
     independently filled. Same outer width as cache/db. */
  shard: 'M2.5 4.5h11v7h-11zM6.2 4.5v7M9.8 4.5v7',

  /* CONTROLLER: capacity stepping up under control. The arrow is the decision;
     the bars are the fleet it resizes. */
  autoscaler: 'M2.5 13h11M4.5 13v-2M7.5 13v-4M10.5 13v-6M8.8 3.5h4.7v4.7M13.5 3.5L9.6 7.4',

  /* GEOGRAPHIC SCOPE: a globe with a meridian and two parallels. Circular
     outline is unique in the set, so it never reads as lb's fan. */
  region: 'M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11M8 2.5c-2.2 2.4-2.2 8.6 0 11M8 2.5c2.2 2.4 2.2 8.6 0 11M3 8h10',

  /* EDGE CACHE: a cloud (points of presence) with the origin link dropping
     out of it. The cloud is the only soft outline in the set. */
  cdn: 'M5 11.5a2.5 2.5 0 0 1 .2-5a3.2 3.2 0 0 1 6.1-.6a2.3 2.3 0 0 1 .4 4.5M5 11.5h6.7M8 11.5v2M6 13.5h4',

  /* METERING: a funnel admitting a limited rate. Drops queue above, a single
     drop passes below — the shape IS the policy. */
  ratelimiter: 'M2.5 3.5h11l-4 4.5v5l-3 1v-6zM4.5 2h7M8 14.5h.01',

  /* FAIL FAST: a switch thrown open in a circuit. The gap is the whole idea,
     so it is the largest single feature in the glyph. */
  breaker: 'M2 11.5h3.2M10.8 11.5H14M6.4 11.5a1.2 1.2 0 1 0-2.4 0a1.2 1.2 0 0 0 2.4 0M12 11.5a1.2 1.2 0 1 0-2.4 0a1.2 1.2 0 0 0 2.4 0M5.4 10.6l5.2-4.1',

  /* BLOB BUCKET: a lidded box holding one object. Deliberately NOT the db
     cylinder: the whole lesson of the kind is that it is not a database. */
  objectstore: 'M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3',

  /* SEARCH over an index: magnifier front and centre, one index line at the
     left edge to say there is a corpus behind it. */
  searchindex: 'M7 3a3.8 3.8 0 1 1 0 7.6A3.8 3.8 0 0 1 7 3M9.7 9.7l3.8 3.8M2.5 13h2.5',

  /* TIME SERIES: an axis with a rising, spiky series. The axis is what
     separates it from cache's bolt at a glance. */
  timeseriesdb: 'M2.5 2.5v11h11M4.5 10.5l2.3-3.2 2 1.7 3.7-5',

  /* GRAPH: three nodes, three edges. The triangle of relationships is the
     data model drawn literally. */
  graphdb:
    'M4 3.2a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8M12 4.6a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8M7.5 11a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8M5.4 4.4l5.2.9M4.5 5.9l2.4 4.9M10.9 7.2l-2.5 3.7',

  /* COLD: a snowflake asterisk. The only glyph built of pure diagonals, so
     it cannot be mistaken for any of the store shapes. */
  coldstorage: 'M8 2.5v11M3.2 5.25l9.6 5.5M12.8 5.25l-9.6 5.5',

  /* NEAREST NEIGHBOUR: scattered points and an arrow landing on the closest
     one. The arrow is the query; the dots are the embedding space. */
  vectordb: 'M3 13.5L9.4 7.1M9.4 7.1H6.6M9.4 7.1v2.8M12.5 4h.01M4.5 4.5h.01M8 3h.01M13 8.5h.01M12 12h.01',

  /* PARTITIONED LOG: three ordered lanes, each with its consumer's cursor
     at a different offset. The staggered cursors ARE consumer lag. */
  streambroker:
    'M2.5 4.5h11M2.5 8h11M2.5 11.5h11M10.5 4.5h.01M6.5 8h.01M4.5 11.5h.01',

  /* FAN-OUT TOPIC: one trunk diverging into three deliveries, arrowheads on
     the outer pair (same head rule as lb). Distinct from lb by the straight
     middle line running the full width: the copy that goes everywhere. */
  pubsub:
    'M2.5 8h3.5M6 8l6-4M6 8h6.5M6 8l6 4M12 4l-1.9-.5M12 4l-.5 1.9M12 12l-1.9.5M12 12l-.5-1.9',

  /* HELD CHANNEL: two brackets holding a duplex pair open. The parentheses
     say "this stays open"; the two lines say traffic flows both ways. */
  websocket:
    'M4.5 3.5C2.8 5.2 2.8 10.8 4.5 12.5M11.5 3.5c1.7 1.7 1.7 7.3 0 9M5.5 6.5h5M5.5 9.5h5',

  /* FRONT DOOR: the door itself, with three routes leaving it. Routing,
     auth and limiting are all "what happens at the door", so the door is
     the glyph. */
  apigateway: 'M2.5 2.5h5.5v11H2.5zM5.75 7v2M9.5 5h4M9.5 8h4M9.5 11h4',

  /* SIDECAR: the service and the small proxy bolted on beside it, joined by
     the one link every request now crosses. */
  sidecar: 'M2.5 4.5h7v7h-7zM11 6.5h2.5v3H11zM9.5 8H11',

  /* SERVERLESS: the lambda letterform itself, cut on the grid. */
  lambda: 'M4.5 3.5h1.9l4.1 9h2M8.4 8.6l-2.7 3.9',

  /* SCHEDULE: a clock face with hands. Circular like region's globe, but
     hands instead of meridians read as time at a glance. */
  cron: 'M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11M8 5.2v3l2.2 1.3',

  /* CONTAINMENT: a hull split by a sealed divider, one compartment hatched
     as the flooded one. The wall holding is the whole idea. */
  bulkhead: 'M2.5 3.5h11v9h-11zM8 3.5v9M3.8 10.7l2.4-2.4M3.8 8l2.4-2.4',

  /* REDELIVERY: the queue's bars, and a loop arrow taking the failed one
     back around for another try. */
  retryqueue:
    'M2.5 4h6M2.5 6.5h4.5M11.7 12.6a3.1 3.1 0 1 1 1.8-4M13.5 6.6l0 2.1-2.1 0',

  /* BATCH ENCODE: a film frame with sprocket rails and the play mark, the
     job every farm like this exists to chew through. */
  transcoder: 'M2.5 4h11v8h-11zM4.6 4v8M11.4 4v8M7 6.3l2.4 1.7L7 9.7z',

  /* CODE AT THE EDGE: the cdn's cloud with a bolt of compute striking out
     of it instead of an origin link. */
  edgecompute:
    'M5 10.5a2.5 2.5 0 0 1 .2-5a3.2 3.2 0 0 1 6.1-.6a2.3 2.3 0 0 1 .4 4.5M8.9 7.5l-2.1 3h2l-.6 3.2 2.6-3.6H8.6z',

  /* DEFERRED WRITE: the store cylinder above, and the write arrow still on
     its way down to it. The gap between them is the data at risk. */
  writebehind:
    'M4 4c0-.8 1.8-1.5 4-1.5s4 .7 4 1.5-1.8 1.5-4 1.5-4-.7-4-1.5M4 4v3c0 .8 1.8 1.5 4 1.5s4-.7 4-1.5V4M8 10v3.5M8 13.5l-1.6-1.6M8 13.5l1.6-1.6',

  /* TRIAGE FUNNEL: the limiter's funnel, but one stream is deliberately
     deflected and crossed out while the other passes. */
  loadshedder:
    'M2.5 3.5h11l-4.2 4.7v4.3l-2.6-1.6V8.2zM11.6 9.6l2 2M13.6 9.6l-2 2',
};

/**
 * Glyphs drawn as filled shapes rather than strokes.
 *
 * Deliberately EMPTY. The set is now uniformly stroked at one weight, which
 * is what makes fourteen icons read as one family. The export is kept (rather
 * than deleted) because the palette imports it, and because a future glyph
 * that genuinely needs a solid counter can opt in here without the consumers
 * changing.
 */
export const FILLED_GLYPHS: ReadonlySet<NodeKind> = new Set<NodeKind>();

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
  objectstore: 'Object storage',
  searchindex: 'Search index',
  timeseriesdb: 'Time-series store',
  graphdb: 'Graph database',
  coldstorage: 'Cold storage',
  vectordb: 'Vector database',
  streambroker: 'Stream broker',
  pubsub: 'Pub/sub topic',
  websocket: 'WebSocket gateway',
  apigateway: 'API gateway',
  sidecar: 'Sidecar proxy',
  lambda: 'Lambda',
  cron: 'Cron job',
  bulkhead: 'Bulkhead',
  retryqueue: 'Retry queue',
  transcoder: 'Transcoder',
  edgecompute: 'Edge compute',
  writebehind: 'Write-behind cache',
  loadshedder: 'Load shedder',
};

/* ================================================================== *
 * UNIT RENDERING — how a node made of several things is drawn
 *
 * `NodeStats.instances` / `perInstance` say what a node is MADE OF: a
 * service scaled to 5 is five machines, a shard with 8 partitions is eight
 * independent units, a replica set is a primary plus N copies. The engine has
 * always known this. These helpers are the geometry that lets the canvas
 * SHOW it, and they live here (rather than inside Canvas.tsx) for two
 * reasons: they are pure functions of numbers, so they can be tested without
 * mounting React, and the Inspector needs the same counting rules the canvas
 * draws with so the two panels can never disagree about what "5x" means.
 *
 * Nothing here chooses a colour. Every function returns positions, counts and
 * fractions; the palette is applied in CSS from tokens.
 * ================================================================== */

/**
 * Most layered cards ever drawn in an instance stack.
 *
 * Past this the stack stops growing and the BADGE carries the true count.
 * This is not a rendering-cost limit — 50 rects is nothing — it is a
 * legibility one, and the number is forced by the node's own geometry rather
 * than picked for looks. Each layer is offset by STACK_STEP px; at 5 layers
 * the stack is 4 * 3 = 12px deep, which fits in the margin the node already
 * reserves above its top edge without touching the row above it in any
 * preset (the tightest vertical gap in the preset set is 52px, see NODE_H).
 * A stack that grew with N would collide with the neighbouring node at about
 * 18 instances and would be an unreadable smear well before that.
 *
 * The consequence is deliberate and worth stating: past 5 the stack is a
 * SYMBOL meaning "several", not a tally. The count badge is the precise
 * channel, and it is always present when instances > 1.
 */
export const STACK_MAX_LAYERS = 5;

/** Offset between successive cards in the stack, in world px, on the 4px scale. */
export const STACK_STEP = 3;

/**
 * How an instance stack should be drawn for a node with `live` serving units
 * and `pending` units still booting.
 *
 * Returns layer offsets from BACK to FRONT, so the consumer paints them in
 * array order and the front card lands last, on top. The front card is the
 * node body itself (offset 0) and is NOT included here: these are only the
 * cards that peek out BEHIND it, which is what makes a stack read as depth
 * rather than as a taller box.
 *
 * Pending units are drawn as extra layers behind the live ones and are
 * flagged so the consumer can ghost them. That ordering is the honest one: a
 * booting machine is not yet carrying traffic, so it sits behind the ones
 * that are, and the student watches it move forward when it lands.
 */
export interface StackLayer {
  /** Distance back from the front card, in world px. */
  offset: number;
  /** True when this layer is a unit that is still warming up. */
  pending: boolean;
}

export function stackLayers(live: number, pending: number): StackLayer[] {
  const liveN = Number.isFinite(live) ? Math.max(0, Math.floor(live)) : 0;
  const pendN = Number.isFinite(pending) ? Math.max(0, Math.floor(pending)) : 0;
  // The front card is the node body, so only liveN - 1 live cards are drawn
  // behind it. A single instance with nothing booting draws no stack at all,
  // which is the point: one machine must look like one box.
  const behind = Math.max(0, liveN - 1);
  const total = Math.min(STACK_MAX_LAYERS - 1, behind + pendN);
  if (total <= 0) return [];

  // Pending layers always get shown if there are any: a warm-up that is
  // invisible because the live count already filled the budget would hide the
  // exact thing the stack exists to teach. So pending claims its share first,
  // capped at the budget, and live takes what is left.
  const pendShown = Math.min(pendN, total);

  const out: StackLayer[] = [];
  // Back to front: pending sits furthest back, then live cards.
  for (let i = 0; i < total; i += 1) {
    const depth = total - i; // total..1, so the last one is nearest the front
    out.push({ offset: depth * STACK_STEP, pending: i < pendShown });
  }
  return out;
}

/**
 * The count badge text for a node of `n` units, or null when no badge is
 * warranted.
 *
 * One unit gets NO badge. A "1x" on every unscaled service would put a chip
 * on almost every node in every diagram, which trains the eye to ignore the
 * badge exactly when it starts to matter.
 */
export function stackBadge(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v > 1 ? `${v}x` : null;
}

/**
 * Layout for a strip of per-unit cells (a shard's partitions, a replica set).
 *
 * The hard requirement is 1..64 cells inside a fixed width while every cell
 * stays a readable object. Two regimes, and the switch between them is a
 * measured threshold rather than a guess:
 *
 *   CELLS   at or below `maxCells`, each partition is its own rect with a
 *           visible gap. This is the regime where a student can point at one
 *           cell and say "that shard is the hot one".
 *
 *   DENSE   above it, gaps are dropped and cells become adjacent columns of a
 *           continuous band. At 64 partitions in 160px a 1px gap would eat
 *           40% of the width and every cell would be sub-pixel; without gaps
 *           each column is 2.5px, which still resolves as a distinct bar.
 *
 * Either way the returned geometry is exact and the caller just draws rects.
 */
export interface CellStrip {
  /** x offset of cell i, in world px from the strip's left edge. */
  x: (i: number) => number;
  /** Width of one cell, in world px. Always > 0. */
  w: number;
  /** True when gaps were dropped because the count is high. */
  dense: boolean;
}

/** Below this many cells the strip keeps visible gaps between partitions. */
export const STRIP_GAP_MAX = 24;

export function cellStrip(count: number, width: number, gap = 1.5): CellStrip {
  const n = Math.max(1, Math.floor(count));
  const dense = n > STRIP_GAP_MAX;
  const g = dense ? 0 : gap;
  // Width per slot including its gap; the last cell has no trailing gap, so
  // the total comes out exactly `width` for any n.
  const slot = (width + g) / n;
  const w = Math.max(0.75, slot - g);
  return { x: (i: number) => i * slot, w, dense };
}
