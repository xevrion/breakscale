/**
 * Render one documentation page per bundled example.
 *
 * WHY THIS EXISTS. There are 23 worked examples, each a topology with a
 * lesson attached and notes written on the canvas explaining what to watch.
 * All of it lives inside the JS bundle, where no crawler and no AI assistant
 * reads it, and where nobody who has not already opened the app can find it.
 * They are the most teachable thing the project has and they are invisible.
 *
 * Generated rather than written by hand, for the same reason the glossary
 * page is: one source of truth. A hand-written page about the retry storm
 * example is wrong the first time somebody tunes the preset, and a teaching
 * tool whose documentation quietly disagrees with the tool is worse than one
 * with no documentation at all.
 *
 * The numbers go further than that. Rather than repeating prose about what
 * happens under load, this RUNS each example through the real engine at
 * several rates and prints what actually came out. Those tables cannot drift
 * because they are not copied from anywhere; they are measured at build time
 * by the same simulator the reader is being told about.
 *
 * Output is MDX for Mintlify. Deliberately plain MDX: frontmatter, prose,
 * tables and one callout. A docs page's job is to be readable and quotable,
 * and every component a generator reaches for is a thing that can render
 * differently than intended on a page nobody previews.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../src/sim/engine.ts';
import { PRESETS } from '../src/sim/presets.ts';
import type { Preset } from '../src/sim/presets.ts';
import { isNote } from '../src/sim/annotations.ts';
import type { NodeKind, SimSnapshot, Topology } from '../src/sim/types.ts';

/** Human label per kind, for the components table. */
const KIND_LABEL: Partial<Record<NodeKind, string>> = {
  client: 'Client',
  lb: 'Load balancer',
  cdn: 'CDN',
  edge: 'Edge compute',
  service: 'Service',
  worker: 'Worker',
  queue: 'Queue',
  retryqueue: 'Retry queue',
  transcoder: 'Transcoder',
  db: 'Database',
  cache: 'Cache',
  writebehind: 'Write-behind cache',
  replica: 'Read replicas',
  shard: 'Sharded store',
  objectstore: 'Object storage',
  search: 'Search index',
  timeseries: 'Time-series store',
  graphdb: 'Graph database',
  vectordb: 'Vector database',
  coldstorage: 'Cold storage',
  broker: 'Stream broker',
  pubsub: 'Pub/sub topic',
  websocket: 'WebSocket gateway',
  lambda: 'Serverless function',
  ratelimiter: 'Rate limiter',
  breaker: 'Circuit breaker',
  bulkhead: 'Bulkhead',
  autoscaler: 'Autoscaler',
  region: 'Region',
  cron: 'Scheduled job',
  loadgen: 'Load generator',
};

/**
 * Advance a topology by `seconds` of simulated time at 60fps, the same step
 * the app uses, so a number printed here is a number the reader can see.
 */
function run(topology: Topology, seconds: number, seed = 7): SimSnapshot {
  const engine = new Engine(structuredClone(topology), seed);
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i += 1) engine.advance(1000 / 60);
  return engine.snapshot();
}

/** Every client's offered rate, scaled by a multiplier. */
function atLoad(topology: Topology, multiplier: number): Topology {
  const next = structuredClone(topology);
  for (const n of next.nodes) {
    if (n.kind === 'client' && typeof n.config.rps === 'number') {
      n.config.rps = Math.round(n.config.rps * multiplier);
    }
  }
  return next;
}

/** The offered rate of a topology as it ships, summed over its clients. */
function baseRps(topology: Topology): number {
  return topology.nodes
    .filter((n) => n.kind === 'client')
    .reduce((sum, n) => sum + (typeof n.config.rps === 'number' ? n.config.rps : 0), 0);
}

function round(n: number, dp = 0): string {
  const f = 10 ** dp;
  return String(Math.round(n * f) / f);
}

/**
 * Escape the characters that would break MDX or a table cell.
 *
 * MDX reads `{` and `<` as the start of an expression and a JSX tag, so a
 * preset whose prose contains either renders as a syntax error rather than as
 * text. A pipe inside a table cell ends the cell early. None of the current
 * presets trip this, which is exactly why it is applied by the generator
 * rather than left to whoever writes the twenty-fourth one.
 */
function mdx(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[{}<>]/g, (c) => `\\${c}`);
}

/**
 * What the example does across a load sweep.
 *
 * Multipliers rather than absolute rates, because the presets are tuned to
 * very different scales: 45 rps for the retry storm, thousands for the
 * company designs. A multiple of the design's own baseline is the comparison
 * that means the same thing on every page.
 *
 * Finer than doubling on purpose. These examples exist to teach that systems
 * fall over a cliff rather than degrading smoothly, and a table that steps
 * 1x, 2x, 4x walks straight past the cliff: the retry storm is healthy at 2x
 * and serving nothing at 4x, so a doubling sweep shows a system that was fine
 * and then was not, which is the one thing the page should not leave a reader
 * believing is sudden and unexplained.
 */
const SWEEP = [1, 1.5, 2, 2.5, 3, 4, 6, 8];

interface Row {
  offered: number;
  goodput: number;
  p99: number;
  errorPct: number;
}

function measure(topology: Topology, base: number): Row[] {
  return SWEEP.map((m) => {
    const s = run(atLoad(topology, m), 20).system;
    return {
      offered: Math.round(base * m),
      goodput: s.goodputRps,
      p99: s.p99,
      errorPct: s.errorRate * 100,
    };
  });
}

function loadTable(rows: Row[]): string {
  const body = rows.map((r) => {
    // A percentile over zero completions is zero, which on a page reads as
    // "fast" when it means "nothing finished". Say so instead.
    const p99 = r.goodput > 0 ? `${round(r.p99, 1)}ms` : 'nothing served';
    return `| ${r.offered} | ${round(r.goodput)} | ${p99} | ${round(r.errorPct, 1)}% |`;
  });

  return [
    '| Offered | Goodput | p99 | Errors |',
    '| ---: | ---: | ---: | ---: |',
    ...body,
  ].join('\n');
}

/**
 * The sentence a reader remembers: the last rate this design holds, and the
 * first one at which it does not. Derived from the same rows the table
 * prints, so it can never claim a cliff the numbers below it do not show.
 *
 * "Holding" is defined as under 1% errors, which is the threshold the app's
 * own health colouring uses, rather than a number invented for this page.
 */
function cliffLine(rows: Row[]): string {
  const healthy = (r: Row): boolean => r.errorPct < 1 && r.goodput > 0;
  const lastGood = [...rows].reverse().find(healthy);
  const firstBad = rows.find((r) => !healthy(r));
  if (!lastGood || !firstBad || firstBad.offered <= lastGood.offered) return '';
  return `This design holds ${lastGood.offered} requests a second with ${round(lastGood.errorPct, 1)}% errors. At ${firstBad.offered} it is losing ${round(firstBad.errorPct)}% of them.`;
}

function componentsTable(topology: Topology): string {
  const counts = new Map<NodeKind, number>();
  for (const n of topology.nodes) {
    counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([kind, n]) => `| ${mdx(KIND_LABEL[kind] ?? kind)} | ${n} |`)
    .sort();
  return ['| Component | Count |', '| --- | ---: |', ...rows].join('\n');
}

/** The notes written on the canvas, which are the lesson in the author's words. */
function notes(topology: Topology): string[] {
  return (topology.annotations ?? [])
    .filter(isNote)
    .map((a) => a.text.trim())
    .filter((t) => t.length > 0);
}

function page(preset: Preset): string {
  const { topology } = preset;
  const base = baseRps(topology);
  const written = notes(topology);
  const rows = base > 0 ? measure(topology, base) : [];
  const cliff = rows.length > 0 ? cliffLine(rows) : '';

  const parts: string[] = [
    '---',
    `title: "${preset.name.replace(/"/g, "'")}"`,
    `description: "${preset.tagline.replace(/"/g, "'")}"`,
    '---',
    '',
    mdx(preset.description),
    '',
  ];

  if (written.length > 0) {
    parts.push('## What to watch', '');
    parts.push(...written.map((t) => `${mdx(t)}\n`));
  }

  parts.push('## What it is made of', '', componentsTable(topology), '');

  if (rows.length > 0) {
    parts.push(
      '## Under load',
      '',
      `Measured by running this design through the simulator at multiples of its own offered rate of ${base} requests a second. Twenty seconds of simulated time, one fixed seed, so the same numbers come out every time.`,
      '',
    );
    if (cliff) parts.push(`<Note>${cliff}</Note>`, '');
    parts.push(loadTable(rows), '');
  }

  parts.push(
    '<Card title="Open this example" icon="play" href="https://breakscale.tech">',
    `  Load **${mdx(preset.name)}** from the Examples menu and drag the traffic slider yourself.`,
    '</Card>',
    '',
  );

  return parts.join('\n');
}

/** Write every example page into `dir`, returning the page ids in order. */
export function writeExamplePages(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  for (const preset of PRESETS) {
    writeFileSync(join(dir, `${preset.id}.mdx`), page(preset), 'utf8');
  }
  return PRESETS.map((p) => p.id);
}
