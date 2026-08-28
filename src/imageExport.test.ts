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
