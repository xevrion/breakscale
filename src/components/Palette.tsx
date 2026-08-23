import { useCallback, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import type { NodeKind } from '../sim/types';
import type { Preset } from '../sim/presets';
import { FILLED_GLYPHS, GLYPH, KIND_NAME, NODE_DND_MIME } from './nodeVisuals';
import './Palette.css';

/* ------------------------------------------------------------------ *
 * Structure
 *
 * Fourteen kinds and thirteen presets in a 224px rail is 27 rows. Listed
 * flat that is a 1100px column: a wall of text that must be scrolled to
 * be read, which means the student cannot see what the app offers.
 *
 * The fix is GROUPING, not shrinking. Four groups of 3-4 kinds each are
 * scannable at a glance because each group answers one question:
 *
 *   Traffic    where load comes from and how it is spread
 *   Compute    the things that do work and can saturate
 *   Data       the things that store it, and the two ways to scale that
 *   Control    the things that protect the system by refusing work
 *
 * A student looking for "how do I stop this melting" goes straight to
 * Control without reading the other eleven names. That is the whole
 * point of the taxonomy — it is a lookup index, not decoration.
 *
 * Sections collapse, and the open/closed state is local UI state that
 * the shell does not need to know about. Components stay open by
 * default because that is the rail's primary job; Examples too, since
 * that is how a student starts. Keys is closed — it is a reference, not
 * a task.
 * ------------------------------------------------------------------ */

interface KindGroup {
  id: string;
  title: string;
  kinds: NodeKind[];
}

const KIND_GROUPS: KindGroup[] = [
  { id: 'traffic', title: 'Traffic', kinds: ['client', 'lb', 'cdn'] },
  { id: 'compute', title: 'Compute', kinds: ['service', 'worker', 'queue'] },
  { id: 'data', title: 'Data', kinds: ['db', 'cache', 'replica', 'shard'] },
  {
    id: 'control',
    title: 'Control',
    kinds: ['ratelimiter', 'breaker', 'autoscaler', 'region'],
  },
];

/**
 * Shown as the row's `title` only. The prose that used to render under
 * every name is what made this rail 260px wide with 84px rows; the real
 * explanation lives in the inspector, where there is room for it and
 * where the student is already looking once they have chosen.
 */
const KIND_HINT: Record<NodeKind, string> = {
  client: 'Sends requests at the rate you set',
  lb: 'Spreads requests across several servers',
  service: 'Handles a request, calls what it needs',
  cache: 'Answers repeat reads without the database',
  db: 'Stores the data. Usually saturates first',
  queue: 'Holds work so the sender does not wait',
  worker: 'Drains the queue in the background',
  replica: 'Scales reads, but they can be stale',
  shard: 'Splits data by key. A hot key ruins it',
  autoscaler: 'Adds capacity when load rises, after a delay',
  region: 'Fails traffic over to another region',
  cdn: 'Serves most requests before they reach you',
  ratelimiter: 'Refuses excess traffic cheaply, at the door',
  breaker: 'Stops calling a dependency that is failing',
};

/**
 * The failure mode each example exists to teach, stated as a fact rather
 * than a sentence. This is the line that makes the preset list a menu of
 * experiments instead of a list of names.
 */
const PRESET_NOTE: Record<string, string> = {
  'single-server': 'Bottleneck: db',
  'load-balanced': 'Shared bottleneck',
  'cache-aside': 'Hit rate collapse',
  'async-workers': 'Backlog growth',
  'retry-storm': 'Retry amplification',
  'cdn-origin': 'Origin offload',
  'rate-limited-api': 'Shed at the door',
  'circuit-breaker': 'Fail fast',
  'read-replicas': 'Stale reads',
  'sharded-database': 'Hot key',
  'autoscaling-service': 'Warmup lag',
  'multi-region': 'Failover cost',
  'full-stack': 'Everything at once',
};

/**
 * The same path data the canvas draws, so a row in the palette is
 * visually the exact object that lands on the canvas. A bare stroked
 * glyph in currentColor — never an icon inside a filled square.
 */
function Glyph({ kind }: { kind: NodeKind }) {
  const filled = FILLED_GLYPHS.has(kind);
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      role="presentation"
      aria-hidden="true"
    >
      <path
        d={GLYPH[kind]}
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A disclosure chevron. Rotates 90deg when open — a transform, which is
 * an interactive transition and therefore allowed; it is not an entrance
 * animation and the content itself never animates.
 */
function Chevron() {
  return (
    <svg
      className="pal-chev"
      width="8"
      height="8"
      viewBox="0 0 8 8"
      role="presentation"
      aria-hidden="true"
    >
      <path
        d="M2.5 1L5.5 4L2.5 7"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Collapsible section
 *
 * A real <button> with aria-expanded and aria-controls, so the rail is
 * navigable and announced correctly. The count rides in the header, so
 * a collapsed section still tells you how much is inside it.
 * ------------------------------------------------------------------ */

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const bodyId = `pal-body-${id}`;
  return (
    <section className="pal-section">
      <h2 className="pal-h">
        <button
          type="button"
          className="pal-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <Chevron />
          <span className="label pal-toggle-title">{title}</span>
          <span className="num pal-count">{count}</span>
        </button>
      </h2>
      {/* Collapsed content is unmounted rather than hidden: 27 rows of
          hidden DOM is 27 rows the screen reader and the tab order still
          have to walk past. */}
      {open ? (
        <div id={bodyId} className="pal-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export interface PaletteProps {
  /** Add a node of `kind` to the canvas at a default position. */
  onAdd: (kind: NodeKind) => void;
  presets: Preset[];
  activePresetId: string | null;
  onLoadPreset: (preset: Preset) => void;
}

function handleDragStart(event: DragEvent<HTMLButtonElement>, kind: NodeKind) {
  const dt = event.dataTransfer;
  // Must match what Canvas checks for in onDragOver / onDrop.
  dt.setData(NODE_DND_MIME, kind);
  dt.effectAllowed = 'copy';
}

export function Palette({
  onAdd,
  presets,
  activePresetId,
  onLoadPreset,
}: PaletteProps) {
  /**
   * Which sections are open. Local UI state — the shell has no business
   * knowing whether a disclosure is expanded, and persisting it would
   * mean a student who collapsed everything once opens the app to an
   * empty rail.
   */
  const [closed, setClosed] = useState<ReadonlySet<string>>(
    () => new Set<string>(['keys']),
  );

  const toggle = useCallback((id: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const totalKinds = useMemo(
    () => KIND_GROUPS.reduce((n, g) => n + g.kinds.length, 0),
    [],
  );

  /**
   * Enter and Space both activate a row. A <button> already does this,
   * but the row is also draggable, and Firefox drops the implicit Space
   * activation on a draggable button — so it is restored explicitly
   * rather than left to chance.
   */
  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, kind: NodeKind) => {
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        onAdd(kind);
      }
    },
    [onAdd],
  );

  return (
    <nav className="pal" aria-label="Components and examples">
      <div className="pal-scroll scroll">
        <Section
          id="components"
          title="Components"
          count={totalKinds}
          open={!closed.has('components')}
          onToggle={() => toggle('components')}
        >
          {/* Groups inside the section are NOT separately collapsible —
              two levels of disclosure in a 224px rail is a filing
              cabinet, not a tool. They are a caption plus a list. */}
          {KIND_GROUPS.map((group) => (
            <div className="pal-group" key={group.id}>
              <p className="label pal-group-title">{group.title}</p>
              <ul className="pal-list">
                {group.kinds.map((kind) => (
                  <li key={kind}>
                    <button
                      type="button"
                      className="pal-row"
                      draggable
                      onDragStart={(e) => handleDragStart(e, kind)}
                      onClick={() => onAdd(kind)}
                      onKeyDown={(e) => onRowKeyDown(e, kind)}
                      title={KIND_HINT[kind]}
                    >
                      <span className="pal-glyph">
                        <Glyph kind={kind} />
                      </span>
                      <span className="pal-name">{KIND_NAME[kind]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>

        <Section
          id="examples"
          title="Examples"
          count={presets.length}
          open={!closed.has('examples')}
          onToggle={() => toggle('examples')}
        >
          <ul className="pal-list">
            {presets.map((preset) => {
              const active = preset.id === activePresetId;
              const note = PRESET_NOTE[preset.id];
              return (
                <li key={preset.id}>
                  <button
                    type="button"
                    className="pal-row pal-row-preset"
                    data-active={active || undefined}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onLoadPreset(preset)}
                    title={preset.description}
                  >
                    {/* The active marker is a glyph slot, not a border on
                        the row: a coloured edge plus a radius is the shape
                        the design rules forbid, and the slot also keeps
                        every preset name on one left axis whether or not
                        it is the active one. */}
                    <span className="pal-mark" aria-hidden="true" />
                    <span className="pal-preset-text">
                      <span className="pal-name">{preset.name}</span>
                      {note ? (
                        <span className="label pal-note">{note}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section
          id="keys"
          title="Keys"
          count={6}
          open={!closed.has('keys')}
          onToggle={() => toggle('keys')}
        >
          <dl className="pal-keylist">
            <div className="pal-keyrow">
              <dt className="pal-key">Space</dt>
              <dd className="pal-keydesc">Pause / resume</dd>
            </div>
            <div className="pal-keyrow">
              <dt className="pal-key">S</dt>
              <dd className="pal-keydesc">Step one tick</dd>
            </div>
            <div className="pal-keyrow">
              <dt className="pal-key">Del</dt>
              <dd className="pal-keydesc">Remove selected</dd>
            </div>
            <div className="pal-keyrow">
              <dt className="pal-key">Drag</dt>
              <dd className="pal-keydesc">Port to port connects</dd>
            </div>
            <div className="pal-keyrow">
              <dt className="pal-key">Shift</dt>
              <dd className="pal-keydesc">Add to selection</dd>
            </div>
            <div className="pal-keyrow">
              <dt className="pal-key">Esc</dt>
              <dd className="pal-keydesc">Cancel / deselect</dd>
            </div>
          </dl>
        </Section>
      </div>
    </nav>
  );
}
