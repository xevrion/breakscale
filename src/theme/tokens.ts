/**
 * Read the colour tokens out of a stylesheet's theme blocks.
 *
 * Parsing the CSS rather than restating the palette in TypeScript is
 * deliberate: a second copy is a second thing to keep in sync, and the point
 * of the contrast test is to check the values that actually ship.
 *
 * No file reading here, so this stays inside the DOM-only `src` project; the
 * test supplies the text.
 */

export type Tokens = Record<string, string>;

/**
 * Read one block's custom properties.
 *
 * `selector` is matched literally, so ':root' and ":root[data-theme='dark']"
 * select different blocks. The blocks contain no nested braces, so the first
 * closing brace at the start of a line ends one.
 */
export function readTokens(css: string, selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end < 0 ? undefined : end);
  const out: Tokens = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** Resolve a token that may be a `var(--other)` alias, one hop deep. */
export function resolve(tokens: Tokens, name: string): string | null {
  const v = tokens[name];
  if (!v) return null;
  const alias = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (alias) return tokens[alias[1]!] ?? null;
  return v;
}
