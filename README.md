# sys-sim

A system design simulator for learning how distributed systems behave under load.

Build a topology on a canvas, push traffic through it, and watch real queueing behaviour emerge:
latency percentiles, utilisation, queue backlogs, and failure cascades. Every number comes from an
actual discrete-event simulation, not a formula or an animation.

## Why

Most system design material is static diagrams and rules of thumb. "Add a cache." "Use a queue."
It is hard to develop intuition for *why* p99 latency falls off a cliff at 80% utilisation, or how
a short timeout with retries turns a slow database into a total outage.

This runs the experiment instead. Drag the load slider and watch it happen.

## Running it

```bash
bun install
bun dev
```

Then open http://localhost:5173.

## How the simulation works

The core is a discrete-event simulator in `src/sim/engine.ts`. Requests are real objects moving
through the topology, and the details that make the results trustworthy are:

**Finite server slots.** A node's `capacity` is the number of requests it can serve at once.
Everything beyond that waits in a real FIFO queue, and beyond `queueLimit` it is shed.

**Service time variance.** `serviceMs` is a mean, and `serviceCv` is the coefficient of variation,
sampled from a gamma distribution. `cv = 0` is deterministic, `cv = 1` is exponential. Variance is
what makes tail latency diverge from the average, so it is modelled rather than assumed away.

**Abandoned work still burns capacity.** When a caller times out, the downstream keeps working on
the request it can no longer deliver. This is why retry storms are visible here rather than
theoretical: retries add load precisely when a system can least afford it.

**Queues acknowledge immediately.** A request entering a queue node resolves as success at that
point and the message is buffered for workers. Backlog depth is real, so you can watch it build
when workers fall behind and drain when load drops. This is the sync-versus-async lesson.

**Percentiles are measured.** p50/p95/p99 come from a ring buffer of completed request latencies
over a trailing window, not from multiplying a mean by a constant.

The simulation is deterministic: the same seed and topology replay identically.

## Components

| Component | What it models |
| --- | --- |
| Client | Traffic source. Poisson arrivals at the configured rate; where end-to-end latency is measured |
| Load balancer | Distributes to downstreams, preferring the least loaded |
| Service | Finite worker threads, calls its downstreams and waits for all of them |
| Cache | Serves a hit fraction directly; a miss costs the downstream round trip |
| Database | Low capacity, higher service time. Usually the first thing to saturate |
| Queue | Acknowledges immediately and buffers. Decouples producer from consumer |
| Worker | Drains queues at its own rate |

## Examples

Each one demonstrates a single failure mode:

- **Single Server** — the latency knee as utilisation approaches 1
- **Load Balanced** — horizontal scaling, until the shared database becomes the bottleneck anyway
- **Cache Aside** — hit rate directly controlling database load
- **Async Workers** — a queue absorbing a spike, and the backlog draining afterwards
- **Retry Storm** — retries amplifying the load that caused them, into collapse

Load one, then raise the traffic slider to two to four times its default and watch it degrade.

## Layout

```
src/sim/       engine, types, presets, seeded RNG, event heap
src/components canvas, inspector, metrics charts, palette
src/App.tsx    shell, simulation loop, persistence
```

The engine has no React dependency and no I/O; it can be driven from a script for experiments.
`src/sim/types.ts` is the contract between the simulation and the UI.

## Notes

Built with Vite, React and TypeScript, with no runtime dependencies beyond React. The canvas is
hand-rolled SVG and the charts are drawn directly rather than pulled from a charting library, which
keeps the bundle small and the rendering predictable.
