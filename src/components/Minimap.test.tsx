// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

/**
 * The minimap's geometry, in isolation.
 *
 * The component reads the canvas viewport and paints a rectangle showing
 * which part of the diagram is on screen. Two things go wrong easily and
 * both did: the rectangle spilling outside the map when the visible area is
 * larger than the diagram, and it collapsing to nothing when the surface has
 * not been measured yet. These pin the arithmetic behind both.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The world rect the camera can currently see. Mirrors Minimap.tsx. */
function viewWorld(
  view: { x: number; y: number; k: number },
  surface: { width: number; height: number },
): Box {
  return {
    x: -view.x / view.k,
    y: -view.y / view.k,
    w: surface.width / view.k,
    h: surface.height / view.k,
  };
}

/** The clamped rectangle, in map px. */
function viewportRect(world: Box, fit: { k: number; w: number; h: number }, v: Box) {
  const x0 = (v.x - world.x) * fit.k;
  const y0 = (v.y - world.y) * fit.k;
  const left = Math.min(Math.max(0, x0), fit.w);
  const top = Math.min(Math.max(0, y0), fit.h);
  const right = Math.min(Math.max(0, x0 + v.w * fit.k), fit.w);
  const bottom = Math.min(Math.max(0, y0 + v.h * fit.k), fit.h);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

const world: Box = { x: 0, y: 0, w: 1000, h: 500 };
const fit = { k: 0.168, w: 168, h: 84 };

describe('minimap viewport', () => {
  it('never spills outside the map', () => {
    // Zoomed out far enough, the visible area is LARGER than everything
    // there is to see. An unclamped rectangle then paints past the map and
    // out over the canvas, which is what this stops.
    const v = viewWorld({ x: 0, y: 0, k: 0.2 }, { width: 4000, height: 2000 });
    const r = viewportRect(world, fit, v);
    expect(r.left + r.width).toBeLessThanOrEqual(fit.w + 0.001);
    expect(r.top + r.height).toBeLessThanOrEqual(fit.h + 0.001);
  });

  it('starts at the map edge rather than at a negative offset', () => {
    // Panned past the top-left of the content, the visible rect begins at a
    // negative world coordinate. Left unclamped that becomes a negative
    // `left`, and the rectangle hangs off the corner of the map.
    const v = viewWorld({ x: 400, y: 300, k: 1 }, { width: 800, height: 600 });
    const r = viewportRect(world, fit, v);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
  });

  it('covers most of the map when the whole diagram is on screen', () => {
    // The reading a student actually uses: fit the diagram, and the
    // rectangle should say "you can see all of this".
    const v = viewWorld({ x: 0, y: 0, k: 1 }, { width: 1000, height: 500 });
    const r = viewportRect(world, fit, v);
    expect(r.width).toBeGreaterThan(fit.w * 0.9);
    expect(r.height).toBeGreaterThan(fit.h * 0.9);
  });

  it('shrinks as the camera zooms in', () => {
    const wide = viewportRect(
      world,
      fit,
      viewWorld({ x: 0, y: 0, k: 1 }, { width: 1000, height: 500 }),
    );
    const close = viewportRect(
      world,
      fit,
      viewWorld({ x: 0, y: 0, k: 4 }, { width: 1000, height: 500 }),
    );
    expect(close.width).toBeLessThan(wide.width);
  });

  it('shrinks as the camera pans off the content, rather than sticking', () => {
    // The bug this replaced: clamping only the near edge pinned the box at
    // the top left and left it the same size, so a camera sitting on the
    // corner and one a mile past it looked identical.
    const onEdge = viewportRect(
      world,
      fit,
      viewWorld({ x: 0, y: 0, k: 1 }, { width: 400, height: 200 }),
    );
    const wayOff = viewportRect(
      world,
      fit,
      viewWorld({ x: 900, y: 400, k: 1 }, { width: 400, height: 200 }),
    );
    expect(wayOff.width).toBeLessThan(onEdge.width);
  });

  it('disappears entirely when the camera is nowhere near the content', () => {
    const gone = viewportRect(
      world,
      fit,
      viewWorld({ x: 9000, y: 9000, k: 1 }, { width: 400, height: 200 }),
    );
    expect(gone.width).toBe(0);
  });

  it('collapses to nothing before the surface has been measured', () => {
    // A zero surface is the state between mounting and the first measure.
    // It must produce an empty rectangle rather than NaN, which would
    // silently blank the whole map.
    const v = viewWorld({ x: 0, y: 0, k: 1 }, { width: 0, height: 0 });
    const r = viewportRect(world, fit, v);
    expect(Number.isFinite(r.width)).toBe(true);
    expect(r.width).toBe(0);
  });
});
