import { useSyncExternalStore } from 'react';
import type { VendorId } from './types';

/* ------------------------------------------------------------------ *
 * Which instance size each component is running on.
 *
 * NOT in NodeConfig, and deliberately so. The engine never reads a vendor
 * size: picking `db.r6g.xlarge` writes a capacity, and capacity is the only
 * thing the simulation has ever known about. The size itself is a label the
 * interface keeps so it can price the design and show what was chosen.
 * AGENTS.md is explicit that `src/sim` is not modified to solve an
 * interface problem, and this is one.
 *
 * Keyed by node id AND vendor, because the same component priced on AWS and
 * on Azure is two different answers, and a student switching between them
 * should not find their AWS choice reinterpreted as an Azure size.
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'breakscale.sizes.v1';

type SizeMap = Record<string, string>;

const key = (vendor: VendorId, nodeId: string) => `${vendor}:${nodeId}`;

let current: SizeMap = load();
const listeners = new Set<() => void>();

function load(): SizeMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SizeMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Both halves are strings a student never types, but this is still
      // storage anyone can edit, so nothing is trusted on the way in.
      if (typeof v === 'string' && v) out[k] = v.slice(0, 120);
    }
    return out;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // A remembered size is a convenience. Losing it must never be louder
    // than that, and never a thrown error during a render.
  }
}

export function getSize(vendor: VendorId, nodeId: string): string | null {
  return current[key(vendor, nodeId)] ?? null;
}

export function setSize(vendor: VendorId, nodeId: string, name: string): void {
  current = { ...current, [key(vendor, nodeId)]: name };
  persist();
  for (const l of listeners) l();
}

/** Forget a node's size, for when the component is deleted. */
export function clearSize(vendor: VendorId, nodeId: string): void {
  if (!(key(vendor, nodeId) in current)) return;
  const next = { ...current };
  delete next[key(vendor, nodeId)];
  current = next;
  persist();
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): SizeMap {
  return current;
}

/** Subscribe to the whole map, for the panel that totals a design's cost. */
export function useSizes(): SizeMap {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export { key as sizeKey };
