# Contributing to Breakscale

Thanks for taking the time. Breakscale is a teaching tool, so the bar for a change is not only
"does it work" but "does it help someone understand distributed systems better".

Do not worry if you get any of the process below wrong, or if you have not contributed to a
project before. Say so and we will help. A lot of the people this tool is built for are students,
and the same goes for the people building it.

## Before you start

**Found something small and obvious?** Send the pull request. No ceremony needed.

**Want to add a component, a preset, or anything touching the engine?** Open an issue first and
describe the approach. It takes a few minutes and it saves you writing something that then has to
be rewritten.

**Want to work on an existing issue?** Comment on it and it will be assigned to you, so two people
do not build the same thing. You do not have to wait for the assignment to land before you start,
it is there to stop collisions rather than to gate you.

Issues carry labels that say what they are and roughly where they live. `good first issue` means
what it says: each one names the file and usually the line the fix probably belongs on, so you are
not hunting for the starting point. `help wanted` is a real task that is not beginner-sized.
`discussion` means the approach is not settled and code is premature, so comment before you build.
The `area:` labels (`area:sim`, `area:canvas`, `area:metrics`, `area:presets`, `area:content`) tell
you which part of the codebase you would be in.

Issues are triaged roughly weekly. If something sits longer than that, a nudge on the thread is
welcome rather than annoying.

## Getting set up

You need [Bun](https://bun.sh). Node 20 or newer also works if you prefer npm.

Fork the repo on GitHub first, then:

```bash
git clone https://github.com/YOUR-USERNAME/breakscale.git
cd breakscale
bun install
bun dev
```

The app runs at http://localhost:5173.

Work on a branch rather than on `main`, and point `main` at this repository so you can keep it
current without your fork drifting:

```bash
git remote add upstream https://github.com/xevrion/breakscale.git
git fetch upstream
git branch --set-upstream-to=upstream/main main
git checkout -b your-branch-name
```

Useful commands:

| Command          | What it does                       |
| ---------------- | ---------------------------------- |
| `bun dev`        | Start the dev server               |
| `bun run build`  | Typecheck and build for production |
| `bun run test`   | Run the test suite                 |
| `bun run lint`   | Lint                               |
| `bun run format` | Format with Prettier               |

## Checks run automatically

Two git hooks are installed when you run `bun install`:

- **On commit**, staged files are formatted with Prettier. You cannot commit badly formatted code.
- **On push**, the full CI suite runs locally: typecheck, lint, format, tests. If any of it fails
  the push is blocked, with the failure printed.

This mirrors the checks in `.github/workflows/ci.yml`, with one gap: the hook runs on your machine
only, while CI also runs the tests and the build on Windows. A push that is green locally can still
turn CI red if a change is sensitive to path separators or drive letters. If you ever need to
bypass a hook deliberately, `git push --no-verify` works, but expect CI to catch whatever the hook
would have.

## How the project is laid out

```
src/sim/         the simulation engine. No React, no DOM, no I/O
src/components/  canvas, inspector, metrics, palette
src/content/     glossary text
src/App.tsx      shell: layout, the animation loop, persistence
```

The important boundary is that `src/sim` knows nothing about the UI. It is a pure discrete-event
simulator you can drive from a script, which is what makes it testable.

## The one rule that matters most

**The numbers have to be true.**

This is a simulator people learn from. If a student watches p99 climb as utilisation passes 80
percent, that has to be because the simulation actually queued requests and measured their
latency, not because something approximated a curve that looks about right.

In practice that means:

- Latency percentiles come from measured request latencies, never from a mean times a constant.
- A component that has no meaningful value for a metric shows something else, or nothing. It does
  not show a plausible looking number.
- If you cannot verify a behaviour with a script that prints real output, it is not finished.

There is a lot of scaffolding in the repo for this. Look at how existing components are verified
before adding one.

## Adding a component

Components live in a registry, so the event loop has no per-kind branching. Adding one means:

1. Add the kind to `NodeKind` in `src/sim/types.ts`.
2. Add any config fields it genuinely needs, each with a doc comment stating meaning and units.
3. Write a behaviour object in the matching `src/sim/behaviour-*.ts` file.
4. Add a `defaultConfig` entry and a label.
5. Give it a readout in `readoutFor` in `src/components/Canvas.tsx`. Show what an engineer would
   actually watch for that component. Never show a field that is structurally always zero for it.
6. Add a glossary entry in `src/content/glossary.ts` explaining what it is and why it matters.
7. Write a test that proves it behaves differently from everything else.

That last point is the real bar. A component that is just an existing one with different default
numbers should not be added; it makes the palette longer without teaching anything new.

## Adding a preset

Presets are the main teaching surface, so they get held to a standard:

- It must isolate **one** lesson, and the description should say what to watch.
- It must be stable at its default load, with an error rate under about two percent.
- It must visibly degrade at two to four times that load, and the bottleneck should be the one the
  lesson is about.
- No overlapping nodes. Check the current `NODE_W` and `NODE_H` and space accordingly.

Do the arithmetic before tuning by feel: a node's ceiling is
`capacity * instances * (1000 / serviceMs)` requests per second.

## Writing for students

The audience is a first-year CS student who has not taken a queueing theory course.

- Plain language. "Requests waiting in line" beats `queueLimit`.
- Sentence case for labels.
- No abbreviations a beginner would not know, unless the glossary explains them.
- Explain why something matters, not only what it is. A metric someone cannot act on is trivia.
- No em dashes. Use a comma, a semicolon, or a second sentence.

## Design constraints

The interface follows a few rules that exist because breaking them made earlier versions look
generated rather than designed:

- No emoji in the interface.
- No glassmorphism, gradient text, or glowing shadows.
- Colour carries meaning. Component colours identify a kind; the status colours mean a metric is in
  trouble. Neither is decoration.
- Every number renders in the mono stack with tabular figures.
- Interactive transitions only, 120 to 200 milliseconds. No entrance animations on content.
- All colour comes from tokens in `src/index.css`. No hardcoded hex anywhere else.
- Text must meet WCAG AA contrast. Compute the ratio rather than eyeballing it.

## Pull requests

- One logical change per pull request. If you find an unrelated bug, mention it in an issue.
- Say what the change does and why. If it changes behaviour, include before and after numbers.
- For anything visible, include a screenshot.
- Run `bun run build` and `bun run test` before opening. Use `bun run test`, not `bun test`: the
  latter bypasses the jsdom setup and reports failures that are not real.

For a new feature or anything touching the engine's architecture, open an issue first and describe
the approach. It saves you writing something that then needs rewriting.

### The title

Pull requests are squash-merged, so the title becomes the commit message on `main` and there is a
CI check that enforces its shape. Start it with one of these:

`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Scopes are optional. This is a single package, so requiring them would be friction for nothing.
`fix: the minimap viewport shrinks when you pan away` and `fix(test): resolve ROOT with
fileURLToPath` are both fine.

Write the subject as a plain statement of what changed, lowercase after the prefix, no trailing
full stop. Look at `git log` for the house style; it leans towards saying what a reader gets rather
than which function moved.

### What happens after you open it

If this is your first pull request here, the checks will sit waiting for a status that never
arrives, until a maintainer approves them. That is GitHub's gate on fork pull requests, not
something you did wrong, and it is usually cleared the same day. After your first merged pull
request they run automatically from then on.

There are four checks: `check` (typecheck, lint, format, tests, build), `CodeQL`, `semantic` for
the title, and a Vercel deploy. The Vercel one reports a failure on pull requests from forks
because it will not build a fork branch without authorisation, so ignore that one; it is not about
your code.

If a review asks for changes, push follow-up commits rather than amending and force-pushing. The
squash-merge flattens them anyway, and it lets the reviewer see what moved since they last looked.

## Reporting bugs

Include what you did, what you expected, and what happened. If it involves the simulation, the
preset name and the load you were running at are usually enough to reproduce it.

One thing worth knowing before reporting that the simulation has frozen: browsers suspend
animation frames in background tabs, so an unfocused tab genuinely stops simulating and every
number reads zero. Check the tab is focused first.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
