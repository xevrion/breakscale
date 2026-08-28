import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import {
  setPreference,
  togglePreference,
  usePreferences,
} from '../content/preferences';
import type { Preferences, ThemeChoice } from '../content/preferences';
import { resolveSystemTheme } from '../theme/applyTheme';
import './Settings.css';

/* ==========================================================================
   Settings.

   WHY IT EXISTS. The preferences store had three fields and the interface
   had one button. `sparklines` and `snapToGrid` were reachable only by
   editing localStorage by hand, which is the same as not existing, and the
   theme had nowhere to live at all. This is the one place that answers
   "where do I change how this behaves".

   WHY A DIALOG, matching the shortcuts card rather than the glossary sheet:
   settings are changed between actions, not while watching a run, so the
   canvas does not need to stay visible behind them.

   DELIBERATELY SHORT. preferences.ts says it plainly: a settings screen with
   twenty switches is how an app stops having opinions. Everything here is a
   choice a reasonable person actually makes differently, and anything that
   has one right answer stays a decision the app makes for them.
   ========================================================================== */

interface ToggleRow {
  key: keyof Omit<Preferences, 'theme'>;
  label: string;
  /** What turning it on actually does, in the reader's terms. */
  hint: string;
}

const TOGGLES: ToggleRow[] = [
  {
    key: 'tooltips',
    label: 'Explain metric names',
    hint: 'Underline terms like p99 and show what they mean on hover.',
  },
  {
    key: 'sparklines',
    label: 'Trend lines on components',
    hint: 'Draw the recent history of each component on its box.',
  },
  {
    key: 'snapToGrid',
    label: 'Snap to the grid',
    hint: 'Keep components aligned while dragging. Hold Ctrl to bypass it.',
  },
  {
    key: 'minimap',
    label: 'Minimap',
    hint: 'A small map of the whole diagram, for finding your way around a big one.',
  },
];

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/**
 * One 16px stroked glyph, matching the icons the top bar and the rail use.
 * A shared component rather than five inline svgs, so the stroke weight and
 * the sizing cannot drift row to row.
 */
function Glyph({ d }: { d: string }) {
  return (
    <svg
      className="st-action-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /**
   * What to do with the design you have built.
   *
   * These are actions rather than preferences, which is not what a settings
   * panel usually holds. They live here anyway because the alternative was
   * three more buttons in a top bar that already carried nine, and a save
   * and a share are things a reader goes looking for rather than reaches for
   * mid-thought.
   */
  onExport?: () => void;
  onImport?: () => void;
  onCopyLink?: () => void;
  onExportImage?: (format: 'svg' | 'png') => void;
}

export function Settings({
  open,
  onClose,
  onExport,
  onImport,
  onCopyLink,
  onExportImage,
}: SettingsProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const prefs = usePreferences();

  /* Focus lands on the card and returns to the opener, the same contract the
     shortcuts dialog and the glossary both keep. */
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    card?.focus();
    return () => {
      const active = document.activeElement;
      const inside = card?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) {
        opener?.focus();
      }
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`st-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="st-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="st-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="st-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        <header className="st-head">
          <h2 id="st-title" className="st-title">
            Settings
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={onClose}
            aria-label="Close settings"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="st-body">
          <section className="st-group">
            <h3 className="st-group-title">Appearance</h3>
            {/*
              A radiogroup rather than a switch, because there are three
              states and one of them ("System") is not the absence of a
              choice. A two-position switch cannot say "follow the machine".
            */}
            <div
              className="st-choices"
              role="radiogroup"
              aria-labelledby="st-theme-label"
            >
              <span id="st-theme-label" className="st-row-label">
                Theme
              </span>
              <div className="st-segmented">
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={prefs.theme === t.value}
                    className={`st-seg${prefs.theme === t.value ? ' is-active' : ''}`}
                    onClick={() => setPreference('theme', t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="st-hint">
                {prefs.theme === 'system'
                  ? `Following your device, which is currently ${resolveSystemTheme()}.`
                  : 'Kept across visits, whatever your device is set to.'}
              </p>
            </div>
          </section>

          {(onExport || onImport || onCopyLink) && (
            <section className="st-group">
              <h3 className="st-group-title">Your design</h3>
              <div className="st-actions">
                {onCopyLink && (
                  <button type="button" className="st-action" onClick={onCopyLink}>
                    <Glyph d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
                    <span className="st-action-text">
                      <span className="st-row-label">Copy link</span>
                      <span className="st-hint">
                        Carries the design in the address itself. Nothing is uploaded
                        and nobody needs an account.
                      </span>
                    </span>
                  </button>
                )}
                {onExport && (
                  <button type="button" className="st-action" onClick={onExport}>
                    <Glyph d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    <span className="st-action-text">
                      <span className="st-row-label">Save to a file</span>
                      <span className="st-hint">
                        Downloads the whole design, notes and all.
                      </span>
                    </span>
                  </button>
                )}
                {onExportImage && (
                  <button
                    type="button"
                    className="st-action"
                    onClick={() => onExportImage('png')}
                  >
                    <Glyph d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 21" />
                    <span className="st-action-text">
                      <span className="st-row-label">Save as a picture</span>
                      <span className="st-hint">
                        A PNG of the whole diagram, for a slide or a report.
                      </span>
                    </span>
                  </button>
                )}
                {onExportImage && (
                  <button
                    type="button"
                    className="st-action"
                    onClick={() => onExportImage('svg')}
                  >
                    <Glyph d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 15l2-3 2 2 2-4 3 5" />
                    <span className="st-action-text">
                      <span className="st-row-label">Save as an SVG</span>
                      <span className="st-hint">
                        Stays sharp at any size, and the text is still text.
                      </span>
                    </span>
                  </button>
                )}
                {onImport && (
                  <button type="button" className="st-action" onClick={onImport}>
                    <Glyph d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                    <span className="st-action-text">
                      <span className="st-row-label">Open a file</span>
                      <span className="st-hint">
                        Or drop one straight onto the canvas.
                      </span>
                    </span>
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="st-group">
            <h3 className="st-group-title">Canvas</h3>
            {TOGGLES.map((row) => (
              <div key={row.key} className="st-row">
                <button
                  type="button"
                  role="switch"
                  aria-checked={prefs[row.key]}
                  className="st-switch"
                  onClick={() => togglePreference(row.key)}
                >
                  <span className="st-switch-track" aria-hidden="true">
                    <span className="st-switch-thumb" />
                  </span>
                  <span className="st-switch-text">
                    <span className="st-row-label">{row.label}</span>
                    <span className="st-hint">{row.hint}</span>
                  </span>
                </button>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
