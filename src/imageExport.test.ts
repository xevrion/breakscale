// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { serialiseSvg } from './imageExport';

/**
 * The export reads back what is actually on screen rather than redrawing the
 * diagram from the topology, so these check the two things that make the
 * result usable somewhere else: that it frames the content, and that it
 * carries enough style to not arrive blank.
 */

function makeSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'cv-svg');
  const g = document.createElementNS(NS, 'g');
  // The live pan/zoom transform, which the export must drop.
  g.setAttribute('transform', 'translate(120,40) scale(0.7)');
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '0');
  rect.setAttribute('width', '10');
  rect.style.fill = 'rgb(1, 2, 3)';
  g.appendChild(rect);
  const chrome = document.createElementNS(NS, 'g');
  chrome.setAttribute('class', 'cv-ann-sel');
  g.appendChild(chrome);
  svg.appendChild(g);
  document.body.appendChild(svg);
  return svg;
}

const bounds = { x: 40, y: 60, width: 400, height: 200 };

describe('serialiseSvg', () => {
  it('frames the content with a viewBox instead of the live transform', () => {
    // The exported file is the diagram at its own scale, not at whatever
    // zoom the reader happened to be at when they pressed the button.
    const out = serialiseSvg(makeSvg(), bounds, '#ffffff', 32);
    expect(out).toContain('viewBox="8 28 464 264"');
    expect(out).not.toContain('translate(120,40)');
  });

  it('declares its own size, since the live element has none', () => {
    // .cv-svg is sized by `inset: 0` against its container, so a serialised
    // copy with no width or height renders at whatever the viewer guesses.
    const out = serialiseSvg(makeSvg(), bounds, '#ffffff', 32);
    expect(out).toContain('width="464"');
    expect(out).toContain('height="264"');
  });

  it('paints a background, so dark ink is not invisible on a dark slide', () => {
    const out = serialiseSvg(makeSvg(), bounds, '#16151a', 0);
    expect(out).toContain('fill="#16151a"');
    // Behind the content, not over it.
    expect(out.indexOf('#16151a')).toBeLessThan(out.indexOf('<g'));
  });

  it('carries the namespace, so the file opens outside a browser', () => {
    expect(serialiseSvg(makeSvg(), bounds, '#fff')).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
  });

  it('drops selection chrome, which is interface and not diagram', () => {
    const out = serialiseSvg(makeSvg(), bounds, '#fff');
    expect(out).not.toContain('cv-ann-sel');
  });

  it('carries fill:none, so a stroked path is not filled black', () => {
    // SVG fills a path black unless told otherwise. Treating `none` as a
    // droppable default turned every sparkline in the export into a solid
    // black blob, which is what this exists to stop happening again.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M0 0 L10 10');
    path.style.fill = 'none';
    path.style.stroke = 'rgb(1, 2, 3)';
    svg.appendChild(path);
    document.body.appendChild(svg);
    const out = serialiseSvg(svg, bounds, '#fff');
    // jsdom reports `fill: none` as `rgba(0, 0, 0, 0)` where a browser says
    // `none`, so the assertion is on the INTENT: whatever spelling arrives,
    // a fill declaration must be carried and it must not be opaque black.
    const decl = /<path[^>]*style="([^"]*)"/.exec(out)?.[1] ?? '';
    expect(decl).toMatch(/fill:/);
    expect(decl).not.toMatch(/fill:\s*(rgb\(0,\s*0,\s*0\)|#000|black)\s*;/);
  });

  it('states the theme it was exported in', () => {
    // A picture taken in light must stay light wherever it is opened, rather
    // than following the reader's own preference.
    document.documentElement.setAttribute('data-theme', 'light');
    expect(serialiseSvg(makeSvg(), bounds, '#fff')).toContain('data-theme="light"');
    document.documentElement.removeAttribute('data-theme');
  });

  it('does not need matchMedia to exist', () => {
    // jsdom has no matchMedia, and an unguarded call made every test in this
    // file throw. The export has to work without it.
    expect(() => serialiseSvg(makeSvg(), bounds, '#fff')).not.toThrow();
  });

  it('leaves the live element untouched', () => {
    // It clones. Mutating the real canvas to export it would move the
    // reader's view out from under them.
    const svg = makeSvg();
    serialiseSvg(svg, bounds, '#fff');
    expect(svg.firstElementChild?.getAttribute('transform')).toBe(
      'translate(120,40) scale(0.7)',
    );
    expect(svg.querySelector('.cv-ann-sel')).not.toBeNull();
  });
});
