import type { NodeKind } from '../sim/types';

/**
 * Kinds this applies to: exactly the ones with a throughput ceiling (see
 * `HAS_THROUGHPUT_CEILING` in ../components/Inspector.tsx) -- headroom is only ever a
 * defined concept for these, so a suggestion is only ever offered for these.
 *
 * One suggestion per kind, not several with tradeoffs. Per the issue
 * discussion: a suggestion that sounds reasonable and makes things worse is
 * worse than saying nothing, so this deliberately does not offer "make the
 * database bigger" for a db -- that specific advice is a trap in at least one
 * of the app's own challenges. Where a kind has no single fix that is
 * obviously right, the suggestion points at the knob that is honestly the
 * most likely lever rather than pretending certainty.
 */
export function suggestionFor(kind: NodeKind): string | null {
  switch (kind) {
    case 'cache':
      // Deliberately NOT "raise the hit rate". The hit/miss roll happens in
      // onServiceComplete (behaviour.ts), so a hit and a miss occupy a slot
      // for the same serviceMs: hit rate changes what this node FORWARDS,
      // never what arrives at it. When the cache itself is over its ceiling,
      // raising hit rate moves nothing here -- it relieves what is behind it.
      return 'Add instances, or more slots per instance. Hit rate will not help here, because a hit and a miss occupy a slot for the same time. It changes what this cache forwards, not what it has to get through.';
    case 'db':
      // Deliberately not "add capacity" -- bigger databases do not always
      // help, and a wrong-sounding suggestion is worse than none. Point at
      // reducing what reaches it instead.
      return 'A database rarely gets faster by being made bigger. Look at what is reaching it instead. A cache in front of it with a higher hit rate, or fewer retries piling on load, will do more than resizing this node.';
    case 'lb':
      // A load balancer being the bottleneck is unusual; its own limit is
      // rarely the real story.
      return 'A load balancer saturating is uncommon. Check the components behind it are not the actual limit before adding capacity here.';
    case 'sidecar':
      // Every hop through a sidecar pays its tax; retries multiply it.
      return 'Each hop pays this proxy a tax. Check retries and timeouts before adding capacity; a retry storm here costs more than the base load does.';
    case 'apigateway':
      return 'This is a stateless front door, so add instances to spread the load across more of them.';
    case 'worker':
      return 'Workers drain a queue at their own pace. Add instances to drain it faster.';
    case 'service':
    case 'objectstore':
    case 'coldstorage':
    case 'retryqueue':
    case 'transcoder':
    case 'edgecompute':
      // The remaining ceiling kinds run the same slot discipline with no
      // sharper lever than the obvious one: more parallel slots, or less
      // time per request.
      return 'Add instances for more parallel slots, or lower service time if the work itself can be made faster.';
    default:
      return null;
  }
}
