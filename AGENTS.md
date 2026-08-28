# Working on Breakscale with an AI assistant

Breakscale is a discrete-event system design simulator for CS students. This file is the context an
assistant needs before touching the code. It is short on purpose; the rules that matter are few.

## The one rule

**The numbers have to be true.**

Students learn from this. If p99 climbs as utilisation passes 80 percent, that has to be because
the simulation queued real requests and measured their latency, not because something approximated
a curve that looks about right.

In practice:

- Percentiles come from measured latencies, never from a mean times a constant.
- A component with no meaningful value for a metric shows something else, or nothing. It never
  shows a plausible-looking number.
- If you cannot verify a behaviour by running a script that prints real output, it is not finished.

## Layout

```
src/sim/          the engine. No React, no DOM, no I/O
  engine.ts       the event loop
  behaviour*.ts   one behaviour object per component kind
  types.ts        the contract between engine and UI
  presets.ts      the 23 worked examples
src/components/   canvas, inspector, metrics, palette, dialogs
src/content/      glossary text, preferences
src/App.tsx       shell: layout, rAF loop, history, keybindings
```

`src/sim` knows nothing about the UI. That boundary is what makes it testable, so keep it.

## Commands

```bash
bun dev            # dev server on :5173
bun run build      # typecheck + build
bun test           # 372 tests
bun run lint
bun run format
```

A pre-push hook runs all of it. A broken tree cannot reach `main`.

## Things that will bite you

**The canvas input layer is fragile and was rebuilt after a real bug.** Pointer capture used to
happen on pointerdown, which retargeted pointerup and suppressed the browser's synthesized click,
making every overlay button inert. Preserve: `.cv-surface` owns the handlers, hit routing goes
through `data-hit` + `data-id` in one `hitTest`, capture happens only at gesture promotion in a
try/catch, and chrome is excluded via `closest('button, input, select, textarea, a, [data-chrome]')`.

**A backgrounded browser tab suspends `requestAnimationFrame`.** The simulation reads zero
everywhere and looks broken. Check `document.visibilityState` before diagnosing anything.

**Hard-reload before concluding something is broken.** A stale HMR module has caused at least one
false diagnosis here.

**Per-kind colours are a specificity trap.** `.cv-node` and `[data-kind='cache']` are both 0-1-0,
so source order decides. Never declare the `--k-*` tokens in a class rule; fallbacks belong inside
`var()`.

**Test drags with real `PointerEvent` sequences, not `.click()`.** `.click()` bypasses the exact
layer that breaks. Paced moves are also not enough: a fast three-event flick found a race that a
16ms-paced drag did not.

## Adding a component

1. Add the kind to `NodeKind` in `types.ts`
2. Config fields with doc comments stating meaning and units
3. A behaviour object in the matching `behaviour-*.ts`
4. `defaultConfig` entry and a label
5. A readout in `readoutFor` in `Canvas.tsx` showing what an engineer would actually watch. Never a
   field that is structurally always zero for that kind.
6. A glossary entry in `content/glossary.ts`
7. A test proving it behaves differently from everything else

Step 7 is the real bar. A component that is an existing one with different defaults makes the
palette longer and teaches nothing.

## Adding an example

- One lesson each, and the description says what to watch
- Stable at its default load, under about 2 percent errors
- Visibly degrades at 2-4x, and the bottleneck is the one the lesson is about
- No overlapping nodes

Do the arithmetic first: a node's ceiling is `capacity * instances * (1000 / serviceMs)` rps.

## Writing

The reader is a first-year student who has not taken a queueing theory course.

- Plain language. "Requests waiting in line" beats `queueLimit`.
- Sentence case. No unexplained abbreviations.
- Say why something matters, not only what it is.
- No em dashes. A comma, a semicolon, or a second sentence.

## Design constraints

- No emoji, glassmorphism, gradient text, or glowing shadows
- Colour carries meaning: component colours identify a kind, status colours mean trouble
- Numbers in the mono stack with tabular figures
- Interactive transitions only, 120-200ms, and `prefers-reduced-motion` disables them
- All colour from tokens in `index.css`. No hardcoded hex elsewhere.
- WCAG AA on text. Compute the ratio, do not eyeball it.

## If you are an agent working autonomously

- Verify before reporting. "I ran it and goodput plateaued at 205 rps" beats "this should work".
- Say what you did not check. A confident report on unverified work costs more than an honest gap.
- Do not commit. Leave that to the human.
- One logical change at a time.
