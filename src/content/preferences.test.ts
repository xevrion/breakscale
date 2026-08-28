// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  __resetPreferences,
  getPreferences,
  setPreference,
  togglePreference,
} from './preferences';

/**
 * Preferences are read from localStorage at startup, which is a trust
 * boundary: the value can be anything a previous version wrote, anything a
 * user typed into devtools, or garbage from a half-finished write. None of
 * that may stop the app booting, so the loader is tested against hostile input
 * rather than only the happy path.
 */

describe('defaults', () => {
  beforeEach(() => __resetPreferences());

  it('starts with tooltips off', () => {
    // The whole point of the preference: a first-time student meets a clean
    // interface, not forty dotted underlines.
    expect(DEFAULT_PREFERENCES.tooltips).toBe(false);
    expect(getPreferences().tooltips).toBe(false);
  });

  it('starts with the visual helpers on', () => {
    expect(DEFAULT_PREFERENCES.sparklines).toBe(true);
    expect(DEFAULT_PREFERENCES.snapToGrid).toBe(true);
  });
});

describe('setting and toggling', () => {
  beforeEach(() => __resetPreferences());

  it('records a change', () => {
    setPreference('tooltips', true);
    expect(getPreferences().tooltips).toBe(true);
  });

  it('toggles', () => {
    togglePreference('tooltips');
    expect(getPreferences().tooltips).toBe(true);
    togglePreference('tooltips');
    expect(getPreferences().tooltips).toBe(false);
  });

  it('leaves the other preferences alone', () => {
    setPreference('tooltips', true);
    expect(getPreferences().sparklines).toBe(DEFAULT_PREFERENCES.sparklines);
    expect(getPreferences().snapToGrid).toBe(DEFAULT_PREFERENCES.snapToGrid);
  });

  it('replaces the object so a subscriber sees a new reference', () => {
    const before = getPreferences();
    setPreference('tooltips', true);
    expect(getPreferences()).not.toBe(before);
  });

  it('does nothing when the value is unchanged', () => {
    const before = getPreferences();
    setPreference('tooltips', false);
    expect(getPreferences()).toBe(before);
  });
});

describe('persistence', () => {
  beforeEach(() => __resetPreferences());

  it('writes the change to storage', () => {
    setPreference('tooltips', true);
    const raw = localStorage.getItem('breakscale.preferences.v1');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).tooltips).toBe(true);
  });

  it('survives a corrupt stored value', () => {
    // Whatever is in storage, the app must boot. Each of these has broken a
    // real application at some point.
    const hostile = [
      'not json at all',
      '{',
      'null',
      '[]',
      '42',
      '"a string"',
      '{"tooltips":"yes please"}',
      '{"tooltips":null,"sparklines":7}',
    ];
    for (const raw of hostile) {
      localStorage.setItem('breakscale.preferences.v1', raw);
      // The loader runs at import time, so what is asserted here is that a
      // reset with hostile bytes still lands on the defaults rather than
      // throwing or half-applying.
      __resetPreferences();
      expect(getPreferences()).toEqual(DEFAULT_PREFERENCES);
    }
  });
});

describe('the tooltips preference gates the Term component', () => {
  beforeEach(() => __resetPreferences());

  it('is the one preference that ships off', () => {
    // Guards the product decision, not just the plumbing. A future change that
    // flips this default would put dotted underlines under forty terms on a
    // student's first screen, which is exactly what this preference exists to
    // prevent. If you mean to change it, change this test deliberately.
    expect(DEFAULT_PREFERENCES.tooltips).toBe(false);
    expect(DEFAULT_PREFERENCES.sparklines).toBe(true);
    expect(DEFAULT_PREFERENCES.snapToGrid).toBe(true);
  });
});
