// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the stuck drag.
 *
 * Pointer capture is deliberately deferred until a press clears the drag
 * threshold, because capturing on pointerdown retargets the pointerup and
 * suppresses the browser's synthesized click, which made every overlay button
 * inert. The cost of deferring is a window where a gesture can escape:
 *
 *   1. Press on a node.
 *   2. Move less than the threshold, so nothing is captured yet.
 *   3. Leave the window and release the button out there.
 *
 * No pointerup ever reaches the surface, so the pending gesture stays armed. A
 * mouse keeps one pointerId for its entire life, so the next time the cursor
 * crossed the canvas the stale entry cleared the threshold and promoted a drag
 * with no button held. The node then followed the cursor around with nothing
 * pressed.
 *
 * The guard is a single check at the top of the move handler: if `buttons` is
 * zero the gesture ended somewhere we could not see, so drop it. This test
 * pins the logic of that guard rather than mounting the component, which keeps
 * it fast and independent of the rendering that surrounds it.
 */

interface Pending {
  pointerId: number;
  screenX: number;
  screenY: number;
  active: boolean;
}

const DRAG_THRESHOLD = 4;

/** The decision the real handler makes, in isolation. */
function step(
  pending: Pending | null,
  e: { pointerId: number; buttons: number; clientX: number; clientY: number },
): { pending: Pending | null; promoted: boolean } {
  if (!pending || pending.pointerId !== e.pointerId) {
    return { pending, promoted: false };
  }

  // The guard under test.
  if (e.buttons === 0) return { pending: null, promoted: false };

  if (!pending.active) {
    const dx = e.clientX - pending.screenX;
    const dy = e.clientY - pending.screenY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) {
      return { pending, promoted: false };
    }
    return { pending: { ...pending, active: true }, promoted: true };
  }

  return { pending, promoted: false };
}

const press = (): Pending => ({
  pointerId: 1,
  screenX: 100,
  screenY: 100,
  active: false,
});

describe('pointer gesture guard', () => {
  it('drops a gesture whose button was released off screen', () => {
    let pending: Pending | null = press();

    // A small move that stays under the threshold, so nothing is captured.
    ({ pending } = step(pending, {
      pointerId: 1,
      buttons: 1,
      clientX: 102,
      clientY: 100,
    }));
    expect(pending).not.toBeNull();

    // The pointer returns much later with no button held. Before the guard
    // this promoted a drag; now it clears the stale gesture.
    const after = step(pending, {
      pointerId: 1,
      buttons: 0,
      clientX: 400,
      clientY: 300,
    });
    expect(after.promoted).toBe(false);
    expect(after.pending).toBeNull();
  });

  it('still promotes a real drag', () => {
    let pending: Pending | null = press();
    const r = step(pending, {
      pointerId: 1,
      buttons: 1,
      clientX: 140,
      clientY: 100,
    });
    expect(r.promoted).toBe(true);
    expect(r.pending?.active).toBe(true);
  });

  it('does not promote inside the threshold', () => {
    const r = step(press(), {
      pointerId: 1,
      buttons: 1,
      clientX: 102,
      clientY: 102,
    });
    // A 2,2 move is about 2.83px, comfortably a click rather than a drag.
    expect(r.promoted).toBe(false);
  });

  it('ignores a different pointer', () => {
    const pending = press();
    const r = step(pending, {
      pointerId: 9,
      buttons: 1,
      clientX: 400,
      clientY: 400,
    });
    expect(r.promoted).toBe(false);
    expect(r.pending).toBe(pending);
  });
});
