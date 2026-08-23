// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { __placeForTest as place, TOOLTIP_GEOMETRY } from './Tooltip';

/**
 * Positioning tests.
 *
 * These are written against the REAL viewport this app is used at and the
 * REAL geometry of its panels, because the two cases that break naive
 * tooltip positioning here are concrete: a term in the rightmost inspector
 * field, and a term in the bottom metrics strip. A tooltip centred on its
 * trigger overflows the viewport in the first case and is placed off the
 * bottom of the screen in the second.
 */

const { VIEWPORT_MARGIN, OFFSET } = TOOLTIP_GEOMETRY;

/** The window size the layout was designed against. */
const VW = 1512;
const VH = 900;

/** A representative measured panel: 300px wide (the cap), 150px tall. */
const PW = 300;
const PH = 150;

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
}

function rect(left: number, top: number, width = 40, height = 18): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Asserts the panel is fully inside the viewport with its margin honoured. */
function expectOnScreen(
  p: { left: number; top: number },
  pw = PW,
  ph = PH,
  vw = VW,
  vh = VH,
): void {
  expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(p.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(p.left + pw).toBeLessThanOrEqual(vw - VIEWPORT_MARGIN);
  expect(p.top + ph).toBeLessThanOrEqual(vh - VIEWPORT_MARGIN);
}

beforeEach(() => setViewport(VW, VH));

describe('place', () => {
  it('prefers above and centres on the trigger when there is room', () => {
    const t = rect(700, 400);
    const p = place(t, PW, PH);
    expect(p.side).toBe('top');
    // Centred: panel centre lines up with trigger centre.
    expect(p.left + PW / 2).toBe(t.left + t.width / 2);
    expect(p.top).toBe(t.top - OFFSET - PH);
    expectOnScreen(p);
  });

  it('flips below when the trigger is against the top bar', () => {
    // The app bar is 72px tall, so a term in it sits around y=30.
    const p = place(rect(700, 30), PW, PH);
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(30 + 18 + OFFSET);
    expectOnScreen(p);
  });

  /* -------- THE INSPECTOR CASE -------- */

  it('shifts left so a term in the rightmost inspector field stays on screen', () => {
    // The inspector rail is 320px wide and hard against the right edge. A
    // value sits right-aligned near x=1470.
    const t = rect(1440, 400, 60);
    const p = place(t, PW, PH);
    expectOnScreen(p);
    // Centring would have put it at 1440+30-150 = 1320, overflowing to 1620.
    expect(p.left).toBe(VW - PW - VIEWPORT_MARGIN);
    expect(p.left + PW).toBeLessThanOrEqual(VW - VIEWPORT_MARGIN);
  });

  it('keeps the arrow pointing at a shifted trigger', () => {
    const t = rect(1440, 400, 60);
    const p = place(t, PW, PH);
    const triggerCentre = t.left + t.width / 2;
    // Arrow offset is panel-local, so panel left + offset must land on the
    // trigger's centre.
    expect(p.left + p.arrowOffset).toBe(triggerCentre);
  });

  it('drops the arrow rather than pointing it at nothing', () => {
    // A trigger jammed into the very corner: the panel cannot shift far
    // enough for the arrow to reach it without colliding with the radius.
    const p = place(rect(1500, 400, 10), PW, PH);
    expect(p.arrowOffset).toBe(-1);
    expectOnScreen(p);
  });

  /* -------- THE METRICS STRIP CASE -------- */

  it('opens upward for a term in the bottom metrics strip', () => {
    // The strip is ~240px tall at the bottom of a 900px viewport.
    const t = rect(600, 830);
    const p = place(t, PW, PH);
    expect(p.side).toBe('top');
    expect(p.top).toBe(830 - OFFSET - PH);
    expectOnScreen(p);
  });

  it('never places a panel off the bottom of the viewport', () => {
    // Every 8px band of the viewport, at the left, middle and right.
    for (let y = 0; y <= VH - 18; y += 8) {
      for (const x of [12, 700, 1440]) {
        const p = place(rect(x, y), PW, PH);
        expectOnScreen(p);
      }
    }
  });

  /* -------- SHORT VIEWPORT: neither vertical side fits -------- */

  it('goes to the side when neither above nor below has room', () => {
    // A 300px-tall window with a term in the middle: 150px of panel does not
    // fit above or below, but there is plenty of horizontal room.
    setViewport(VW, 300);
    const p = place(rect(700, 140), PW, PH);
    expect(['left', 'right']).toContain(p.side);
    expectOnScreen(p, PW, PH, VW, 300);
  });

  it('clamps rather than escaping when nothing fits at all', () => {
    // Smaller than the panel in both axes. It cannot be placed correctly, but
    // it must still be reachable rather than rendered off-screen.
    setViewport(280, 130);
    const p = place(rect(140, 60), PW, PH);
    expect(p.left).toBe(VIEWPORT_MARGIN);
    expect(p.top).toBe(VIEWPORT_MARGIN);
  });

  it('places a side tooltip vertically centred on its trigger', () => {
    setViewport(VW, 300);
    const t = rect(700, 140);
    const p = place(t, PW, PH);
    expect(p.top + PH / 2).toBe(t.top + t.height / 2);
  });

  it('returns integers so the panel never lands on a half pixel', () => {
    // A trigger of odd width centred against an odd panel width is the case
    // that produces fractional coordinates and blurred text.
    const p = place(rect(700.5, 400.5, 37), 301, 149);
    expect(Number.isInteger(p.left)).toBe(true);
    expect(Number.isInteger(p.top)).toBe(true);
  });
});
