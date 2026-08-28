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
];

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

export function Settings({ open, onClose }: SettingsProps) {
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
