import { createElement, useCallback, useMemo, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import type { NodeKind } from '../sim/types';
import type { Preset } from '../sim/presets';
import { ICON_BOX, ICON_STROKE, KIND_ICON, KIND_NAME, NODE_DND_MIME } from './nodeVisuals';
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
  { id: 'traffic', title: 'Traffic', kinds: ['client', 'lb', 'cdn', 'edgecompute'] },
  {
    id: 'compute',
    title: 'Compute',
    kinds: ['service', 'worker', 'queue', 'retryqueue', 'transcoder'],
  },
  {
    id: 'data',
    title: 'Data',
    kinds: ['db', 'cache', 'writebehind', 'replica', 'shard'],
  },
  {
    // The polyglot-persistence shelf: each of these exists because putting
    // its workload in the main database is the mistake it teaches against.
    id: 'stores',
    title: 'Specialised stores',
    kinds: [
      'objectstore',
      'searchindex',
      'timeseriesdb',
      'graphdb',
      'vectordb',
      'coldstorage',
    ],
  },
  {
    // How services talk when it is not one request calling one server:
    // logs, topics, sockets, functions and jobs on a clock.
    id: 'messaging',
    title: 'Messaging',
    kinds: ['streambroker', 'pubsub', 'websocket', 'lambda', 'cron'],
  },
  {
    id: 'control',
    title: 'Control',
    kinds: [
      'ratelimiter',
      'loadshedder',
      'breaker',
      'bulkhead',
      'autoscaler',
      'region',
      'apigateway',
      'sidecar',
    ],
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
  objectstore: 'Blobs: slow per request, near-unlimited',
  searchindex: 'Fast search, but writes index late',
  timeseriesdb: 'Swallows metrics; range queries cost',
  graphdb: 'Relationships. Depth multiplies the cost',
  coldstorage: 'Archive tier: cheap, and takes seconds',
  vectordb: 'Similarity search. Recall costs latency',
  streambroker: 'A replayable log; consumers fall behind',
  pubsub: 'One publish becomes N deliveries',
  websocket: 'Holds connections; they run out, not rps',
  apigateway: 'Auth, rate limits and routing at the door',
  sidecar: 'A proxy tax on every hop, buying retries',
  lambda: 'Scales instantly, but cold starts cost',
  cron: 'Dumps a burst of work on a schedule',
  bulkhead: 'Caps calls to one dependency; contains it',
  retryqueue: 'Redelivers failures; dead-letters the rest',
  transcoder: 'Grinds long CPU jobs pulled off a queue',
  edgecompute: 'Answers what it can at the edge itself',
  writebehind: 'Acks writes fast; a crash loses the buffer',
  loadshedder: 'Under load, drops low-priority traffic first',
};

/**
 * What each example teaches, written as something a person would say.
 *
 * These used to be fragments — "Bottleneck: db", "Shed at the door" — which
 * read as tags on a config file rather than as an invitation to try
 * something. A student picking an example wants to know what they are about
 * to watch happen, so each line now says that in plain words.
 */
const PRESET_NOTE: Record<string, string> = {
  'single-server': 'Watch the database become the bottleneck',
  'load-balanced': 'More servers, same database behind them',
  'cache-aside': 'What happens when the hit rate falls',
  'async-workers': 'A backlog that grows faster than it drains',
  'retry-storm': 'Retries making an overload worse',
  'cdn-origin': 'How much traffic never reaches you',
  'rate-limited-api': 'Turning excess away before it queues',
  'circuit-breaker': 'Giving a failing dependency room to recover',
  'read-replicas': 'Reads that scale, and reads that go stale',
  'sharded-database': 'One hot key undoing all the partitions',
  'autoscaling-service': 'Capacity arriving after it was needed',
  'multi-region': 'What a failover actually costs you',
  'full-stack': 'Every piece at once, under real load',
  'specialised-stores': 'The right store for each job, side by side',
  'event-driven': 'Lag, fan-out, cold starts and a cron burst',
  'resilient-delivery': 'Choosing what fails, and where failures go',
  twitter: 'One tweet becoming a hundred thousand writes',
  stripe: 'Refusing work rather than charging twice',
  whatsapp: 'Messages that wait instead of failing',
};

/**
 * The same icon primitives the canvas draws, so a row in the palette is
 * visually the exact object that lands on the canvas. A bare stroked icon
 * in currentColor, never an icon inside a filled square. Sized in em so it
 * tracks the row's own type size instead of a hardcoded pixel count.
 */
function Glyph({ kind }: { kind: NodeKind }) {
  return (
    <svg
      width="1.1em"
      height="1.1em"
      viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="presentation"
      aria-hidden="true"
    >
      {KIND_ICON[kind].map(([tag, attrs]) => {
        const { key, ...rest } = attrs;
        return createElement(tag, { key, ...rest });
      })}
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
                      /* Drives the chip's colour trio in Palette.css. This
                         is the same `data-kind` contract the canvas uses,
                         so a kind is coloured by one rule per surface
                         rather than by an inline style computed in JS. */
                      data-kind={kind}
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
