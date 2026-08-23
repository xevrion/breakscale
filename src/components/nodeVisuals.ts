import type { NodeKind } from '../sim/types';

/* ------------------------------------------------------------------ *
 * Kind icons, from Lucide.
 *
 * One icon per kind, all from one library cut on one 24x24 grid at one
 * stroke weight, which is what makes thirty-three of them read as a family
 * rather than as thirty-three separately-sourced pictures.
 *
 * WHY `__iconNode` AND NOT THE COMPONENTS. Each lucide-react icon module
 * exports the React component (default) and `__iconNode`, the list of SVG
 * primitives ([tag, attrs] pairs) the component is built from. The canvas
 * draws every node inside ONE parent <svg>; a component that renders its
 * own <svg> root would have to be nested as an inner viewport, while the
 * primitive list can be painted straight into a positioned <g> exactly the
 * way the old hand-drawn paths were. So this module re-exports the
 * primitives, and each consumer owns one tiny renderer. The deep imports
 * are typed by lucide-icons.d.ts and are exactly as tree-shakeable as the
 * barrel: only the thirty-three modules named here are bundled.
 *
 * CHOOSING RULES, in priority order:
 *   BEHAVIOUR   the icon depicts what the component DOES to traffic, not
 *               what the hardware looks like, because the behaviour is the
 *               thing a student is here to learn.
 *   FAMILY      related kinds quote a shared shape and differ in one mark:
 *               db / cache / replica are all the cylinder, ratelimiter /
 *               loadshedder are both the funnel, cdn / edgecompute are
 *               both the cloud, queue / streambroker / retryqueue are all
 *               rows of items.
 *   CONTRAST    unrelated kinds must not collide at 14px. The circular
 *               outlines (globe, clock) stay unique in the set.
 * ------------------------------------------------------------------ */

/* Traffic */
import { __iconNode as icClient } from 'lucide-react/dist/esm/icons/monitor-smartphone.mjs';
import { __iconNode as icLb } from 'lucide-react/dist/esm/icons/split.mjs';
import { __iconNode as icCdn } from 'lucide-react/dist/esm/icons/cloud-download.mjs';
import { __iconNode as icRegion } from 'lucide-react/dist/esm/icons/globe.mjs';
/* Compute */
import { __iconNode as icService } from 'lucide-react/dist/esm/icons/server.mjs';
import { __iconNode as icWorker } from 'lucide-react/dist/esm/icons/cog.mjs';
import { __iconNode as icLambda } from 'lucide-react/dist/esm/icons/square-function.mjs';
import { __iconNode as icEdgecompute } from 'lucide-react/dist/esm/icons/cloud-lightning.mjs';
import { __iconNode as icTranscoder } from 'lucide-react/dist/esm/icons/film.mjs';
import { __iconNode as icCron } from 'lucide-react/dist/esm/icons/calendar-clock.mjs';
/* Data */
import { __iconNode as icDb } from 'lucide-react/dist/esm/icons/database.mjs';
import { __iconNode as icCache } from 'lucide-react/dist/esm/icons/database-zap.mjs';
import { __iconNode as icReplica } from 'lucide-react/dist/esm/icons/database-backup.mjs';
import { __iconNode as icShard } from 'lucide-react/dist/esm/icons/columns-3.mjs';
import { __iconNode as icObjectstore } from 'lucide-react/dist/esm/icons/package.mjs';
import { __iconNode as icSearchindex } from 'lucide-react/dist/esm/icons/text-search.mjs';
import { __iconNode as icTimeseriesdb } from 'lucide-react/dist/esm/icons/chart-line.mjs';
import { __iconNode as icGraphdb } from 'lucide-react/dist/esm/icons/waypoints.mjs';
import { __iconNode as icColdstorage } from 'lucide-react/dist/esm/icons/snowflake.mjs';
import { __iconNode as icVectordb } from 'lucide-react/dist/esm/icons/chart-scatter.mjs';
import { __iconNode as icWritebehind } from 'lucide-react/dist/esm/icons/hard-drive-download.mjs';
/* Messaging */
import { __iconNode as icQueue } from 'lucide-react/dist/esm/icons/rows-3.mjs';
import { __iconNode as icStreambroker } from 'lucide-react/dist/esm/icons/logs.mjs';
import { __iconNode as icPubsub } from 'lucide-react/dist/esm/icons/share-2.mjs';
import { __iconNode as icWebsocket } from 'lucide-react/dist/esm/icons/cable.mjs';
import { __iconNode as icRetryqueue } from 'lucide-react/dist/esm/icons/list-restart.mjs';
/* Control */
import { __iconNode as icAutoscaler } from 'lucide-react/dist/esm/icons/scaling.mjs';
import { __iconNode as icRatelimiter } from 'lucide-react/dist/esm/icons/funnel.mjs';
import { __iconNode as icBreaker } from 'lucide-react/dist/esm/icons/unplug.mjs';
import { __iconNode as icApigateway } from 'lucide-react/dist/esm/icons/door-open.mjs';
import { __iconNode as icSidecar } from 'lucide-react/dist/esm/icons/blocks.mjs';
import { __iconNode as icBulkhead } from 'lucide-react/dist/esm/icons/square-split-horizontal.mjs';
import { __iconNode as icLoadshedder } from 'lucide-react/dist/esm/icons/funnel-x.mjs';

/**
 * Shared, non-component values used by both the canvas and the palette.
 * They live outside both component modules so each file exports only
 * components, which is what React Fast Refresh requires to hot-update a
 * module instead of forcing a full reload.
 */

/** MIME type the palette sets on dragstart and the canvas checks for on drop. */
export const NODE_DND_MIME = 'application/x-sys-sim-node';

/**
 * One Lucide icon as its raw SVG primitives: [tagName, attributes] pairs.
 * Drawn in a 24x24 box (ICON_BOX) expecting stroke-width ICON_STROKE,
 * currentColor stroke and no fill from the surrounding container. A few
 * primitives (chart-scatter's points) carry their own fill="currentColor",
 * which the renderer must pass through untouched.
 */
export type IconNode = [elementName: string, attrs: Record<string, string>][];

/**
 * The kind -> icon table. The reasoning for each pick is inline, because a
 * future kind must be slotted into the same system, not just given the
 * first icon that looks nice.
 */
export const KIND_ICON: Record<NodeKind, IconNode> = {
  /* Traffic ORIGIN: the devices load comes from. A plural picture (monitor
     and phone), because this node is a population, not one person. */
  client: icClient,

  /* FAN-OUT: one path dividing. The split IS the job. */
  lb: icLb,

  /* COMPUTE: the rack unit with status pips. The one deliberately literal
     icon, because "a server" is the mental anchor everything else riffs on. */
  service: icService,

  /* FAST LOOKUP: the db cylinder crossed by a bolt. Same silhouette as db,
     one mark of difference, exactly like the old hand-drawn pair. */
  cache: icCache,

  /* DURABLE STORE: the canonical cylinder that cache and replica quote. */
  db: icDb,

  /* BUFFER: a container of ordered rows. Related to streambroker's lanes
     and retryqueue's list, which are the other row-based kinds. */
  queue: icQueue,

  /* BACKGROUND CONSUMER: the machine-work cog, grinding through jobs. */
  worker: icWorker,

  /* READ REPLICAS: the cylinder with a copy-restore arrow; replication
     drawn onto the family's shared store shape. */
  replica: icReplica,

  /* PARTITIONED STORE: one box cut into vertical columns, each its own
     independent slice; the old glyph's exact idea. */
  shard: icShard,

  /* CONTROLLER: the frame being resized outward; capacity under control. */
  autoscaler: icAutoscaler,

  /* GEOGRAPHIC SCOPE: the globe. Circular outline stays unique to the
     place-kinds so it never reads as a flow icon. */
  region: icRegion,

  /* EDGE CACHE: the cloud delivering content downward to the viewer.
     Shares the cloud with edgecompute; the arrow vs bolt is the difference
     between serving bytes and running code. */
  cdn: icCdn,

  /* METERING: the funnel; admits a limited rate by shape alone. */
  ratelimiter: icRatelimiter,

  /* FAIL FAST: the connection deliberately pulled apart. The gap is the
     whole idea, same as the old thrown-switch glyph. */
  breaker: icBreaker,

  /* BLOB BUCKET: a parcel; an opaque object with a handle, deliberately
     NOT the db cylinder because the lesson is that it is not a database. */
  objectstore: icObjectstore,

  /* SEARCH over an index: the magnifier over lines of corpus. */
  searchindex: icSearchindex,

  /* TIME SERIES: a line series on an axis. */
  timeseriesdb: icTimeseriesdb,

  /* GRAPH: nodes joined by edges; the data model drawn literally. */
  graphdb: icGraphdb,

  /* COLD: the snowflake; pure diagonals, collides with no store shape. */
  coldstorage: icColdstorage,

  /* NEAREST NEIGHBOUR: scattered points in a space; the embedding space
     drawn as a scatter plot, sharing the axis motif with timeseriesdb. */
  vectordb: icVectordb,

  /* PARTITIONED LOG: lanes of entries with per-lane markers; the ordered
     row family again, one step more structured than queue. */
  streambroker: icStreambroker,

  /* FAN-OUT TOPIC: one node sharing out to many; the deliver-to-everyone
     counterpart of lb's pick-one split. */
  pubsub: icPubsub,

  /* HELD CHANNEL: a cable with both ends drawn; the connection itself is
     the resource this kind rations. */
  websocket: icWebsocket,

  /* FRONT DOOR: the open door. Routing, auth and limiting are all "what
     happens at the door", so the door is the icon. */
  apigateway: icApigateway,

  /* SIDECAR: the small block bolted onto the big one. */
  sidecar: icSidecar,

  /* SERVERLESS: a function in a box; f(x) is the whole product. */
  lambda: icLambda,

  /* SCHEDULE: calendar plus clock; fires at a time, not on demand. */
  cron: icCron,

  /* CONTAINMENT: one hull divided into sealed compartments. */
  bulkhead: icBulkhead,

  /* REDELIVERY: the queue's rows plus a restart loop taking the failed
     item back around. */
  retryqueue: icRetryqueue,

  /* BATCH ENCODE: the film frame, the job this farm exists to chew. */
  transcoder: icTranscoder,

  /* CODE AT THE EDGE: the cdn's cloud with a bolt of compute instead of a
     delivery arrow. */
  edgecompute: icEdgecompute,

  /* DEFERRED WRITE: the arrow still on its way down into durable media;
     the gap between ack and disk is the data at risk. */
  writebehind: icWritebehind,

  /* TRIAGE: the limiter's funnel with the discard cross; some traffic is
     deliberately turned away so the rest survives. */
  loadshedder: icLoadshedder,
};

/**
 * The viewBox every Lucide icon is drawn in, in icon units. Consumers scale
 * from this to their rendered size rather than the art being redrawn; one
 * number to change if the icon set is ever swapped again.
 */
export const ICON_BOX = 24;

/**
 * The stroke width the set is designed for, in icon units (so 2/24 of the
 * rendered size). Every consumer derives its stroke from this so all icons
 * everywhere carry the same visual weight.
 */
export const ICON_STROKE = 2;

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
