import { describe, expect, it } from 'vitest';

/**
 * Pointer-type handling for pen, touch and smartboard input.
 *
 * The canvas's pointer router is a state machine driven by decisions that
 * live in pointerInput.ts precisely so they can be pinned here without
 * mounting the component: the per-pointer-type drag threshold, press
 * routing (barrel button, eraser, middle-pan), palm rejection, the
 * multi-pointer touch map, the pinch maths, and the cancel path. The same
 * approach as Canvas.gesture.test.tsx: test the logic, not the rendering
 * around it.
 */

import {
  DRAG_THRESHOLD_COARSE,
  DRAG_THRESHOLD_MOUSE,
  PALM_CONTACT_PX,
  beginPinch,
  distance,
  dragThresholdFor,
  endPointer,
  isPalmTouch,
  midpoint,
  pinchFrame,
  pressAction,
  snapsToGrid,
} from './pointerInput';
import type { PinchState, PointerPoint, TouchMap } from './pointerInput';

/* ------------------------------------------------------------------ *
 * Drag threshold per pointer type
 * ------------------------------------------------------------------ */

describe('dragThresholdFor', () => {
  it('keeps the 4px threshold for a mouse', () => {
    expect(dragThresholdFor('mouse')).toBe(DRAG_THRESHOLD_MOUSE);
    expect(dragThresholdFor('mouse')).toBe(4);
  });

  it('widens to 10px for a finger and a pen, which jitter', () => {
    expect(dragThresholdFor('touch')).toBe(DRAG_THRESHOLD_COARSE);
    expect(dragThresholdFor('pen')).toBe(DRAG_THRESHOLD_COARSE);
    expect(DRAG_THRESHOLD_COARSE).toBe(10);
  });

  it('treats an unknown or empty pointerType as a mouse', () => {
    // Older engines and synthetic events report ''; the strict threshold is
    // the safe default because it only ever risks a drag, never a lost tap
    // promotion for real touch hardware, which always reports its type.
    expect(dragThresholdFor('')).toBe(DRAG_THRESHOLD_MOUSE);
  });

  it('turns a tap-with-jitter into a click, not a drag', () => {
    // The decision the move handler makes: promote only past the threshold.
    const promotes = (type: string, dx: number, dy: number) => {
      const t = dragThresholdFor(type);
      return dx * dx + dy * dy >= t * t;
    };
    // A 6px wobble is a deliberate mouse drag but touch/pen tap noise.
    expect(promotes('mouse', 6, 0)).toBe(true);
    expect(promotes('touch', 6, 0)).toBe(false);
    expect(promotes('pen', 6, 0)).toBe(false);
    // Real motion still promotes for everyone.
    expect(promotes('touch', 8, 8)).toBe(true);
    expect(promotes('pen', 10, 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Press routing: barrel button, eraser, middle-pan
 * ------------------------------------------------------------------ */

describe('pressAction', () => {
  it('routes a primary press to a gesture for every pointer type', () => {
    expect(pressAction(0, 'mouse')).toBe('gesture');
    expect(pressAction(0, 'touch')).toBe('gesture');
    expect(pressAction(0, 'pen')).toBe('gesture');
  });

  it('keeps the mouse middle button as a forced pan', () => {
    expect(pressAction(1, 'mouse')).toBe('pan');
  });

  it('never misreads a pen barrel-button press as a normal press', () => {
    // A pen contact with the barrel button held reports button 2.
    expect(pressAction(2, 'pen')).toBe('none');
    // The eraser tip reports button 5.
    expect(pressAction(5, 'pen')).toBe('none');
  });

  it('ignores right-click and non-mouse middle values', () => {
    expect(pressAction(2, 'mouse')).toBe('none');
    expect(pressAction(1, 'pen')).toBe('none');
    expect(pressAction(1, 'touch')).toBe('none');
  });
});

/* ------------------------------------------------------------------ *
 * Palm rejection
 * ------------------------------------------------------------------ */

describe('isPalmTouch', () => {
  it('rejects a palm-sized contact on either axis', () => {
    expect(isPalmTouch('touch', PALM_CONTACT_PX, 10, false)).toBe(true);
    expect(isPalmTouch('touch', 10, PALM_CONTACT_PX, false)).toBe(true);
    expect(isPalmTouch('touch', 80, 60, false)).toBe(true);
  });

  it('never rejects a fingertip-sized contact', () => {
    // Typical fingertip contacts run 20-35 CSS px.
    expect(isPalmTouch('touch', 24, 28, false)).toBe(false);
    expect(isPalmTouch('touch', 35, 35, false)).toBe(false);
  });

  it('never rejects hardware that does not report contact size', () => {
    // Unsupported hardware reports 0 (some engines 1). Rejecting a
    // legitimate touch is worse than admitting a palm, so unknown size is
    // always admitted.
    expect(isPalmTouch('touch', 0, 0, false)).toBe(false);
    expect(isPalmTouch('touch', 1, 1, false)).toBe(false);
  });

  it('rejects every touch while the pen is in contact (pen priority)', () => {
    expect(isPalmTouch('touch', 0, 0, true)).toBe(true);
    expect(isPalmTouch('touch', 24, 24, true)).toBe(true);
  });

  it('only ever rejects touches, whatever the size reports', () => {
    expect(isPalmTouch('pen', 500, 500, false)).toBe(false);
    expect(isPalmTouch('mouse', 500, 500, true)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Multi-pointer map and pinch
 * ------------------------------------------------------------------ */

const touchMap = (entries: [number, PointerPoint][]): TouchMap => new Map(entries);

describe('pinch', () => {
  it('does not begin from a single finger', () => {
    expect(beginPinch(touchMap([[1, { x: 100, y: 100 }]]), 1)).toBeNull();
    expect(beginPinch(touchMap([]), 1)).toBeNull();
  });

  it('records the initial distance, scale and midpoint', () => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 200, y: 100 }],
    ]);
    const pinch = beginPinch(touches, 1.5);
    expect(pinch).not.toBeNull();
    expect(pinch!.a).toBe(1);
    expect(pinch!.b).toBe(2);
    expect(pinch!.d0).toBe(100);
    expect(pinch!.k0).toBe(1.5);
    expect(pinch!.lastMid).toEqual({ x: 150, y: 100 });
  });

  it('floors a degenerate start distance so ratios cannot explode', () => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 100, y: 100 }],
    ]);
    expect(beginPinch(touches, 1)!.d0).toBe(1);
  });

  it('doubling the spread targets exactly double the scale', () => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 200, y: 100 }],
    ]);
    const pinch = beginPinch(touches, 1)!;
    touches.set(1, { x: 50, y: 100 });
    touches.set(2, { x: 250, y: 100 });
    const frame = pinchFrame(pinch, touches)!;
    expect(frame.k).toBe(2);
    // Spread about the same centre: the midpoint has not moved, so no pan.
    expect(frame.dx).toBe(0);
    expect(frame.dy).toBe(0);
  });

  it('pans by the midpoint delta while two fingers travel together', () => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 200, y: 100 }],
    ]);
    const pinch = beginPinch(touches, 1)!;
    touches.set(1, { x: 130, y: 140 });
    touches.set(2, { x: 230, y: 140 });
    const frame = pinchFrame(pinch, touches)!;
    // Same spread, so no zoom; the midpoint moved (30, 40).
    expect(frame.k).toBe(1);
    expect(frame.dx).toBe(30);
    expect(frame.dy).toBe(40);
    expect(frame.mid).toEqual({ x: 180, y: 140 });
  });

  it('targets the ABSOLUTE scale, so a round trip lands back on k0', () => {
    const touches = touchMap([
      [1, { x: 0, y: 0 }],
      [2, { x: 100, y: 0 }],
    ]);
    const pinch = beginPinch(touches, 1.25)!;
    // Out to 173px, back in to 100px: many frames of drift-prone maths in
    // an incremental design, exactly two absolute targets here.
    touches.set(2, { x: 173, y: 0 });
    pinchFrame(pinch, touches);
    touches.set(2, { x: 100, y: 0 });
    expect(pinchFrame(pinch, touches)!.k).toBe(1.25);
  });

  it('advancing lastMid keeps the pan delta per-frame, not cumulative', () => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 200, y: 100 }],
    ]);
    const pinch = beginPinch(touches, 1)!;
    touches.set(1, { x: 110, y: 100 });
    touches.set(2, { x: 210, y: 100 });
    const f1 = pinchFrame(pinch, touches)!;
    expect(f1.dx).toBe(10);
    pinch.lastMid = f1.mid; // what the move handler does after applying
    touches.set(1, { x: 120, y: 100 });
    touches.set(2, { x: 220, y: 100 });
    const f2 = pinchFrame(pinch, touches)!;
    expect(f2.dx).toBe(10);
  });

  it('reports null once either finger is gone', () => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 200, y: 100 }],
    ]);
    const pinch = beginPinch(touches, 1)!;
    touches.delete(2);
    expect(pinchFrame(pinch, touches)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The cancel path: pointerup and pointercancel bookkeeping
 * ------------------------------------------------------------------ */

describe('endPointer', () => {
  const setup = (): { touches: TouchMap; pinch: PinchState } => {
    const touches = touchMap([
      [1, { x: 100, y: 100 }],
      [2, { x: 200, y: 100 }],
    ]);
    return { touches, pinch: beginPinch(touches, 1)! };
  };

  it('drops the contact and ends the pinch when a pinch finger lifts', () => {
    const { touches, pinch } = setup();
    expect(endPointer(touches, pinch, 2)).toBeNull();
    expect(touches.has(2)).toBe(false);
    expect(touches.size).toBe(1);
  });

  it('treats a cancelled finger exactly like a lifted one', () => {
    // pointercancel (browser-level palm rejection, a system gesture taking
    // the pointer over) runs the same cleanup as pointerup: nothing stays
    // armed.
    const { touches, pinch } = setup();
    expect(endPointer(touches, pinch, 1)).toBeNull();
    expect(touches.size).toBe(1);
  });

  it('keeps the pinch alive when a bystander finger lifts', () => {
    const { touches, pinch } = setup();
    touches.set(3, { x: 300, y: 300 });
    expect(endPointer(touches, pinch, 3)).toBe(pinch);
    expect(touches.size).toBe(2);
    expect(pinchFrame(pinch, touches)).not.toBeNull();
  });

  it('is a clean no-op for a pointer that was never tracked', () => {
    const touches = touchMap([[1, { x: 0, y: 0 }]]);
    expect(endPointer(touches, null, 9)).toBeNull();
    expect(touches.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

describe('midpoint and distance', () => {
  it('compute the obvious values', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

/* ------------------------------------------------------------------ *
 * Grid snap
 *
 * The preference used to be decoration. `snapToGrid` was stored, defaulted,
 * sanitised on read and offered as a switch in Settings, and nothing anywhere
 * read it: every drag chose its rounding from the Ctrl key alone, so turning
 * the switch off moved a boolean and changed nothing on the canvas. A
 * typecheck cannot see that and neither can a screenshot, so it is pinned
 * here.
 * ------------------------------------------------------------------ */

describe('grid snap', () => {
  it('snaps when the preference is on and nothing is held', () => {
    expect(snapsToGrid(true, false)).toBe(true);
  });

  it('does not snap when the preference is off', () => {
    expect(snapsToGrid(false, false)).toBe(false);
  });

  it('lets Ctrl bypass the snap for the drag in progress', () => {
    expect(snapsToGrid(true, true)).toBe(false);
  });

  it('never turns snapping back on: Ctrl only ever loosens', () => {
    expect(snapsToGrid(false, true)).toBe(false);
  });
});
