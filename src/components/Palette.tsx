import type { DragEvent } from 'react';
import type { NodeKind } from '../sim/types';
import type { Preset } from '../sim/presets';
import { FILLED_GLYPHS, GLYPH, NODE_DND_MIME } from './nodeVisuals';
import './Palette.css';

/** Canonical order shown in the rail. */
const NODE_KINDS: NodeKind[] = [
  'client',
  'lb',
  'service',
  'cache',
  'db',
  'queue',
  'worker',
];

const KIND_LABEL: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
};

/**
 * Kept as the row's `title` only. The prose that used to render under
 * every name is what made this rail 260px wide with 84px rows and 27% of
 * its column empty; the real explanation now lives in the inspector,
 * where there is room for it and where the student is already looking.
 */
const KIND_HINT: Record<NodeKind, string> = {
  client: 'Sends requests at the rate you set',
  lb: 'Spreads requests across several servers',
  service: 'Handles a request, calls what it needs',
  cache: 'Answers repeat reads without the database',
  db: 'Stores the data. Usually saturates first',
  queue: 'Holds work so the sender does not wait',
  worker: 'Drains the queue in the background',
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
};

/**
 * The same path data the canvas draws, so a row in the palette is
 * visually the exact object that lands on the canvas. A bare stroked
 * glyph in currentColor — never an icon inside a filled square.
 */
function Glyph({ kind }: { kind: NodeKind }) {
  const filled = FILLED_GLYPHS.has(kind);
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" role="presentation" aria-hidden="true">
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
  return (
    <nav className="pal scroll" aria-label="Components and examples">
      <section className="pal-section">
        <h2 className="label pal-heading">Components</h2>
        <ul className="pal-list">
          {NODE_KINDS.map((kind) => (
            <li key={kind}>
              <button
                type="button"
                className="pal-row"
                draggable
                onDragStart={(e) => handleDragStart(e, kind)}
                onClick={() => onAdd(kind)}
                title={KIND_HINT[kind]}
              >
                <span className="pal-glyph">
                  <Glyph kind={kind} />
                </span>
                <span className="pal-name">{KIND_LABEL[kind]}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="pal-section">
        <h2 className="label pal-heading">Examples</h2>
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
                  <span className="pal-name">{preset.name}</span>
                  {note ? <span className="label pal-note">{note}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* A rail that ends in a key reference is a tool; one that ends in
          300px of nothing is a draft. Only shortcuts App actually
          handles are listed. */}
      <section className="pal-section pal-keys">
        <h2 className="label pal-heading">Keys</h2>
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
        </dl>
      </section>
    </nav>
  );
}
