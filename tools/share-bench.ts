/**
 * Size benchmark for share links.
 *
 *   bun run tools/share-bench.ts
 *
 * Prints, for every worked example, how many characters the design costs
 * under each representation on the way to a URL. The objective is fixed:
 * the whole link under MAX_SHARE_URL_CHARS. Every encoding decision in
 * share/wire.ts was made against this table, and any change to it should
 * be justified by a new run of this script pasted into the change.
 *
 * Columns:
 *
 *   json      JSON.stringify of the readable Topology, pretty-printed
 *   min       the same, minified
 *   compact   generation 2: default config fields stripped, minified
 *   d2        compact JSON deflated and base64url'd (the old link body)
 *   bin       generation 3 wire bytes, uncompressed
 *   bin+z     the same, deflated
 *   d3        generation 3 link body: flag byte + best of bin/bin+z, base64url
 *   url       the full share URL for the production origin
 */

import { PRESETS, defaultConfig } from '../src/sim/presets.ts';
import type { Topology } from '../src/sim/types.ts';
import { MAX_SHARE_URL_CHARS, SHARE_VERSION, encodeTopology } from '../src/share.ts';
import { WIRE_SCHEMA, packTopology } from '../src/share/wire.ts';

const ORIGIN = 'https://breakscale.vercel.app/';

/* ---------------- helpers ---------------- */

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function base64UrlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** Generation 2's payload, reproduced so the old size is measured, not remembered. */
function compactJson(topology: Topology): string {
  const nodes = topology.nodes.map((node) => {
    const def = defaultConfig(node.kind) as unknown as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.config)) {
      if (v !== def[k]) config[k] = v;
    }
    return { ...node, x: Math.round(node.x), y: Math.round(node.y), config };
  });
  const annotations = topology.annotations ?? [];
  return JSON.stringify({
    nodes,
    edges: topology.edges,
    ...(annotations.length > 0 ? { annotations } : {}),
  });
}

/**
 * Raw-byte cost of the config section under the two candidate layouts,
 * measured on the design's real overrides. The mask is what shipped; the
 * index list is the alternative the spec asked to be measured against.
 */
function configLayouts(topology: Topology): { mask: number; list: number } {
  let mask = 0;
  let list = 0;
  const varintLen = (n: number): number => Math.max(1, Math.ceil(Math.log2(n + 1) / 7));
  for (const node of topology.nodes) {
    const def = defaultConfig(node.kind) as unknown as Record<string, unknown>;
    const schema = WIRE_SCHEMA[node.kind];
    let bits = 0;
    let n = 0;
    for (const [k, v] of Object.entries(node.config)) {
      if (v === undefined || v === def[k]) continue;
      n += 1;
      const bit = schema.indexOf(k as keyof typeof node.config);
      if (bit >= 0) bits += 2 ** bit;
    }
    mask += varintLen(bits * 2);
    list += 1 + n;
  }
  return { mask, list };
}

/* ---------------- run ---------------- */

interface Row {
  id: string;
  nodes: number;
  edges: number;
  anns: number;
  json: number;
  min: number;
  compact: number;
  d2: number;
  bin: number;
  binZ: number;
  d3: number;
  url: number;
}

async function measure(id: string, topology: Topology): Promise<Row> {
  const json = JSON.stringify(topology, null, 2).length;
  const min = JSON.stringify(topology).length;
  const compact = compactJson(topology);
  const compactZ = await deflate(new TextEncoder().encode(compact));
  const bin = packTopology(topology);
  const binZ = await deflate(bin);
  const d3 = await encodeTopology(topology);
  return {
    id,
    nodes: topology.nodes.length,
    edges: topology.edges.length,
    anns: topology.annotations?.length ?? 0,
    json,
    min,
    compact: compact.length,
    d2: 3 + base64UrlLength(compactZ.length + 1),
    bin: bin.length,
    binZ: binZ.length,
    d3: d3.length,
    url: ORIGIN.length + 1 + d3.length,
  };
}

function pad(v: string | number, w: number): string {
  return String(v).padStart(w);
}

const rows: Row[] = [];
for (const p of PRESETS) rows.push(await measure(p.id, p.topology));

console.log(
  `share link sizes, format ${SHARE_VERSION}, limit ${MAX_SHARE_URL_CHARS} url chars`,
);
console.log();
console.log(
  [
    'example'.padEnd(20),
    pad('n', 3),
    pad('e', 3),
    pad('a', 3),
    pad('json', 6),
    pad('min', 6),
    pad('compact', 8),
    pad('d2', 6),
    pad('bin', 6),
    pad('bin+z', 6),
    pad('d3', 6),
    pad('url', 6),
    '  fits',
  ].join(' '),
);
for (const r of rows) {
  console.log(
    [
      r.id.padEnd(20),
      pad(r.nodes, 3),
      pad(r.edges, 3),
      pad(r.anns, 3),
      pad(r.json, 6),
      pad(r.min, 6),
      pad(r.compact, 8),
      pad(r.d2, 6),
      pad(r.bin, 6),
      pad(r.binZ, 6),
      pad(r.d3, 6),
      pad(r.url, 6),
      r.url <= MAX_SHARE_URL_CHARS ? '  yes' : '  NO',
    ].join(' '),
  );
}

const worst = rows.reduce((a, b) => (b.url > a.url ? b : a));
const d2Worst = rows.reduce((a, b) => (b.d2 > a.d2 ? b : a));
console.log();
console.log(
  `largest link: ${worst.id}, ${worst.url} url chars (d2 body was ${worst.d2}, d3 body is ${worst.d3})`,
);
console.log(`largest d2 body: ${d2Worst.id} at ${d2Worst.d2} chars`);
console.log(
  `over the limit: ${
    rows
      .filter((r) => r.url > MAX_SHARE_URL_CHARS)
      .map((r) => r.id)
      .join(', ') || 'none'
  }`,
);

/* ---------------- the two decisions the spec asked to be measured ---------------- */

console.log();
console.log(
  'config section, raw bytes: per-kind bitmask (shipped) vs count + field index list',
);
let maskTotal = 0;
let listTotal = 0;
for (const p of PRESETS) {
  const c = configLayouts(p.topology);
  maskTotal += c.mask;
  listTotal += c.list;
}
console.log(`  mask ${maskTotal}  list ${listTotal}  across all examples`);

console.log();
console.log(
  'labels: how often a label repeats inside one design (a string table only pays for repeats)',
);
let repeats = 0;
let labels = 0;
for (const p of PRESETS) {
  const seen = new Map<string, number>();
  for (const n of p.topology.nodes) seen.set(n.label, (seen.get(n.label) ?? 0) + 1);
  labels += p.topology.nodes.length;
  for (const c of seen.values()) repeats += c - 1;
}
console.log(`  ${repeats} repeated labels out of ${labels}`);

/* ---------------- where the bytes go ---------------- */

console.log();
console.log(`byte budget of the largest design (${worst.id}), uncompressed wire bytes`);
{
  const t = PRESETS.find((p) => p.id === worst.id)?.topology;
  if (t) {
    const all = packTopology(t).length;
    const noAnn = packTopology({ nodes: t.nodes, edges: t.edges }).length;
    const noEdges = packTopology({ nodes: t.nodes, edges: [] }).length;
    const bare = packTopology({
      nodes: t.nodes.map((n) => ({ ...n, label: '' })),
      edges: [],
    }).length;
    console.log(`  nodes without labels ${bare}`);
    console.log(`  node labels          ${noEdges - bare}`);
    console.log(`  edges                ${noAnn - noEdges}`);
    console.log(`  annotations          ${all - noAnn}`);
    console.log(`  total                ${all}`);
  }
}
