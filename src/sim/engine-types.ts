/**
 * Structural types shared between the engine and the behaviour registry.
 *
 * They live in their own module so behaviour.ts can describe what it is handed
 * without importing the Engine class (which imports behaviour.ts back). The
 * engine's real NodeState and Req satisfy these interfaces structurally, so no
 * casting or adapter layer is needed at the call sites.
 */
import type { FailureReason, NodeConfig, NodeKind, SimEdge } from './types';

/** The engine's per-node runtime state, as far as a behaviour may see it. */
export interface NodeStateLike {
  readonly id: string;
  readonly kind: NodeKind;
  readonly config: NodeConfig;
  /** Requests occupying a server slot right now. */
  readonly busy: number;
  /** Outgoing edges, resolved from the topology. */
  readonly out: readonly SimEdge[];
  /** Queue nodes feeding this node, for pull-based kinds. */
  readonly sources: readonly string[];
  /**
   * Behaviour-private scratch state, created once by the behaviour's
   * initState() hook and owned entirely by that behaviour. The engine never
   * reads or interprets it -- it only allocates it at buildNodes() time and
   * drops it on reset(), which is exactly the lifecycle a token bucket or a
   * breaker state machine needs. Typed `unknown` so a behaviour must narrow
   * it to its own shape, and no behaviour can read another's.
   */
  ext: unknown;
}

/** An in-flight request, as far as a behaviour may see it. */
export interface ReqLike {
  readonly nodeId: string;
  /** Hop depth from the client root. */
  readonly hop: number;
  /** Which retry attempt this call represents at the parent. */
  readonly attempt: number;
  /** Own service time already spent at this node. */
  readonly ownMs: number;
  /** True when this is a detached queue message being drained by a worker. */
  readonly detached: boolean;
  /**
   * Partition/cache key this request concerns. Drawn by the client from a
   * small keyspace and inherited unchanged by every downstream call the
   * request makes, so a replica set or a shard several hops away sees the
   * key the client actually asked for. Kinds that do not partition by key
   * ignore it entirely.
   */
  readonly key: number;
  /**
   * True when this request is a write rather than a read. Set by the kind
   * that first classifies it (a replica set, from readFraction) and
   * inherited downstream, so a later node sees the same classification.
   */
  readonly isWrite: boolean;
}

/**
 * The slice of the engine a behaviour is allowed to drive.
 *
 * Deliberately small: a behaviour decides policy and asks the engine to carry
 * it out. Nothing here exposes the heap, the request pool, or the clock's
 * mutability, so a behaviour cannot desynchronise the simulation.
 */
export interface BehaviourCtx {
  /** Current simulated time in ms. */
  readonly now: number;

  /**
   * One draw from the deterministic RNG. Behaviours must take draws in a fixed
   * order for a given event, or replay stops matching.
   */
  roll(): number;

  /** Queued (not yet in service) request count for a node. */
  queueDepth(state: NodeStateLike): number;
  /** queueLimit floored to a non-negative integer. */
  effectiveQueueLimit(state: NodeStateLike): number;
  /** capacity floored to at least one slot. */
  effectiveCapacity(state: NodeStateLike): number;

  /** Book a cache hit / miss against a node's rolling counters. */
  countHit(state: NodeStateLike): void;
  countMiss(state: NodeStateLike): void;

  /** Queue-node admission: ack the caller and buffer a detached copy. */
  ackAndBuffer(state: NodeStateLike, req: ReqLike): void;

  /** The shared edge-selection policy: weighted-random, or least-loaded on ties. */
  pickWeightedOrLeastLoaded(out: readonly SimEdge[]): SimEdge | null;

  /** Fail a request with a reason, contributing `latencyMs` to its parent. */
  fail(req: ReqLike, reason: FailureReason, latencyMs: number): void;

  /**
   * Refuse a request at `state` with an arbitrary reason, booking it against
   * that node's error counters. This is the general form of the engine's own
   * shed path: the two differ only in which counter is credited. A behaviour
   * uses it to refuse with a reason the engine has no opinion about --
   * 'throttled' for a spent token bucket, 'rejected' for an open circuit.
   */
  reject(state: NodeStateLike, req: ReqLike, reason: FailureReason): void;

  /**
   * Book a behaviour-defined counter against a node, in events per second
   * over the engine's standard rate window. Counter names are namespaced per
   * node, so two behaviours can never collide. Read back with counterRate().
   * This exists so a behaviour can publish a readout of its own without the
   * engine growing a fixed field for every kind that wants one.
   */
  countCustom(state: NodeStateLike, name: string, n: number): void;
  /** Read back a counter booked with countCustom(), as events per second. */
  counterRate(state: NodeStateLike, name: string): number;

  /* ---- controller surface ------------------------------------------ *
   * For kinds that act ON other nodes rather than serving requests: an
   * autoscaler writes a watched node's capacity, a region node needs to
   * know whether its chosen downstream is actually alive.
   * ------------------------------------------------------------------ */

  /**
   * A node's smoothed utilisation, 0..1, or null if it does not exist.
   * This is the same figure the UI shows, so a student watching the meter
   * is watching exactly what the controller reacts to.
   */
  utilizationOf(nodeId: string): number | null;
  /** A node's live capacity in slots, or null if it does not exist. */
  capacityOf(nodeId: string): number | null;
  /**
   * Write a node's capacity, in slots. Applied to both runtime state and the
   * stored topology so the Inspector shows what the controller did, and any
   * work waiting on the newly freed slots starts immediately.
   */
  setCapacity(nodeId: string, capacity: number): void;
  /**
   * Is this node currently taken out by an injected 'crash'? A controller
   * must not treat a crashed node as merely idle, and a region node uses it
   * to decide the active region has failed.
   */
  isCrashed(nodeId: string): boolean;
  /** Is this edge cut by an injected 'partition'? */
  isEdgeCut(edgeId: string): boolean;

  /* ---- self-managed service ---------------------------------------- *
   *
   * For a kind whose internal structure the engine has no concept of: a
   * sharded store is N independent queue-and-server units, which cannot be
   * expressed in the single busy/waiting pair on NodeState. These let such a
   * behaviour keep its own slot bookkeeping in `ext` while still driving the
   * engine's real service timing, error roll, timeout and completion path,
   * instead of reimplementing them and drifting from the other kinds.
   * ------------------------------------------------------------------ */

  /**
   * Draw a service time and schedule `req`'s completion at this node, WITHOUT
   * touching the node's own busy counter -- the behaviour owns that. Once the
   * service time elapses, `onDrained` fires (so the behaviour can release its
   * slot and start whatever it had waiting) and the request then continues
   * down the normal completion path: error roll, onServiceComplete, routing.
   */
  serveWithin(
    state: NodeStateLike,
    req: ReqLike,
    onDrained: (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void,
  ): void;

  /**
   * Add `extraMs` to the service time of a request the behaviour is about to
   * serve -- replication lag on a write, for instance. Applied by
   * serveWithin() on top of the drawn service time.
   */
  addServiceDelay(req: ReqLike, extraMs: number): void;

  /**
   * Publish a per-shard utilisation vector for the snapshot. The engine
   * copies it into NodeStats and computes max/min; it has no opinion about
   * what a "shard" is.
   */
  reportShardUtilization(state: NodeStateLike, perShard: readonly number[]): void;

  /** Mark a request as a write, so downstream kinds see the classification. */
  markWrite(req: ReqLike, isWrite: boolean): void;
}
