/**
 * WCAG contrast arithmetic for the theme palettes.
 *
 * AGENTS.md requires that text contrast is computed rather than estimated.
 * This is the module that does the computing; theme.test.ts consumes it so a
 * palette change that drops a pair below AA fails the suite instead of
 * shipping.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse #rgb, #rrggbb or #rrggbbaa. Alpha is ignored: see `over`. */
export function parseHex(hex: string): Rgb {
  const h = hex.trim().replace('#', '');
  const full =
    h.length === 3 || h.length === 4
      ? h
          .slice(0, 3)
          .split('')
          .map((c) => c + c)
          .join('')
      : h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Relative luminance, per WCAG 2.1 definition. */
export function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio between two opaque colours, 1..21. */
export function contrast(a: string | Rgb, b: string | Rgb): number {
  const la = luminance(typeof a === 'string' ? parseHex(a) : a);
  const lb = luminance(typeof b === 'string' ? parseHex(b) : b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `fg` at `alpha` over opaque `bg`. */
export function over(fg: string | Rgb, bg: string | Rgb, alpha: number): Rgb {
  const f = typeof fg === 'string' ? parseHex(fg) : fg;
  const b = typeof bg === 'string' ? parseHex(bg) : bg;
  return {
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  };
}

/** Round the way a report should: two decimals, never flattering. */
export function ratio(a: string | Rgb, b: string | Rgb): number {
  return Math.floor(contrast(a, b) * 100) / 100;
}
