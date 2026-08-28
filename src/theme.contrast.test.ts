/**
 * WCAG contrast for both themes, computed from index.css itself.
 *
 * AGENTS.md: "Text meets WCAG AA. Compute the ratio; do not estimate it."
 * The dark palette carries 132 derived per-kind colours on top of the core
 * ramp, which is far past what anyone can check by eye, so the check reads
 * the shipped stylesheet and does the arithmetic. A palette edit that drops a
 * pair below AA fails here rather than reaching a reader.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from './theme/contrast';
import { readTokens, resolve } from './theme/tokens';
import type { Tokens } from './theme/tokens';

// Read off disk rather than importing. `import css from './index.css?raw'`
// yields an empty string under vitest, because CSS is handled by the style
// pipeline instead of being served as text, and an empty palette would make
// every assertion below pass vacuously.
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

const THEMES: Array<[string, Tokens]> = [
  ['light', readTokens(css, ':root')],
  ['dark', readTokens(css, ":root[data-theme='dark']")],
];

/** WCAG AA for body text. */
const AA = 4.5;
/** WCAG AA for large text and for non-text UI components. */
const AA_LARGE = 3;

function colour(t: Tokens, name: string): string {
  const v = resolve(t, name);
  if (!v) throw new Error(`missing token ${name}`);
  return v;
}

describe.each(THEMES)('%s theme', (_name, tokens) => {
  it('carries body text at AA on every surface it is painted on', () => {
    for (const surface of ['--bg', '--surface', '--surface-2', '--surface-3']) {
      expect(
        ratio(colour(tokens, '--text'), colour(tokens, surface)),
        `--text on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('carries dimmed text at AA on the two main surfaces', () => {
    for (const surface of ['--bg', '--surface']) {
      expect(
        ratio(colour(tokens, '--text-dim'), colour(tokens, surface)),
        `--text-dim on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('keeps the faintest text above the large-text floor', () => {
    // --text-faint is used for labels set in caps at a larger optical size,
    // which is why it is held to AA_LARGE rather than AA.
    for (const surface of ['--bg', '--surface']) {
      expect(
        ratio(colour(tokens, '--text-faint'), colour(tokens, surface)),
        `--text-faint on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('carries status colours at AA on both surfaces', () => {
    for (const status of ['--ok', '--warn', '--danger', '--accent']) {
      for (const surface of ['--bg', '--surface']) {
        expect(
          ratio(colour(tokens, status), colour(tokens, surface)),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('carries each status ink on its own soft plate', () => {
    for (const [ink, soft] of [
      ['--ok', '--ok-soft'],
      ['--warn', '--warn-soft'],
      ['--danger', '--danger-soft'],
      ['--accent-ink', '--accent-soft'],
    ]) {
      expect(
        ratio(colour(tokens, ink!), colour(tokens, soft!)),
        `${ink} on ${soft}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('reads a button label against its own accent fill', () => {
    expect(
      ratio(colour(tokens, '--accent-fg'), colour(tokens, '--accent')),
      '--accent-fg on --accent',
    ).toBeGreaterThanOrEqual(AA);
  });

  it('carries every component kind label on its own fill', () => {
    // 33 kinds, one assertion each: the node label is the text a student
    // actually reads, and it sits on the kind's tinted plate rather than on
    // the page background.
    const kinds = [
      ...new Set(
        Object.keys(tokens)
          .map((k) => /^--kind-([a-z0-9]+)-ink$/.exec(k)?.[1])
          .filter((k): k is string => Boolean(k)),
      ),
    ];
    expect(kinds.length).toBe(33);
    for (const kind of kinds) {
      expect(
        ratio(
          colour(tokens, `--kind-${kind}-ink`),
          colour(tokens, `--kind-${kind}-fill`),
        ),
        `${kind} ink on fill`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('separates every kind fill from the canvas it sits on', () => {
    // Not a text requirement, but a node whose plate is indistinguishable
    // from the canvas has no edges, so the diagram stops reading as boxes.
    const kinds = [
      ...new Set(
        Object.keys(tokens)
          .map((k) => /^--kind-([a-z0-9]+)-fill$/.exec(k)?.[1])
          .filter((k): k is string => Boolean(k)),
      ),
    ];
    for (const kind of kinds) {
      expect(
        ratio(colour(tokens, `--kind-${kind}-fill`), colour(tokens, '--bg')),
        `${kind} fill against --bg`,
      ).toBeGreaterThan(1.02);
    }
  });

  it('gives every kind border enough presence to read as an outline', () => {
    // Not a WCAG threshold. The node border is a soft inner outline, not the
    // shape's edge (the -stroke token does that job), and the shipped light
    // palette sits at 1.95 to 2.13 against its own fill. The floor is set
    // just under that measured range so a derived palette cannot quietly
    // wash a border out, without inventing a stricter rule than the design
    // it is checking.
    const kinds = [
      ...new Set(
        Object.keys(tokens)
          .map((k) => /^--kind-([a-z0-9]+)-line$/.exec(k)?.[1])
          .filter((k): k is string => Boolean(k)),
      ),
    ];
    for (const kind of kinds) {
      expect(
        ratio(
          colour(tokens, `--kind-${kind}-line`),
          colour(tokens, `--kind-${kind}-fill`),
        ),
        `${kind} line against its fill`,
      ).toBeGreaterThanOrEqual(1.9);
    }
  });
});

describe('theme parity', () => {
  it('defines the same colour tokens in both themes', () => {
    // A token present in light and missing in dark silently falls back to the
    // light value, which is the single most common way a dark theme ends up
    // with one glaring white patch.
    const [, light] = THEMES[0]!;
    const [, dark] = THEMES[1]!;
    const isColour = (v: string) => /^(#|rgba?\(|hsla?\()/i.test(v);
    const missing = Object.keys(light)
      .filter((k) => isColour(light[k]!))
      .filter((k) => !(k in dark));
    expect(missing).toEqual([]);
  });

  it('honours the OS preference block with the same values as the explicit one', () => {
    // The media query cannot alias the [data-theme] block (it has to stand
    // alone before any script runs), so the two are duplicated and must not
    // drift apart.
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const auto = readTokens(media, "  :root:not([data-theme='light'])");
    const [, dark] = THEMES[1]!;
    for (const [k, v] of Object.entries(auto)) {
      expect(dark[k], `${k} drifted between the explicit and OS dark blocks`).toBe(v);
    }
    expect(Object.keys(auto).length).toBeGreaterThan(140);
  });
});
