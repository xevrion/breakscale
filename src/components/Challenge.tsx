import { useState } from 'react';
import type { Challenge, ChallengeResult } from '../sim/challenge';
import './Challenge.css';

/**
 * The active brief, and how the design is doing against it.
 *
 * Sits over the canvas rather than in a dialog, because the whole point is
 * to read the requirement and watch the numbers move at the same time. A
 * brief you have to close to see its effect is a quiz question.
 *
 * Every goal is shown at all times, met or not, with the number that decided
 * it. "Failed" on its own tells a reader nothing they can act on; "p99 is
 * 324ms and it needs to be under 200" tells them where to look.
 */
export interface ChallengePanelProps {
  challenge: Challenge;
  result: ChallengeResult;
  onGiveUp: () => void;
}

const LABEL: Record<string, string> = {
  p99: 'p99 latency',
  p95: 'p95 latency',
  errorRate: 'Requests lost',
};

/** Metrics carry different units, and a bare number is not a measurement. */
function format(metric: string, value: number): string {
  if (metric === 'errorRate') return `${value.toFixed(1)}%`;
  return `${Math.round(value)}ms`;
}

export function ChallengePanel({ challenge, result, onGiveUp }: ChallengePanelProps) {
  /* Hints are asked for, never volunteered. A panel that opens with three
     paragraphs of help has answered a question nobody asked yet, and the
     reader skips them. Asking is also the honest signal that someone is
     stuck, which is the moment help is worth anything. */
  const [shown, setShown] = useState<string[]>([]);

  /* Starting a different brief starts from no hints. Adjusted during render
     rather than in an effect: an effect would paint the previous brief's
     hints for a frame first, and React documents this as the way to reset
     state when a prop changes. */
  const [lastId, setLastId] = useState(challenge.id);
  if (lastId !== challenge.id) {
    setLastId(challenge.id);
    setShown([]);
  }

  return (
    <section
      className={`chal${result.passed ? ' is-passed' : ''}`}
      aria-label="Challenge"
    >
      <header className="chal-head">
        <p className="label chal-kicker">Challenge</p>
        <h2 className="chal-name">{challenge.name}</h2>
      </header>

      <p className="chal-brief">{challenge.brief}</p>

      <ul className="chal-goals">
        {result.goals.map((g) => (
          <li key={g.goal.metric} className={`chal-goal${g.met ? ' is-met' : ''}`}>
            <span className="chal-goal-name">
              {LABEL[g.goal.metric] ?? g.goal.metric}
            </span>
            <span className="num chal-goal-actual">
              {format(g.goal.metric, g.actual)}
            </span>
            <span className="label chal-goal-target">
              needs {format(g.goal.metric, g.goal.max)} or less
            </span>
          </li>
        ))}
      </ul>

      {result.passed ? (
        <>
          <p className="chal-verdict">Passed. The design meets every condition.</p>
          {/* The explanation arrives only now. Shown from the start it is the
              answer, and the brief stops being one; withheld until the reader
              has already worked it out, it is the difference between passing
              and understanding, which is the whole point of the exercise. */}
          <p className="chal-lesson">{challenge.lesson}</p>
        </>
      ) : (
        <div className="chal-help">
          {shown.map((text, i) => (
            <p key={i} className="chal-hint">
              {text}
            </p>
          ))}
          {shown.length < challenge.hints.length ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost chal-more"
              onClick={() => setShown(challenge.hints.slice(0, shown.length + 1))}
            >
              {shown.length === 0 ? 'Give me a hint' : 'Another hint'}
            </button>
          ) : null}
        </div>
      )}

      <button type="button" className="btn btn-sm chal-exit" onClick={onGiveUp}>
        {result.passed ? 'Done' : 'Leave the challenge'}
      </button>
    </section>
  );
}
