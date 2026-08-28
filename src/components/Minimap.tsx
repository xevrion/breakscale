import { memo, useCallback, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { SimNode } from '../sim/types';
import './Minimap.css';

/* ==========================================================================
   Minimap.

   WHY IT EXISTS. A twenty-node company architecture is several screens wide
   at a readable zoom, and the only ways to find the part you wanted were to
   zoom out until the labels were unreadable, or to pan and hope. This shows
   the whole diagram at once and says which piece of it you are looking at.

   DELIBERATELY NOT A SECOND RENDERER. Nodes are plain rectangles here, in
   their kind's colour, with no labels, no metrics and no edges. It is a map,
   not a thumbnail: at this size a label is illegible and an edge is noise,
   and every detail added is another thing that can disagree with the canvas.
   ========================================================================== */

const NODE_W = 184;
const NODE_H = 88;

export interface MinimapProps {
  nodes: readonly SimNode[];
  /** Current viewport in world units, so the map can outline it. */
  view: { x: number; y: number; k: number };
  /** Size of the canvas surface in screen px. */
  surface: { width: number; height: number };
  /** Centre the canvas on this world point. */
  onGoTo: (worldX: number, worldY: number) => void;
}

const PAD = 120;

export const Minimap = memo(function Minimap({
  nodes,
  view,
  surface,
  onGoTo,
}: MinimapProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  /** World bounds of the whole diagram, padded so nothing touches the edge. */
  const world = useMemo(() => {
    if (nodes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
      if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
    }
    return {
      x: minX - PAD,
      y: minY - PAD,
      w: maxX - minX + PAD * 2,
      h: maxY - minY + PAD * 2,
    };
  }, [nodes]);

  /* One scale for both axes, so the map is not a distorted picture of the
     diagram. The smaller of the two fits the long side. */
  const fit = useMemo(() => {
    if (!world) return null;
    const box = 168;
    const k = Math.min(box / world.w, box / world.h);
    return { k, w: world.w * k, h: world.h * k };
  }, [world]);

  /** Convert a click in the map back to the world point it stands for. */
  const goToEvent = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const el = boxRef.current;
      if (!el || !world || !fit) return;
      const r = el.getBoundingClientRect();
      onGoTo(
        world.x + (e.clientX - r.left) / fit.k,
        world.y + (e.clientY - r.top) / fit.k,
      );
    },
    [world, fit, onGoTo],
  );

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a convenience; the gesture still works without it.
      }
      goToEvent(e);
    },
    [goToEvent],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Dragging scrubs the view, which is how a minimap is actually used:
      // press roughly where you want to be, then adjust without letting go.
      if (!dragging.current || e.buttons === 0) return;
      goToEvent(e);
    },
    [goToEvent],
  );

  const onUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
  }, []);

  if (!world || !fit || nodes.length === 0) return null;

  // The viewport, expressed in world units then mapped like everything else.
  const viewWorld = {
    x: -view.x / view.k,
    y: -view.y / view.k,
    w: surface.width / view.k,
    h: surface.height / view.k,
  };

  return (
    <div
      ref={boxRef}
      className="mm"
      data-chrome="minimap"
      style={{ width: fit.w, height: fit.h }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role="presentation"
      aria-hidden="true"
    >
      {nodes.map((n) => (
        <span
          key={n.id}
          className="mm-node"
          data-kind={n.kind}
          style={{
            left: (n.x - world.x) * fit.k,
            top: (n.y - world.y) * fit.k,
            // A node under about 2px reads as dirt on the screen rather than
            // as a component, so the marks have a floor.
            width: Math.max(2, NODE_W * fit.k),
            height: Math.max(2, NODE_H * fit.k),
          }}
        />
      ))}
      {/* The viewport, clamped to the map's own bounds.

          Zoomed out far enough, or on a small diagram, the visible area is
          LARGER than everything there is to see, and an unclamped rectangle
          spills past the map and out over the canvas. Clamping says the
          honest thing instead: the whole map is on screen. */}
      <span
        className="mm-view"
        style={{
          left: Math.max(0, (viewWorld.x - world.x) * fit.k),
          top: Math.max(0, (viewWorld.y - world.y) * fit.k),
          width: Math.min(
            viewWorld.w * fit.k,
            fit.w - Math.max(0, (viewWorld.x - world.x) * fit.k),
          ),
          height: Math.min(
            viewWorld.h * fit.k,
            fit.h - Math.max(0, (viewWorld.y - world.y) * fit.k),
          ),
        }}
      />
    </div>
  );
});
