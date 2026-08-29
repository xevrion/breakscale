import type { Challenge } from './challenge';

/**
 * The briefs.
 *
 * Each one is an existing preset with a load and a goal attached, chosen so
 * that the design as it ships FAILS and a specific, findable change makes it
 * pass. A brief you pass without touching anything teaches nothing, and one
 * with no reachable answer teaches less than that.
 *
 * Every threshold here was measured against the engine, not estimated: the
 * failing number is what the preset actually does at that load, and the
 * passing one is what it does after the change named in the hint. They are
 * pinned by tests for the same reason the presets' own copy is, because a
 * brief that has drifted from the simulation is worse than no brief.
 *
 * Deliberately few. Four briefs that each teach a different thing beat
 * twenty that teach the same one, and the set is easier to keep honest.
 */
export const CHALLENGES: Challenge[] = [
  {
    id: 'hold-the-line',
    name: 'Hold the line',
    brief:
      'Your one server and its database are handling 150 requests a second. The team has agreed that 99 out of 100 requests should come back within 200ms, and right now you are just over. Get under it.',
    presetId: 'single-server',
    loadRps: 150,
    goals: [{ metric: 'p99', max: 200 }],
    hint: 'The database is the only thing here that queues. Look at how many requests it can work on at once.',
  },
  {
    id: 'more-machines',
    name: 'More machines, not bigger ones',
    brief:
      'Three servers share 600 requests a second and they are dropping nearly a third of them. The budget is there for more database capacity. Stop the losses.',
    presetId: 'load-balanced',
    loadRps: 600,
    goals: [{ metric: 'errorRate', max: 1 }],
    hint: 'Try making the database bigger first. When that changes nothing, ask what a bigger machine actually buys you, and what it does not.',
  },
  {
    id: 'stop-the-storm',
    name: 'Stop the storm',
    brief:
      'At 150 requests a second this system is losing every single request. The database is working flat out the whole time, so it is not idle, and it is not broken. Work out where the load is coming from and make it serve traffic again.',
    presetId: 'retry-storm',
    loadRps: 150,
    goals: [
      { metric: 'errorRate', max: 1 },
      { metric: 'p99', max: 250 },
    ],
    hint: 'The API gives up after 250ms and tries again twice. Count how many requests the database is really being asked for, then decide whether to change the retries or what they land on.',
  },
  {
    id: 'keep-it-warm',
    name: 'Keep it warm',
    brief:
      'A cache sits in front of this database and traffic has reached 1,200 a second. Requests are timing out and about one in twenty is being lost. The agreement is 99 out of 100 inside 200ms, with losses under one percent.',
    presetId: 'cache-aside',
    loadRps: 1200,
    goals: [
      { metric: 'p99', max: 200 },
      { metric: 'errorRate', max: 1 },
    ],
    hint: 'The cache is not the thing that is full. Work out how many requests are getting past it, and whether what they land on was ever sized for that many. There is more than one way to fix this.',
  },
];

export function challengeById(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}
