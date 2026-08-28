import type { Vendor } from './types';

/* ------------------------------------------------------------------ *
 * Google Cloud: product names and published hardware specs.
 *
 * WHAT THIS FILE IS.
 *
 * Two kinds of fact, and nothing else. First, what Google calls the thing
 * a student already understands generically: a load balancer is "Cloud Load
 * Balancing", a database is "Cloud SQL". Second, for the handful of kinds
 * where picking a size is a real decision, the sizes Google publishes, with
 * the vCPU count, the memory, the network ceiling and the on-demand price.
 *
 * WHAT THIS FILE IS NOT.
 *
 * It is not a model of anything. No number here is turned into simulator
 * behaviour in this file, and nothing here says how many requests a
 * machine serves or how long one takes. Google does not publish that,
 * because it depends entirely on what the software does. That derivation
 * lives in `derive.ts`, alone and labelled, and the interface tells the
 * reader which numbers are derived rather than quoted.
 *
 * THE RULE FOR EVERY NUMBER BELOW.
 *
 * Published, with the URL it came from, or absent. AGENTS.md asks for
 * measured numbers and forbids plausible-looking ones, so a field Google
 * does not state is simply missing rather than filled in with something
 * reasonable. Several fields are missing for exactly that reason, and each
 * gap is explained where it occurs.
 *
 * UNITS. Google publishes Compute Engine machine memory as "Memory (GB)"
 * in the machine-type docs, while the pricing page for the same machines
 * writes GiB and states that Compute Engine counts memory "in JEDEC binary
 * gigabytes (GB) also known as gibibytes (GiB)". The two are the same
 * quantity under two spellings. `memoryUnit` records the docs' own spelling
 * per entry rather than converting, because converting is where a quoted
 * figure quietly becomes an approximated one.
 *
 * NETWORK. Kept as the vendor's own text, never a number. Google's own
 * footnote is that "Maximum egress bandwidth cannot exceed the number
 * given. Actual egress bandwidth depends on the destination IP address and
 * other factors." That is a ceiling, and "Up to 10 Gbps" stored as `10`
 * would read as a promise the vendor did not make.
 * ------------------------------------------------------------------ */

/** Every price in this file is the on-demand rate for this region. */
const REGION = 'us-central1 (Iowa)';

/** The day the prices below were read off Google's pricing pages. */
const PRICED_ON = '2026-08-28';

const MACHINE_TYPES_DOC =
  'https://docs.cloud.google.com/compute/docs/general-purpose-machines';
const COMPUTE_PRICING =
  'https://cloud.google.com/products/compute/pricing/general-purpose';

export const GCP: Vendor = {
  id: 'gcp',
  label: 'Google Cloud',
  region: REGION,
  kinds: {
    client: {
      product: 'Client',
      // Not a product. The browser or phone calling the system is outside
      // the cloud account, and naming a Google product here would invent a
      // component the student is not paying for.
    },

    lb: {
      product: 'Cloud Load Balancing',
      note: 'The layer 7 flavour is the external Application Load Balancer. Google groups every load balancer under one product name and distinguishes them by type rather than selling them separately.',
    },

    service: {
      product: 'Compute Engine',
      note: 'A plain virtual machine, chosen here because the sizes are the thing a student is picking. Cloud Run is the same workload without the machine choice, and GKE is the same workload with a cluster around it.',
      sizes: [
        // N2 is Google's mainstream general-purpose Intel series and the
        // one whose sizes read most like the textbook "4 vCPU, 16 GB box".
        {
          name: 'n2-standard-2',
          vcpu: 2,
          memory: 8,
          memoryUnit: 'GB',
          network: 'Up to 10 Gbps',
          pricePerHour: 0.097118,
          pricedOn: PRICED_ON,
          source: `${MACHINE_TYPES_DOC} and ${COMPUTE_PRICING}#n2-machine-types`,
        },
        {
          name: 'n2-standard-4',
          vcpu: 4,
          memory: 16,
          memoryUnit: 'GB',
          network: 'Up to 10 Gbps',
          pricePerHour: 0.194236,
          pricedOn: PRICED_ON,
          source: `${MACHINE_TYPES_DOC} and ${COMPUTE_PRICING}#n2-machine-types`,
        },
        {
          name: 'n2-standard-8',
          vcpu: 8,
          memory: 32,
          memoryUnit: 'GB',
          network: 'Up to 16 Gbps',
          pricePerHour: 0.388472,
          pricedOn: PRICED_ON,
          source: `${MACHINE_TYPES_DOC} and ${COMPUTE_PRICING}#n2-machine-types`,
        },
        {
          name: 'n2-standard-16',
          vcpu: 16,
          memory: 64,
          memoryUnit: 'GB',
          network: 'Up to 32 Gbps',
          pricePerHour: 0.776944,
          pricedOn: PRICED_ON,
          source: `${MACHINE_TYPES_DOC} and ${COMPUTE_PRICING}#n2-machine-types`,
        },
        // E2 is the cheap shared-core-adjacent series a student is likely to
        // actually start on, so one entry is included for the price contrast.
        {
          name: 'e2-standard-4',
          vcpu: 4,
          memory: 16,
          memoryUnit: 'GB',
          network: 'Up to 8 Gbps',
          pricePerHour: 0.13402284,
          pricedOn: PRICED_ON,
          source: `${MACHINE_TYPES_DOC} and ${COMPUTE_PRICING}#e2-machine-types`,
        },
      ],
    },

    db: {
      product: 'Cloud SQL',
      note: 'The managed relational database a student reaches for first. Spanner is the other choice and is a different lesson: it scales horizontally and costs accordingly, so it is not the default here.',
      sizes: [
        // Cloud SQL names a custom machine as db-custom-VCPU-MEMORYMB, where
        // the memory half is megabytes. Enterprise edition allows 1 to 96
        // vCPUs at 0.9 to 6.5 GB per vCPU, a multiple of 256 MB and at least
        // 3.75 GB, so each size below is a legal configuration.
        //
        // PRICE IS COMPOSED, NOT QUOTED. Google no longer publishes a price
        // per named Cloud SQL machine type; it publishes a rate per vCPU
        // hour and per GiB hour, and the console multiplies. So each price
        // here is vCPUs * 0.0413 + GiB * 0.007, the two published Enterprise
        // edition rates for a single-zone instance in us-central1. It is
        // arithmetic on two quoted numbers rather than a third quoted
        // number, and a high-availability instance is exactly double.
        //
        // maxConnections is PostgreSQL's published default for the memory
        // band the instance falls in, not a hard ceiling. See the note on
        // each entry: the figure is banded, and MySQL does not publish an
        // equivalent per-size default at all.
        {
          name: 'db-custom-2-7680',
          vcpu: 2,
          memory: 7.5,
          memoryUnit: 'GiB',
          // 7.5 GiB lands in the "from 7.5 to < 15" band, whose published
          // default max_connections is 400.
          maxConnections: 400,
          pricePerHour: 0.1351,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/sql/pricing and https://docs.cloud.google.com/sql/docs/postgres/flags',
        },
        {
          name: 'db-custom-4-16384',
          vcpu: 4,
          memory: 16,
          memoryUnit: 'GiB',
          // 16 GiB lands in the "from 15 to < 30" band, default 500.
          maxConnections: 500,
          pricePerHour: 0.2772,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/sql/pricing and https://docs.cloud.google.com/sql/docs/postgres/flags',
        },
        {
          name: 'db-custom-8-32768',
          vcpu: 8,
          memory: 32,
          memoryUnit: 'GiB',
          // 32 GiB lands in the "from 30 to < 60" band, default 600.
          maxConnections: 600,
          pricePerHour: 0.5544,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/sql/pricing and https://docs.cloud.google.com/sql/docs/postgres/flags',
        },
        {
          name: 'db-custom-16-65536',
          vcpu: 16,
          memory: 64,
          memoryUnit: 'GiB',
          // 64 GiB lands in the "from 60 to < 120" band, default 800.
          maxConnections: 800,
          pricePerHour: 1.1088,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/sql/pricing and https://docs.cloud.google.com/sql/docs/postgres/flags',
        },
      ],
    },

    cache: {
      product: 'Memorystore for Redis',
      note: 'Memorystore also comes in Valkey, Memcached and Redis Cluster flavours. Plain Redis is the one a student means by "add a cache".',
      sizes: [
        // Memorystore is NOT sized by machine type. You choose a memory size
        // in GiB, and the capacity tier that size falls into sets the price
        // per GiB hour and the minimum network performance. The entries
        // below are therefore one representative size per tier, named the way
        // Google names the tier.
        //
        // NO vCPU FIELD, DELIBERATELY. Google does not publish a vCPU count
        // per Memorystore tier, so there is none here. `derive.ts` reads a
        // missing count as "nothing honest to say" rather than guessing, and
        // a made-up core count is exactly what AGENTS.md rules out.
        //
        // maxConnections is the published 65,000 connected clients per
        // instance, which Google states uniformly for Basic and Standard
        // tiers rather than per size.
        {
          name: 'M1 Basic, 4 GiB',
          memory: 4,
          memoryUnit: 'GiB',
          network: '10 Gbps minimum',
          maxConnections: 65000,
          // $0.049 per GiB hour in the M1 Basic tier, times 4 GiB.
          pricePerHour: 0.196,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/memorystore/docs/redis/pricing and https://docs.cloud.google.com/memorystore/docs/redis/quotas',
        },
        {
          name: 'M2 Basic, 10 GiB',
          memory: 10,
          memoryUnit: 'GiB',
          network: '10 Gbps minimum',
          maxConnections: 65000,
          // $0.027 per GiB hour in the M2 Basic tier, times 10 GiB.
          pricePerHour: 0.27,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/memorystore/docs/redis/pricing and https://docs.cloud.google.com/memorystore/docs/redis/quotas',
        },
        {
          name: 'M3 Basic, 35 GiB',
          memory: 35,
          memoryUnit: 'GiB',
          network: '10 Gbps minimum',
          maxConnections: 65000,
          // $0.023 per GiB hour in the M3 Basic tier, times 35 GiB.
          pricePerHour: 0.805,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/memorystore/docs/redis/pricing and https://docs.cloud.google.com/memorystore/docs/redis/quotas',
        },
        {
          name: 'M2 Standard, 10 GiB',
          memory: 10,
          memoryUnit: 'GiB',
          network: '10 Gbps minimum',
          maxConnections: 65000,
          // $0.054 per GiB hour in the M2 Standard tier, times 10 GiB. The
          // Standard tier is the replicated, automatically failing-over one,
          // which is why it costs twice the Basic rate at the same size.
          pricePerHour: 0.54,
          pricedOn: PRICED_ON,
          source:
            'https://cloud.google.com/memorystore/docs/redis/pricing and https://docs.cloud.google.com/memorystore/docs/redis/quotas',
        },
      ],
    },

    queue: {
      product: 'Cloud Tasks',
      note: 'Cloud Tasks rather than Pub/Sub, because a queue in this sense has a named worker at the other end. Google draws the same line: with Cloud Tasks "a publisher specifies an endpoint where each message is to be delivered", while a Pub/Sub publisher needs to know nothing about its subscribers.',
    },

    worker: {
      product: 'Cloud Run jobs',
      note: 'A job runs its work and exits, which is what a background worker does. Google contrasts it with a Cloud Run service, which "listens for and serves requests". Cloud Run worker pools fit a queue consumer even better, but they are still in preview, so the stable answer is the one named here.',
    },

    cdn: {
      product: 'Cloud CDN',
    },

    objectstore: {
      product: 'Cloud Storage',
    },

    coldstorage: {
      product: 'Cloud Storage Archive class',
      note: "Not a separate product. Archive is one of Cloud Storage's storage classes, alongside Rapid, Standard, Nearline and Coldline, and it carries a 365 day minimum storage duration.",
    },

    searchindex: {
      product: 'Agent Search',
      note: 'Google has no managed Elasticsearch or OpenSearch of its own, which is the honest answer for a student who wants a search index you operate. Agent Search is the first-party product for searching your own data, and it is a retrieval service rather than an inverted index. Its own docs list six former names, including Vertex AI Search and Enterprise Search, so expect older material to call it something else.',
    },

    timeseriesdb: {
      product: 'Bigtable',
      note: 'No dedicated time series database exists at Google. Bigtable is the usual home for the workload, and Google lists "time-series data, such as CPU and memory usage over time for multiple servers" among its uses, but it is a wide-column store rather than a time series product.',
    },

    graphdb: {
      product: 'Spanner Graph',
      note: 'A feature of Spanner rather than a standalone graph database, and it needs the Enterprise or Enterprise Plus edition. Google has nothing that corresponds to a dedicated graph service.',
    },

    vectordb: {
      product: 'Vector Search',
      note: 'The dedicated vector index, renamed from Matching Engine and still carrying that name in some client library classes. If the vectors live beside relational data, pgvector on Cloud SQL or AlloyDB is the other route and avoids running a second system.',
    },

    streambroker: {
      product: 'Managed Service for Apache Kafka',
      note: 'Real Kafka, run by Google, for when the lesson is specifically Kafka. Pub/Sub covers the same shape of problem without the Kafka API.',
    },

    pubsub: {
      product: 'Pub/Sub',
      note: 'Written without a "Cloud" prefix. Publishers "trigger subscriber execution just by publishing an event", which is the distinction from Cloud Tasks.',
    },

    websocket: {
      product: 'Cloud Run',
      note: 'Google sells no dedicated WebSocket product the way a gateway with a WebSocket mode would be. Cloud Run supports them "with no additional configuration required", holding a stream open for as long as the request timeout, up to 60 minutes.',
    },

    apigateway: {
      product: 'API Gateway',
      note: 'The small, cheap one for putting an API in front of serverless backends. Apigee is the other product and is a full API management platform, which is a different scale of decision.',
    },

    lambda: {
      product: 'Cloud Run functions',
      note: 'Renamed from Cloud Functions. Google folded the functions product into Cloud Run, so the name a student sees today is this one.',
    },

    cron: {
      product: 'Cloud Scheduler',
    },

    ratelimiter: {
      product: 'Google Cloud Armor',
      note: 'Rate limiting is a policy on the load balancer edge rather than a component you place. Cloud Armor offers throttling to a configured threshold and rate-based bans.',
    },

    replica: {
      product: 'Cloud SQL read replica',
      note: 'Google recommends keeping direct read replicas to ten or fewer, and that is guidance rather than an enforced limit, so no number is stored here.',
    },

    shard: {
      product: 'Spanner',
      note: 'The closest thing to sharding you do not operate yourself. Spanner splits data automatically rather than asking you to choose a shard key the way a sharded Cloud SQL fleet would.',
    },

    edgecompute: {
      product: 'Service Extensions',
      note: 'Not a general edge runtime, so this is a partial match rather than an equivalent. Service Extensions run your own WebAssembly inside the load balancer, which suits rewriting a header and not hosting an application. The load balancer extensions are generally available; the Media CDN ones are still in preview.',
    },

    transcoder: {
      product: 'Transcoder API',
      // Sizing is not a choice here: the API bills by output minute and
      // exposes no machine to pick, so there are no sizes to list.
    },
  },
};
