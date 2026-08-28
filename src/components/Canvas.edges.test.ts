import { describe, expect, it } from 'vitest';
import { ARROW_LEN, EDGE_RADIUS, arrowPath, previewPath, routeEdge } from './edgeRoute';
import type { EdgeDir, EdgeRoute, Pt, Rect } from './edgeRoute';

/**
 * The router is pure geometry (rects in, path out), so it is tested as such:
 * every case the canvas can produce is asserted here without a DOM.
 *
 * Box-avoidance is checked on `route.points`, the pre-fillet polyline the
 * path is built from. Each fillet cuts INSIDE its corner (toward the chord),
 * so the rendered path is contained in the polyline's corridor: a polyline
 * that avoids a box proves the drawn path avoids it too.
 */

const W = 184;
const H = 88;
const box = (x: number, y: number): Rect => ({ x, y, w: W, h: H });

const A = box(0, 0);

/** Numbers in a path string; asserting on them catches NaN and Infinity. */
function pathNumbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
}

function expectFinitePath(d: string): void {
  expect(d).not.toMatch(/NaN|Infinity|undefined/);
  const nums = pathNumbers(d);
  expect(nums.length).toBeGreaterThan(0);
  for (const n of nums) expect(Number.isFinite(n)).toBe(true);
}

/** Polyline with zero-length legs dropped, mirroring what gets drawn. */
function cleanPoints(pts: Pt[]): Pt[] {
  const p: Pt[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.abs(last.x - q.x) > 0.01 || Math.abs(last.y - q.y) > 0.01) {
      p.push(q);
    }
  }
  return p;
}

/** Travel direction of the final (non-degenerate) segment. */
function finalDir(pts: Pt[]): EdgeDir | null {
  const p = cleanPoints(pts);
  if (p.length < 2) return null;
  const a = p[p.length - 2]!;
  const b = p[p.length - 1]!;
  if (Math.abs(b.y - a.y) < 0.01) return b.x > a.x ? 'right' : 'left';
  return b.y > a.y ? 'down' : 'up';
}

/**
 * True when an axis-aligned segment passes through the OPEN interior of a
 * rect (shrunk by 0.5px, because anchors legitimately sit ON box edges).
 */
function segmentEntersRect(p: Pt, q: Pt, r: Rect): boolean {
  const eps = 0.5;
  const x0 = r.x + eps;
  const x1 = r.x + r.w - eps;
  const y0 = r.y + eps;
  const y1 = r.y + r.h - eps;
  const lox = Math.min(p.x, q.x);
  const hix = Math.max(p.x, q.x);
  const loy = Math.min(p.y, q.y);
  const hiy = Math.max(p.y, q.y);
  return Math.max(lox, x0) < Math.min(hix, x1) && Math.max(loy, y0) < Math.min(hiy, y1);
}

function expectAvoidsBoxes(route: EdgeRoute, a: Rect, b: Rect): void {
  const pts = cleanPoints(route.points);
  for (let i = 1; i < pts.length; i++) {
    expect(segmentEntersRect(pts[i - 1]!, pts[i]!, a)).toBe(false);
    expect(segmentEntersRect(pts[i - 1]!, pts[i]!, b)).toBe(false);
  }
}

function pointInRect(p: Pt, r: Rect): boolean {
  const eps = 0.5;
  return (
    p.x > r.x + eps && p.x < r.x + r.w - eps && p.y > r.y + eps && p.y < r.y + r.h - eps
  );
}

/** Did the router have a clear corridor on at least one axis? */
function hasCorridor(a: Rect, b: Rect): boolean {
  const gap = Math.max(
    b.x - (a.x + a.w),
    a.x - (b.x + b.w),
    b.y - (a.y + a.h),
    a.y - (b.y + b.h),
  );
  return gap >= 12;
}

describe('routeEdge anchor selection', () => {
  it('routes right for a target to the right', () => {
    expect(routeEdge(A, box(400, 0)).dir).toBe('right');
    expect(routeEdge(A, box(400, 300)).dir).toBe('right');
    expect(routeEdge(A, box(400, -300)).dir).toBe('right');
  });

  it('routes left for a target behind the source', () => {
    expect(routeEdge(A, box(-400, 0)).dir).toBe('left');
    expect(routeEdge(A, box(-400, 300)).dir).toBe('left');
    expect(routeEdge(A, box(-400, -300)).dir).toBe('left');
  });

  it('routes vertically when the target sits in the same column', () => {
    expect(routeEdge(A, box(0, 300)).dir).toBe('down');
    expect(routeEdge(A, box(60, 300)).dir).toBe('down');
    expect(routeEdge(A, box(-60, 300)).dir).toBe('down');
    expect(routeEdge(A, box(0, -300)).dir).toBe('up');
    expect(routeEdge(A, box(100, -300)).dir).toBe('up');
  });

  it('prefers a horizontal corridor over a vertical one', () => {
    // Both axes are clear; side exit wins so fan-outs read as a bus.
    expect(routeEdge(A, box(400, 300)).dir).toBe('right');
    expect(routeEdge(A, box(-400, -300)).dir).toBe('left');
  });
});

describe('routeEdge path geometry', () => {
  const cases: Array<[string, Rect]> = [
    ['target right, same row', box(400, 0)],
    ['target right, below', box(400, 300)],
    ['target right, above', box(400, -300)],
    ['target left, same row', box(-400, 0)],
    ['target left, below', box(-400, 300)],
    ['target left, above', box(-400, -300)],
    ['target directly below', box(0, 300)],
    ['target directly above', box(0, -300)],
    ['target below, column offset', box(60, 300)],
    ['target above, column offset', box(-60, -300)],
    ['boxes nearly touching, right', box(W + 12, 0)],
    ['boxes nearly touching, right and offset', box(W + 12, 120)],
    ['boxes nearly touching, below', box(10, H + 12)],
  ];

  for (const [name, b] of cases) {
    it(`${name}: clean, finite, box-avoiding`, () => {
      const r = routeEdge(A, b);
      expectFinitePath(r.d);
      expectAvoidsBoxes(r, A, b);
      // The final segment travels the way the arrowhead will point.
      expect(finalDir(r.points)).toBe(r.dir);
      // The tip sits just outside the target, never inside either box.
      expect(pointInRect(r.tip, A)).toBe(false);
      expect(pointInRect(r.tip, b)).toBe(false);
    });
  }

  it('degenerates to a straight line on the same row', () => {
    const r = routeEdge(A, box(400, 0));
    expect(cleanPoints(r.points)).toHaveLength(2);
    expect(r.d).not.toContain('A');
  });

  it('degenerates to a straight line in the same column', () => {
    const r = routeEdge(A, box(0, 300));
    expect(cleanPoints(r.points)).toHaveLength(2);
    expect(r.d).not.toContain('A');
  });

  it('an overlapping target still yields a finite, well-formed route', () => {
    for (const b of [box(20, 10), box(0, 0), box(-30, 40), box(90, -20)]) {
      const r = routeEdge(A, b);
      expectFinitePath(r.d);
      expect(['right', 'left', 'down', 'up']).toContain(r.dir);
      expectFinitePath(arrowPath(r.tip, r.dir));
    }
  });

  it('never emits a fillet radius above EDGE_RADIUS', () => {
    for (const b of [box(400, 300), box(-400, -300), box(60, 300), box(W + 12, 120)]) {
      const d = routeEdge(A, b).d;
      for (const m of d.matchAll(/A(-?\d+(?:\.\d+)?)/g)) {
        const r = Number(m[1]);
        expect(r).toBeGreaterThan(0);
        expect(r).toBeLessThanOrEqual(EDGE_RADIUS);
      }
    }
  });

  it('sweep: every geometry on a coarse grid is finite and box-avoiding', () => {
    const deltas = [-600, -300, -196, -100, -40, 0, 40, 100, 196, 300, 600];
    for (const dx of deltas) {
      for (const dy of deltas) {
        const b = box(dx, dy);
        const r = routeEdge(A, b);
        expectFinitePath(r.d);
        if (hasCorridor(A, b)) {
          // The arrow-matches-path guarantee holds for every geometry the
          // router can actually route around; when the boxes themselves
          // overlap the wire is buried underneath them and its clamped
          // final leg may degenerate, so only finiteness is promised there.
          expect(finalDir(r.points)).toBe(r.dir);
          expectAvoidsBoxes(r, A, b);
          expect(pointInRect(r.label, A)).toBe(false);
          expect(pointInRect(r.label, b)).toBe(false);
        }
      }
    }
  });
});

describe('routeEdge labels', () => {
  it('anchors the label in the clear corridor between the boxes', () => {
    // Horizontal route: label x strictly between the facing edges.
    const right = routeEdge(A, box(400, 300));
    expect(right.label.x).toBeGreaterThan(W);
    expect(right.label.x).toBeLessThan(400);

    const left = routeEdge(A, box(-400, 0));
    expect(left.label.x).toBeGreaterThan(-400 + W);
    expect(left.label.x).toBeLessThan(0);

    // Vertical route: label y strictly between the facing edges.
    const down = routeEdge(A, box(60, 300));
    expect(down.label.y).toBeGreaterThan(H);
    expect(down.label.y).toBeLessThan(300);

    const up = routeEdge(A, box(0, -300));
    expect(up.label.y).toBeGreaterThan(-300 + H);
    expect(up.label.y).toBeLessThan(0);
  });
});

describe('parallel (bidirectional) edges', () => {
  it('lanes separate an A->B / B->A pair into two visible wires', () => {
    const b = box(400, 0);
    const ab = routeEdge(A, b, -1);
    const ba = routeEdge(b, A, 1);
    expect(ab.d).not.toBe(ba.d);
    // Two straight wires 16px apart instead of one fused line.
    expect(Math.abs(ab.points[0]!.y - ba.points[0]!.y)).toBe(16);
    // Arrowheads land on different rows at opposite ends.
    expect(ab.tip.y).not.toBe(ba.tip.y);
    expect(ab.dir).toBe('right');
    expect(ba.dir).toBe('left');
  });

  it('lanes separate a vertical pair too', () => {
    const b = box(0, 300);
    const ab = routeEdge(A, b, -1);
    const ba = routeEdge(b, A, 1);
    expect(Math.abs(ab.points[0]!.x - ba.points[0]!.x)).toBe(16);
    expect(ab.dir).toBe('down');
    expect(ba.dir).toBe('up');
  });
});

describe('arrowPath', () => {
  it('emits four distinct axis-aligned orientations', () => {
    const tip = { x: 100, y: 50 };
    const dirs: EdgeDir[] = ['right', 'left', 'down', 'up'];
    const heads = dirs.map((d) => arrowPath(tip, d));
    expect(new Set(heads).size).toBe(4);
    for (const h of heads) expectFinitePath(h);
    // The head's base sits ARROW_LEN behind the tip, against the travel
    // direction, so the triangle points the way the wire arrives.
    expect(heads[0]).toContain(`${100 - ARROW_LEN},`);
    expect(heads[1]).toContain(`${100 + ARROW_LEN},`);
    expect(heads[2]).toContain(`,${50 - ARROW_LEN}`);
    expect(heads[3]).toContain(`,${50 + ARROW_LEN}`);
  });
});

describe('previewPath', () => {
  it('exits the side facing the pointer and stays finite', () => {
    // Pointer right: leaves the right edge at the port row.
    expect(previewPath(A, 400, 44)).toMatch(/^M184,44/);
    // Pointer left: leaves the left edge.
    expect(previewPath(A, -200, 44)).toMatch(/^M0,44/);
    // Pointer below: leaves the bottom edge at the column centre.
    expect(previewPath(A, 92, 300)).toMatch(/^M92,88/);
    // Pointer above: leaves the top edge.
    expect(previewPath(A, 92, -200)).toMatch(/^M92,0/);
    for (const [px, py] of [
      [400, 44],
      [-200, 300],
      [92, -200],
      [50, 50],
      [0, 0],
    ] as const) {
      expectFinitePath(previewPath(A, px, py));
    }
  });
});
