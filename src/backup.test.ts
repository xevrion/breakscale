// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { BACKED_UP_KEYS, BACKUP_APP, buildBackup, restoreBackup } from './backup';
import { saveDesign } from './savedDesigns';
import { PRESETS } from './sim/presets';

/**
 * The backup is the door out of a browser-only store: without it, choosing
 * this app means the work is trapped in one profile on one machine. So the
 * cases that matter are the ones where it would silently fail to carry
 * something, or would accept a file that then breaks the app on boot.
 */

const topo = () => structuredClone(PRESETS[0]!.topology);

beforeEach(() => localStorage.clear());

describe('building a backup', () => {
  it('carries the saved designs', () => {
    saveDesign('kept', topo());
    const body = JSON.parse(buildBackup());
    expect(body.app).toBe(BACKUP_APP);
    expect(body.data['breakscale.designs.v1']).toContain('kept');
  });

  it('carries every key it claims to, when they are present', () => {
    for (const k of BACKED_UP_KEYS) localStorage.setItem(k, '{"x":1}');
    const body = JSON.parse(buildBackup());
    expect(Object.keys(body.data).sort()).toEqual([...BACKED_UP_KEYS].sort());
  });

  it('omits a key that was never written rather than storing null', () => {
    saveDesign('only this', topo());
    const body = JSON.parse(buildBackup());
    expect(body.data).not.toHaveProperty('breakscale.layout.v1');
  });

  it('makes a backup of an empty browser without failing', () => {
    const body = JSON.parse(buildBackup());
    expect(body.data).toEqual({});
  });
});

describe('restoring', () => {
  it('puts the designs back', () => {
    saveDesign('original', topo());
    const backup = buildBackup();
    localStorage.clear();
    const r = restoreBackup(backup);
    expect(r.ok).toBe(true);
    expect(localStorage.getItem('breakscale.designs.v1')).toContain('original');
  });

  it('replaces rather than merges, and says which keys it wrote', () => {
    // Merging would mean deciding which copy of a design called "draft"
    // wins, and there is no answer to that a student would predict.
    saveDesign('from the backup', topo());
    const backup = buildBackup();
    localStorage.clear();
    saveDesign('already here', topo());
    const r = restoreBackup(backup);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.restored).toContain('breakscale.designs.v1');
    const now = localStorage.getItem('breakscale.designs.v1')!;
    expect(now).toContain('from the backup');
    expect(now).not.toContain('already here');
  });

  it.each([
    ['empty', ''],
    ['not json', '{{{'],
    ['a list', '[]'],
    ['someone else’s file', '{"app":"figma","data":{}}'],
    ['no contents', '{"app":"breakscale-backup","version":1}'],
  ])('refuses %s with a sentence rather than a throw', (_label, text) => {
    const r = restoreBackup(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
  });

  it('refuses a backup from a newer version', () => {
    const r = restoreBackup(
      JSON.stringify({ app: BACKUP_APP, version: 99, data: { x: 'y' } }),
    );
    expect(r.ok).toBe(false);
  });

  it('skips a session whose topology the engine could not run', () => {
    // A dangling edge would route traffic into a component that is not
    // there, so it must not be written back even inside a valid backup.
    const bad = topo();
    bad.edges[0]!.to = 'gone';
    const r = restoreBackup(
      JSON.stringify({
        app: BACKUP_APP,
        version: 1,
        data: {
          'breakscale.session.v1': JSON.stringify({ topology: bad }),
          'breakscale.preferences.v1': '{"tooltips":true}',
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(localStorage.getItem('breakscale.session.v1')).toBeNull();
    expect(localStorage.getItem('breakscale.preferences.v1')).not.toBeNull();
  });

  it('leaves the browser untouched when nothing in the file is readable', () => {
    saveDesign('mine', topo());
    const before = localStorage.getItem('breakscale.designs.v1');
    const r = restoreBackup(
      JSON.stringify({ app: BACKUP_APP, version: 1, data: { 'x.y': 'z' } }),
    );
    expect(r.ok).toBe(false);
    expect(localStorage.getItem('breakscale.designs.v1')).toBe(before);
  });

  it('round trips a real browser exactly', () => {
    saveDesign('one', topo());
    saveDesign('two', topo());
    localStorage.setItem('breakscale.preferences.v1', '{"tooltips":true}');
    const snapshot = Object.fromEntries(
      BACKED_UP_KEYS.map((k) => [k, localStorage.getItem(k)]),
    );
    const backup = buildBackup();
    localStorage.clear();
    restoreBackup(backup);
    for (const k of BACKED_UP_KEYS) {
      expect(localStorage.getItem(k)).toBe(snapshot[k]);
    }
  });
});
