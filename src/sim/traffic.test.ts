import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import { TRAFFIC_PATTERNS, type Topology, type TrafficPattern } from './types';

/**
 * Traffic patterns vary a client's offered rate over time.
 *
 * The properties worth pinning are that each pattern has the SHAPE it claims,
 * that leaving the field off changes nothing, and that determinism survives.
 * A pattern that merely produced "some varying number" would look right on a
 * chart and teach nothing.
 */

const PERIOD_S = 20;
const BASELINE_RPS = 100;

function clientTopology(pattern?: TrafficPattern): Topology {
  const client = makeNode('client', 0, 0, 'Client');
  const service = makeNode('service', 240, 0, 'Service');
  client.config.rps = BASELINE_RPS;
  if (pattern) {
    client.config.traffic = pattern;
    client.config.trafficPeriodS = PERIOD_S;
  }
  // Wide enough that the service never queues: this measures ARRIVALS, and a
  // bottleneck here would silently cap the very peaks the test is checking.
  service.config.capacity = 10_000;
  service.config.serviceMs = 1;
  service.config.queueLimit = 100_000;
  return {
    nodes: [client, service],
    edges: [{ id: 'e1', from: client.id, to: service.id, weight: 1 }],
  };
}

/** Requests that arrived in each one-second bucket. */
function arrivalsPerSecond(
  pattern: TrafficPattern | undefined,
  seconds: number,
): number[] {
  const engine = new Engine(clientTopology(pattern), 42);
  const perSecond: number[] = [];
  let seen = 0;
  for (let s = 0; s < seconds; s += 1) {
    for (let f = 0; f < 60; f += 1) engine.advance(1000 / 60);
    const total = engine.snapshot().system.totalRequests;
    perSecond.push(total - seen);
    seen = total;
  }
  return perSecond;
}

describe('traffic patterns', () => {
  it('steady holds the baseline', () => {
    const arrivals = arrivalsPerSecond('steady', 30);
    const mean = arrivals.reduce((a, b) => a + b, 0) / arrivals.length;
    // Poisson arrivals scatter around the mean; the shape claim is that it
    // does not trend, not that every second is identical.
    expect(mean).toBeGreaterThan(BASELINE_RPS * 0.9);
    expect(mean).toBeLessThan(BASELINE_RPS * 1.1);
  });

  it('ramp climbs, then holds at the baseline', () => {
    const arrivals = arrivalsPerSecond('ramp', PERIOD_S * 2);
    const firstQuarter = arrivals.slice(0, 5).reduce((a, b) => a + b, 0);
    const lastQuarter = arrivals
      .slice(PERIOD_S - 5, PERIOD_S)
      .reduce((a, b) => a + b, 0);
    expect(firstQuarter).toBeLessThan(lastQuarter);

    // Past one period it holds rather than climbing further.
    const afterPeriod = arrivals.slice(PERIOD_S + 2);
    const held = afterPeriod.reduce((a, b) => a + b, 0) / afterPeriod.length;
    expect(held).toBeGreaterThan(BASELINE_RPS * 0.8);
    expect(held).toBeLessThan(BASELINE_RPS * 1.2);
  });

  it('spike is quiet, then bursts above the baseline', () => {
    const arrivals = arrivalsPerSecond('spike', PERIOD_S);
    const peak = Math.max(...arrivals);
    const quiet = Math.min(...arrivals);
    expect(peak).toBeGreaterThan(BASELINE_RPS * 2);
    expect(quiet).toBeLessThan(BASELINE_RPS * 0.5);
  });

  it('spike moves the same work, not more of it', () => {
    // The lesson is burstiness. If a spike simply offered more traffic, any
    // failure it caused would be explained by volume and teach nothing.
    const spiked = arrivalsPerSecond('spike', PERIOD_S * 3);
    const steady = arrivalsPerSecond('steady', PERIOD_S * 3);
    const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(total(spiked)).toBeLessThan(total(steady));
  });

  it('diurnal peaks and troughs within one cycle', () => {
    const arrivals = arrivalsPerSecond('diurnal', PERIOD_S);
    const peak = Math.max(...arrivals);
    const trough = Math.min(...arrivals);
    expect(peak).toBeGreaterThan(trough * 2);
    // The trough is quiet but never silent: a day's low is not an outage.
    expect(trough).toBeGreaterThan(0);
  });
});

describe('traffic patterns leave existing designs alone', () => {
  it('an absent pattern matches steady exactly', () => {
    const withField = arrivalsPerSecond('steady', 20);
    const without = arrivalsPerSecond(undefined, 20);
    expect(without).toEqual(withField);
  });

  it('replays identically for the same seed', () => {
    for (const pattern of TRAFFIC_PATTERNS) {
      const a = arrivalsPerSecond(pattern, 15);
      const b = arrivalsPerSecond(pattern, 15);
      expect(b).toEqual(a);
    }
  });
});
