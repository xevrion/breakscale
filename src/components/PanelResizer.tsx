import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import './PanelResizer.css';

/* ==========================================================================
   The drag handle that resizes a panel.

   WHY IT WRITES CSS DIRECTLY. The three panel sizes live as custom
   properties on .app-body, and a drag updates them by writing the property
   on the element rather than by setting React state. The canvas re-renders
   at 10Hz off the simulation snapshot; routing a 60Hz drag through state
   would put a React render between every pointer frame and make the whole
   diagram stutter while the panel moved. The committed value IS stored in
   React, once, at the end of the gesture, which is what gets persisted.

   Sizes are clamped here rather than in CSS so that the stored number is
   already legal: a min/max in CSS would let an out-of-range value round-trip
   through storage and come back looking valid.
   ========================================================================== */

export type ResizeEdge = 'left' | 'right' | 'bottom';

export interface PanelResizerProps {
  /** Which panel edge this handle drags. */
  edge: ResizeEdge;
  /** The custom property to write, e.g. '--rail-w'. */
  property: string;
  /** Current size in px, used as the drag origin. */
  size: number;
  min: number;
  max: number;
  /** Commit the final size once, at the end of the gesture. */
  onCommit: (size: number) => void;
  /** Restore the shipped default. Bound to a double-click on the handle. */
  onReset: () => void;
  /** Accessible name, e.g. "Resize the components rail". */
  label: string;
}

/** Where to write the custom property. Both slots share one owner. */
function owner(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>('.app-body') ?? null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function PanelResizer({
  edge,
  property,
  size,
  min,
  max,
  onCommit,
  onReset,
  label,
}: PanelResizerProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; from: number; origin: number } | null>(null);
  /**
   * The live size during a drag. A ref rather than state for the reason in
   * the header: nothing may re-render per pointer frame.
   */
  const live = useRef(size);

  const write = useCallback(
    (v: number) => {
      live.current = v;
      owner(elRef.current)?.style.setProperty(property, `${v}px`);
    },
    [property],
  );

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag.current = {
        id: e.pointerId,
        // The bottom strip grows UPWARD, so its delta is inverted against
        // the pointer's y. The left rail grows right, the right rail left.
        from: edge === 'bottom' ? e.clientY : e.clientX,
        origin: size,
      };
      live.current = size;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a convenience: without it the window listeners below
        // still finish the gesture. Never let it throw the drag away.
      }
    },
    [edge, size],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      // The same stuck-drag guard the canvas uses: a release that happened
      // outside the window leaves no pointerup, so a zero button mask means
      // the gesture is already over.
      if (e.buttons === 0) {
        drag.current = null;
        onCommit(live.current);
        return;
      }
      const now = edge === 'bottom' ? e.clientY : e.clientX;
      const delta = now - d.from;
      const signed = edge === 'left' ? delta : edge === 'right' ? -delta : -delta;
      write(clamp(Math.round(d.origin + signed), min, max));
    },
    [edge, min, max, write, onCommit],
  );

  const end = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released, or never captured.
      }
      onCommit(live.current);
    },
    [onCommit],
  );

  /**
   * Keyboard resizing. A drag handle that only responds to a pointer is
   * unusable for anyone who does not use one, and this is a real control
   * with a real value, so it gets arrow keys and a slider role.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 1 : 16;
      const grow = edge === 'bottom' ? 'ArrowUp' : 'ArrowRight';
      const shrink = edge === 'bottom' ? 'ArrowDown' : 'ArrowLeft';
      // The right rail grows leftward, so its keys are the other way round.
      const dir = edge === 'right' ? -1 : 1;
      let next: number | null = null;
      if (e.key === grow) next = size + step * dir;
      else if (e.key === shrink) next = size - step * dir;
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      if (next === null) return;
      e.preventDefault();
      const v = clamp(Math.round(next), min, max);
      write(v);
      onCommit(v);
    },
    [edge, size, min, max, write, onCommit],
  );

  // The committed size flows back in as a prop (undo, a reset, another
  // window). Sync the property so the two can never disagree.
  useEffect(() => {
    if (drag.current) return;
    write(size);
  }, [size, write]);

  return (
    <div
      ref={elRef}
      className={`pr pr-${edge}`}
      data-chrome="panel-resize"
      role="separator"
      aria-orientation={edge === 'bottom' ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      // A double-click on a divider restoring the default is the convention
      // every editor with draggable panes shares, and it is the way back
      // from a panel dragged somewhere unusable.
      onDoubleClick={onReset}
    />
  );
}
