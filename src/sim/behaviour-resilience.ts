/**
 * Resilience and delivery component behaviours: bulkhead, retryqueue,
 * transcoder, edgecompute, writebehind, loadshedder.
 *
 * The theme this module shares is FAILURE HANDLING AS A DESIGN CHOICE. The
 * edge module (cdn, ratelimiter, breaker) is about stopping load before it
 * hurts; these six are about what a system does with the load, and the
 * failures, it has already accepted: contain them (bulkhead), give them
 * somewhere to go (retryqueue), buffer them at a known risk (writebehind),
 * answer them without travelling (edgecompute), grind through them off the
 * request path (transcoder), or choose WHICH of them to fail (loadshedder).
 *
 * Every one is a plain ComponentBehaviour: the event loop has no idea they
 * exist and none of them added a conditional to engine.ts. Two of them
 * (retryqueue, writebehind) are built on one new BehaviourCtx primitive,
 * ackAndRelay(), which is the delivery-side sibling of the queue's
 * ackAndBuffer(): ack the caller, then deliver the detached copy downstream
 * through this node's own slots and the engine's ordinary retry machinery.
 *
 * Determinism notes, same rules as every other behaviour module:
 *   - timestamps are compared, never per-tick deltas accumulated;
 *   - RNG draws happen in a fixed position per event or not at all. The
 *     loadshedder classifies priority from a HASH of the request key rather
 *     than a roll, so it consumes zero randomness, exactly like the limiter.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/* ================================================================== *
 * bulkhead -- an isolated concurrency pool around one dependency
 * ================================================================== */

/** Bulkhead scratch state: the one number the component is about. */
interface BulkheadState {
  /** Downstream calls currently outstanding through this pool. */
  inFlight: number;
}

function cfgBulkheadMax(state: NodeStateLike): number {
  const v = state.config.bulkheadMax;
  return v !== undefined && v >= 1 ? Math.floor(v) : 8;
}

/**
 * A bulkhead: at most `bulkheadMax` calls may be outstanding to the
 * dependency behind it at once. The excess fails here, immediately, as
 * 'bulkhead-full'.
 *
 * The teaching point is Little's law working as a safety property. When the
 * dependency is healthy, concurrency sits at `rate * latency` and the cap is
 * invisible. When the dependency slows down, concurrency is the FIRST number
 * to move -- it climbs toward `rate * newLatency` within one latency of the
 * change -- and the cap catches it before a backlog can form. Admitted calls
 * keep a bounded queue behind the dependency, so their latency stays flat;
 * everything else is refused in microseconds instead of waiting out a
 * timeout. Without the bulkhead the same slowdown fills the dependency's
 * queue to its limit, and every caller pays seconds to learn what this
 * component would have told them instantly.
 *
 * It observes concurrency rather than error rate, which is what separates it
 * from the breaker: a dependency that is slow-but-succeeding never trips a
 * breaker's error window, but it fills a bulkhead within one round trip.
 *
 * A bulkhead guards ONE pool: it routes each admitted request down exactly
 * one edge (weighted, like an lb, for the rare case of several). To isolate
 * two dependencies, wire two bulkheads; that is precisely how the pattern is
 * deployed in practice, one pool per dependency.
 *
 * The pool is counted at admission and released when the downstream call
 * reports back through onDownstreamResult. The count is deliberately not
 * decremented on this node's own error roll, so `errorRate` and `retries`
 * are not exposed for the kind (both would make the count drift); the
 * defaults keep them at zero.
 */
const bulkhead: ComponentBehaviour = {
  kind: 'bulkhead',
  // A gate, not a server: it holds no slots of its own and its utilisation
  // would be meaningless. The pool count is its real meter.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,
  // The whole component is a count of downstream outcomes.
  observesOutcome: true,

  initState: (): BulkheadState => ({ inFlight: 0 }),

  onAdmit: (ctx, state, req): AdmitAction => {
    // Nothing wired behind it: there is no pool to guard, so pass through
    // rather than black-holing the topology a student is mid-way through
    // wiring up.
    if (state.out.length === 0) return 'passthru';

    const b = state.ext as BulkheadState;
    if (b.inFlight >= cfgBulkheadMax(state)) {
      ctx.countCustom(state, 'bulkheadRejected', 1);
      ctx.reject(state, req, 'bulkhead-full');
      return 'handled';
    }
    b.inFlight++;
    ctx.countCustom(state, 'admitted', 1);
    return 'passthru';
  },

  route: () => 'one',
  pickEdge: (ctx, state, _req, out) => {
    const edge = ctx.pickWeightedOrLeastLoaded(out);
    if (edge === null) {
      // Every edge is cut: no downstream call will be made, so no
      // onDownstreamResult will ever release the slot this request was
      // granted at admission. Hand it back here or the pool leaks shut.
      const b = state.ext as BulkheadState | null;
      if (b && b.inFlight > 0) b.inFlight--;
    }
    return edge;
  },

  onDownstreamResult: (_ctx, state, _req, _ok, _reason) => {
    const b = state.ext as BulkheadState;
    if (b.inFlight > 0) b.inFlight--;
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const b = state.ext as BulkheadState | null;
    stats.bulkheadInFlight = b ? b.inFlight : 0;
    stats.bulkheadLimit = cfgBulkheadMax(state);
    stats.bulkheadRejectedRate = ctx.counterRate(state, 'bulkheadRejected');
    // Show the pool as this node's occupancy so the canvas meter means
    // "how full is the bulkhead" rather than sitting at zero forever.
    stats.inFlight = b ? b.inFlight : 0;
  },
};

/* ================================================================== *
 * retryqueue -- retried delivery with a dead letter shelf
 * ================================================================== */

/** Retry-queue scratch state. */
interface RetryQueueState {
  /** Messages that exhausted every retry since sim start. */
  deadLetters: number;
}

/**
 * A delivery queue with a redrive policy -- SQS with maxReceiveCount, a
 * Rabbit queue with a DLX.
 *
 * The caller is acknowledged instantly, exactly like the plain queue. The
 * difference is on the far side: this node delivers the message downstream
 * ITSELF (capacity is its delivery concurrency), and when a delivery fails
 * it is retried with exponential backoff -- the engine's own retry path,
 * driven by this node's `retries` -- instead of the failure evaporating. A
 * message that fails every attempt lands on the DEAD LETTER shelf: a counter
 * that only grows, in plain sight.
 *
 * The teaching point is that failures need somewhere to go. A plain queue
 * feeding a flaky worker silently loses every failed message; a student
 * watching only throughput never learns it happened. Here the same flakiness
 * shows up as a redelivery rate (the early warning) and then a dead letter
 * count (the bill), and a transient error rate of e is survived at a cost of
 * roughly e + e^2 extra deliveries while only the e^(retries+1) fraction is
 * lost -- numbers a student can check against the sliders.
 *
 * creditsJoinCompletion is FALSE, and must be: the ack already booked one
 * completion for the message, and the delivered message joining its
 * downstream call at this same node would book a second.
 */
const retryqueue: ComponentBehaviour = {
  kind: 'retryqueue',
  // Delivery slots are real work: the meter reads delivery concurrency.
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: false,
  observesOutcome: true,

  initState: (): RetryQueueState => ({ deadLetters: 0 }),

  onAdmit: (ctx, state, req): AdmitAction => {
    if (ctx.queueDepth(state) >= ctx.effectiveQueueLimit(state)) return 'shed';
    ctx.ackAndRelay(state, req);
    return 'handled';
  },

  onDownstreamResult: (ctx, state, req, ok, reason) => {
    if (ok) {
      ctx.countCustom(state, 'delivered', 1);
      return;
    }
    // Mirror the engine's own retry predicate exactly, so this ledger never
    // disagrees with what actually happens next: a failed attempt is
    // redelivered unless the budget is spent or the failure is one the
    // engine never retries (a wiring error, a depth blowout).
    const retries = Math.max(0, Math.floor(state.config.retries));
    const final = req.attempt >= retries || reason === 'depth' || reason === 'no-route';
    if (final) {
      ctx.countCustom(state, 'deadLetter', 1);
      (state.ext as RetryQueueState).deadLetters++;
    } else {
      ctx.countCustom(state, 'redelivery', 1);
    }
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    stats.deliveredRate = ctx.counterRate(state, 'delivered');
    stats.redeliveryRate = ctx.counterRate(state, 'redelivery');
    stats.deadLetterRate = ctx.counterRate(state, 'deadLetter');
    stats.deadLetters = (state.ext as RetryQueueState | null)?.deadLetters ?? 0;
  },
};

/* ================================================================== *
 * transcoder -- a CPU-bound batch job farm
 * ================================================================== */

/**
 * A transcoder farm: workers whose jobs take SECONDS, not milliseconds.
 *
 * Mechanically this is the worker's discipline -- it drains the queue nodes
 * that feed it -- and it is deliberately a separate kind anyway, for the same
 * reason db is separate from service: the numbers it is used with are from a
 * different regime and teach a different lesson. At serviceMs in the
 * thousands, capacity stops meaning "threads" and starts meaning "how many
 * encodes fit on one box", throughput is single digits per second, and the
 * queue in front of it is measured in minutes of backlog rather than
 * requests. Undersize the farm by 10% and the backlog grows FOREVER -- there
 * is no burst to ride out, because the deficit is structural. That is the
 * capacity-planning arithmetic every video pipeline lives and dies by, and
 * it is the beating heart of the Netflix and Spotify ingest architectures.
 *
 * It can also be pushed to directly (an ordinary edge into it works), but
 * queue-fed is the intended shape: the queue is what makes the deficit
 * visible instead of shedding it.
 */
const transcoder: ComponentBehaviour = {
  kind: 'transcoder',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: true,
  buffersForConsumers: false,
  pump: 'sources',
  creditsJoinCompletion: true,
};

/* ================================================================== *
 * edgecompute -- limited compute at the CDN edge
 * ================================================================== */

/**
 * Compute at the edge: a small function running in the PoP itself.
 *
 * `edgeShare` is the fraction of requests it can fully answer -- an auth
 * check, a redirect, a personalised fragment assembled from what is already
 * at the edge. Those complete in single-digit milliseconds without a single
 * byte travelling to the origin. Everything else passes through and pays the
 * full origin path.
 *
 * The difference from the CDN is what the number means. A CDN's hitRate is a
 * property of the TRAFFIC (how repetitive it is); edgeShare is a property of
 * the CODE (how much logic you managed to push outward), and raising it is
 * engineering work, not luck. The lesson is the same shape though: the p50 a
 * client sees is a blend of two distributions, and moving work to the edge
 * moves requests between them one slider-notch at a time.
 *
 * One RNG draw per completion, unconditionally and in a fixed position, for
 * the same replay-stability reason the cache documents.
 */
const edgecompute: ComponentBehaviour = {
  kind: 'edgecompute',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  onServiceComplete: (ctx, state, _req) => {
    const share = clamp01(state.config.edgeShare ?? 0);
    if (ctx.roll() < share) {
      ctx.countCustom(state, 'edgeHandled', 1);
      return 'complete';
    }
    ctx.countCustom(state, 'passedThrough', 1);
    // Nothing behind it: it still answers, it just cannot demonstrate the
    // pass-through lesson.
    return state.out.length === 0 ? 'complete' : 'downstream';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    stats.edgeHandledRate = ctx.counterRate(state, 'edgeHandled');
    stats.passedThroughRate = ctx.counterRate(state, 'passedThrough');
  },
};

/* ================================================================== *
 * writebehind -- a write buffer that trades durability for latency
 * ================================================================== */

function cfgFlushDelayMs(state: NodeStateLike): number {
  const v = state.config.flushDelayMs;
  return v !== undefined && v > 0 ? v : 0;
}

/**
 * A write-behind cache: writes are acknowledged from memory in about a
 * millisecond, and flushed to the backing store `flushDelayMs` later.
 *
 * Chosen over a read-through variant deliberately: the existing `cache`
 * already IS read-through (hit answers, miss falls downstream), so the read
 * path is covered. What the palette lacked was the write path's bargain, and
 * write-behind is the sharpest form of it: the caller is told "saved" while
 * the data exists only in this node's memory.
 *
 * `capacity` is the buffer -- how many writes may sit dirty at once, memory
 * rather than threads -- and the standing dirty population is writeRate
 * times the flush delay, which the utilisation meter reads as buffer fill.
 *
 * The lesson has two halves. The visible half: downstream sees the same
 * write rate, just later and smoothed, and the caller's latency no longer
 * contains the store's -- that is why the pattern exists. The half that
 * matters: CRASH THIS NODE. Every buffered write fails as 'crashed' in the
 * same instant, and those are writes the callers were already told
 * succeeded. The failures spike on the graph is data loss made countable,
 * and no other component in the palette can show it.
 *
 * creditsJoinCompletion is FALSE for the same double-count reason as the
 * retry queue: the ack already booked the completion.
 */
const writebehind: ComponentBehaviour = {
  kind: 'writebehind',
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: false,
  observesOutcome: true,

  onAdmit: (ctx, state, req): AdmitAction => {
    if (ctx.queueDepth(state) >= ctx.effectiveQueueLimit(state)) return 'shed';
    // The relayed copy carries the flush delay as extra service time, so a
    // dirty write HOLDS its buffer slot for the whole residence interval --
    // which is what makes the buffer a real population a crash can lose,
    // not an accounting fiction.
    ctx.ackAndRelay(state, req, cfgFlushDelayMs(state));
    return 'handled';
  },

  onDownstreamResult: (ctx, state, _req, ok, _reason) => {
    ctx.countCustom(state, ok ? 'flushed' : 'flushFailed', 1);
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    // Dirty writes: acknowledged, not yet landed on the store. Buffered
    // (queued) plus mid-residence (inFlight); both die with the node.
    stats.dirtyWrites = stats.inFlight + stats.queued;
    stats.flushedRate = ctx.counterRate(state, 'flushed');
  },
};

/* ================================================================== *
 * loadshedder -- priority-aware admission control
 * ================================================================== */

/** Token bucket state, same shape as the rate limiter's. */
interface ShedderState {
  /** Tokens available right now. Fractional: refill is continuous. */
  tokens: number;
  /** Simulated time the bucket was last refilled, in ms. */
  lastRefillMs: number;
  /** Bucket size the tokens were last capped against, to detect a config change. */
  lastBurst: number;
}

function shedRate(state: NodeStateLike): number {
  const r = state.config.rateLimitRps;
  return r !== undefined && r > 0 ? r : 0;
}

function shedBurst(state: NodeStateLike): number {
  const b = state.config.burst;
  if (b !== undefined && b > 0) return b;
  const r = shedRate(state);
  return r > 0 ? r : 1;
}

/**
 * Refill against elapsed SIMULATED time, exactly as the rate limiter does
 * and for exactly the reasons documented there: over T seconds the bucket
 * grants rate*T tokens no matter how the frames fell.
 */
function shedRefill(ctx: BehaviourCtx, state: NodeStateLike, b: ShedderState): void {
  const burst = shedBurst(state);
  if (burst !== b.lastBurst) {
    if (b.tokens > burst) b.tokens = burst;
    b.lastBurst = burst;
  }
  const elapsed = ctx.now - b.lastRefillMs;
  if (elapsed <= 0) return;
  b.lastRefillMs = ctx.now;
  const rate = shedRate(state);
  if (rate <= 0) return;
  b.tokens += (elapsed / 1000) * rate;
  if (b.tokens > burst) b.tokens = burst;
}

/** The bucket as of now, without mutating it. Snapshot-side arithmetic only. */
function shedProjected(ctx: BehaviourCtx, state: NodeStateLike, b: ShedderState): number {
  const burst = shedBurst(state);
  let tokens = b.tokens > burst ? burst : b.tokens;
  const rate = shedRate(state);
  const elapsed = ctx.now - b.lastRefillMs;
  if (rate > 0 && elapsed > 0) {
    tokens += (elapsed / 1000) * rate;
    if (tokens > burst) tokens = burst;
  }
  return tokens;
}

/**
 * Is this request low priority?
 *
 * Derived from the request KEY, not from an RNG draw: the key already
 * identifies who is asking (it is what shards partition on), so "the low 30%
 * of the key space is best-effort traffic" is the honest model of tiered
 * users -- the same caller is always the same priority, retries included --
 * and it costs the random stream nothing. The key is hashed first (Knuth's
 * multiplicative constant) so priority does not correlate with shard index,
 * which is key modulo shardCount on the raw value.
 */
function isLowPriority(state: NodeStateLike, req: ReqLike): boolean {
  const share = clamp01(state.config.lowPriorityShare ?? 0);
  if (share <= 0) return false;
  const hashed = (Math.imul(req.key, 2654435761) >>> 0) / 4294967296;
  return hashed < share;
}

/**
 * A load shedder: admission control that fails the RIGHT traffic.
 *
 * Same token bucket as the rate limiter, one difference in the admission
 * rule: a high-priority request needs 1 token, a low-priority request needs
 * the bucket to also hold a reserve of `priorityReserve * burst` on top. In
 * an idle system the bucket sits full and everyone gets in. Under
 * saturation, tokens hover near zero, which is INSIDE the reserve -- so
 * low-priority traffic is refused ('deprioritized') while high-priority
 * traffic keeps finding its single token ('throttled' only appears once even
 * the high tier outruns the bucket).
 *
 * The teaching point is graceful degradation as a policy rather than an
 * accident. A plain limiter at 2x load fails half of EVERYTHING -- checkout
 * and thumbnail alike. This component fails the thumbnails 100% and the
 * checkouts 0%, at the same total admission rate, and the per-priority
 * readouts let a student verify exactly that trade. Zero RNG draws.
 */
const loadshedder: ComponentBehaviour = {
  kind: 'loadshedder',
  // A doorman, like the limiter: no slots, no meaningful utilisation.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: (state): ShedderState => ({
    // Starts full, like the limiter: an idle system absorbs a burst.
    tokens: shedBurst(state),
    lastRefillMs: 0,
    lastBurst: shedBurst(state),
  }),

  onAdmit: (ctx, state, req): AdmitAction => {
    const b = state.ext as ShedderState;
    shedRefill(ctx, state, b);
    const low = isLowPriority(state, req);

    // No rate configured means no limit: pass everything, as the limiter
    // does, rather than black-holing a half-configured node.
    if (shedRate(state) <= 0) {
      ctx.countCustom(state, low ? 'lowAdmitted' : 'highAdmitted', 1);
      return 'passthru';
    }

    // The admission floor this request must find in the bucket. High
    // priority pays list price; low priority must also leave the reserve
    // untouched, which is the entire mechanism.
    const floor = low ? 1 + clamp01(state.config.priorityReserve ?? 0.3) * shedBurst(state) : 1;

    if (b.tokens >= floor) {
      b.tokens -= 1;
      ctx.countCustom(state, low ? 'lowAdmitted' : 'highAdmitted', 1);
      return 'passthru';
    }

    ctx.countCustom(state, low ? 'lowShed' : 'highShed', 1);
    ctx.reject(state, req, low ? 'deprioritized' : 'throttled');
    return 'handled';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const b = state.ext as ShedderState | null;
    stats.highAdmittedRate = ctx.counterRate(state, 'highAdmitted');
    stats.lowAdmittedRate = ctx.counterRate(state, 'lowAdmitted');
    stats.highSheddedRate = ctx.counterRate(state, 'highShed');
    stats.lowSheddedRate = ctx.counterRate(state, 'lowShed');
    stats.admittedRate = stats.highAdmittedRate + stats.lowAdmittedRate;
    // Projected, not stored: refill is lazy, same reasoning as the limiter.
    stats.tokens = b ? shedProjected(ctx, state, b) : 0;
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const RESILIENCE_BEHAVIOURS: ComponentBehaviour[] = [
  bulkhead,
  retryqueue,
  transcoder,
  edgecompute,
  writebehind,
  loadshedder,
];

/* Re-exported for the verification harness; not used by the engine. */
export type { BulkheadState, RetryQueueState, ShedderState };
