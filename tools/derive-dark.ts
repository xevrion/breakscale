/**
 * Derive the dark palette's per-kind colours from the light one.
 *
 * The 33 component kinds carry four colours each. Hand-writing 132 dark
 * values would be both tedious and impossible to keep in tune with the light
 * set; deriving them keeps the same hue relationships, which is what makes a
 * cache node still read as "the amber one" after the theme flips.
 *
 * The transform is done in OKLCH, not HSL. HSL's lightness is not
 * perceptual: rotating hue at fixed HSL lightness makes yellows glare and
 * blues sink, which is exactly the failure that makes naive dark themes look
 * muddy. OKLCH lightness is perceptually even, so one target per role holds
 * across all 33 hues.
 */

import { parseHex } from '../src/theme/contrast';

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = parseHex(hex);
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);

  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  return {
    l: L,
    c: Math.hypot(a, bb),
    h: (Math.atan2(bb, a) * 180) / Math.PI,
  };
}

export function oklchToHex({ l, c, h }: Oklch): string {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const lr = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const lg = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const lb = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;

  const to255 = (v: number) =>
    Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255)));
  const hex = (v: number) => to255(v).toString(16).padStart(2, '0');
  return `#${hex(lr)}${hex(lg)}${hex(lb)}`;
}

/**
 * Role targets for the dark theme, as (lightness, chroma scale).
 *
 * `fill` is a dim tinted plate a node sits on, `line` its border, `stroke`
 * the icon, `ink` the label text on the fill. Ink is pushed bright because it
 * carries text and has to clear AA against its own fill; fill is pushed dark
 * for the same reason from the other side.
 */
export const DARK_ROLES = {
  fill: { l: 0.26, cScale: 0.55 },
  line: { l: 0.52, cScale: 0.95 },
  stroke: { l: 0.72, cScale: 0.9 },
  ink: { l: 0.86, cScale: 0.55 },
} as const;

export type Role = keyof typeof DARK_ROLES;

/** Map one light token to its dark counterpart, preserving hue. */
export function darkenRole(lightHex: string, role: Role): string {
  const { c, h } = hexToOklch(lightHex);
  const spec = DARK_ROLES[role];
  // Chroma is scaled from the light value rather than fixed, so a
  // deliberately muted kind stays muted relative to a vivid one.
  return oklchToHex({ l: spec.l, c: Math.min(c * spec.cScale + 0.04, 0.19), h });
}
