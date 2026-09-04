<p align="center">
  <img src="docs/banner.png" alt="Breakscale: build a system, load it until it breaks, watch why" width="100%" />
</p>

<p align="center">
  <a href="https://breakscale.tech"><strong>Try it</strong></a>
  &nbsp;·&nbsp;
  <a href="https://docs.breakscale.tech">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/xevrion/breakscale/actions/workflows/ci.yml">
    <img src="https://github.com/xevrion/breakscale/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/xevrion/breakscale/stargazers">
    <img src="https://img.shields.io/github/stars/xevrion/breakscale?style=flat&color=blue" alt="Stars" />
  </a>
  <a href="https://github.com/xevrion/breakscale/forks">
    <img src="https://img.shields.io/github/forks/xevrion/breakscale?style=flat&color=blue" alt="Forks" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT licensed" />
  </a>
  <a href="CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome" />
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/194049" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/194049/daily?language=TypeScript" alt="xevrion/breakscale | Trendshift" width="250" height="55" /></a>
</p>

Breakscale is a system design simulator for learning how distributed systems behave under load.
You place components on a canvas, wire them together, then drag a slider and watch real queueing
behaviour emerge: latency percentiles climbing, queues filling, circuit breakers tripping, whole
systems collapsing into retry storms.

Every number comes from an actual discrete-event simulation. Nothing is faked, approximated, or
animated to look plausible.

## Why this exists

Most system design material is static diagrams and rules of thumb. "Add a cache." "Use a queue."
It is hard to build intuition for why p99 latency falls off a cliff as utilisation passes 80
percent, or how a short timeout with retries turns one slow database into a total outage.

Breakscale runs the experiment instead. Load the Retry Storm example, drag the traffic up, and
watch goodput fall to zero while the database still runs flat out, because every request that
completes has already been abandoned by a caller that gave up.

## Getting started

You need [Bun](https://bun.sh).

```bash
git clone https://github.com/xevrion/breakscale.git
cd breakscale
bun install
bun dev
```

Open http://localhost:5173, pick an example from the left, and raise the traffic slider until
something goes red.

## What is in it

**33 components.** Load balancers, caches, databases, queues and workers, plus the things real
systems are actually made of: CDNs, rate limiters, circuit breakers, read replicas, sharded
stores, autoscalers, stream brokers, WebSocket gateways, serverless functions, bulkheads and more.

**23 worked examples.** Sixteen teaching scenarios, each isolating one failure mode, plus seven
reconstructions of real architectures:

| Example             | What it teaches                                                  |
| ------------------- | ---------------------------------------------------------------- |
| Single Server       | Latency climbs sharply as the database fills up                  |
| Load Balanced       | Three servers share the load, but all still talk to one database |
| Cache Aside         | Lower the hit rate and the database takes the whole load         |
| Async Workers       | The backlog grows when workers fall behind, and drains after     |
| Retry Storm         | Retries multiply the load that caused them                       |
| Rate Limited API    | Serves slightly less, but what it serves stays fast              |
| Circuit Breaker     | Break the dependency, watch the circuit trip, then recover       |
| Sharded Database    | One shard melts while the average still looks healthy            |
| Autoscaling Service | Requests fail in the gap while new servers boot                  |

Plus **Netflix**, **Spotify**, **Discord**, **Uber**, **Twitter/X**, **Stripe** and **WhatsApp**,
reconstructed from published engineering material. Each names what it models and what it leaves
out. They are teaching diagrams, not insider knowledge.

**Chaos controls.** Crash a node, slow it down, force an error rate, or cut a specific link, then
watch the failure propagate and see whether the design survives it.

**Explanations built in.** Every metric and unit has a plain-language definition covering both what
it means and why it matters, because a number a student cannot act on is trivia.

## How the simulation works

The engine in `src/sim` is a discrete-event simulator. Requests are real objects moving through the
topology, and a few details are what make the results worth trusting:

**Finite server slots.** A component's `capacity` is how many requests it can work on at once, and
`instances` is how many copies of it are running. Everything beyond `instances × capacity` waits in
a real FIFO queue, and beyond the queue limit it is shed.

**Service time variance.** Service time is a mean plus a coefficient of variation, sampled from a
gamma distribution. Variance is what makes tail latency diverge from the average, so it is modelled
rather than assumed away.

**Abandoned work still burns capacity.** When a caller times out, the downstream keeps working on a
request nobody is waiting for. This is why retry storms are visible here rather than theoretical.

**Queues acknowledge immediately.** A request entering a queue resolves as success at that point
and the message is buffered for workers. Backlog depth is real, so you can watch it build and
drain.

**Percentiles are measured.** p50, p95 and p99 come from a ring buffer of completed request
latencies, never from multiplying a mean by a constant.

The simulation is deterministic: the same seed and topology replay identically. Correctness is
covered by a test suite asserting request conservation, that the failure breakdown sums to the
failure total, that utilisation stays within bounds, and that no snapshot field is ever `NaN` or
infinite.

## Project layout

```
src/sim/         the simulation engine. No React, no DOM, no I/O
src/components/  canvas, inspector, metrics, palette
src/content/     glossary text
src/App.tsx      shell: layout, the animation loop, persistence
```

The engine has no UI dependency, so you can drive it from a script:

```ts
import { Engine } from './src/sim/engine';
import { PRESETS } from './src/sim/presets';

const engine = new Engine(PRESETS[0].topology, 42);
for (let i = 0; i < 600; i += 1) engine.advance(1000 / 60);
console.log(engine.snapshot().system);
```

## Contributing

Contributions are welcome, especially new components, new teaching examples, and better
explanations. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the project is put together and what
the bar is for a change.

The short version: the numbers have to be true. This is a tool people learn from, so a plausible
looking number is worse than no number at all.

## Built with

React, TypeScript and Vite, with Lucide for icons. The canvas is hand-rolled SVG and the charts are
drawn directly rather than pulled from a charting library, which keeps the bundle small and the
rendering predictable.

## Star history

<a href="https://star-history.com/#xevrion/breakscale&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=xevrion/breakscale&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=xevrion/breakscale&type=Date" />
    <img alt="Star history for xevrion/breakscale" src="https://api.star-history.com/svg?repos=xevrion/breakscale&type=Date" />
  </picture>
</a>

## License

[MIT](LICENSE)

The bundled Caveat webfont in `public/fonts/Caveat/` is **not** covered by the
MIT licence. It is licensed separately under the
[SIL Open Font License 1.1](public/fonts/Caveat/OFL.txt), which ships alongside
the font file as that licence requires.
Copyright 2014 The Caveat Project Authors.
