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

/** One line, plain language, no jargon the student has to look up. */
const KIND_DESCRIPTION: Record<NodeKind, string> = {
  client: 'Sends requests at the rate you set',
  lb: 'Spreads requests across several servers',
  service: 'Handles a request, calls what it needs',
  cache: 'Answers repeat reads without the database',
  db: 'Stores the data. Usually saturates first',
  queue: 'Holds work so the sender does not wait',
  worker: 'Drains the queue in the background',
};

/**
 * The same path data the canvas draws, so a row in the palette is
 * visually the exact object that lands on the canvas.
 */
function Glyph({ kind }: { kind: NodeKind }) {
  const filled = FILLED_GLYPHS.has(kind);
  return (
    <svg
      width="16"
      height="16"
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
        <h2 className="pal-heading">Components</h2>
        <ul className="pal-list">
          {NODE_KINDS.map((kind) => (
            <li key={kind}>
              <button
                type="button"
                className="pal-row"
                draggable
                onDragStart={(e) => handleDragStart(e, kind)}
                onClick={() => onAdd(kind)}
                title={`Add ${KIND_LABEL[kind]}`}
              >
                <span className="pal-glyph">
                  <Glyph kind={kind} />
                </span>
                <span className="pal-text">
                  <span className="pal-name">{KIND_LABEL[kind]}</span>
                  <span className="pal-desc">{KIND_DESCRIPTION[kind]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="pal-section">
        <h2 className="pal-heading">Examples</h2>
        <ul className="pal-list">
          {presets.map((preset) => {
            const active = preset.id === activePresetId;
            return (
              <li key={preset.id}>
                <button
                  type="button"
                  className="pal-row pal-row-preset"
                  data-active={active || undefined}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onLoadPreset(preset)}
                >
                  <span className="pal-text">
                    <span className="pal-name">{preset.name}</span>
                    <span className="pal-desc">{preset.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </nav>
  );
}
