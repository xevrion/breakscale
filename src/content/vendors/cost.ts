import type { NodeConfig, NodeKind, SimNode } from '../../sim/types';
import type { Vendor, VendorSize } from './types';

/* ------------------------------------------------------------------ *
 * What a design would cost.
 *
 * A system design argument is never only about latency. "Add a read
 * replica" and "buy a bigger box" both fix a queue, and which one is right
 * usually turns on money. Without a price the simulator can only ever
 * teach half the trade.
 *
 * WHAT THIS IS HONEST ABOUT.
 *
 * Every hourly rate comes from a vendor file and carries a source URL. The
 * arithmetic here is just rate times fleet size times hours, which is
 * genuinely how these bills work for compute.
 *
 * What it is NOT is a bill. Real invoices carry storage, egress, backup,
 * support, reserved-instance discounts and free tiers, none of which this
 * models. So the figure is labelled as compute only, everywhere it is
 * shown. An estimate presented as a bill would be the same dishonesty as a
 * derived number presented as a measurement.
 * ------------------------------------------------------------------ */

/**
 * Hours in an average month.
 *
 * 730, not 720. Vendors bill per hour and quote monthly figures on a
 * 730-hour month (365 days / 12), so using 30 days would put every number
 * here about 1.4 percent below the same number on the vendor's own
 * calculator, for no reason anyone could see.
 */
export const HOURS_PER_MONTH = 730;

/**
 * How many of this thing are actually running.
 *
 * The engine already tracks fleet size honestly and differently per kind,
 * so this reads what each kind really uses rather than assuming `instances`
 * everywhere: a shard's fleet is its partition count, a replica set's is
 * its replica count.
 */
export function fleetSize(kind: NodeKind, config: NodeConfig): number {
  // Each field is optional on the type because only some kinds read it, so
  // a missing one means "this kind does not have a fleet" and falls back to
  // a single box rather than to zero.
  const count = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;

  if (kind === 'shard') return count(config.shardCount);
  // A replica set is the primary plus its replicas, which is what you pay
  // for: the primary is a box too.
  if (kind === 'replica') return count(config.replicaCount) + 1;
  return count(config.instances);
}

export interface NodeCost {
  nodeId: string;
  label: string;
  /** The size this price came from, so the reader can check it. */
  sizeName: string;
  fleet: number;
  perHour: number;
  perMonth: number;
}

export interface DesignCost {
  nodes: NodeCost[];
  perMonth: number;
  /** Components with no priced size, which the total therefore excludes. */
  unpriced: string[];
}

/**
 * Cost a design, given the size chosen for each component.
 *
 * `sizeOf` returns the size a node is running on, or null where the student
 * has not picked one. A component with no size is NOT guessed at: it is
 * listed as unpriced, because inventing a rate for it would make the total
 * look complete while being wrong by an unknown amount.
 */
export function costDesign(
  nodes: readonly SimNode[],
  vendor: Vendor | null,
  sizeOf: (node: SimNode) => VendorSize | null,
): DesignCost {
  const out: NodeCost[] = [];
  const unpriced: string[] = [];
  if (!vendor) return { nodes: out, perMonth: 0, unpriced: [] };

  for (const node of nodes) {
    const size = sizeOf(node);
    if (!size || typeof size.pricePerHour !== 'number') {
      // A client is not a thing you rent, so it is not "unpriced" in the
      // sense of missing data. Only components the vendor actually sells
      // are reported as a gap in the total.
      if (node.kind !== 'client' && vendor.kinds[node.kind]) {
        unpriced.push(node.label);
      }
      continue;
    }
    const fleet = fleetSize(node.kind, node.config);
    const perHour = size.pricePerHour * fleet;
    out.push({
      nodeId: node.id,
      label: node.label,
      sizeName: size.name,
      fleet,
      perHour,
      perMonth: perHour * HOURS_PER_MONTH,
    });
  }

  out.sort((a, b) => b.perMonth - a.perMonth);
  return {
    nodes: out,
    perMonth: out.reduce((sum, n) => sum + n.perMonth, 0),
    unpriced,
  };
}

/** Money, in the way a reader scans a bill rather than reads a number. */
export function formatMoney(usd: number): string {
  if (usd >= 10_000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  // Sub-dollar figures are real for a small instance, and rounding them to
  // $0 would tell a student the thing is free.
  return `$${usd.toFixed(3)}`;
}

/** The caveat, in one place, so it cannot drift between two surfaces. */
export const COST_NOTE =
  'Compute only, at on-demand rates. A real bill also carries storage, network egress, backups and support, and discounts for commitment.';
