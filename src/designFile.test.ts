import { describe, expect, it } from 'vitest';
import type { Topology } from './sim/types';
import { makeNode } from './sim/presets';
import {
  DESIGN_FILE_APP,
  DESIGN_FILE_VERSION,
  buildDesignFile,
  designFileName,
  parseDesignFile,
} from './designFile';

/*
 * The file format is a trust boundary, so this file is mostly about what
 * must NOT get through. The round trip proves a design survives the trip
 * intact; everything after it proves that a file which has been truncated,
 * hand-edited, written by something else, or built to smuggle a colour into
 * a style attribute is turned into a message rather than into a broken app.
 */

function makeTopology(): Topology {
  const client = makeNode('client', 0, 0);
  const svc = makeNode('service', 200, 0);
  const db = makeNode('db', 400, 0);
  return {
    nodes: [client, svc, db],
    edges: [
      { id: `${client.id}->${svc.id}`, from: client.id, to: svc.id, weight: 1 },
      { id: `${svc.id}->${db.id}`, from: svc.id, to: db.id, weight: 1 },
    ],
    annotations: [
      {
        id: 'section-1',
        kind: 'section',
        label: 'Serving reads',
        x: -40,
        y: -60,
        width: 520,
        height: 200,
        tone: 3,
      },
      {
        id: 'note-1',
        kind: 'note',
        text: 'Drag the load slider up and watch the queue in front of the database.',
        x: 0,
        y: 180,
        width: 260,
        size: 'md',
        font: 'hand',
        bold: true,
      },
    ],
  };
}

describe('buildDesignFile', () => {
  it('writes the marker, the version and the whole topology', () => {
    const parsed: unknown = JSON.parse(buildDesignFile(makeTopology(), 'Netflix'));
    const f = parsed as Record<string, unknown>;
    expect(f.app).toBe(DESIGN_FILE_APP);
    expect(f.version).toBe(DESIGN_FILE_VERSION);
    expect(f.name).toBe('Netflix');
    expect(typeof f.savedAt).toBe('string');
  });

  it('does not reach back into the live topology', () => {
    const t = makeTopology();
    const text = buildDesignFile(t, null);
    t.nodes[0]!.x = 9999;
    const back = parseDesignFile(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.topology.nodes[0]!.x).toBe(0);
  });
});

describe('round trip', () => {
  it('returns the same nodes, edges and annotations it was given', () => {
    const t = makeTopology();
    const result = parseDesignFile(buildDesignFile(t, 'Netflix'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.nodes).toEqual(t.nodes);
    expect(result.topology.edges).toEqual(t.edges);
    expect(result.topology.annotations).toEqual(t.annotations);
    expect(result.name).toBe('Netflix');
  });

  it('keeps a design with no annotations free of the field', () => {
    const t = makeTopology();
    delete t.annotations;
    const result = parseDesignFile(buildDesignFile(t, null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.annotations).toBeUndefined();
    expect(result.name).toBeNull();
  });
});

describe('designFileName', () => {
  const day = new Date(2026, 7, 28);

  it('names the file from the design and the date', () => {
    expect(designFileName('Netflix', day)).toBe('netflix-2026-08-28.breakscale.json');
  });

  it('falls back to "design" when there is no name', () => {
    expect(designFileName(null, day)).toBe('design-2026-08-28.breakscale.json');
  });

  it('strips anything a file system or a shell would choke on', () => {
    expect(designFileName('../../etc/passwd; rm -rf /', day)).toBe(
      'etc-passwd-rm-rf-2026-08-28.breakscale.json',
    );
    expect(designFileName('   ', day)).toBe('design-2026-08-28.breakscale.json');
  });
});

describe('hostile and damaged input', () => {
  it('rejects truncated JSON without throwing', () => {
    const text = buildDesignFile(makeTopology(), 'Netflix');
    const result = parseDesignFile(text.slice(0, Math.floor(text.length / 2)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/);
  });

  it('rejects an empty file', () => {
    expect(parseDesignFile('').ok).toBe(false);
    expect(parseDesignFile('   \n ').ok).toBe(false);
  });

  it('rejects JSON that is not an object', () => {
    expect(parseDesignFile('[]').ok).toBe(false);
    expect(parseDesignFile('null').ok).toBe(false);
    expect(parseDesignFile('42').ok).toBe(false);
    expect(parseDesignFile('"a design, honest"').ok).toBe(false);
  });

  it('rejects somebody else’s JSON', () => {
    const result = parseDesignFile(
      JSON.stringify({ app: 'figma', version: 1, topology: makeTopology() }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Breakscale design/);
  });

  it('rejects a file written by a newer version', () => {
    const result = parseDesignFile(
      JSON.stringify({
        app: DESIGN_FILE_APP,
        version: DESIGN_FILE_VERSION + 1,
        topology: makeTopology(),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/);
  });

  it('rejects a topology whose edge points at a node that is not there', () => {
    const t = makeTopology();
    t.edges[1]!.to = 'db-does-not-exist';
    const result = parseDesignFile(buildDesignFile(t, null));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/damaged/);
  });

  it('rejects a node whose kind is not one the simulator has', () => {
    const t = makeTopology();
    const bad = structuredClone(t.nodes[1]!) as { kind: string };
    bad.kind = 'blockchain';
    const result = parseDesignFile(
      JSON.stringify({
        app: DESIGN_FILE_APP,
        version: DESIGN_FILE_VERSION,
        topology: { nodes: [t.nodes[0], bad], edges: [] },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a node whose config is missing a number the engine reads', () => {
    const t = makeTopology();
    const bad = structuredClone(t.nodes[1]!) as unknown as {
      config: Record<string, unknown>;
    };
    delete bad.config.serviceMs;
    const result = parseDesignFile(
      JSON.stringify({
        app: DESIGN_FILE_APP,
        version: DESIGN_FILE_VERSION,
        topology: { nodes: [t.nodes[0], bad], edges: [] },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('drops a hostile colour instead of letting it into a style attribute', () => {
    const t = makeTopology();
    const notes = t.annotations!;
    const note = notes[1] as { color?: string };
    note.color = 'red; background: url(https://evil.example/x.png)';
    const section = notes[0] as { color?: string };
    section.color = 'expression(alert(1))';

    const result = parseDesignFile(buildDesignFile(t, null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const a of result.topology.annotations ?? []) {
      expect(a.color).toBeUndefined();
    }
  });

  it('keeps a plain colour that a picker could have produced', () => {
    const t = makeTopology();
    (t.annotations![1] as { color?: string }).color = '#ff8800';
    const result = parseDesignFile(buildDesignFile(t, null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.annotations![1]!.color).toBe('#ff8800');
  });

  it('drops malformed annotations but keeps the design', () => {
    const t = makeTopology();
    const result = parseDesignFile(
      JSON.stringify({
        app: DESIGN_FILE_APP,
        version: DESIGN_FILE_VERSION,
        topology: {
          nodes: t.nodes,
          edges: t.edges,
          annotations: [
            {
              id: 'note-x',
              kind: 'note',
              text: 'kept',
              x: 0,
              y: 0,
              width: 200,
              size: 'md',
            },
            { kind: 'note', text: 'no id', x: 0, y: 0 },
            { id: 'note-y', kind: 'note', text: 'no coordinates' },
            'not even an object',
            null,
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.nodes).toHaveLength(3);
    expect(result.topology.annotations).toHaveLength(1);
    expect(result.topology.annotations![0]!.id).toBe('note-x');
  });

  it('carries nothing beyond nodes, edges and annotations into the topology', () => {
    const t = makeTopology();
    const result = parseDesignFile(
      JSON.stringify({
        app: DESIGN_FILE_APP,
        version: DESIGN_FILE_VERSION,
        topology: { ...t, __proto__: { polluted: true }, extra: 'ignored' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.topology).sort()).toEqual([
      'annotations',
      'edges',
      'nodes',
    ]);
    expect(
      (result.topology as unknown as Record<string, unknown>).extra,
    ).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts a file from an older version that has no version field', () => {
    const t = makeTopology();
    const result = parseDesignFile(
      JSON.stringify({
        app: DESIGN_FILE_APP,
        topology: { nodes: t.nodes, edges: t.edges },
      }),
    );
    expect(result.ok).toBe(true);
  });
});
