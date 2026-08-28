import { useCallback, useEffect, useState } from 'react';

/**
 * Exit presence for a panel that slides out before it unmounts.
 *
 * A conditionally rendered panel cannot animate its exit: the element is gone
 * from the DOM a frame before any transition could run. This hook keeps the
 * panel mounted through the exit. `mounted` is what the caller renders on;
 * `closing` is true only during the exit window, and is what the caller uses
 * to apply the exit animation class and to mark the panel `inert` so a
 * leaving panel is never focusable or readable mid-flight.
 *
 * Unmounting is driven by the caller reporting `animationend` via `unmount`,
 * with a timeout as the safety net: if the exit animation never fires (a
 * stylesheet that sets `animation: none`, a display: none ancestor), the
 * panel still leaves the DOM instead of lingering forever. The timeout is
 * deliberately longer than the longest motion token (200ms), so under normal
 * conditions `animationend` always wins.
 *
 * Costs nothing while idle: a closed panel is fully unmounted, and an open
 * one carries no timers and no listeners.
 */
export function usePresence(
  open: boolean,
  timeoutMs = 300,
): { mounted: boolean; closing: boolean; unmount: () => void } {
  const [mounted, setMounted] = useState(open);

  // Opening must mount synchronously, in this same render, so the entrance
  // animation's first frame is the first frame the panel exists. This is the
  // documented "adjust state during render" pattern; React re-renders
  // immediately without committing the intermediate state.
  if (open && !mounted) setMounted(true);

  const closing = mounted && !open;

  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => setMounted(false), timeoutMs);
    return () => window.clearTimeout(t);
  }, [closing, timeoutMs]);

  const unmount = useCallback(() => setMounted(false), []);

  return { mounted, closing, unmount };
}
