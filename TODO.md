# TODO

## Now

- [ ] Pen / touch / smartboard input
- [ ] Canvas notes and sections (model exists, no UI)

## Before going public

- [x] Deploy (breakscale.vercel.app)
- [ ] Custom domain (breakscale.dev?)
- [x] Logo + favicon
- [x] OG image
- [ ] README banner + screenshots
- [ ] Seed 5-10 good-first-issues
- [x] Enable Discussions
- [ ] Delete TODO.md
- [x] Flip repo public

## SEO / AEO

- [x] Meta tags, og:, twitter:
- [x] robots.txt
- [x] sitemap.xml
- [x] canonical + og:url
- [x] JSON-LD: SoftwareApplication, LearningResource
- [ ] Glossary as crawlable HTML, not locked in the bundle
- [ ] Per-example pages
- [x] llms.txt

## Save / share (excalidraw parity)

- [x] Design persists to localStorage, restores on reload
- [ ] Export to file (.breakscale.json)
- [ ] Import from file, drag-and-drop onto the canvas
- [ ] Export as PNG / SVG
- [ ] Share link: topology encoded in the URL hash, read-only for the recipient
- [ ] Named saves, a list of your own designs
- [ ] Live collaboration (later, maybe)

## UI ideas (from a competitor's build, worth taking)

- [ ] Search box over the 33 components
- [ ] Minimap for large diagrams
- [ ] Name the design + a "saved" indicator, so people know work persists
- [ ] Canvas toggles surfaced in the inspector: snap, grid, minimap, edge labels
- [ ] Component count by category ("3 network, 2 database")
- [ ] Baseline rate x pattern multiplier, clearer than a raw slider

## Product

- [ ] Cloud vendor mode: AWS / GCP / Azure / generic
  - [ ] Vendor names per component (Database -> RDS / Cloud SQL / Azure SQL)
  - [ ] Real instance classes and their actual limits (db.r6g.large, n2-standard-4)
  - [ ] Defaults derived from published specs, cited in the source
  - [ ] Picker in preferences, generic stays the default
  - [ ] Vendor pricing, feeds the cost model below
- [ ] Challenges ("5k rps under 200ms p99")
- [ ] Request tracer (queued vs service time)
- [ ] Cost model
- [ ] Traffic scenarios: ramp, spike, diurnal, thundering herd
- [ ] Networking layer (bandwidth + loss; latency already works)

## Bugs / gaps

- [ ] Safari pinch broken (uses gesturestart, not ctrl+wheel)
- [ ] Lint warnings in App.tsx, Glossary.tsx, Metrics.tsx
- [ ] No visual regression tests
- [ ] Never tested on real smartboard or tablet

## Done

- [x] MIT, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, templates
- [x] CI + pre-push hooks, 23 labels, repo description and topics
- [x] Engine: 33 components, 23 examples, 372 tests
- [x] Undo/redo, canvas shortcuts, edge routing, floating panels
- [x] Light theme, Lucide icons, icon transport controls
- [x] Responsive 2560 down to 960
- [x] Glossary (100 terms) + tooltips, off by default
