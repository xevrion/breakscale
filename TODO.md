# Breakscale TODO

Working list. Delete or move to issues before the repo goes public.

Status as of the last update: **33 components, 23 examples, 100 glossary terms, 372 tests
passing**, CI green, repo `xevrion/breakscale` still **private**.

---

## In flight

- [ ] **Pen, touch and smartboard input.** No `pointerType` handling exists today, so every
      gesture is treated as a mouse: the 4px drag threshold is wrong for fingers and pens, there
      is no pinch-zoom or two-finger pan (the only navigation on a smartboard), no palm rejection,
      and `pointercancel` is unhandled so a browser-stolen gesture stays armed forever.
- [ ] **Canvas notes and sections.** The model is committed and tested in `src/sim/annotations.ts`
      and wired into no UI at all. Notes are free text; sections are labelled frames drawn around a
      group, the eraser.io pattern.

---

## Launch blockers

Things that must be true before the repo goes public.

- [ ] **Deploy it.** Nothing is hosted. This is the highest-leverage item left: every part of the
      open-source funnel assumes a live URL, and it turns a bug report from "clone and run" into
      "click and see". A static Vite build on GitHub Pages is one workflow file. Decide between
      Pages, Vercel and Netlify; Pages is enough for a client-side app with no backend.
- [ ] **Domain.** `breakscale.dev` or `.app` if free. Not required to launch, but the README, the
      OG tags and the repo homepage all want a stable URL, and changing it later means editing all
      three plus any links people have shared.
- [ ] **Flip the repo to public.** Everything else in this section should land first.
- [ ] **Delete `NEXT.md` and this file**, or convert the surviving items to issues.
- [ ] **Remove `public/__harness.js`** from the working tree. It is gitignored so it will not ship,
      but it should not sit in `public/` where Vite copies it into `dist/`.

## Images and identity

- [ ] **Logo.** Nothing exists; `public/favicon.svg` is a placeholder. Needs to work at 16px in a
      browser tab and large on a README banner. The name is literal enough that a mark showing
      something breaking under load would read immediately.
- [x] Social meta tags: `og:type`, `og:site_name`, `og:title`, `og:description`, `twitter:card`,
      `twitter:title`, `twitter:description`
- [ ] **OG image itself.** The tags are in place but `og:image` is deliberately absent, because
      pointing it at a file that does not exist is worse than omitting it: a broken image is what
      gets cached. Needs a real 1200x630 image, then the tag. `og:url` also waits on the domain.
- [ ] **README banner.** Excalidraw leads with a hyperlinked banner and a product screenshot, and
      for a visual tool the screenshot persuades more than any paragraph. A 10 second GIF of a
      retry storm collapsing would do more than either.
- [ ] **Screenshots for the README**, showing a company architecture under load. The Discord and
      Netflix examples are the most striking.

## SEO and AEO

The whole point is that a student searching "why does p99 spike at 80% utilisation" finds a tool
that shows them, so this is worth real effort rather than boilerplate.

- [x] Meta tags: title, description, `og:`, `twitter:`. `canonical` and `og:url` wait on a domain.
- [x] `robots.txt`
- [ ] **`sitemap.xml`.** Waits on the domain, since it needs absolute URLs. The `Sitemap:` line is
      already stubbed in `robots.txt`.
- [ ] **Structured data**: `SoftwareApplication` JSON-LD, plus `LearningResource` which fits a
      teaching tool and almost nobody in this space uses.
- [ ] **AEO / answer-engine visibility.** The glossary is 100 entries of genuinely quotable
      plain-language explanation, each written as a definition plus why it matters. That is exactly
      the shape an AI answer cites. Consider rendering the glossary as crawlable HTML at a stable
      URL rather than leaving it locked inside the bundle, where no crawler will ever read it.
- [ ] **Per-example pages, eventually.** 23 examples, each teaching one named failure mode, is 23
      pages of long-tail search intent ("retry storm", "hot shard", "thundering herd"). Only worth
      doing after the app is deployed and the routing exists.
- [ ] **`llms.txt`.** Cheap, and this is the kind of tool an AI would usefully point someone at.

## Repo and community

- [x] MIT licence, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY
- [x] Issue templates (bug asks for preset and load, which is what actually reproduces a sim bug)
      and a PR template
- [x] CI: typecheck, lint, format, test, build, with actions pinned to commit SHAs
- [x] Pre-commit and pre-push hooks mirroring CI
- [x] 23 labels including `sim-accuracy` for "a number the simulator shows is wrong"
- [x] Repo description and 10 topics
- [ ] **Seed good-first-issues.** The strongest finding from the Excalidraw research: their
      maintainers write the good-first-issues themselves _with a pointer to where the fix lives_.
      One sentence like "the fix is probably in `behaviour-edge.ts` near the token refill" turns a
      scary codebase into an afternoon task. Five to ten of these matter more than any template.
- [ ] **Enable Discussions**, so support questions have somewhere to go that is not the bug tracker.
- [ ] **First tagged release.** Stay on 0.x. Excalidraw is six years and 130k stars in at v0.18.
      Say in the README what 1.0 would mean; probably "saved topologies will always load".

## Product

- [ ] **Challenges.** "Serve 5k rps under 200ms p99 within a budget." The engine already exposes
      everything needed to evaluate a goal against a real snapshot.
- [ ] **Request tracer.** Show one request's path and timing through the system, with queued time
      visually separated from service time. That distinction is the entire lesson about why latency
      grows under load, and nothing in the app teaches it directly yet.
- [ ] **Cost model.** Per-component monthly cost, so a design can be argued about on price as well
      as latency.
- [ ] **Traffic scenarios**: ramp, spike, diurnal, thundering herd, instead of only a manual slider.
- [ ] **Networking layer.** `SimEdge` already carries optional `latencyMs`, `bandwidthRps` and
      `lossRate`; only latency is implemented. The other two are the seam a real networking phase
      grows into. Deliberately deferred.

## Known gaps and smaller things

- [ ] Safari trackpad pinch uses proprietary `gesturestart` and `gesturechange` events, not
      ctrl+wheel. A comment in `Canvas.tsx` still claims otherwise, so pinch is dead on Safari.
- [ ] Lint warnings in `App.tsx`, `Glossary.tsx` and `Metrics.tsx` (`set-state-in-effect`,
      `exhaustive-deps`). Warnings, not errors, so CI passes, but they are real smells.
- [ ] No visual regression testing. Given how much of this project is layout, screenshot diffing
      would have caught several bugs that took a person noticing them.
- [ ] The app has never been used on an actual smartboard or drawing tablet. Simulated pointer
      events are not the same thing, and the pen work should be treated as unverified until someone
      tries it on real hardware.

---

## Done

Kept short; the git log is the real record.

- Discrete-event engine, 33 components in a behaviour registry, verified against measured numbers
- 23 examples including seven real company architectures, each stable at 1x and degrading by 4x
- Light theme with per-component colour, Lucide icons, icon transport controls
- Undo and redo with gesture-boundary commits, plus the conventional canvas shortcuts
- Edge routing that works from any geometry, with correct arrowheads
- Panels float over a canvas that never moves when they open
- Responsive from 2560 down to about 960 wide, including square and short windows
- Tooltips and a 100-term glossary, off by default
- Examples moved out of the rail into a searchable gallery
