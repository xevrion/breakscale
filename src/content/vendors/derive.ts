import type { NodeConfig, NodeKind } from '../../sim/types';
import type { VendorSize } from './types';

/* ------------------------------------------------------------------ *
 * From a published spec to the engine's knobs.
 *
 * THIS FILE IS THE MODEL, AND IT IS THE ONLY ONE.
 *
 * Every number in the vendor data files is a published fact with a URL.
 * Nothing here is. No vendor states how many concurrent requests an
 * instance serves, or how long each takes, because that depends on what
 * the software does: the same db.r6g.large answers 50k trivial key reads a
 * second or 20 heavy joins, and both are correct.
 *
 * The derivation below is therefore a DEFAULT, not a measurement, and it
 * is deliberately simple so that it is obviously a rule of thumb rather
 * than something that looks researched. Anything cleverer would invite the
 * reader to trust it more than it deserves.
 *
 * The interface labels every value that comes through here as derived, and
 * a student who wants their own system's behaviour is told to set the
 * knobs directly. That honesty is the feature; the numbers are scaffolding.
 * ------------------------------------------------------------------ */

/**
 * Concurrent requests one vCPU is assumed to handle at a time.
 *
 * One. A busy request occupies a core, so a 4 vCPU machine gets 4 slots.
 *
 * This is wrong in both directions and is meant to be: an IO-bound service
 * holds thousands of connections on four cores, and a CPU-bound one manages
 * fewer than one per core once it is context switching. It is here to give
 * a switched vendor a starting point that scales with the size a student
 * picked, not to predict anything.
 */
const SLOTS_PER_VCPU = 1;

/**
 * Service time is NOT derived from the instance.
 *
 * A bigger machine does not make a query faster; it makes more of them run
 * at once. Latency comes from the work, and the work is what the student is
 * modelling. Changing serviceMs when someone picks a larger instance would
 * teach the opposite of the thing this simulator exists to teach, so
 * whatever the component already had is kept.
 */
export interface Derived {
  capacity: number;
  /** Always null. Present so the caller cannot forget the reason above. */
  serviceMs: null;
}

/**
 * The capacity a size implies, for kinds where instance sizing is the thing
 * that limits concurrency.
 *
 * Kinds that are not sized this way get nothing: a CDN, a queue or a
 * managed pub/sub does not expose a vCPU count that a student is choosing,
 * and inventing a slot count for one would be exactly the plausible-looking
 * number AGENTS.md forbids.
 */
const SIZED_KINDS: ReadonlySet<NodeKind> = new Set([
  'service',
  'db',
  'cache',
  'worker',
  'replica',
  'shard',
  'searchindex',
  'timeseriesdb',
  'graphdb',
  'vectordb',
  'transcoder',
]);

export function isSizedKind(kind: NodeKind): boolean {
  return SIZED_KINDS.has(kind);
}

/**
 * Derive the engine knobs a vendor size implies.
 *
 * Returns null where there is nothing honest to say, which the caller must
 * treat as "leave the component alone" rather than as a zero.
 */
export function deriveFromSize(kind: NodeKind, size: VendorSize): Derived | null {
  if (!isSizedKind(kind)) return null;

  // A size with no published vCPU count gets nothing. Azure Managed Redis
  // states its per-SKU counts only inside an image, and inventing one to
  // fill the gap is the plausible-looking number AGENTS.md forbids.
  const vcpu = size.vcpu;
  if (typeof vcpu !== 'number' || !Number.isFinite(vcpu) || vcpu <= 0) return null;

  // A published max-connections figure is a REAL ceiling, so where the
  // vendor states one it wins over the vCPU rule of thumb. This is the one
  // place the derivation gets to stand on a citable number.
  const fromVcpu = Math.max(1, Math.round(vcpu * SLOTS_PER_VCPU));
  const capacity =
    typeof size.maxConnections === 'number' && size.maxConnections > 0
      ? Math.min(fromVcpu, size.maxConnections)
      : fromVcpu;

  return { capacity, serviceMs: null };
}

/**
 * Apply a size to a config, leaving everything the derivation cannot speak
 * to untouched.
 */
export function applySize(
  kind: NodeKind,
  config: NodeConfig,
  size: VendorSize,
): NodeConfig {
  const derived = deriveFromSize(kind, size);
  if (!derived) return config;
  return { ...config, capacity: derived.capacity };
}

/**
 * The sentence shown wherever a derived number appears.
 *
 * One string, in one place, so the caveat cannot drift between the
 * inspector and anywhere else that grows a need for it later.
 */
export const DERIVED_NOTE =
  'Capacity is our estimate from the vCPU count, not a figure the vendor publishes. Set it yourself to model your own service.';
