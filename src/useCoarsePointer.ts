import { useSyncExternalStore } from 'react';

/**
 * Is the reader's primary input a finger?
 *
 * Kept apart from any width breakpoint on purpose: width asks how much ROOM
 * the shell has, this asks what the reader is holding. A tablet has a
 * desktop-sized screen and no keyboard; a small desktop window has a
 * keyboard and no room. Anything that exists only because a key or a hover
 * exists belongs on this query, and anything about layout belongs on the
 * other.
 *
 * `pointer: coarse` reports the PRIMARY pointer, so a laptop with a
 * touchscreen still reads fine and keeps its shortcuts. That is correct: it
 * has a keyboard.
 */
const COARSE_QUERY = '(pointer: coarse)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(COARSE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

/** No window (a test importing a component, SSR): assume a mouse. */
function serverSnapshot(): boolean {
  return false;
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, isCoarsePointer, serverSnapshot);
}
