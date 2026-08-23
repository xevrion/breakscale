/**
 * Plain-language explanations for every term the interface puts in front of a
 * student.
 *
 * This is the single source of truth for both the hover/focus tooltips and the
 * glossary panel, so a term is never explained two different ways in two
 * places.
 *
 * House style for an entry, learned from watching people read this app:
 *   - `short` is what fits in a tooltip header and on a narrow screen. One
 *     line, no jargon, no trailing period.
 *   - `why` is the part that actually teaches. A metric a student cannot act
 *     on is trivia, so say what it tells them and what to do about it.
 *   - Never define a term using another undefined term. Where one entry leans
 *     on another, name it in `see` so the reader can follow the thread.
 *   - Address the reader as "you". Prefer "the slowest 1% of requests" over
 *     "the 99th percentile of the latency distribution".
 */

export type GlossaryCategory =
  | 'latency'
  | 'throughput'
  | 'failure'
  | 'capacity'
  | 'component'
  | 'unit';

export interface GlossaryEntry {
  /** Stable lookup key. Also the anchor id in the glossary panel. */
  id: string;
  /** How the term appears in the interface. */
  term: string;
  /** One-line definition. Tooltip header; no trailing period. */
  short: string;
  /** Why a student should care. Two or three sentences at most. */
  why: string;
  category: GlossaryCategory;
  /** Ids of related entries, for "see also" links. */
  see?: string[];
  /** Extra words that should match this entry when searching. */
  aliases?: string[];
}

export const GLOSSARY: GlossaryEntry[] = [
  /* ---- units ---------------------------------------------------------- */
  {
    id: 'rps',
    term: 'RPS',
    short: 'Requests per second',
    why: 'How much traffic is arriving. Every system has a point where more requests per second stops meaning more work done and starts meaning longer queues, so this is the dial you turn to find that point.',
    category: 'unit',
    aliases: ['requests per second', 'req/s', 'load', 'traffic'],
    see: ['throughput', 'goodput'],
  },
  {
    id: 'ms',
    term: 'ms',
    short: 'Milliseconds — one thousandth of a second',
    why: 'The unit for how long something took. For scale: 1 ms is imperceptible, 100 ms feels instant, 1000 ms (one second) is a noticeable wait, and past about 3000 ms most people give up.',
    category: 'unit',
    aliases: ['millisecond', 'milliseconds'],
    see: ['latency'],
  },

  /* ---- latency -------------------------------------------------------- */
  {
    id: 'latency',
    term: 'Latency',
    short: 'How long one request takes from start to finish',
    why: 'Measured here at the client, so it includes every hop, every queue and every retry along the way. It is the number your users actually feel.',
    category: 'latency',
    aliases: ['response time', 'delay'],
    see: ['p50', 'p99', 'queue-time'],
  },
  {
    id: 'percentile',
    term: 'Percentile',
    short: 'A ranking, not an average',
    why: 'Sort every request by how long it took. The 50th percentile is the one in the middle, the 99th is near the slow end. Percentiles are used instead of averages because one very slow request barely moves an average but is a real person waiting.',
    category: 'latency',
    aliases: ['percentiles', 'pXX'],
    see: ['p50', 'p95', 'p99'],
  },
  {
    id: 'p50',
    term: 'p50',
    short: 'The typical request — half were faster, half slower',
    why: 'Also called the median. It tells you what a normal experience looks like, but it deliberately ignores the worst half, so a healthy p50 can hide serious problems.',
    category: 'latency',
    aliases: ['median', '50th percentile'],
    see: ['p99', 'percentile'],
  },
  {
    id: 'p95',
    term: 'p95',
    short: 'The slowest 1 in 20 requests',
    why: 'Sits between the typical case and the worst case. Useful for spotting trouble building before it shows up in p99.',
    category: 'latency',
    aliases: ['95th percentile'],
    see: ['p50', 'p99'],
  },
  {
    id: 'p99',
    term: 'p99',
    short: 'The slowest 1 in 100 requests',
    why: 'The number to watch. It is where overload shows up first: p50 can look perfectly fine while p99 climbs, because queues punish the unlucky requests long before they slow down the typical one. On a busy page made of many requests, almost every user hits their p99 somewhere.',
    category: 'latency',
    aliases: ['99th percentile', 'tail latency'],
    see: ['p50', 'utilisation', 'queue-time'],
  },
  {
    id: 'queue-time',
    term: 'Queue time',
    short: 'Time spent waiting for a free slot, not being worked on',
    why: 'A request that takes 200 ms might have been served in 5 ms and queued for 195. Under load, most latency is waiting rather than working, which is why adding capacity helps more than making the work itself faster.',
    category: 'latency',
    aliases: ['waiting', 'wait time'],
    see: ['latency', 'utilisation', 'backlog'],
  },

  /* ---- throughput ----------------------------------------------------- */
  {
    id: 'throughput',
    term: 'Throughput',
    short: 'Requests finished per second',
    why: 'Work actually completed, as opposed to work arriving. Once a system is saturated, throughput flattens out no matter how much more traffic you send: that flat line is the system telling you its real limit.',
    category: 'throughput',
    aliases: ['completions'],
    see: ['rps', 'goodput', 'offered'],
  },
  {
    id: 'offered',
    term: 'Offered',
    short: 'Traffic arriving, whether or not it succeeds',
    why: 'Compare it with goodput. The gap between the two lines is the traffic your system is failing to serve.',
    category: 'throughput',
    aliases: ['offered load', 'arrival rate'],
    see: ['goodput', 'dropped'],
  },
  {
    id: 'goodput',
    term: 'Goodput',
    short: 'Requests that actually succeeded, per second',
    why: 'The only throughput number that counts, because a fast error is still an error. A system can look busy while its goodput is zero, which is exactly what a retry storm looks like.',
    category: 'throughput',
    aliases: ['successful throughput'],
    see: ['throughput', 'offered', 'dropped'],
  },
  {
    id: 'dropped',
    term: 'Dropped',
    short: 'Requests that arrived but were never served successfully',
    why: 'The gap between offered and goodput. Some were shed on purpose to protect the system, some timed out, some hit errors — the failure breakdown tells you which.',
    category: 'failure',
    aliases: ['lost'],
    see: ['shed', 'timeout', 'error-rate'],
  },

  /* ---- failure -------------------------------------------------------- */
  {
    id: 'error-rate',
    term: 'Error rate',
    short: 'The share of requests that failed',
    why: 'Counts every kind of failure together. Watch it alongside latency: a system that sheds load keeps latency low and error rate high, while one that queues everything does the opposite.',
    category: 'failure',
    aliases: ['errors', 'err'],
    see: ['dropped', 'shed', 'timeout'],
  },
  {
    id: 'shed',
    term: 'Shed',
    short: 'Turned away immediately because the queue was full',
    why: 'A deliberate defence, not a malfunction. Refusing a request instantly is far cheaper than accepting it, making it wait, and failing anyway — and it keeps the system responsive for everyone else.',
    category: 'failure',
    aliases: ['load shedding', 'rejected'],
    see: ['queue-limit', 'rate-limiter'],
  },
  {
    id: 'timeout',
    term: 'Timeout',
    short: 'The caller gave up waiting',
    why: 'The work usually carries on downstream even though nobody is waiting for the answer any more, so the capacity is spent for nothing. That is what makes retry storms so destructive.',
    category: 'failure',
    aliases: ['timed out'],
    see: ['retry', 'retry-storm'],
  },
  {
    id: 'retry',
    term: 'Retry',
    short: 'Automatically asking again after a failure',
    why: 'Helpful when failures are rare and random. Harmful when the system is already overloaded, because retries add load exactly when there is least to spare.',
    category: 'failure',
    see: ['retry-storm', 'timeout', 'breaker'],
  },
  {
    id: 'retry-storm',
    term: 'Retry storm',
    short: 'Retries multiplying the overload that caused them',
    why: 'A slow service causes timeouts, timeouts cause retries, retries add load, which makes it slower still. Systems can collapse to zero goodput this way while looking fully busy.',
    category: 'failure',
    see: ['retry', 'timeout', 'breaker'],
  },

  /* ---- capacity ------------------------------------------------------- */
  {
    id: 'utilisation',
    term: 'Utilisation',
    short: 'How much of a component’s capacity is in use',
    why: 'The single best early warning. Waiting time rises gently up to about 70%, then sharply, and becomes unbounded as it approaches 100%. A component at 95% is not "nearly fine" — it is about to fall over.',
    category: 'capacity',
    aliases: ['util', 'usage'],
    see: ['capacity', 'p99', 'queue-time'],
  },
  {
    id: 'capacity',
    term: 'Capacity',
    short: 'How many requests a component can work on at once',
    why: 'Think of it as the number of checkout tills open. Anything beyond that waits in line. Capacity times (1000 ÷ service time) gives the most requests per second a component can possibly handle.',
    category: 'capacity',
    aliases: ['slots', 'concurrency'],
    see: ['service-time', 'utilisation', 'instances'],
  },
  {
    id: 'service-time',
    term: 'Service time',
    short: 'How long the component takes to do the work itself',
    why: 'Excludes any queueing. It is the best case for that component: a request can never be faster than this, and under load it will be much slower.',
    category: 'capacity',
    aliases: ['processing time'],
    see: ['capacity', 'queue-time'],
  },
  {
    id: 'backlog',
    term: 'Backlog',
    short: 'Work piled up waiting to be processed',
    why: 'A backlog that keeps growing means arrivals are outpacing the workers, and it will never recover on its own. A backlog that spikes and drains is a system absorbing a burst, which is what queues are for.',
    category: 'capacity',
    aliases: ['queue depth', 'depth'],
    see: ['queue-limit', 'queue-time'],
  },
  {
    id: 'queue-limit',
    term: 'Queue limit',
    short: 'The longest the waiting line is allowed to get',
    why: 'Once it is full, new requests are shed instead of queued. Setting it is a real trade-off: a long queue absorbs bursts but makes waits longer, while a short one fails fast and stays responsive.',
    category: 'capacity',
    see: ['backlog', 'shed'],
  },
  {
    id: 'instances',
    term: 'Instances',
    short: 'How many copies of a component are running',
    why: 'Scaling out means running more copies. Doubling instances roughly doubles the work you can do, right up until a shared dependency further down becomes the new bottleneck.',
    category: 'capacity',
    aliases: ['replicas', 'copies', 'machines'],
    see: ['capacity', 'autoscaler', 'bottleneck'],
  },
  {
    id: 'bottleneck',
    term: 'Bottleneck',
    short: 'The one component that limits the whole system',
    why: 'A system is only as fast as its narrowest point. Adding capacity anywhere else changes nothing, which is why finding the bottleneck matters more than optimising everything.',
    category: 'capacity',
    see: ['utilisation', 'instances'],
  },

  /* ---- components ----------------------------------------------------- */
  {
    id: 'load-balancer',
    term: 'Load balancer',
    short: 'Spreads incoming requests across several servers',
    why: 'Lets you scale out by adding servers. It does not create capacity, though — if every server talks to the same database, that database is still the bottleneck.',
    category: 'component',
    aliases: ['lb'],
    see: ['bottleneck', 'instances'],
  },
  {
    id: 'cache',
    term: 'Cache',
    short: 'Remembers recent answers so the work is not repeated',
    why: 'A hit is answered immediately; a miss costs a full trip to whatever is behind it. Hit rate is the whole story: at 90%, the database sees only a tenth of the traffic.',
    category: 'component',
    see: ['hit-rate', 'cdn'],
  },
  {
    id: 'hit-rate',
    term: 'Hit rate',
    short: 'The share of requests a cache can answer by itself',
    why: 'Small changes here have outsized effects. Going from 90% to 80% hit rate does not add 10% more database load — it doubles it.',
    category: 'component',
    aliases: ['cache hit'],
    see: ['cache', 'cdn'],
  },
  {
    id: 'cdn',
    term: 'CDN',
    short: 'A cache close to your users, in front of everything',
    why: 'Serves the common requests before they ever reach your servers. The cheapest traffic to handle is traffic your system never sees.',
    category: 'component',
    aliases: ['content delivery network', 'edge cache'],
    see: ['cache', 'hit-rate'],
  },
  {
    id: 'queue',
    term: 'Queue',
    short: 'Accepts work now so it can be done later',
    why: 'The caller gets an answer immediately while the work is buffered for a worker. This is how a system absorbs a spike instead of collapsing under it — but only if the workers eventually catch up.',
    category: 'component',
    aliases: ['message queue', 'buffer'],
    see: ['worker', 'backlog', 'async'],
  },
  {
    id: 'async',
    term: 'Asynchronous',
    short: 'Answering before the work is finished',
    why: 'Keeps the user waiting only for an acknowledgement rather than the whole job. The trade-off is that the answer is a promise, and the work can still fail after you have replied.',
    category: 'component',
    aliases: ['async', 'background work'],
    see: ['queue', 'worker'],
  },
  {
    id: 'worker',
    term: 'Worker',
    short: 'Processes queued work in the background',
    why: 'Workers set the drain rate. If they are slower than arrivals, the backlog grows without limit no matter how big the queue is.',
    category: 'component',
    see: ['queue', 'backlog'],
  },
  {
    id: 'rate-limiter',
    term: 'Rate limiter',
    short: 'Caps how many requests are let through per second',
    why: 'Protects what is behind it by refusing excess traffic cheaply and immediately. Errors go up, but latency stays flat and the service survives — often the better failure.',
    category: 'component',
    aliases: ['throttle', 'token bucket'],
    see: ['shed', 'burst'],
  },
  {
    id: 'burst',
    term: 'Burst',
    short: 'How much traffic can arrive at once before limiting starts',
    why: 'Lets a rate limiter absorb a short spike without punishing normal, uneven traffic. Real traffic arrives in clumps, not at a steady drip.',
    category: 'component',
    see: ['rate-limiter'],
  },
  {
    id: 'breaker',
    term: 'Circuit breaker',
    short: 'Stops calling a dependency that is already failing',
    why: 'When errors pass a threshold it opens and fails instantly without calling downstream, giving the struggling service room to recover. It then lets a few test requests through to check whether it is safe to resume.',
    category: 'component',
    aliases: ['circuit breaker', 'open', 'closed', 'half-open'],
    see: ['retry-storm', 'timeout'],
  },
  {
    id: 'autoscaler',
    term: 'Autoscaler',
    short: 'Adds and removes instances to track a utilisation target',
    why: 'Watches a component and scales it to keep utilisation near a setpoint. New instances take time to start, so capacity always lags load — which is why a sharp spike still hurts even with autoscaling on.',
    category: 'component',
    see: ['instances', 'utilisation', 'warmup'],
  },
  {
    id: 'warmup',
    term: 'Warm-up',
    short: 'The delay before a new instance can serve traffic',
    why: 'Machines boot, caches fill, connections open. Scaling up is never instant, and this gap is when the system is most likely to fail.',
    category: 'component',
    aliases: ['warmup', 'boot time'],
    see: ['autoscaler', 'instances'],
  },
  {
    id: 'shard',
    term: 'Shard',
    short: 'A slice of the data, held on its own partition',
    why: 'Splitting data across shards multiplies capacity, as long as traffic spreads evenly. One popular key breaks that assumption: a single shard saturates while the rest sit idle, and the total looks healthy while users see failures.',
    category: 'component',
    aliases: ['sharding', 'partition'],
    see: ['hot-key', 'bottleneck'],
  },
  {
    id: 'hot-key',
    term: 'Hot key',
    short: 'One piece of data that far more requests want',
    why: 'Defeats sharding, because a single key can only live on one shard. Average utilisation stays low while that one shard is on fire.',
    category: 'component',
    aliases: ['hotspot', 'hot partition'],
    see: ['shard'],
  },
  {
    id: 'read-replica',
    term: 'Read replica',
    short: 'A copy of the database that serves reads only',
    why: 'Most workloads read far more than they write, so replicas scale the common case cheaply. The cost is that a replica can be slightly behind the primary.',
    category: 'component',
    aliases: ['replica'],
    see: ['replication-lag', 'stale-read'],
  },
  {
    id: 'replication-lag',
    term: 'Replication lag',
    short: 'How far behind the primary a replica is',
    why: 'A write takes time to reach the replicas. Read during that window and you get the old value, which is why a user can save a change and then not see it.',
    category: 'component',
    see: ['read-replica', 'stale-read'],
  },
  {
    id: 'stale-read',
    term: 'Stale read',
    short: 'Getting an out-of-date answer from a replica',
    why: 'The visible cost of scaling reads. Usually harmless, occasionally serious — showing a stale balance or an unsaved edit is how this becomes a real bug.',
    category: 'component',
    see: ['replication-lag', 'read-replica'],
  },
  {
    id: 'region',
    term: 'Region',
    short: 'A separate location your system runs in',
    why: 'Running in more than one region means one can fail without taking everything down. Failover is not instant, though, and requests arriving mid-switch are still lost.',
    category: 'component',
    aliases: ['failover', 'multi-region'],
    see: ['bottleneck'],
  },
];

/** Fast lookup by id. */
export const GLOSSARY_BY_ID: ReadonlyMap<string, GlossaryEntry> = new Map(
  GLOSSARY.map((e) => [e.id, e]),
);

/**
 * Search across term, aliases and definition text.
 *
 * Ranked so an exact term match always beats an incidental mention in some
 * other entry's `why` text, which is what makes typing "p99" feel correct
 * rather than returning six entries that happen to discuss it.
 */
export function searchGlossary(query: string): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return GLOSSARY;

  const scored: Array<{ entry: GlossaryEntry; score: number }> = [];
  for (const entry of GLOSSARY) {
    const term = entry.term.toLowerCase();
    const aliases = entry.aliases?.map((a) => a.toLowerCase()) ?? [];

    let score = 0;
    if (term === q || aliases.includes(q)) score = 100;
    else if (term.startsWith(q)) score = 80;
    else if (aliases.some((a) => a.startsWith(q))) score = 70;
    else if (term.includes(q)) score = 50;
    else if (aliases.some((a) => a.includes(q))) score = 40;
    else if (entry.short.toLowerCase().includes(q)) score = 20;
    else if (entry.why.toLowerCase().includes(q)) score = 10;

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.entry.term.localeCompare(b.entry.term),
  );
  return scored.map((s) => s.entry);
}

export const CATEGORY_LABEL: Record<GlossaryCategory, string> = {
  latency: 'Latency',
  throughput: 'Throughput',
  failure: 'Failures',
  capacity: 'Capacity',
  component: 'Components',
  unit: 'Units',
};
