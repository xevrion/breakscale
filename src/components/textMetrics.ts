/**
 * Real text measurement for the SVG canvas.
 *
 * WHY THIS EXISTS.
 *
 * Every label on a node used to be fitted with a fixed advance-width
 * constant — one number standing in for the width of any character. That is
 * wrong in both directions at once, because the sans stack is proportional:
 *
 *   measured at 14px/550, the actual per-character advance
 *     "l"  3.71px      "W"  13.10px      lowercase avg 7.51      caps avg 8.94
 *
 * A single constant cannot serve a 3.5x spread. The shipped value of 9.0px
 * was tuned to be safe for capitals, which meant:
 *
 *   - "WWWWWWWWWWWWWWWW" cleared a 15-character budget untouched and then
 *     rendered 209.7px wide against 144px of room — 65px of overhang,
 *     straight through the status mark and out of the node.
 *   - "llllllllllllllll" was truncated at 15 characters despite the whole
 *     string measuring 59.4px, wasting 85px of the room it had.
 *
 * Both were verified in the live document with getComputedTextLength().
 *
 * THE FIX. Measure the actual string with a 2D canvas context, which returns
 * the same advance widths the SVG text layout uses for the same font, and
 * cache the result. Measurement is only reached on a cache miss, so the 10Hz
 * snapshot loop pays for a given string exactly once.
 *
 * Fonts load asynchronously, so a measurement taken before the stack settles
 * can be stale. `resetTextMetrics` clears the cache; Canvas calls it from a
 * document.fonts.ready handler.
 */

/** Cache key -> measured width in CSS px. */
const cache = new Map<string, number>();

let ctx: CanvasRenderingContext2D | null = null;
let ctxFailed = false;

function context(): CanvasRenderingContext2D | null {
  if (ctx || ctxFailed) return ctx;
  // A jsdom test environment has no canvas backend; measurement degrades to
  // the estimate path rather than throwing.
  try {
    ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) ctxFailed = true;
  return ctx;
}

/**
 * Resolve a CSS custom property from the document root.
 *
 * The font stacks live in index.css as --sans / --mono and must not be
 * duplicated here: a second copy is a second thing to keep in sync, and the
 * whole point of this module is to stop guessing at what the browser will do.
 */
function rootValue(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * The font stacks a canvas text run can be measured in, keyed to the CSS
 * custom property that defines each one. Annotations may choose a family, so
 * the set is open in a way node labels never needed: whatever a note is
 * drawn in has to be what it is measured in, or the wrap will disagree with
 * the paint.
 */
const STACKS = {
  sans: { prop: '--sans', fallback: 'system-ui, sans-serif' },
  mono: { prop: '--mono', fallback: 'ui-monospace, monospace' },
  hand: { prop: '--hand', fallback: 'Comic Sans MS, cursive' },
  marker: { prop: '--marker', fallback: 'Comic Sans MS, cursive' },
  serif: { prop: '--serif', fallback: 'Georgia, serif' },
} as const;

export type FontFamily = keyof typeof STACKS;

const resolved = new Map<FontFamily, string>();

function stack(family: FontFamily): string {
  const hit = resolved.get(family);
  if (hit !== undefined) return hit;
  const spec = STACKS[family] ?? STACKS.sans;
  const v = rootValue(spec.prop, spec.fallback);
  resolved.set(family, v);
  return v;
}

/**
 * Per-character fallback widths, used only when a canvas context is
 * unavailable (jsdom). Deliberately generous: over-measuring condenses a
 * string slightly early, which is invisible, while under-measuring overruns
 * the node, which is the defect this module exists to remove.
 */
const FALLBACK_CHAR_W = 9.0;

export interface TextStyle {
  size: number;
  weight: number;
  family: FontFamily;
  /** Extra advance per character, for a letter-spaced style. */
  tracking?: number;
  /** Measure the uppercased string, for a text-transform: uppercase style. */
  uppercase?: boolean;
}

/**
 * Width in CSS px of `text` rendered in `style`.
 *
 * Letter-spacing is added per character rather than asked of the canvas,
 * because `CanvasRenderingContext2D.letterSpacing` is not supported
 * everywhere and silently does nothing where it is not.
 */
export function measureText(text: string, style: TextStyle): number {
  if (!text) return 0;
  const s = style.uppercase ? text.toUpperCase() : text;
  const key = `${style.size}|${style.weight}|${style.family}|${style.tracking ?? 0}|${s}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const c = context();
  let w: number;
  if (c) {
    c.font = `${style.weight} ${style.size}px ${stack(style.family)}`;
    w = c.measureText(s).width + (style.tracking ?? 0) * s.length;
  } else {
    w = s.length * FALLBACK_CHAR_W * (style.size / 14);
  }
  cache.set(key, w);
  return w;
}

/**
 * Where the first baseline sits inside a line box of `lineH`, in CSS px.
 *
 * CSS centres the font's own box (ascent + descent) in the line box and puts
 * the baseline an ascent below the top. A single constant cannot stand in for
 * that across faces: measured at 16px, fontBoundingBoxAscent is 1.063em for
 * the UI sans and 0.938em for Caveat, so text set in one and positioned for
 * the other sits visibly high or low. That mattered as soon as notes gained a
 * choice of typeface.
 *
 * Falls back to the old 0.8em approximation where there is no canvas to
 * measure with (jsdom), which keeps the pure layout functions testable.
 */
export function baselineIn(lineH: number, style: TextStyle): number {
  const c = context();
  if (!c) return (lineH - style.size) / 2 + style.size * 0.8;
  const key = `bl|${style.size}|${style.weight}|${style.family}|${lineH}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  c.font = `${style.weight} ${style.size}px ${stack(style.family)}`;
  // Both halves are measured. Deriving the descent from the ascent would put
  // an invented number back into the arithmetic this function exists to fix.
  const m = c.measureText('Hxg');
  const asc = m.fontBoundingBoxAscent;
  const desc = m.fontBoundingBoxDescent;
  const usable =
    Number.isFinite(asc) && Number.isFinite(desc) && asc > 0 && asc + desc > 0;
  const v = usable
    ? (lineH - (asc + desc)) / 2 + asc
    : (lineH - style.size) / 2 + style.size * 0.8;
  cache.set(key, v);
  return v;
}

/**
 * Longest prefix of `text` that fits `budget` px in `style`, with a single
 * U+2026 appended when anything was dropped.
 *
 * Binary search over the prefix length: the cost is log(n) cached
 * measurements rather than the n a linear walk would take, and every
 * intermediate measurement is itself cached for the next frame.
 *
 * Returns the ellipsis alone if not even one character fits, and never
 * returns a string wider than the budget.
 */
export function truncateToWidth(
  text: string,
  budget: number,
  style: TextStyle,
): string {
  if (budget <= 0) return '';
  if (measureText(text, style) <= budget) return text;

  const ell = '…';
  const ellW = measureText(ell, style);
  if (ellW > budget) return '';

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(text.slice(0, mid), style) + ellW <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ell : `${text.slice(0, lo).trimEnd()}${ell}`;
}

/**
 * Drop every cached measurement.
 *
 * Called once the webfont stack has settled, because a width measured
 * against the fallback font is not the width the glyphs will actually
 * occupy once the intended face is in use.
 */
export function resetTextMetrics(): void {
  cache.clear();
  // The resolved stacks go too. A stack read before index.css applied is as
  // stale as a width measured against the wrong face.
  resolved.clear();
}
