# TODO

## Now

- [x] Annotate the 23 examples with sections and notes
- [x] Pen / touch / smartboard input
- [x] Canvas notes and sections (built, and used by all 23 examples)

## Before going public

- [x] Deploy (breakscale.vercel.app)
- [x] Custom domain (breakscale.tech)
      Every host reference derives from tools/site.ts, so moving origin is one
      environment variable rather than a search and replace.
- [x] Logo + favicon
- [x] OG image
- [x] README banner (screenshots still to come)
- [x] Seed 5-10 good-first-issues
- [x] Enable Discussions
- [ ] Delete TODO.md
- [x] Flip repo public

## SEO / AEO

Search and AI-answer visibility are the same work: ordinary SEO fundamentals,
applied once. Target the queries this tool actually answers (system design
simulator, retry storms, latency percentiles under load) rather than the broad
system-design terms that established course sites already hold.

- [x] Meta tags, og:, twitter:
- [x] robots.txt
- [x] sitemap.xml
- [x] canonical + og:url
- [x] JSON-LD: SoftwareApplication, LearningResource
- [x] Glossary as crawlable HTML, not locked in the bundle
- [x] Serve the glossary at /glossary, not only /glossary.html
      It 404'd in production while the sitemap advertised it. Fixed with a
      rewrite in vercel.json.
- [x] Verify the domain in Google Search Console, submit the sitemap
      Verified by DNS. Sitemap read the same day, both pages discovered.
- [x] Redirect www and the old deployment URL to the apex (308)
- [ ] Bing Webmaster Tools; it can import the Search Console property.
      Worth doing because Copilot cites the Bing index, which is separate
      from Google's.
- [ ] Per-example pages, one per preset
      23 presets, each with a topology, a lesson, and measured numbers.
      Generate them the way tools/glossary-page.ts generates the glossary so
      they cannot drift from the presets.
- [x] A title that matches what people search for
- [x] Serve /favicon.ico as well as the SVG
      Clients request that path by convention whatever the HTML declares, so
      an SVG-only setup left it 404ing and the search result showing a
      placeholder. Also added an apple-touch-icon.
- [ ] Static landing content
      The app is a client-rendered SPA, so a crawler sees an empty body. The
      glossary carries the only crawlable prose on the site, and it is not
      the page that would rank for "system design simulator". Measured
      against what currently ranks for that query, this is the gap.
- [ ] Replace the generated art with custom OG image, favicon and logo
      Hand-made rather than drawn in code.
- [ ] Run the SEO / AEO skills for a full pass, after the custom art lands
      The audit checks the OG image, favicon and logo, so running it against
      placeholders would only produce findings the real assets fix.

## Save / share (parity with the canvas tools people expect)

- [x] Design persists to localStorage, restores on reload
- [x] Export to file (.breakscale)
- [x] Import from file, drag-and-drop onto the canvas
- [x] Export as PNG / SVG
- [x] Share link: topology encoded in the URL hash, read-only for the recipient
- [x] Named saves, a list of your own designs
- [ ] Live collaboration (later, maybe)

## Interface

- [x] Search box over the 33 components
- [x] Adjustable size for the rail, the inspector and the charts strip
- [x] A visible button to bring the diagram back on screen
- [x] Minimap for large diagrams (off by default, toggle in Settings)
- [x] Name the design + a "saved" indicator, so people know work persists
- [ ] Toggle snap to grid with a key (#28)
      The inspector turned out to be the wrong home for these: it is not
      rendered at all when nothing is selected, so there was nowhere reachable
      to put them. Minimap and sparklines are set-once preferences and stay in
      Settings; snap is the one you reach for mid-drag, so it gets a key.
- [x] Component count by category ("3 network, 2 database")
- [ ] Baseline rate x pattern multiplier, clearer than a raw slider

## Product

- [x] Cloud vendor mode: AWS / GCP / Azure / generic
  - [x] Vendor names per component (Database -> RDS / Cloud SQL / Azure SQL)
  - [x] Real instance classes and their actual limits (db.r6g.large, n2-standard-4)
  - [x] Defaults derived from published specs, cited in the source
  - [x] Picker in preferences, generic stays the default
  - [x] Vendor pricing gathered and cited (43 hourly prices, all sourced)
- [x] Challenges: design a system to meet a stated requirement (#27)
      Four briefs, each an existing preset with a load and a goal attached.
      Hints are asked for rather than volunteered, and the lesson only shows
      once you pass. Blank-canvas briefs and a budget ceiling are on the issue.
- [x] Request tracer (queued vs service time)
- [x] Cost model
- [ ] Traffic scenarios: ramp, spike and diurnal are in the engine and
      tested; they still need a control in the inspector. Thundering herd is
      not started, and is correlated arrivals rather than a rate curve.
- [ ] Networking layer (bandwidth + loss; latency already works)

## Bugs / gaps

- [ ] Safari pinch zoom (#9)
- [ ] Lint warnings in App.tsx, Glossary.tsx, Metrics.tsx
- [ ] Visual regression tests (#14)
- [ ] Never tested on real smartboard or tablet

## Done

- [x] MIT, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, templates
- [x] CI + pre-push hooks, 23 labels, repo description and topics
- [x] CI runs the tests and the build on Windows as well as Linux (#18)
- [x] Engine: 33 components, 23 examples
- [x] Undo/redo, canvas shortcuts, edge routing, floating panels
- [x] Light theme, Lucide icons, icon transport controls
- [x] Responsive 2560 down to 960
- [x] Glossary (100 terms) + tooltips, off by default
