import type { Vendor } from './types';

/* ------------------------------------------------------------------ *
 * Microsoft Azure: published spec data.
 *
 * Every number in this file was copied from a Microsoft published page and
 * carries the URL it came from, so a reader can check it rather than trust
 * it. Where Microsoft publishes no figure for something, the field is
 * absent. A missing number is an honest gap; a plausible invented one is
 * the failure this file exists to avoid.
 *
 * The mapping from these specs to simulator behaviour is NOT in this file.
 * No vendor publishes how many concurrent requests an instance serves,
 * because that depends on what the software does. That derivation lives in
 * `derive.ts`, labelled as derived. See `types.ts` for why the two are kept
 * apart.
 *
 * Prices are pay-as-you-go in East US, Linux where the meter distinguishes
 * an operating system, read from the Azure Retail Prices API. That API is
 * the machine-readable form of the public pricing pages, so any price here
 * can be re-checked with one request to:
 *
 *   https://prices.azure.com/api/retail/prices
 *     ?$filter=armRegionName eq 'eastus' and priceType eq 'Consumption'
 *
 * CAVEATS a reader could otherwise misread as exact:
 *
 * - VM network bandwidth is not a guarantee. Azure calls it "expected"
 *   bandwidth, defines it as the maximum aggregated bandwidth across all
 *   NICs for all destinations, and states outright that upper limits are
 *   not guaranteed.
 * - VM IOPS is the VM's ceiling on remote disk traffic, not a property of
 *   any disk you attach. The disk has its own smaller limit and the lower
 *   of the two wins. Several sizes also burst above the listed figure for
 *   up to 30 minutes.
 * - Azure SQL Database publishes memory in GB, not GiB. It does not
 *   convert to the VM figures.
 * - Azure SQL Database prices are COMPUTE ONLY, billed per vCore hour.
 *   Storage and backup are separate meters, so this is not the whole bill.
 * - Azure SQL Database max concurrent sessions is 30,000 at every General
 *   Purpose size, so it does not distinguish one size from another. Max
 *   concurrent workers, which does vary, is the limit that bites first, so
 *   that is the number carried as `maxConnections` below.
 * - Azure SQL Database IO latency is published as a range (5-10 ms read,
 *   5-7 ms write) and called approximate and not guaranteed, so it is not
 *   carried here at all.
 * - Redis connection limits are ceilings for a lightly loaded cache.
 *   Microsoft warns that connection overhead plus client load can exhaust
 *   capacity before the limit is reached.
 * - Azure Managed Redis sizes above 350 GB are in preview.
 * - Prices exclude reserved capacity, spot and Azure Hybrid Benefit
 *   discounts. VM prices are the Linux meter; Windows costs more.
 * ------------------------------------------------------------------ */

/** ISO date every price below was read from the retail prices API. */
const PRICED_ON = '2026-08-28';

const VM_SPEC =
  'https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dsv5-series';

const SQL_SPEC =
  'https://learn.microsoft.com/en-us/azure/azure-sql/database/resource-limits-vcore-single-databases';

const REDIS_SPEC = 'https://learn.microsoft.com/en-us/azure/redis/overview';

export const AZURE: Vendor = {
  id: 'azure',
  label: 'Microsoft Azure',
  region: 'East US',

  kinds: {
    client: {
      product: 'Azure Front Door',
      note: 'The client is a browser or a phone, which is not an Azure product at all. Front Door is the first Azure thing a request touches, so it stands in for the edge.',
    },

    lb: {
      product: 'Azure Load Balancer',
      note: 'Azure splits load balancing in two. Load Balancer works at the TCP and UDP level; Application Gateway reads HTTP and can route on the URL path. Balancing traffic across identical servers is the Load Balancer job.',
    },

    /**
     * Dsv5, the general-purpose series. The published column headings are
     * "vCPUs (Qty.)", "Memory (GiB)", "Max Network Bandwidth (Mbps)" and
     * "Uncached Premium SSD IOPS". The network wording is carried verbatim
     * because Azure means expected, not guaranteed.
     */
    service: {
      product: 'Azure Virtual Machines',
      note: 'Virtual Machines is the size-and-price story a student can reason about. App Service and Container Apps run the same code with the machine hidden, which deploys more easily but hides the capacity number.',
      sizes: [
        {
          name: 'Standard_D2s_v5',
          vcpu: 2,
          memory: 8,
          memoryUnit: 'GiB',
          network: '12,500 Mbps max network bandwidth',
          maxIops: 3750,
          pricePerHour: 0.096,
          pricedOn: PRICED_ON,
          source: VM_SPEC,
        },
        {
          name: 'Standard_D4s_v5',
          vcpu: 4,
          memory: 16,
          memoryUnit: 'GiB',
          network: '12,500 Mbps max network bandwidth',
          maxIops: 6400,
          pricePerHour: 0.192,
          pricedOn: PRICED_ON,
          source: VM_SPEC,
        },
        {
          name: 'Standard_D8s_v5',
          vcpu: 8,
          memory: 32,
          memoryUnit: 'GiB',
          network: '12,500 Mbps max network bandwidth',
          maxIops: 12800,
          pricePerHour: 0.384,
          pricedOn: PRICED_ON,
          source: VM_SPEC,
        },
        {
          name: 'Standard_D16s_v5',
          vcpu: 16,
          memory: 64,
          memoryUnit: 'GiB',
          network: '12,500 Mbps max network bandwidth',
          maxIops: 25600,
          pricePerHour: 0.768,
          pricedOn: PRICED_ON,
          source: VM_SPEC,
        },
        {
          name: 'Standard_D32s_v5',
          vcpu: 32,
          memory: 128,
          memoryUnit: 'GiB',
          network: '16,000 Mbps max network bandwidth',
          maxIops: 51200,
          pricePerHour: 1.536,
          pricedOn: PRICED_ON,
          source: VM_SPEC,
        },
      ],
    },

    /**
     * Azure Managed Redis, Balanced tier: the 4:1 memory-to-vCPU ratio
     * Microsoft calls ideal for standard workloads.
     *
     * Microsoft keys the connection-limit table by size in GB and tier
     * rather than by SKU name, so the size on each row below is what lets
     * you find the right line in that table. Per-SKU vCPU counts are
     * published only inside an image, so they are not quoted.
     */
    cache: {
      product: 'Azure Managed Redis',
      note: 'Azure Cache for Redis is the name in most tutorials, but Microsoft has set its retirement for 30 September 2028 and blocks new creation for existing customers from 1 October 2026. New work goes to Azure Managed Redis.',
      sizes: [
        {
          name: 'B0 (Balanced, 0.5 GB)',
          memory: 0.5,
          memoryUnit: 'GB',
          maxConnections: 15000,
          pricePerHour: 0.016,
          pricedOn: PRICED_ON,
          source: REDIS_SPEC,
        },
        {
          name: 'B1 (Balanced, 1 GB)',
          memory: 1,
          memoryUnit: 'GB',
          maxConnections: 15000,
          pricePerHour: 0.032,
          pricedOn: PRICED_ON,
          source: REDIS_SPEC,
        },
        {
          name: 'B3 (Balanced, 3 GB)',
          memory: 3,
          memoryUnit: 'GB',
          maxConnections: 15000,
          pricePerHour: 0.065,
          pricedOn: PRICED_ON,
          source: REDIS_SPEC,
        },
        {
          name: 'B10 (Balanced, 12 GB)',
          memory: 12,
          memoryUnit: 'GB',
          maxConnections: 30000,
          pricePerHour: 0.315,
          pricedOn: PRICED_ON,
          source: REDIS_SPEC,
        },
        {
          name: 'B20 (Balanced, 24 GB)',
          memory: 24,
          memoryUnit: 'GB',
          maxConnections: 75000,
          pricePerHour: 0.629,
          pricedOn: PRICED_ON,
          source: REDIS_SPEC,
        },
      ],
    },

    /**
     * Azure SQL Database, General Purpose, provisioned compute,
     * standard-series (Gen5). East US bills 0.152217 USD per vCore hour and
     * the meter is exactly linear, so each price below is that rate times
     * the vCore count. `maxConnections` carries max concurrent WORKERS, not
     * sessions, because sessions are a flat 30,000 at every size.
     */
    db: {
      product: 'Azure SQL Database',
      note: 'The managed relational database. Azure also sells Database for PostgreSQL and for MySQL, the same idea with a different engine. SQL Database is the one Azure documents most deeply and prices per vCore.',
      sizes: [
        {
          name: 'GP_Gen5_2',
          vcpu: 2,
          memory: 10.4,
          memoryUnit: 'GB',
          maxIops: 640,
          maxConnections: 200,
          pricePerHour: 0.304434,
          pricedOn: PRICED_ON,
          source: SQL_SPEC,
        },
        {
          name: 'GP_Gen5_4',
          vcpu: 4,
          memory: 20.8,
          memoryUnit: 'GB',
          maxIops: 1280,
          maxConnections: 400,
          pricePerHour: 0.608868,
          pricedOn: PRICED_ON,
          source: SQL_SPEC,
        },
        {
          name: 'GP_Gen5_8',
          vcpu: 8,
          memory: 41.5,
          memoryUnit: 'GB',
          maxIops: 2560,
          maxConnections: 800,
          pricePerHour: 1.217736,
          pricedOn: PRICED_ON,
          source: SQL_SPEC,
        },
        {
          name: 'GP_Gen5_16',
          vcpu: 16,
          memory: 83,
          memoryUnit: 'GB',
          maxIops: 5120,
          maxConnections: 1600,
          pricePerHour: 2.435472,
          pricedOn: PRICED_ON,
          source: SQL_SPEC,
        },
        {
          name: 'GP_Gen5_32',
          vcpu: 32,
          memory: 166.1,
          memoryUnit: 'GB',
          maxIops: 12800,
          maxConnections: 3000,
          pricePerHour: 4.870944,
          pricedOn: PRICED_ON,
          source: SQL_SPEC,
        },
      ],
    },

    queue: {
      product: 'Azure Service Bus queues',
      note: 'Azure has two queue products. Storage queues are simpler and hold more data; Service Bus queues add what a job queue actually needs, including dead-lettering. Microsoft points work-queue designs at Service Bus.',
    },

    worker: {
      product: 'Azure Container Apps jobs',
      note: 'A worker pulls from a queue and scales with queue depth, which Container Apps jobs do natively. The same loop runs on a Virtual Machine, but then the scaling is yours to write.',
    },

    cdn: {
      product: 'Azure Front Door',
      note: 'Azure CDN Standard from Microsoft was folded into Front Door, so one product is both the global load balancer and the CDN.',
    },

    objectstore: {
      product: 'Azure Blob Storage (Hot tier)',
      note: 'Blob Storage is one product with several access tiers. Hot is the tier for data read often, which is what object storage usually means. Cool, Cold and Archive are the same blobs priced for data read rarely.',
    },

    searchindex: {
      product: 'Azure AI Search',
      note: 'Formerly Azure Cognitive Search. Same service, renamed.',
    },

    timeseriesdb: {
      product: 'Azure Data Explorer',
      note: 'Azure Time Series Insights was retired and this is where its workload went. Data Explorer is built for timestamped append-heavy data and queries it with KQL.',
    },

    graphdb: {
      product: 'Azure Cosmos DB for Apache Gremlin',
      note: 'Cosmos DB is one database with several APIs. Picking the Gremlin API at creation time is what makes an account a graph database.',
    },

    coldstorage: {
      product: 'Azure Blob Storage (Archive tier)',
      note: 'The same blobs as object storage, in the tier priced for data almost never read. Reading from Archive means rehydrating first, which takes hours, so it behaves like a different product.',
    },

    vectordb: {
      product: 'Azure AI Search',
      note: 'Azure has no standalone vector database. Vector search is a feature added to existing products: AI Search indexes vectors alongside text, Cosmos DB stores them next to documents. AI Search is the one built for retrieval.',
    },

    streambroker: {
      product: 'Azure Event Hubs',
      note: 'The partitioned append-only log, the same shape as Kafka. Event Hubs speaks the Kafka protocol, so Kafka clients connect unchanged.',
    },

    pubsub: {
      product: 'Azure Service Bus topics',
      note: 'Fan-out to independent subscribers. Event Grid also fans out but is built for reacting to Azure resource events; topics are the general publish and subscribe primitive for your own messages.',
    },

    websocket: {
      product: 'Azure Web PubSub',
      note: 'Azure has two. SignalR Service carries the SignalR protocol and its client libraries; Web PubSub is plain WebSocket with no framework attached.',
    },

    apigateway: {
      product: 'Azure API Management',
    },

    lambda: {
      product: 'Azure Functions',
    },

    cron: {
      product: 'Azure Functions timer trigger',
      note: 'Azure has no separate scheduler product. A scheduled job is an ordinary Function with a timer trigger and a cron expression.',
    },

    ratelimiter: {
      product: 'Azure API Management rate-limit policy',
      note: 'Not a product you buy. Rate limiting is a policy attached to an API Management API, or a rule in Front Door WAF to do it at the edge instead.',
    },

    replica: {
      product: 'Azure SQL Database geo-replica',
      note: 'Which feature depends on the goal: active geo-replication for a readable copy in another region, or the read scale-out replica included in Business Critical and Hyperscale for spreading read load.',
    },

    shard: {
      product: 'Azure Cosmos DB physical partition',
      note: 'Azure has no sharding product. Cosmos DB shards for you once you pick a partition key. For Azure SQL Database, sharding is something you build, with Elastic Database tools as a helper library.',
    },

    edgecompute: {
      product: 'Azure Front Door rules engine',
      note: 'Azure has no real equivalent of Cloudflare Workers. The rules engine rewrites and routes at the point of presence but does not run arbitrary code. IoT Edge is unrelated: it runs containers on hardware you own.',
    },

    // No `transcoder` entry. Azure Media Services was retired on 30 June
    // 2024 and Microsoft directs customers to third-party partners for
    // encoding rather than to any replacement Azure product. Omitting the
    // kind makes the lookup fall back to the generic name, which is the
    // honest answer. Naming some unrelated service here would not be.
    // https://learn.microsoft.com/en-us/previous-versions/azure/media-services/latest/azure-media-services-retirement
  },
};
