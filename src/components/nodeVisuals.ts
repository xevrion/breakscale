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
};
