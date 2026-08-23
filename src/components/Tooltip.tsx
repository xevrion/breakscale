import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY_BY_ID } from '../content/glossary';
import './Tooltip.css';

/**
 * Explanation tooltips.
 *
 * The native `title` attribute is not good enough for a teaching tool: it waits
 * about a second, cannot be styled, never appears for keyboard users, and does
 * nothing at all on a touch screen. Every one of those matters when the whole
 * point is that a confused student can find out what a word means.
 *
 * So this is hand-built, and it commits to three things the native one misses:
 * it opens on keyboard focus, it opens on tap, and it is positioned so it can
 * never be clipped by a panel that scrolls.
 */

/** Delay before opening, so sweeping across the UI does not strobe tooltips. */
const OPEN_DELAY_MS = 350;
/**
 * Once one tooltip has opened, neighbours open immediately. Re-waiting a third
 * of a second per term makes comparing two numbers feel broken.
 */
const GRACE_MS = 400;
/** Delay before closing, so the pointer can travel into the tooltip itself. */
const CLOSE_DELAY_MS = 120;
/** Keep the panel clear of the viewport edge by this much. */
const VIEWPORT_MARGIN = 8;
/** Gap between the trigger and the panel. */
const OFFSET = 10;

/** Shared across instances: was another tooltip open a moment ago? */
let lastCloseAt = 0;

interface Placement {
  left: number;
  top: number;
  /** Which side of the trigger we ended up on, for the arrow. */
  side: 'top' | 'bottom';
  /** Arrow offset from the panel's left edge. */
  arrowLeft: number;
}

export interface TermProps {
  /** Glossary entry id. Unknown ids render children unchanged. */
  id: string;
  children: ReactNode;
  /** Extra classes on the trigger. */
  className?: string;
  /**
   * Suppresses the dotted underline. For places where the affordance would be
   * noise, such as a term already inside a heading that is obviously a label.
   */
  bare?: boolean;
  /** Called when the reader follows a "see also" link. */
  onNavigate?: (id: string) => void;
}

/**
 * Wraps a term and attaches its glossary explanation.
 *
 * Renders a <span>, so it is safe inside a paragraph, a table cell or a label,
 * but NOT inside an SVG. Canvas readouts are explained through the inspector
 * and the glossary panel instead.
 */
export function Term({
  id,
  children,
  className,
  bare = false,
  onNavigate,
}: TermProps) {
  const entry = GLOSSARY_BY_ID.get(id);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const tooltipId = useId();

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setOpen((wasOpen) => {
      if (wasOpen) lastCloseAt = Date.now();
      return false;
    });
  }, [clearTimers]);

  const openNow = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const openSoon = useCallback(() => {
    clearTimers();
    // Within the grace window the reader is already reading tooltips, so
    // waiting again would just feel unresponsive.
    const delay = Date.now() - lastCloseAt < GRACE_MS ? 0 : OPEN_DELAY_MS;
    openTimer.current = window.setTimeout(() => setOpen(true), delay);
  }, [clearTimers]);

  const closeSoon = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(close, CLOSE_DELAY_MS);
  }, [clearTimers, close]);

  useEffect(() => clearTimers, [clearTimers]);

  /* Position after layout, before paint, so it never appears in the wrong
     place for a frame. */
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const t = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer above; flip below when there is not room. This app has a metrics
    // strip along the bottom, so terms down there must open upward and terms
    // in the top bar must open downward.
    const roomAbove = t.top;
    const roomBelow = vh - t.bottom;
    const side: 'top' | 'bottom' =
      roomAbove >= p.height + OFFSET + VIEWPORT_MARGIN || roomAbove > roomBelow
        ? 'top'
        : 'bottom';

    const top =
      side === 'top' ? t.top - p.height - OFFSET : t.bottom + OFFSET;

    // Centre on the trigger, then shift to stay on screen. The inspector sits
    // hard against the right edge, so this clamp is load-bearing.
    const centred = t.left + t.width / 2 - p.width / 2;
    const left = Math.min(
      Math.max(centred, VIEWPORT_MARGIN),
      vw - p.width - VIEWPORT_MARGIN,
    );

    // The arrow tracks the trigger even after the panel has been shifted.
    const arrowLeft = Math.min(
      Math.max(t.left + t.width / 2 - left, 14),
      p.width - 14,
    );

    setPlacement({
      left,
      top: Math.min(Math.max(top, VIEWPORT_MARGIN), vh - p.height - VIEWPORT_MARGIN),
      side,
      arrowLeft,
    });
  }, [open]);

  /* Escape closes; scrolling or resizing dismisses rather than chasing the
     trigger, which is cheaper and less distracting. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    const onScroll = () => close();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  if (!entry) return <>{children}</>;

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          id={tooltipId}
          role="tooltip"
          className={`tip tip-${placement?.side ?? 'top'}`}
          style={{
            left: placement?.left ?? -9999,
            top: placement?.top ?? -9999,
            // Hidden until measured, so it never flashes at the wrong spot.
            visibility: placement ? 'visible' : 'hidden',
          }}
          onPointerEnter={openNow}
          onPointerLeave={closeSoon}
        >
          <span
            className="tip-arrow"
            style={{ left: placement?.arrowLeft ?? 0 }}
            aria-hidden="true"
          />
          <p className="tip-term">{entry.term}</p>
          <p className="tip-short">{entry.short}</p>
          <p className="tip-why">{entry.why}</p>
          {entry.see && entry.see.length > 0 && onNavigate ? (
            <p className="tip-see">
              <span className="tip-see-label">See also</span>
              {entry.see.map((sid) => {
                const other = GLOSSARY_BY_ID.get(sid);
                if (!other) return null;
                return (
                  <button
                    key={sid}
                    type="button"
                    className="tip-see-link"
                    onClick={() => {
                      close();
                      onNavigate(sid);
                    }}
                  >
                    {other.term}
                  </button>
                );
              })}
            </p>
          ) : null}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span
        ref={triggerRef}
        className={`term${bare ? ' term-bare' : ''}${className ? ` ${className}` : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`${entry.term}. ${entry.short}. What it means.`}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onPointerEnter={(e) => {
          // Touch reports as a pointerenter immediately followed by a tap; let
          // the click handler own that case so it toggles rather than sticking.
          if (e.pointerType === 'touch') return;
          openSoon();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'touch') return;
          closeSoon();
        }}
        onFocus={openNow}
        onBlur={closeSoon}
        onClick={() => (open ? close() : openNow())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open ? close() : openNow();
          }
        }}
      >
        {children}
      </span>
      {panel}
    </>
  );
}
