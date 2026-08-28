import { createElement, useCallback, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import type { NodeKind } from '../sim/types';
import {
  ICON_BOX,
  ICON_STROKE,
  KIND_ICON,
  KIND_NAME,
  KIND_TERM,
  NODE_DND_MIME,
} from './nodeVisuals';
import { Term } from './Tooltip';
import { usePreference } from '../content/preferences';
import { useVendor } from '../content/vendors/useVendor';
import { nameFor } from '../content/vendors/lookup';
import type { Vendor } from '../content/vendors/types';
import { ANN_DND_MIME } from './annotationLayout';
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

export type AnnotationTool = 'note' | 'section';

/**
 * The two annotation rows. Not components: they carry no traffic, have no
 * simulation behaviour and never reach the engine, so they sit in their own
 * group rather than borrowing a NodeKind. The icons are drawn inline for
 * the same reason: KIND_ICON is the engine-backed vocabulary and these are
 * not in it.
 */
const ANN_ROWS: {
  tool: AnnotationTool;
  name: string;
  hint: string;
  icon: string[];
}[] = [
  {
    tool: 'note',
    name: 'Note',
    hint: 'Click, then click the canvas to place text (N)',
    // Lucide "type": text as text.
    icon: ['M4 7V5h16v2', 'M9 20h6', 'M12 5v15'],
  },
  {
    tool: 'section',
    name: 'Section',
    hint: 'Click, then drag on the canvas to frame a group (B)',
    // A frame with a label notch: the thing it draws.
    icon: [
      'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
      'M3 9h8',
    ],
  },
];

/**
 * Does `kind` match the typed query?
 *
 * Matches the display name, the one-line hint and the group title, so
 * "melting" finds the Control group's contents and "stale" finds read
 * replicas. Searching only the names would fail exactly the student this
 * is for: someone who knows the problem they have but not what the
 * component is called.
 *
 * Substring rather than fuzzy. A 33-item list is small enough that a
 * substring match is predictable, and predictability beats cleverness when
 * the result is "the thing you wanted is not on screen".
 */
function matchesKind(
  kind: NodeKind,
  group: KindGroup,
  needle: string,
  vendor: Vendor | null,
): boolean {
  return (
    KIND_NAME[kind].toLowerCase().includes(needle) ||
    // The vendor name too, so someone who typed "RDS" finds the database
    // even though the concept is what the rail is organised by.
    nameFor(kind, vendor).toLowerCase().includes(needle) ||
    KIND_HINT[kind].toLowerCase().includes(needle) ||
    group.title.toLowerCase().includes(needle)
  );
}

export interface PaletteProps {
  /** Add a node of `kind` to the canvas at a default position. */
  onAdd: (kind: NodeKind) => void;
  /**
   * Arm the note or section tool. The next drag on the canvas draws the
   * shape; clicking the row again disarms.
   */
  onAddAnnotation?: (tool: AnnotationTool) => void;
  /**
   * Which tool is armed, so the row can say so. A control that puts the app
   * into a mode has to show the mode is on, or the changed cursor is the only
   * evidence and the student who looks back at the rail sees nothing.
   */
  armedTool?: AnnotationTool | null;
}

function handleDragStart(event: DragEvent<HTMLButtonElement>, kind: NodeKind) {
  const dt = event.dataTransfer;
  // Must match what Canvas checks for in onDragOver / onDrop.
  dt.setData(NODE_DND_MIME, kind);
  dt.effectAllowed = 'copy';
}

function handleAnnDragStart(event: DragEvent<HTMLButtonElement>, tool: AnnotationTool) {
  const dt = event.dataTransfer;
  dt.setData(ANN_DND_MIME, tool);
  dt.effectAllowed = 'copy';
}

export function Palette({ onAdd, onAddAnnotation, armedTool }: PaletteProps) {
  /**
   * Whether the hover explanations are on. With them OFF (the default) the
   * per-row "?" mark is not rendered at all: <Term> degrades to its bare
   * children then, which left 33 inert question marks with no handler and no
   * focus stop — decoration that could only mislead — and their sr-only
   * labels, no longer anchored by the positioned .pal-explain wrapper,
   * silently extended the document's scroll box by ~634px.
   */
  const hintsOn = usePreference('tooltips');
  const vendor = useVendor();

  const totalKinds = useMemo(
    () => KIND_GROUPS.reduce((n, g) => n + g.kinds.length, 0),
    [],
  );

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const needle = query.trim().toLowerCase();

  /**
   * The groups with non-matching kinds removed, and empty groups dropped.
   *
   * Filtering rather than reordering keeps the taxonomy intact while
   * searching: a student who typed "cache" and sees it under Data has
   * learned where to find it next time without the search box.
   */
  const groups = useMemo(() => {
    if (!needle) return KIND_GROUPS;
    return KIND_GROUPS.map((g) => ({
      ...g,
      kinds: g.kinds.filter((k) => matchesKind(k, g, needle, vendor)),
    })).filter((g) => g.kinds.length > 0);
  }, [needle, vendor]);

  const matchCount = useMemo(
    () => groups.reduce((n, g) => n + g.kinds.length, 0),
    [groups],
  );

  const onSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  /** Escape clears the box, then gives it up. The usual contract for search. */
  const onSearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    setQuery((q) => {
      if (q) return '';
      searchRef.current?.blur();
      return q;
    });
  }, []);

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
        {/* Not a disclosure. The rail itself already hides and shows with one
            button and a keyboard shortcut, so wrapping its only remaining
            section in a second collapse gave the same content two ways to
            disappear and made the components one extra click away for no gain.
            A heading and a list is the whole of it now.

            Groups inside are not separately collapsible either: two levels of
            disclosure in a 224px rail is a filing cabinet, not a tool. */}
        <div className="pal-section">
          <p className="label pal-heading">
            Components{' '}
            <span className="pal-heading-count">
              {needle ? `${matchCount} of ${totalKinds}` : totalKinds}
            </span>
          </p>

          {/* Thirty-three rows is more than a person scans, and the rail had
              no way to ask for one by name. A plain text input rather than a
              combobox: it filters a list that stays visible and keeps its
              grouping, so there is no popup, no active-descendant and nothing
              to announce beyond the count, which the live region below does. */}
          <div className="pal-search">
            <svg
              className="pal-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              className="pal-search-input"
              placeholder="Search components"
              aria-label="Search components"
              value={query}
              onChange={onSearchChange}
              onKeyDown={onSearchKeyDown}
            />
            {query && (
              <button
                type="button"
                className="pal-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* The count is announced, not just shown: a filter that silently
              empties the list leaves a screen reader user with no idea it
              did anything. */}
          <p className="sr-only" role="status">
            {needle
              ? `${matchCount} of ${totalKinds} components match ${query.trim()}`
              : ''}
          </p>

          {needle && matchCount === 0 && (
            <p className="pal-empty">
              Nothing matches {'\u201c'}
              {query.trim()}
              {'\u201d'}. Searching what a component does works too, like {'\u201c'}
              stale{'\u201d'} or {'\u201c'}refuse{'\u201d'}.
            </p>
          )}

          {groups.map((group) => (
            <div className="pal-group" key={group.id}>
              <p className="label pal-group-title">{group.title}</p>
              <ul className="pal-list">
                {group.kinds.map((kind) => (
                  /*
                    WHY THE EXPLANATION IS NOT ON THE ROW ITSELF.

                    Every other surface in the app wraps the label in <Term>.
                    Here that is wrong, and the reason is what the row DOES:
                    clicking it puts a component on the canvas. Making the
                    name a tooltip trigger would nest one interactive element
                    inside another, and worse, it would mean the gesture for
                    "what IS a circuit breaker?" and the gesture for "give me
                    a circuit breaker" are the same click. A student browsing
                    to learn would litter the canvas doing it.

                    So the trigger is a SIBLING of the button, not a child.
                    The row keeps its click, its drag and its keyboard
                    activation exactly as they were; the mark beside it
                    explains. Hovering anywhere on the row reveals the mark,
                    so it is discoverable without being 33 permanent dots.
                  */
                  <li key={kind} className="pal-item">
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
                      <span className="pal-name">{nameFor(kind, vendor)}</span>
                    </button>
                    {/*
                      `bare` because the row is already a strong affordance
                      and a dotted underline on a lone question mark would be
                      noise on top of noise. The tooltip itself is unchanged.
                    */}
                    {hintsOn && (
                      <Term id={KIND_TERM[kind]} className="pal-explain" bare>
                        <span aria-hidden="true">?</span>
                        <span className="sr-only">What is a {KIND_NAME[kind]}?</span>
                      </Term>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/*
            Annotation rows: the documentation layer. Same affordances as a
            component row (drag onto the canvas, or click to place at the
            centre of the view), so nothing new has to be learned; the
            neutral chip is what says "not a component". The keyboard route
            (N / B arming a tool) is printed in each row's title.
          */}
          {onAddAnnotation && (
            <div className="pal-group">
              <p className="label pal-group-title">Annotate</p>
              <ul className="pal-list">
                {ANN_ROWS.map((row) => (
                  <li key={row.tool} className="pal-item">
                    <button
                      type="button"
                      className={`pal-row${armedTool === row.tool ? ' is-armed' : ''}`}
                      aria-pressed={armedTool === row.tool}
                      draggable
                      onDragStart={(e) => handleAnnDragStart(e, row.tool)}
                      onClick={() => onAddAnnotation(row.tool)}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Spacebar') {
                          e.preventDefault();
                          onAddAnnotation(row.tool);
                        }
                      }}
                      title={row.hint}
                    >
                      <span className="pal-glyph">
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
                          {row.icon.map((d) => (
                            <path key={d} d={d} />
                          ))}
                        </svg>
                      </span>
                      <span className="pal-name">{row.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
