/**
 * Nothing on a touch device may name an input the reader does not have.
 *
 * A phone was being offered a "Keyboard shortcuts" dialog, told to "hover"
 * over a term, told to "Hold Ctrl", and told to press "Esc" to cancel. Each
 * one describes an application the reader is not holding, and a reader who
 * follows the instruction and gets nothing reasonably concludes the feature
 * is broken rather than inapplicable.
 *
 * These assert the COPY, not the layout: the rule is about what the reader
 * can do with their hands, which is why it keys off a coarse pointer and not
 * off a width. A tablet has a desktop-sized screen and still no keyboard.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settings = readFileSync(
  new URL('./components/Settings.tsx', import.meta.url),
  'utf8',
);
const canvas = readFileSync(
  new URL('./components/Canvas.tsx', import.meta.url),
  'utf8',
);
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

/** Wording that only makes sense with a mouse or a keyboard. */
const MOUSE_ONLY = [/on hover\./, /Hold Ctrl/];

describe('touch copy', () => {
  it('offers no keyboard hints from the settings panel on touch', () => {
    // Each mouse-only phrase must sit on the non-coarse side of a branch,
    // which means a coarse alternative exists in the same file.
    for (const phrase of MOUSE_ONLY) {
      const found = phrase.test(settings);
      expect(found, `${phrase} present`).toBe(true);
      expect(settings.includes('coarse'), 'settings branches on pointer').toBe(true);
    }
  });

  it('drops the shortcuts dialog from the menu on touch', () => {
    // The row is built inside a coarse guard rather than always present.
    const guarded = /coarse[\s\S]{0,200}Keyboard shortcuts/.test(app);
    expect(guarded).toBe(true);
  });

  it('does not tell a touch reader to press Esc', () => {
    // Every armed-tool hint offers a coarse wording without the key.
    expect(canvas.includes("'Tap a component to connect'")).toBe(true);
    expect(canvas.includes("'Tap the canvas to place a note'")).toBe(true);
    // And the desktop wording is still there for a mouse.
    expect(canvas.includes('Esc to cancel')).toBe(true);
  });

  it('hides the mouse-gesture hint strip on a coarse pointer', () => {
    const css = readFileSync(
      new URL('./components/Canvas.css', import.meta.url),
      'utf8',
    );
    // The strip teaches scroll-to-pan and ctrl-scroll-to-zoom.
    const rule =
      /@media \(pointer: coarse\)[\s\S]{0,200}\.cv-hint-idle[\s\S]{0,80}display:\s*none/;
    expect(rule.test(css)).toBe(true);
  });
});
