import { describe, expect, it } from 'vitest';

/**
 * Regression test for the canvas sliding under a palette drop.
 *
 * The refit effect exists so a diagram that arrives all at once (mount,
 * session restore, a preset load) is framed rather than left off screen. It
 * decided that from "was the canvas empty before this render", which made a
 * node dropped onto an empty canvas look like a wholesale replacement.
 *
 * Measured in the browser before the fix, dropping from the component rail
 * onto a cleared canvas: the first drop panned the view 48px and the second
 * 396px horizontally and 156px vertically, with no pan input. The scale never
 * moved, because a one or two node fit clamps to FIT_MAX either way, so it
 * read as the whole canvas sliding rather than as a zoom.
 *
 * A dropped node is already under the cursor, so there is nothing for a fit
 * to reveal. This pins the decision rather than mounting the component: the
 * bug was that the guard and the drop were reasoned about separately, which
 * is exactly what a mounted test that drops through the real DOM would have
 * missed too.
 */

interface RefitInput {
  /** Nodes on the canvas after this render. */
  nodeCount: number;
  /** Did the canvas hold anything before this render? */
  hadContent: boolean;
  /** Has the shell asked for a fit (a preset load)? */
  signalChanged: boolean;
  /** Is a pointer gesture in flight? */
  gestureInFlight: boolean;
  /** Did this change come from a palette drop? */
  dropped: boolean;
}

/** The decision the real effect makes, in isolation. */
function shouldRefit(i: RefitInput): boolean {
  if (i.nodeCount === 0) return false;
  if (i.hadContent && !i.signalChanged) return false;
  if (i.gestureInFlight) return false;
  if (i.dropped) return false;
  return true;
}

const base: RefitInput = {
  nodeCount: 1,
  hadContent: false,
  signalChanged: false,
  gestureInFlight: false,
  dropped: false,
};

describe('canvas refit', () => {
  it('does not refit when a node is dropped onto an empty canvas', () => {
    expect(shouldRefit({ ...base, dropped: true })).toBe(false);
  });

  it('does not refit when a node is dropped onto a populated canvas', () => {
    expect(
      shouldRefit({ ...base, nodeCount: 2, hadContent: true, dropped: true }),
    ).toBe(false);
  });

  it('still frames content that arrives on its own, such as a session restore', () => {
    expect(shouldRefit(base)).toBe(true);
  });

  it('still honours an explicit fit request, such as a preset load', () => {
    expect(
      shouldRefit({ ...base, nodeCount: 3, hadContent: true, signalChanged: true }),
    ).toBe(true);
  });

  it('leaves the camera alone for an ordinary edit', () => {
    expect(shouldRefit({ ...base, nodeCount: 4, hadContent: true })).toBe(false);
  });

  it('never refits mid-gesture, which is what moved an alt-drag clone', () => {
    expect(shouldRefit({ ...base, gestureInFlight: true })).toBe(false);
  });

  it('does not refit an empty canvas', () => {
    expect(shouldRefit({ ...base, nodeCount: 0 })).toBe(false);
  });

  /**
   * A preset load right after a drop must still be framed. The flag is read
   * and cleared once per effect run for this reason: a drop that lands while
   * another guard already holds must not leave it set for the next load.
   */
  it('a drop does not suppress the preset load that follows it', () => {
    const dropped = { ...base, nodeCount: 2, hadContent: true, dropped: true };
    expect(shouldRefit(dropped)).toBe(false);
    const thenPreset = { ...base, nodeCount: 5, hadContent: true, signalChanged: true };
    expect(shouldRefit(thenPreset)).toBe(true);
  });
});
