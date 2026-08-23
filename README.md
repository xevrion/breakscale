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

**Finite server slots.** A node's `capacity` is how many requests it can work on at once, and
`instances` is how many copies of it are running. Everything beyond `instances × capacity` waits in
a real FIFO queue, and beyond `queueLimit` it is shed.

**Service time variance.** `serviceMs` is a mean, and `serviceCv` is the coefficient of variation,
sampled from a gamma distribution. `cv = 0` is deterministic, `cv = 1` is exponential. Variance is
what makes tail latency diverge from the average, so it is modelled rather than assumed away.

**Abandoned work still burns capacity.** When a caller times out, the downstream keeps working on
the request it can no longer deliver. This is why retry storms are visible here rather than
theoretical: retries add load precisely when a system can least afford it.

**Queues acknowledge immediately.** A request entering a queue node resolves as success at that
point and the message is buffered for workers. Backlog depth is real, so you can watch it build
when workers fall behind and drain when load drops.

**Percentiles are measured.** p50/p95/p99 come from a ring buffer of completed request latencies
over a trailing window, not from multiplying a mean by a constant.

The simulation is deterministic: the same seed and topology replay identically. Correctness is
covered by an invariant harness asserting conservation of requests, that the failure breakdown sums
to the failure total, that utilisation stays within [0, 1], and that no snapshot field is ever NaN
or infinite.

## Components

| Component | What it models |
| --- | --- |
| Client | Traffic source. Poisson arrivals at the configured rate; where end-to-end latency is measured |
| Load balancer | Distributes to downstreams, preferring the least loaded |
| Service | Finite worker threads; calls its downstreams and waits for all of them |
| Cache | Serves a hit fraction directly; a miss costs the downstream round trip |
| Database | Low capacity, higher service time. Usually the first thing to saturate |
| Queue | Acknowledges immediately and buffers. Decouples producer from consumer |
| Worker | Drains queues at its own rate |
| CDN | An edge cache in front of everything; a miss costs a trip to the origin |
| Rate limiter | Token bucket. Refuses excess traffic cheaply instead of queueing it |
| Circuit breaker | Trips open when a dependency fails, stops calling it, then probes for recovery |
| Read replicas | Scales reads, not writes. A read can arrive before the write it should have seen |
| Sharded store | Partitions data by key. One hot key saturates a single shard |
| Autoscaler | Adds and removes instances to hold utilisation near a target, with warm-up delay |
| Region | Failover between locations. Traffic shifts after the failover window |

Behaviour lives in a registry (`src/sim/behaviour*.ts`), one object per kind, so the event loop
contains no per-kind branching and a new component is a single entry.

## Examples

Each preset isolates one failure mode. Load one, then raise the traffic slider to two to four times
its default and watch it degrade.

- **Single Server** — latency climbs sharply as the database fills up
- **Load Balanced** — three servers share the load, but all still talk to one database
- **Cache Aside** — lower the hit rate and the database takes the whole load
- **Async Workers** — the backlog grows when workers fall behind, and drains after
- **Retry Storm** — retries multiply the load that caused them
- **CDN + Origin** — drop the hit rate and watch the origin melt
- **Rate Limited API** — serves slightly less, but what it serves stays fast
- **Circuit Breaker** — break the dependency, watch the circuit trip, then recover
- **Read Replicas** — a read can arrive before the write it should have seen
- **Sharded Database** — one shard melts while the average still looks healthy
- **Autoscaling Service** — requests fail in the gap while new servers boot
- **Multi-Region Failover** — crash the active region; every request fails until failover lands
- **Full Stack** — every tier at once

The failure signatures differ in instructive ways. Rate Limited API sheds a large share of traffic
while p99 stays flat; Single Server fails far fewer requests but triples its p99. Same overload,
opposite failure modes: one refuses work, the other makes everyone wait.

## Chaos

The engine supports failure injection: crash a node, slow it down, force an error rate, or
partition a specific edge. Faults compose correctly with retries, timeouts and the circuit breaker,
so you can break a dependency and watch the breaker respond.

## Glossary

Every metric and unit the interface shows has a plain-language explanation in
`src/content/glossary.ts`, covering what the term means and why it matters. It is the single source
for both the in-app tooltips and the glossary panel, so nothing is ever explained two ways.

## Layout

```
src/sim/         engine, component behaviour registry, types, presets, seeded RNG, event heap
src/content/     glossary text
src/components/  canvas, inspector, metrics charts, palette
src/App.tsx      shell, simulation loop, persistence
```

The engine has no React dependency and no I/O, so it can be driven from a script for experiments.
`src/sim/types.ts` is the contract between the simulation and the UI.

## Notes

Built with Vite, React and TypeScript, with no runtime dependencies beyond React. The canvas is
hand-rolled SVG and the charts are drawn directly rather than pulled from a charting library, which
keeps the bundle small and the rendering predictable.
