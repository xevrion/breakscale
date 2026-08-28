import { isTopology } from './clipboard';
import { sanitizeAnnotations } from './sim/annotations';
import type { Topology } from './sim/types';

/* ------------------------------------------------------------------ *
 * Share links.
 *
 * A design is carried entirely in the URL fragment, so a link is a
 * complete document and nothing is ever uploaded anywhere. The fragment
 * (everything after `#`) is never sent to a server by the browser, which
 * is why the design goes there rather than in a query string.
 *
 * The payload is `d1.` followed by base64url text. Two facts drive that
 * shape:
 *
 *   - The version prefix. A future format has to be DETECTED, not
 *     misparsed: without a prefix, a v2 payload fed to a v1 reader would
 *     decode into plausible garbage and the reader would have no way to
 *     say "this link is newer than I am". One short token in front is the
 *     whole cost of never having that problem.
 *   - base64url, not base64. `+`, `/` and `=` are all hostile in a URL:
 *     the first two get percent-escaped by some clients and the padding
 *     is routinely eaten by chat apps and mail clients that guess where a
 *     link ends. The URL-safe alphabet has none of those characters.
 *
 * A raw topology is large (a twenty-node example with annotations is
 * several kilobytes of JSON), so it is deflated first WHERE THE BROWSER
 * OFFERS IT. `CompressionStream` is not universal and is missing from
 * some test environments, so the encoder falls back to uncompressed text
 * and marks which of the two it produced in a single leading byte. The
 * decoder reads that flag rather than sniffing, so neither path can ever
 * be mistaken for the other.
 *
 * Everything arriving through here came from someone else's URL and is
 * untrusted exactly the way the clipboard is. It is validated by the SAME
 * `isTopology` the paste path and the saved session use, and its
 * annotations by the same `sanitizeAnnotations`; there is deliberately no
 * second validator here to drift out of step with those.
 * ------------------------------------------------------------------ */

/**
 * Format marker. Bumped only when the bytes behind it change meaning, at
 * which point an old reader reports an unreadable link instead of showing
 * a wrong one.
 */
export const SHARE_VERSION = 'd1';

const PREFIX = `${SHARE_VERSION}.`;

/**
 * First byte of the decoded payload: which of the two encodings follows.
 * A flag rather than a sniff, so a JSON document that happens to begin
 * with a deflate-looking byte cannot be mistaken for a compressed one.
 */
const RAW = 0;
const DEFLATED = 1;

/**
 * Largest JSON document we will accept out of a link, in bytes.
 *
 * This is the decompression bomb guard. Deflate happily turns a few
 * hundred bytes of URL into hundreds of megabytes of output, and a
 * decoder that only checked its INPUT size would allocate all of it
 * before discovering the design was nonsense. The limit is applied to
 * the running output total, so a bomb is abandoned mid-stream rather
 * than after it has landed. Two megabytes is far above any real design
 * (the largest worked example is around 30KB of JSON) and far below
 * what would trouble a browser tab.
 */
export const MAX_DECODED_BYTES = 2 * 1024 * 1024;

/**
 * Ceiling on the encoded text itself, as a cheap first gate. Browsers
 * start truncating URLs somewhere above this, so a longer one could not
 * have arrived intact anyway and there is no point decoding it.
 */
const MAX_ENCODED_CHARS = 512 * 1024;

/**
 * A byte buffer backed by an ordinary ArrayBuffer.
 *
 * Written out rather than left as a bare `Uint8Array`, whose default
 * buffer type also admits a SharedArrayBuffer: the stream APIs will not
 * take one, so spelling the narrower type keeps the mismatch a compile
 * error here rather than a runtime surprise in one browser.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/* ---------------- base64url ---------------- */

function toBase64Url(bytes: Bytes): string {
  // Chunked, because `String.fromCharCode(...bytes)` on a large design
  // spreads tens of thousands of arguments onto the stack and throws.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Bytes | null {
  // Anything outside the alphabet means the link was mangled in transit
  // (or was never one of ours), and atob's own behaviour on stray
  // characters differs between engines. Reject it here so the answer is
  // the same everywhere.
  if (!/^[A-Za-z0-9\-_]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  // atob wants the padding back; the length modulo 4 says how much.
  const pad = b64.length % 4;
  if (pad === 1) return null;
  try {
    const bin = atob(pad === 0 ? b64 : b64 + '='.repeat(4 - pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/* ---------------- compression ---------------- */

/**
 * Whether this environment can deflate. Read at call time rather than
 * cached at module load, so a test can exercise both paths in one run
 * without the module remembering the wrong answer.
 */
function hasCompression(): boolean {
  return (
    typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
  );
}

/**
 * Feed a whole buffer into a transform stream and detach.
 *
 * Both promises are explicitly swallowed. When the reader on the other
 * end gives up on a bomb (see `drain`) the pending write and close reject
 * with that abort, and an unobserved rejection there would surface as a
 * crash in a context that has already handled the problem correctly.
 */
function pump(writable: WritableStream<BufferSource>, bytes: Bytes): void {
  const writer = writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
}

async function deflate(bytes: Bytes): Promise<Bytes> {
  const cs = new CompressionStream('deflate-raw');
  pump(cs.writable, bytes);
  const chunks = await drain(cs.readable, Number.POSITIVE_INFINITY);
  if (!chunks) throw new Error('deflate failed');
  return concat(chunks, Number.POSITIVE_INFINITY);
}

/**
 * Inflate with a hard ceiling on the OUTPUT. Returns null when the
 * stream is not valid deflate, and null when it runs past `limit`: a
 * link that expands to more than a real design ever could is a bomb, not
 * a diagram, and the only safe reading of it is no reading at all.
 */
async function inflate(bytes: Bytes, limit: number): Promise<Bytes | null> {
  try {
    const ds = new DecompressionStream('deflate-raw');
    pump(ds.writable, bytes);
    const chunks = await drain(ds.readable, limit);
    if (!chunks) return null;
    return concat(chunks, limit);
  } catch {
    // Malformed deflate data: the stream errors rather than returning.
    return null;
  }
}

/**
 * Read a stream to completion, giving up the moment the accumulated
 * output passes `limit`. Cancelling the reader is what actually stops a
 * bomb: without it the stream keeps inflating in the background.
 */
async function drain(
  stream: ReadableStream<Bytes>,
  limit: number,
): Promise<Bytes[] | null> {
  const reader = stream.getReader();
  const chunks: Bytes[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > limit) {
        // Cancelling tears down the underlying inflater, which rejects
        // whatever it had pending; that rejection is the expected result
        // of giving up and is not a second failure to report.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return chunks;
}

function concat(chunks: Bytes[], limit: number): Bytes {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const c of chunks) {
    if (at + c.length > out.length) break;
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ---------------- encode ---------------- */

/**
 * What actually travels: the two fields the engine reads plus the
 * annotations that explain them. Nothing else. The offered-load slider
 * value is derived from the client nodes on the other side, and the
 * preset id is a fact about the SENDER's session rather than about the
 * design, so neither is worth the characters.
 */
function payloadOf(topology: Topology): string {
  const annotations = topology.annotations ?? [];
  return JSON.stringify({
    nodes: topology.nodes,
    edges: topology.edges,
    ...(annotations.length > 0 ? { annotations } : {}),
  });
}

/**
 * Encode a topology as the fragment text of a share link, without the
 * leading `#`. Compressed when the browser can, plain when it cannot;
 * either way the result is URL-safe text a decoder on the far side reads
 * the same way.
 */
export async function encodeTopology(topology: Topology): Promise<string> {
  const json = new TextEncoder().encode(payloadOf(topology));
  if (hasCompression()) {
    try {
      const packed = await deflate(json);
      const body = new Uint8Array(packed.length + 1);
      body[0] = DEFLATED;
      body.set(packed, 1);
      return PREFIX + toBase64Url(body);
    } catch {
      // Fall through to the plain encoding. A link that is longer than
      // it needed to be still opens; a link that failed to build does
      // not.
    }
  }
  const body = new Uint8Array(json.length + 1);
  body[0] = RAW;
  body.set(json, 1);
  return PREFIX + toBase64Url(body);
}

/**
 * The whole shareable URL for a design, built from a base URL so the
 * function stays testable without a DOM. Query string and path are kept;
 * only the fragment is replaced.
 */
export async function buildShareUrl(topology: Topology, base: string): Promise<string> {
  const hash = await encodeTopology(topology);
  const hashless = base.split('#')[0] ?? base;
  return `${hashless}#${hash}`;
}

/* ---------------- decode ---------------- */

/**
 * What came back from a link.
 *
 * A discriminated union rather than `Topology | null`, because the three
 * outcomes need three different things said to the reader: a design that
 * opened, a link that is not ours to read (leave the session alone and
 * say nothing), and a link that WAS ours and did not survive the trip
 * (say so, because the reader is entitled to know their link is broken
 * rather than watching it silently do nothing).
 */
export type ShareResult =
  | { status: 'ok'; topology: Topology }
  | { status: 'absent' }
  | { status: 'invalid'; message: string };

/** Copy for the one case a reader has to be told about. */
const BAD_LINK =
  'That shared link could not be read, so your own design was opened instead.';

/**
 * Is this fragment even ours? Cheap and synchronous, so a boot path can
 * decide whether to wait for a decode before showing anything, without
 * paying for the decode itself.
 */
export function hasShareHash(hash: string): boolean {
  return normalize(hash).startsWith(PREFIX);
}

function normalize(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

/**
 * Decode a fragment back into a topology.
 *
 * Never throws and never returns something the engine cannot run:
 * truncation, a wrong alphabet, valid base64 wrapped around nonsense, a
 * payload that inflates without bound and a design carrying a hostile
 * annotation colour all end in a plain report rather than a crash, a
 * blank canvas or a style injection.
 */
export async function decodeTopology(hash: string): Promise<ShareResult> {
  const text = normalize(hash);
  if (!text) return { status: 'absent' };
  if (!text.startsWith(PREFIX)) {
    // Some other fragment: a deep link, a scroll anchor, a router path.
    // Not ours, so not an error.
    return { status: 'absent' };
  }
  if (text.length > MAX_ENCODED_CHARS) {
    return { status: 'invalid', message: BAD_LINK };
  }

  const body = fromBase64Url(text.slice(PREFIX.length));
  if (!body || body.length < 2) return { status: 'invalid', message: BAD_LINK };

  const flag = body[0];
  const rest = body.subarray(1);
  let json: Bytes | null;
  if (flag === DEFLATED) {
    if (!hasCompression()) {
      // A compressed link opened where nothing can inflate it. Say so
      // rather than showing an empty canvas.
      return { status: 'invalid', message: BAD_LINK };
    }
    json = await inflate(rest, MAX_DECODED_BYTES);
  } else if (flag === RAW) {
    json = rest.length > MAX_DECODED_BYTES ? null : rest;
  } else {
    // A flag from a format this build does not know.
    json = null;
  }
  if (!json) return { status: 'invalid', message: BAD_LINK };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch {
    return { status: 'invalid', message: BAD_LINK };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'invalid', message: BAD_LINK };
  }

  const p = parsed as { nodes?: unknown; edges?: unknown; annotations?: unknown };
  const candidate = { nodes: p.nodes, edges: p.edges };
  // The SAME structural gate the clipboard and the saved session use. A
  // dangling edge, an unknown kind or a non-finite coordinate is rejected
  // here, before the engine is ever handed the graph.
  if (!isTopology(candidate)) return { status: 'invalid', message: BAD_LINK };

  // Annotations are presentation data the engine never sees, so they
  // cross the boundary through their own sanitizer, which is also what
  // strips a colour crafted to break out of a style attribute.
  const annotations = sanitizeAnnotations(p.annotations);

  return {
    status: 'ok',
    topology: {
      nodes: candidate.nodes,
      edges: candidate.edges,
      ...(annotations.length > 0 ? { annotations } : {}),
    },
  };
}
