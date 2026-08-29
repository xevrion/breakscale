import type { SimSnapshot, Topology } from './types';

/**
 * A brief with a pass condition the engine can check.
 *
 * The sandbox teaches whoever already knows what to try. A brief teaches
 * everyone else, which is most of the people this tool is for: it says what
 * the system has to survive, and lets the reader find out for themselves
 * which part of their design is the one that gives way.
 *
 * A challenge is deliberately NOT a new kind of thing. It is a preset plus a
 * goal, because the expensive half of "add challenges" is authoring
 * scenarios and twenty-three of those already exist. `presetId` says which
 * design to start from; everything else here is the goal.
 */
export interface Challenge {
  id: string;
  /** Shown as the heading. A short imperative: "Survive the spike". */
  name: string;
  /**
   * The brief, in the words a client would use rather than in metrics.
   *
   * "Traffic triples at the top of the hour and it has to stay up" is the
   * problem; `goals` below is the same thing stated so a machine can check
   * it. Both are needed: the sentence is what makes it a task rather than a
   * form, and the goals are what make it checkable.
   */
  brief: string;
  presetId: string;
  /** Offered load the design is judged at, in requests per second. */
  loadRps: number;
  goals: Goal[];
  /**
   * What to change, in the reader's terms. Not a solution: a starting point,
   * because a blank "make it work" is where people give up.
   */
  hint: string;
}

/**
 * One checkable condition.
 *
 * Every metric here is measured by the engine already, so a goal never needs
 * the simulation to do anything new. `max` reads as "no more than", which is
 * the direction every one of these happens to run: latency, errors and cost
 * are all things you are trying to keep down.
 */
export interface Goal {
  metric: GoalMetric;
  max: number;
}

export type GoalMetric = 'p99' | 'errorRate' | 'p95';

/** How one goal came out, with the number that decided it. */
export interface GoalResult {
  goal: Goal;
  actual: number;
  met: boolean;
}

export interface ChallengeResult {
  passed: boolean;
  goals: GoalResult[];
}

/**
 * Read the metric a goal names off a snapshot.
 *
 * errorRate is stored as a fraction and stated in the brief as a percentage,
 * because "under 1%" is how the requirement is written down in real life and
 * "under 0.01" is not.
 */
function actualFor(metric: GoalMetric, snapshot: SimSnapshot): number {
  const s = snapshot.system;
  switch (metric) {
    case 'p99':
      return s.p99;
    case 'p95':
      return s.p95;
    case 'errorRate':
      return s.errorRate * 100;
  }
}

/**
 * Judge a run.
 *
 * A dead system is a FAILURE, never a pass, and that needs saying because
 * the arithmetic alone would get it wrong. When nothing completes there are
 * no latencies to take a percentile of, so p99 reads 0 and would satisfy any
 * "under 200ms" goal it was given. The errorRate goal catches this on its
 * own in every brief that has one, but a brief judged only on latency would
 * hand out a pass for a total outage. So a run with no goodput fails
 * outright, whatever the other numbers say.
 */
export function evaluate(challenge: Challenge, snapshot: SimSnapshot): ChallengeResult {
  const dead = snapshot.system.goodputRps <= 0;
  const goals = challenge.goals.map((goal) => {
    const actual = actualFor(goal.metric, snapshot);
    return { goal, actual, met: !dead && actual <= goal.max };
  });
  return { passed: !dead && goals.every((g) => g.met), goals };
}

/** The load a challenge is judged at, applied to every traffic source. */
export function applyLoad(topology: Topology, loadRps: number): Topology {
  const clients = topology.nodes.filter((n) => n.kind === 'client');
  if (clients.length === 0) return topology;
  const each = Math.max(1, Math.round(loadRps / clients.length));
  for (const c of clients) c.config.rps = each;
  return topology;
}
