/**
 * Put the chosen theme on the document.
 *
 * The stylesheet does the actual work: `:root[data-theme='dark']` for an
 * explicit choice, and a `prefers-color-scheme` block for `system`. All this
 * has to do is set or clear one attribute.
 *
 * `system` clears the attribute rather than resolving the OS preference to a
 * concrete value, so the page keeps following the OS live. Writing 'dark'
 * because the OS is currently dark would freeze it at whatever it was when
 * the page loaded, and the theme would stop changing at sunset.
 */

import type { ThemeChoice } from '../content/preferences';

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/** What `system` currently resolves to, for labelling the control. */
export function resolveSystemTheme(): 'light' | 'dark' {
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
