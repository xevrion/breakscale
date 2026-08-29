import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Challenge } from '../sim/challenge';
import { usePresence } from './presence';
import './Examples.css';

/* ==========================================================================
   The challenge picker.

   Deliberately the examples dialog's shell and stylesheet rather than a third
   dialog design. A reader who has opened Examples already knows how this
   behaves, and the two are the same act: pick a system to load. What differs
   is that these arrive with a goal attached.

   No search box. There are four of these against twenty-three examples, and
   a filter over four rows is furniture.
   ========================================================================== */

export interface ChallengesProps {
  open: boolean;
  onClose: () => void;
  challenges: readonly Challenge[];
  onStart: (id: string) => void;
}

export function Challenges({ open, onClose, challenges, onStart }: ChallengesProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`ex-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="ex-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="ex-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chal-title"
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
        <header className="ex-head">
          <div>
            <h2 id="chal-title" className="ex-title">
              Challenges
            </h2>
            <p className="ex-sub">
              A system that does not meet its requirement. Work out why, and fix it.
            </p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="ex-grid">
          {challenges.map((c) => (
            <button
              key={c.id}
              type="button"
              className="ex-item"
              onClick={() => {
                onStart(c.id);
                onClose();
              }}
            >
              <span className="ex-item-name">{c.name}</span>
              <span className="ex-item-desc">{c.brief}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
