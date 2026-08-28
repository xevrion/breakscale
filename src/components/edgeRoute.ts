/**
 * Edge routing as pure geometry: node rectangles in, orthogonal path out.
 *
 * This module owns the THREE coupled decisions an edge needs, because a
 * previous attempt proved they cannot be changed independently:
 *
 *   1. ANCHORS. Which side of each box the wire leaves and enters. The old
 *      router pinned these to the visible ports (out right, in left), which
 *      is correct only while the target sits to the right; a target behind
 *      or above the source forced the path to double back across the node
 *      it had just left.
 *   2. PATH. The filleted orthogonal run between those anchors.
 *   3. ARROWHEAD. The arrival direction, which the head must point along.
 *
 * routeEdge returns all three together so a caller cannot mix an anchor
 * choice with a mismatched head.
 *
 * The VISIBLE ports stay where they are (out on the right edge, in on the
 * left): they are the affordance for drawing an edge and they teach the
 * request direction. Only the drawn path picks its sides.
 *
 * No imports on purpose: the module must stay loadable by node-environment
 * unit tests without dragging React or the canvas in.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Travel direction of the path's FINAL segment, i.e. where the arrow points. */
export type EdgeDir = 'right' | 'left' | 'down' | 'up';

export interface EdgeRoute {
  /** Path for the wire itself. Stops ARROW_INSET short of the tip so the
   *  stroke never pokes through the solid arrowhead. */
  d: string;
  /** Apex of the arrowhead, TIP_BACKOFF outside the target's entry edge. */
  tip: Pt;
  /** Direction the final segment travels; the arrowhead points this way. */
  dir: EdgeDir;
  /**
   * Anchor for the rate label, break mark and delete button. Chosen to sit
   * on the wire's mid leg, which lives strictly in the clear corridor
   * BETWEEN the two boxes, so it is never painted under (and made
   * unclickable by) either endpoint node.
   */
  label: Pt;
  /**
   * The pre-fillet polyline the path is built from, exposed for tests: the
   * filleted path is contained in this polyline's corridor (each fillet cuts
   * inside its corner), so asserting the polyline avoids a box proves the
   * rendered path does too.
   */
  points: Pt[];
}

export const EDGE_STUB = 22;
export const EDGE_RADIUS = 12;

/** How far the wire stops short of the tip so the stroke hides under the head. */
export const ARROW_INSET = 8;
export const ARROW_LEN = 8;
export const ARROW_HALF = 3.6;

/** Gap between the arrow tip and the target's entry edge. */
const TIP_BACKOFF = 2;

/**
 * Minimum CLEAR corridor between the two boxes for an axis to be routable:
 * the tip backoff (2) plus the arrow inset (8) plus a 2px sliver of visible
 * wire. Below this a side arrival cannot be drawn without the head or the
 * line poking into a box, so the router falls through to the other axis.
 */
const AXIS_MIN_GAP = TIP_BACKOFF + ARROW_INSET + 2;

/**
 * Perpendicular shift, in world px, for each lane of a bidirectional pair.
 * Two opposite edges get lanes -1 and +1, so their wires (and arrowheads)
 * sit 2 * LANE_OFFSET apart instead of fusing into one line.
 */
export const LANE_OFFSET = 8;

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Emit an axis-aligned polyline with a fillet at every right-angle corner.
 *
 * Corner radius is clamped to half of BOTH adjacent legs, so two corners
 * sharing a leg can never overlap and kink. The sweep flag comes from the
 * cross product of the incoming and outgoing directions, which is what lets
 * one builder serve every orientation instead of hand-derived flag tables.
 */
export function roundedPath(pts: Pt[], radius: number): string {
  // Drop zero-length legs so a clamped mid never yields a degenerate corner.
  const p: Pt[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.abs(last.x - q.x) > 0.01 || Math.abs(last.y - q.y) > 0.01) {
      p.push(q);
    }
  }
  if (p.length === 0) return '';
  let d = `M${fmt(p[0]!.x)},${fmt(p[0]!.y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]!;
    const c = p[i]!;
    const b = p[i + 1]!;
    const v1 = { x: c.x - a.x, y: c.y - a.y };
    const v2 = { x: b.x - c.x, y: b.y - c.y };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    // Parallel (or anti-parallel) legs make no corner; tiny legs make no
    // room for an arc worth drawing. Both fall back to a hard vertex.
    const v1Horiz = Math.abs(v1.y) < 0.01;
    const v2Horiz = Math.abs(v2.y) < 0.01;
    if (r < 0.5 || v1Horiz === v2Horiz) {
      d += ` L${fmt(c.x)},${fmt(c.y)}`;
      continue;
    }
    const u1 = { x: v1.x / l1, y: v1.y / l1 };
    const u2 = { x: v2.x / l2, y: v2.y / l2 };
    const sweep = u1.x * u2.y - u1.y * u2.x > 0 ? 1 : 0;
    d +=
      ` L${fmt(c.x - u1.x * r)},${fmt(c.y - u1.y * r)}` +
      ` A${fmt(r)},${fmt(r)} 0 0 ${sweep} ${fmt(c.x + u2.x * r)},${fmt(c.y + u2.y * r)}`;
  }
  const last = p[p.length - 1]!;
  if (p.length > 1) d += ` L${fmt(last.x)},${fmt(last.y)}`;
  return d;
}

/**
 * Pick the exit/entry sides from where the target box actually sits.
 *
 * The rule, chosen deliberately:
 *
 *   - A HORIZONTAL corridor wins whenever one exists (the target's box is
 *     clear of the source's by at least AXIS_MIN_GAP on the left or right).
 *     Requests read left-to-right in this tool, the visible ports are on the
 *     side edges, and a fan-out drawn as a horizontal bus is the schematic
 *     shape students are taught; so the side exit is the default even for
 *     steep diagonals.
 *   - VERTICAL routing takes over exactly when no horizontal corridor
 *     exists, i.e. the boxes overlap (or nearly overlap) in x. That is the
 *     "target almost directly above or below" case: a side exit there would
 *     travel sideways only to hook back over its own box.
 *   - When NO axis has a clear corridor the boxes themselves overlap.
 *     Nothing can avoid crossing them, so route along the dominant centre
 *     delta and keep the shape sane and finite.
 */
function pickDir(a: Rect, b: Rect): EdgeDir {
  if (b.x - (a.x + a.w) >= AXIS_MIN_GAP) return 'right';
  if (a.x - (b.x + b.w) >= AXIS_MIN_GAP) return 'left';
  if (b.y - (a.y + a.h) >= AXIS_MIN_GAP) return 'down';
  if (a.y - (b.y + b.h) >= AXIS_MIN_GAP) return 'up';
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/**
 * Route one edge from box `a` to box `b`.
 *
 * `lane` is 0 for a lone edge; a bidirectional pair passes -1 and +1 so the
 * two wires shift LANE_OFFSET to either side of the shared corridor instead
 * of overlapping into one line.
 */
export function routeEdge(a: Rect, b: Rect, lane = 0): EdgeRoute {
  const dir = pickDir(a, b);
  const off = lane * LANE_OFFSET;
  const horizontal = dir === 'right' || dir === 'left';

  if (horizontal) {
    const sign = dir === 'right' ? 1 : -1;
    const start: Pt = {
      x: dir === 'right' ? a.x + a.w : a.x,
      y: a.y + a.h / 2 + off,
    };
    const tip: Pt = {
      x: dir === 'right' ? b.x - TIP_BACKOFF : b.x + b.w + TIP_BACKOFF,
      y: b.y + b.h / 2 + off,
    };
    // Where the LINE stops. Clamped so a squeezed corridor shortens the
    // approach rather than sending the wire backwards into the source box.
    let endX = tip.x - sign * ARROW_INSET;
    if (sign * (endX - start.x) < 0) endX = start.x;
    const end: Pt = { x: endX, y: tip.y };

    if (Math.abs(end.y - start.y) < 1) {
      // Same row: a straight run, labelled at the centre of the clear gap.
      const points = [start, end];
      return {
        d: roundedPath(points, EDGE_RADIUS),
        tip,
        dir,
        label: { x: (start.x + tip.x) / 2, y: start.y },
        points,
      };
    }

    // Vertical mid leg at the centre of the corridor: leave horizontally,
    // run vertically, arrive horizontally.
    const mid = (start.x + end.x) / 2;
    const points = [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
    return {
      d: roundedPath(points, EDGE_RADIUS),
      tip,
      dir,
      label: { x: mid, y: (start.y + end.y) / 2 },
      points,
    };
  }

  const sign = dir === 'down' ? 1 : -1;
  const start: Pt = {
    x: a.x + a.w / 2 + off,
    y: dir === 'down' ? a.y + a.h : a.y,
  };
  const tip: Pt = {
    x: b.x + b.w / 2 + off,
    y: dir === 'down' ? b.y - TIP_BACKOFF : b.y + b.h + TIP_BACKOFF,
  };
  let endY = tip.y - sign * ARROW_INSET;
  if (sign * (endY - start.y) < 0) endY = start.y;
  const end: Pt = { x: tip.x, y: endY };

  if (Math.abs(end.x - start.x) < 1) {
    const points = [start, end];
    return {
      d: roundedPath(points, EDGE_RADIUS),
      tip,
      dir,
      label: { x: start.x, y: (start.y + tip.y) / 2 },
      points,
    };
  }

  const mid = (start.y + end.y) / 2;
  const points = [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  return {
    d: roundedPath(points, EDGE_RADIUS),
    tip,
    dir,
    label: { x: (start.x + end.x) / 2, y: mid },
    points,
  };
}

/**
 * Arrowhead for an axis-aligned arrival: four fixed triangles, one per
 * direction, so there is no per-edge trigonometry. `dir` is the travel
 * direction of the final segment, exactly as routeEdge reports it.
 */
export function arrowPath(tip: Pt, dir: EdgeDir): string {
  const x = fmt(tip.x);
  const y = fmt(tip.y);
  switch (dir) {
    case 'right':
      return `M${x},${y} L${fmt(tip.x - ARROW_LEN)},${fmt(tip.y - ARROW_HALF)} L${fmt(
        tip.x - ARROW_LEN,
      )},${fmt(tip.y + ARROW_HALF)} Z`;
    case 'left':
      return `M${x},${y} L${fmt(tip.x + ARROW_LEN)},${fmt(tip.y - ARROW_HALF)} L${fmt(
        tip.x + ARROW_LEN,
      )},${fmt(tip.y + ARROW_HALF)} Z`;
    case 'down':
      return `M${x},${y} L${fmt(tip.x - ARROW_HALF)},${fmt(tip.y - ARROW_LEN)} L${fmt(
        tip.x + ARROW_HALF,
      )},${fmt(tip.y - ARROW_LEN)} Z`;
    case 'up':
      return `M${x},${y} L${fmt(tip.x - ARROW_HALF)},${fmt(tip.y + ARROW_LEN)} L${fmt(
        tip.x + ARROW_HALF,
      )},${fmt(tip.y + ARROW_LEN)} Z`;
  }
}

/**
 * Path for the in-flight link preview: from a source box to a bare point
 * (the pointer, or the armed-click stub). Same side-selection idea with the
 * point treated as a zero-size target, and the wire runs all the way to the
 * point because the preview draws no arrowhead.
 */
export function previewPath(a: Rect, px: number, py: number): string {
  let dir: EdgeDir;
  if (px >= a.x + a.w + AXIS_MIN_GAP) dir = 'right';
  else if (px <= a.x - AXIS_MIN_GAP) dir = 'left';
  else if (py >= a.y + a.h + AXIS_MIN_GAP) dir = 'down';
  else if (py <= a.y - AXIS_MIN_GAP) dir = 'up';
  // Pointer over or beside the source: default to the out-port side.
  else dir = 'right';

  if (dir === 'right' || dir === 'left') {
    const start: Pt = { x: dir === 'right' ? a.x + a.w : a.x, y: a.y + a.h / 2 };
    if (Math.abs(py - start.y) < 1)
      return roundedPath([start, { x: px, y: py }], EDGE_RADIUS);
    const mid = (start.x + px) / 2;
    return roundedPath(
      [start, { x: mid, y: start.y }, { x: mid, y: py }, { x: px, y: py }],
      EDGE_RADIUS,
    );
  }
  const start: Pt = { x: a.x + a.w / 2, y: dir === 'down' ? a.y + a.h : a.y };
  if (Math.abs(px - start.x) < 1)
    return roundedPath([start, { x: px, y: py }], EDGE_RADIUS);
  const mid = (start.y + py) / 2;
  return roundedPath(
    [start, { x: start.x, y: mid }, { x: px, y: mid }, { x: px, y: py }],
    EDGE_RADIUS,
  );
}
