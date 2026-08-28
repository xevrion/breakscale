/**
 * Export the diagram as an SVG or PNG file.
 *
 * WHY IT IS NOT A ONE-LINER. The canvas is a live SVG, so serialising it is
 * tempting, but the result would be blank: every colour, font and stroke on
 * it comes from CSS classes in a stylesheet the exported file does not carry,
 * and the element has no intrinsic width or height (it is sized by `inset: 0`
 * against its container). So the export has to inline the computed style of
 * every element, and compute its own viewBox from the content.
 *
 * The alternative, redrawing the diagram from the topology into a fresh
 * canvas, was rejected: it would be a SECOND renderer to keep in step with
 * the real one, and the first divergence would be a silent wrong picture.
 * Reading back what is actually on screen cannot drift.
 */

/** Properties worth carrying. A full computed style is ~340 declarations per
 *  element, which produces a file tens of megabytes long for a large diagram
 *  and is mostly defaults. This is what the canvas actually paints with. */
const CARRIED = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'text-decoration',
  'dominant-baseline',
  'letter-spacing',
  'color',
  'visibility',
] as const;

export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Copy the computed style of every node in `src` onto the matching node in
 * `dst`, walking both trees in lockstep.
 *
 * Lockstep rather than by selector, because the clone has the same shape by
 * construction and matching on classes would need the stylesheet this whole
 * function exists to avoid needing.
 */
function inlineStyles(src: Element, dst: Element): void {
  const cs = getComputedStyle(src);
  let decl = '';
  for (const prop of CARRIED) {
    const v = cs.getPropertyValue(prop);
    // `none` and empty are the defaults for most of these; writing them adds
    // bytes without changing the picture.
    if (!v || v === 'none' || v === 'normal' || v === 'auto') continue;
    decl += `${prop}:${v};`;
  }
  if (decl) dst.setAttribute('style', decl);

  const sk = src.children;
  const dk = dst.children;
  for (let i = 0; i < sk.length && i < dk.length; i += 1) {
    inlineStyles(sk[i]!, dk[i]!);
  }
}

/**
 * Build a standalone SVG string for `svg`, framed to `bounds`.
 *
 * `bounds` are WORLD coordinates, so the export is the diagram at its own
 * scale rather than whatever the reader happened to be zoomed to.
 */
export function serialiseSvg(
  svg: SVGSVGElement,
  bounds: ExportBounds,
  background: string,
  padding = 32,
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);

  // The live root carries the pan/zoom transform on its first group. The
  // export is framed by the viewBox instead, so that transform has to go or
  // the content would be shifted twice.
  const g = clone.firstElementChild;
  if (g && g.tagName.toLowerCase() === 'g') g.removeAttribute('transform');

  // Selection chrome is interface, not diagram. Someone exporting a picture
  // does not want the handles that happened to be showing.
  for (const sel of ['.cv-ann-sel', '.cv-marquee', '.cv-link-preview']) {
    for (const el of Array.from(clone.querySelectorAll(sel))) el.remove();
  }

  const x = bounds.x - padding;
  const y = bounds.y - padding;
  const w = bounds.width + padding * 2;
  const h = bounds.height + padding * 2;

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  clone.setAttribute('width', String(Math.round(w)));
  clone.setAttribute('height', String(Math.round(h)));
  clone.removeAttribute('class');

  const body = new XMLSerializer().serializeToString(clone);
  // A background rect rather than a transparent file: a diagram drawn in dark
  // ink lands invisible when pasted onto a dark slide, and the reader has no
  // way to tell why.
  const bg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>`;
  return body.replace(/(<svg[^>]*>)/, `$1${bg}`);
}

/** Hand the reader a file. Shared by both formats and by the JSON export. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on the next task, not immediately: some browsers have not yet
  // started the download when click() returns, and revoking first cancels it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Rasterise an SVG string to a PNG blob.
 *
 * Via an Image and a canvas, which is the only route that does not require
 * reimplementing text layout. `scale` is a device-pixel multiplier: 2 gives a
 * file that still looks sharp in a slide deck.
 */
export async function svgToPng(
  svgText: string,
  width: number,
  height: number,
  scale = 2,
): Promise<Blob> {
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('the diagram could not be rendered'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser has no 2D canvas');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('the image could not be saved'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
