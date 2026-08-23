/**
 * Control-plane component behaviours: autoscaler, region.
 *
 * These two are different in kind from everything else in the registry. A
 * service, a cache, a queue are all things a request passes THROUGH. These are
 * things that act ON the topology: an autoscaler writes another node's
 * capacity, a region node decides which downstream is allowed to exist right
 * now. They are the control plane, and grouping them says so.
 *
 * Both are plain ComponentBehaviour objects. The event loop has no idea they
 * exist and neither added a conditional to engine.ts.
 *
 * A note on determinism, which shapes both. `advance(dt)` is driven by
 * wall-clock frames, so dt varies frame to frame. Anything asking "has enough
 * time passed?" must compare *simulated timestamps* rather than accumulate
 * per-tick deltas, or the same seed yields different results at a different
 * frame rate. That is why the autoscaler stores `lastDecisionMs` and
 * `warmupDueMs` as absolute simulated times and ignores its own `dtMs`
 * argument entirely, and why the region node's failover deadline is an
 * absolute time evaluated lazily when a request arrives.
 *
 * Neither behaviour draws from the RNG. A controller that consumed random
 * numbers would shift the shared random stream for every other node depending
 * on how often it happened to act, which is exactly the kind of coupling that
 * makes a "deterministic" simulator quietly non-reproducible.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike } from './engine-types';
import type { ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/* ------------------------------------------------------------------ *
 * autoscaler
 * ------------------------------------------------------------------ */

/**
 * Utilisation band below `targetUtil` inside which the controller does
 * nothing. Without it the controller flaps by one step every cooldown while
 * utilisation sits naturally just under its setpoint.
 */
const DEAD_BAND = 0.1;

/** Fallbacks for the optional config knobs, so an unset field is never NaN. */
const DEFAULT_TARGET_UTIL = 0.7;
const DEFAULT_MIN_CAPACITY = 1;
const DEFAULT_MAX_CAPACITY = 64;
const DEFAULT_COOLDOWN_MS = 5000;
const DEFAULT_STEP_PCT = 0.5;
const DEFAULT_WARMUP_MS = 0;

interface AutoscalerState {
  /** Simulated time of the last decision; -Infinity means "never decided". */
  lastDecisionMs: number;
  /**
   * Capacity the controller believes the watched node should have. Tracked
   * separately from the node's live capacity because during a warm-up the two
   * deliberately disagree, and that gap is the thing worth showing.
   */
  targetCapacity: number;
  /**
   * Simulated time at which a pending scale-UP lands, or -1 when nothing is
   * warming up. Holding a granted decision here instead of applying it at once
   * is the entire point of this component.
   */
  warmupDueMs: number;
  /** Capacity to write when the warm-up completes. */
  pendingCapacity: number;
  /** Node being driven, resolved from the controller's first out edge. */
  watchedId: string;
}

function asAutoscaler(state: NodeStateLike): AutoscalerState | null {
  return (state.ext as AutoscalerState | null) ?? null;
}

/**
 * A capacity controller.
 *
 * It sits BESIDE the node it scales rather than in front of it: its outgoing
 * edge names its target and carries no traffic. Once per `cooldownMs` it
 * compares the watched node's utilisation against `targetUtil` and steps
 * capacity by `scaleStepPct`, clamped to [minCapacity, maxCapacity].
 *
 * The teaching point is the lag. A scale-UP does not take effect until
 * `warmupMs` after the decision -- machines boot, images pull, JITs warm --
 * so a student who steps the load up watches utilisation pin at 1.0, and the
 * queue build behind it, for a visible interval before capacity answers. And
 * because the controller reacts to a utilisation its own past decisions
 * caused, a short cooldown against a long warmup makes it overshoot and
 * oscillate. That is a real failure mode, and being able to reproduce it on
 * purpose is worth more than a controller that always behaves.
 *
 * Scale-DOWN is immediate, as it is in reality: releasing a machine needs no
 * warm-up. This asymmetry is deliberate and is itself part of why autoscalers
 * oscillate downward faster than they recover.
 */
const autoscaler: ComponentBehaviour = {
  kind: 'autoscaler',
  // A controller is not in the request path: it serves nothing, holds nothing,
  // and reports no utilisation of its own. Marking it servesRequests:false is
  // what keeps its (permanently zero) slot count out of the utilisation
  // integration, so it renders as a control box rather than an idle server.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,

  initState: (): AutoscalerState => ({
    lastDecisionMs: -Infinity,
    targetCapacity: 0,
    warmupDueMs: -1,
    pendingCapacity: 0,
    watchedId: '',
  }),

  /**
   * Traffic reaching an autoscaler means the student wired requests INTO the
   * controller. Refusing explicitly is far more legible than serving it, which
   * would make the controller look like a hop that mysteriously adds latency.
   */
  onAdmit: (ctx, state, req) => {
    ctx.reject(state, req, 'no-route');
    return 'handled';
  },

  /**
   * `dtMs` is deliberately unused: every decision compares absolute simulated
   * timestamps, so the controller behaves identically at any frame rate.
   */
  onTick: (ctx, state) => {
    const st = asAutoscaler(state);
    if (!st) return;

    // The watched node is whatever this controller points at, re-resolved each
    // tick so rewiring the edge on the canvas retargets it live.
    const watched = state.out.length > 0 ? state.out[0].to : '';
    if (watched !== st.watchedId) {
      st.watchedId = watched;
      // A new target invalidates every decision made about the old one.
      st.warmupDueMs = -1;
      st.targetCapacity = 0;
      st.lastDecisionMs = -Infinity;
    }
    if (watched === '') return;

    const liveCapacity = ctx.capacityOf(watched);
    if (liveCapacity === null) return;

    // First tick: adopt what the node already has, so the controller never
    // yanks capacity to a default the student did not ask for.
    if (st.targetCapacity === 0) st.targetCapacity = liveCapacity;

    // A pending scale-up whose warm-up elapsed becomes real capacity now.
    if (st.warmupDueMs >= 0 && ctx.now >= st.warmupDueMs) {
      st.warmupDueMs = -1;
      st.targetCapacity = st.pendingCapacity;
      ctx.setCapacity(watched, st.pendingCapacity);
    }

    // A scale-up already booked and still warming up blocks further decisions.
    //
    // Without this the controller re-derives the same "scale up" verdict on
    // every cooldown -- utilisation is still high, because the capacity it
    // ordered has not arrived yet -- and each re-decision pushes warmupDueMs
    // forward by another full warmup. The pending capacity then never lands at
    // all, and the node stays at its original size forever. A real autoscaler
    // has exactly this problem and solves it the same way: it does not issue a
    // second order while the first is still being fulfilled.
    if (st.warmupDueMs >= 0) return;

    const cfg = state.config;
    const cooldown = Math.max(0, cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    if (ctx.now - st.lastDecisionMs < cooldown) return;

    // A crashed node reports whatever utilisation it held when it died, which
    // is not a signal. Acting on it would either spin capacity up against a
    // dead box or scale it away just before it recovers.
    if (ctx.isCrashed(watched)) return;

    const util = ctx.utilizationOf(watched);
    if (util === null) return;

    const minCap = Math.max(1, Math.floor(cfg.minCapacity ?? DEFAULT_MIN_CAPACITY));
    const maxCap = Math.max(minCap, Math.floor(cfg.maxCapacity ?? DEFAULT_MAX_CAPACITY));
    const target = clamp01(cfg.targetUtil ?? DEFAULT_TARGET_UTIL);
    const step = Math.max(0.01, cfg.scaleStepPct ?? DEFAULT_STEP_PCT);
    // Capacity is integral, so a step must move at least one slot: a small
    // percentage of a small capacity would otherwise round to a permanent
    // no-op and the controller would silently do nothing forever.
    const delta = Math.max(1, Math.round(st.targetCapacity * step));

    // The capacity that would put utilisation exactly on the setpoint, given
    // that busy slots are (util * currentCapacity) right now. Used to bound a
    // step so the controller cannot overshoot THROUGH its own setpoint: a
    // fixed percentage step alone will happily take a node from 40%
    // utilisation straight into saturation, and then have to scale back up,
    // which is self-inflicted oscillation on top of the real kind.
    const busySlots = util * st.targetCapacity;
    const idealCapacity = Math.max(1, Math.ceil(busySlots / (target > 0 ? target : 1)));

    let want = st.targetCapacity;
    if (util > target) {
      // Scale up by a step, but never past what the setpoint actually needs.
      want = Math.min(st.targetCapacity + delta, Math.max(idealCapacity, st.targetCapacity + 1));
    } else if (util < target - DEAD_BAND) {
      // Scale down by a step, but never below what the setpoint needs. The
      // asymmetry with scale-up is deliberate: shedding too much capacity
      // causes an immediate outage, while adding too much only costs money.
      want = Math.max(st.targetCapacity - delta, idealCapacity);
    }

    want = want < minCap ? minCap : want > maxCap ? maxCap : want;
    if (want === st.targetCapacity) return;

    st.lastDecisionMs = ctx.now;

    if (want < st.targetCapacity) {
      // Removing capacity is immediate; nothing has to boot. Any pending
      // scale-up is cancelled outright rather than left half-set, so a later
      // read of pendingCapacity cannot resurrect a decision this one reversed.
      st.targetCapacity = want;
      st.warmupDueMs = -1;
      st.pendingCapacity = want;
      ctx.setCapacity(watched, want);
      return;
    }

    const warmup = Math.max(0, cfg.warmupMs ?? DEFAULT_WARMUP_MS);
    if (warmup === 0) {
      st.targetCapacity = want;
      ctx.setCapacity(watched, want);
      return;
    }
    // Book the decision. The slots do not exist yet -- this is the lag.
    st.pendingCapacity = want;
    st.warmupDueMs = ctx.now + warmup;
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const st = asAutoscaler(state);
    if (!st) return;
    const scaling = st.warmupDueMs >= 0;
    // While warming up, report the capacity being BOOKED rather than the one
    // in force: paired with watchedCapacity, the gap between the two numbers
    // is the visible form of the lag this component exists to teach.
    stats.targetCapacity = scaling ? st.pendingCapacity : st.targetCapacity;
    stats.scaling = scaling;
    stats.watchedCapacity = st.watchedId ? ctx.capacityOf(st.watchedId) ?? 0 : 0;
    stats.watchedUtil = st.watchedId ? ctx.utilizationOf(st.watchedId) ?? 0 : 0;
  },
};

/* ------------------------------------------------------------------ *
 * region
 * ------------------------------------------------------------------ */

interface RegionState {
  /** Region index currently serving, 0-based. -1 until first use. */
  active: number;
  /**
   * Simulated time an in-progress failover completes, or -1 when traffic is
   * flowing normally. While set, every request to this node is refused.
   */
  failoverDueMs: number;
  /** Region the in-progress failover is moving to. */
  failoverTarget: number;
  /**
   * The value of config.activeRegion the last time this behaviour looked.
   *
   * `config.activeRegion` is the student's INTENT, not the live state: once
   * traffic has failed over, the two legitimately disagree, and the config
   * still names the region that died. Tracking the last-seen value is what
   * separates "the student moved the slider" (follow it) from "the config
   * merely still differs because we failed away from it" (ignore it).
   * Without this the adopt step drags `active` back onto the dead region on
   * the very next request and failover never completes.
   */
  lastConfigured: number;
}

function asRegion(state: NodeStateLike): RegionState | null {
  return (state.ext as RegionState | null) ?? null;
}

/** How many of this node's out edges count as regions. */
function regionCount(state: NodeStateLike): number {
  const declared = Math.floor(state.config.regions ?? state.out.length);
  return Math.max(1, Math.min(declared, state.out.length));
}

/**
 * Is region `i` usable right now?
 *
 * A region is unreachable either because the node serving it is crashed or
 * because the link to it is partitioned. Both are injected failures, which is
 * what lets a student cause a regional outage without deleting anything.
 */
function regionHealthy(ctx: BehaviourCtx, state: NodeStateLike, i: number): boolean {
  const edge = state.out[i];
  if (!edge) return false;
  if (ctx.isEdgeCut(edge.id)) return false;
  return !ctx.isCrashed(edge.to);
}

/**
 * A multi-region failover switch.
 *
 * Deliberately the simplest construct that teaches the idea: outgoing edge i
 * is region i, exactly one region serves traffic at a time, and when that
 * region becomes unreachable traffic moves to the next healthy one in a fixed
 * scan order.
 *
 * The part worth seeing is that failover is not free. Detection, DNS/anycast
 * convergence and connection re-establishment are collapsed into one
 * `failoverMs` window during which the node serves nothing and every request
 * fails as 'region-down'. A student who sets failoverMs to 30000 to feel safe
 * watches half a minute of total outage; one who sets it to 0 gets a cutover
 * no real system achieves. That trade is the lesson, and collapsing three
 * mechanisms into one number is what keeps it legible.
 *
 * What this deliberately is NOT: a geo-latency model, a replication model, or
 * an active-active router. Those need real links with propagation delay, and
 * SimEdge.latencyMs is where that will go in the networking phase.
 */
const region: ComponentBehaviour = {
  kind: 'region',
  // A pure switch, like an lb: it forwards without holding slots of its own.
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  initState: (): RegionState => ({
    active: -1,
    failoverDueMs: -1,
    failoverTarget: -1,
    lastConfigured: -1,
  }),

  onAdmit: () => 'passthru',
  route: () => 'one',
  // pickEdge returning null here is not a wiring mistake: it means no region
  // is serving, either mid-failover or with every region down.
  noRouteReason: 'region-down',

  /**
   * Returning null means "no region is serving", which the engine resolves as
   * a routing failure. The reason is mapped to 'region-down' by the engine's
   * no-route path for this kind, so a student sees WHY it failed rather than a
   * generic routing error.
   */
  pickEdge: (ctx, state, _req, out) => {
    const st = asRegion(state);
    if (!st) return null;

    const cfg = state.config;
    const count = regionCount(state);

    // Adopt the configured region on first use, and follow the student if they
    // CHANGE it in the Inspector. A manual switch is instant and deliberate:
    // a planned migration, not an outage.
    //
    // The trigger is a change in the configured value, never a disagreement
    // between it and the live region -- after a failover the two differ by
    // design, and treating that as a manual switch would drag traffic back
    // onto the region that just died.
    const configured = Math.floor(cfg.activeRegion ?? 0);
    const wanted = configured < 0 ? 0 : configured >= count ? count - 1 : configured;
    if (st.active === -1 || wanted !== st.lastConfigured) {
      st.lastConfigured = wanted;
      st.active = wanted;
      st.failoverDueMs = -1;
    }

    // A failover in progress lands once its window elapses. Evaluated here,
    // lazily on arrival, rather than from a tick -- so it depends only on
    // simulated time and not on how often the node happened to be polled.
    if (st.failoverDueMs >= 0) {
      if (ctx.now < st.failoverDueMs) return null; // still dark
      st.active = st.failoverTarget;
      st.failoverDueMs = -1;
    }

    if (regionHealthy(ctx, state, st.active)) return out[st.active];

    // The active region is down. Scan forward with wraparound so regions are
    // always tried in the same order; an arbitrary or random pick here would
    // make failover non-reproducible from the same seed.
    let next = -1;
    for (let i = 1; i <= count; i++) {
      const candidate = (st.active + i) % count;
      if (regionHealthy(ctx, state, candidate)) {
        next = candidate;
        break;
      }
    }
    // Every region is down: there is nowhere to fail over to, so the node
    // stays dark rather than pretending a switch would help.
    if (next === -1) return null;

    const failoverMs = Math.max(0, cfg.failoverMs ?? 0);
    if (failoverMs === 0) {
      st.active = next;
      return out[next];
    }

    st.failoverTarget = next;
    st.failoverDueMs = ctx.now + failoverMs;
    return null; // dark for the length of the failover window
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const st = asRegion(state);
    if (!st) return;
    const failingOver = st.failoverDueMs >= 0 && ctx.now < st.failoverDueMs;
    stats.activeRegion = st.active < 0 ? 0 : st.active;
    stats.failingOver = failingOver;
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const CONTROL_BEHAVIOURS: ComponentBehaviour[] = [autoscaler, region];

/* Re-exported for the verification harness; not used by the engine. */
export type { AutoscalerState, RegionState };
