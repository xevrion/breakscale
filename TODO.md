# TODO

## Now

- [x] Annotate the 23 examples with sections and notes
- [x] Pen / touch / smartboard input
- [x] Canvas notes and sections (built, and used by all 23 examples)

## Before going public

- [x] Deploy (breakscale.vercel.app)
- [x] Custom domain (breakscale.tech, on Cloudflare DNS)
      Registrar Namify, nameservers cora/koa.ns.cloudflare.com, A records for
      apex and www at 76.76.21.21, DNS only (NOT proxied: Vercel needs a
      direct connection to issue its certificate). SPF and DMARC set to
      reject, since the domain sends no mail. SITE_ORIGIN is set in Vercel
      production and every host reference derives from tools/site.ts.
- [x] Logo + favicon
- [x] OG image
- [x] README banner (screenshots still to come)
- [x] Seed 5-10 good-first-issues
- [x] Enable Discussions
- [ ] Delete TODO.md
- [x] Flip repo public

## SEO / AEO

The honest framing, because it changes what is worth doing. Google's own AI
optimization guide says GEO and AEO are rebranded labels for ordinary SEO, and
that it ignores llms.txt outright. So there is no separate AI checklist to
work through, there is one pile of fundamentals that happens to feed both.

Ranking first for "system design" is not reachable and chasing it wastes the
effort. Educative, ByteByteGo, DesignGurus and system-design-primer (330k
stars) hold those queries with years of authority behind them. What is open is
the set of queries nobody has answered well: "system design simulator",
"visualize a retry storm", "what does p99 latency actually look like",
"simulate a thundering herd". Breakscale is the best answer to those and the
only one that runs the experiment.

- [x] Meta tags, og:, twitter:
- [x] robots.txt
- [x] sitemap.xml
- [x] canonical + og:url
- [x] JSON-LD: SoftwareApplication, LearningResource
- [x] Glossary as crawlable HTML, not locked in the bundle
- [x] Glossary served at /glossary, not just /glossary.html
      It was 404ing in production while the sitemap advertised it, so the one
      page with 4,828 words of crawlable prose was invisible and the sitemap
      pointed at a dead URL. A rewrite in vercel.json fixes it.

- [ ] Static landing content (LOW priority, and here is why)
      The app renders nothing without JavaScript: curl the home page and the
      body is empty. That sounds fatal until you check the thing we are
      modelling ourselves on. Excalidraw serves ten words and a "You need to
      enable JavaScript to run this app" message, has no JSON-LD at all, and
      its robots.txt says `Allow: /$`, which permits only the root. They rank
      anyway.
      So this is not what stands between us and being found, and it is days of
      work. We already beat them on every technical measure that can be
      audited: three schema types to their zero, a 4,828-word crawlable
      glossary to their nothing, a full sitemap to their unreferenced one.
      What actually carries Excalidraw is nine years, 105k stars, a Wikipedia
      entry, an npm package embedded everywhere, and constant Reddit and
      YouTube mentions. Brand mentions correlate roughly 3x more strongly with
      AI citation than backlinks do. That is won by the launch posts, the open
      issues and the contributors, not by a renderer.

- [ ] Per-example pages, one static page per preset
      23 presets, each with a topology, a lesson, and numbers from an actual
      simulation. Worth doing, but for the right reason: not as schema fodder,
      as the sort of page someone links to from a Reddit thread about retry
      storms. Content nobody else has, aimed at questions nobody answers well.
      Generate them the way tools/glossary-page.ts already generates the
      glossary so they cannot drift from the presets.

- [ ] Verify the domain in Google Search Console and submit the sitemap
      DNS verification via a Cloudflare TXT record is the least fragile
      method. Then submit https://breakscale.tech/sitemap.xml and request
      indexing on the home page and the glossary.
      Bing Webmaster Tools too: Copilot cites the Bing index, and Bing can
      import the Search Console property directly.

- [ ] Run the SEO / AEO skills (/seo-audit, /seo-geo, /seo-schema) for a full
      pass. AFTER the custom art lands, not before: the audit checks the OG
      image, favicon and logo, so running it against the code-drawn
      placeholders would just generate findings that the real assets fix.
- [ ] Replace the generated art with custom OG image, favicon and logo
      Redrawn in code around the knee curve, derived from M/M/1 rather than
      styled by eye. Keep if it holds up, otherwise hand-make.
- [ ] Screenshots for the README (a retry storm collapsing is the one to get)
- [ ] Per-example pages
- [x] llms.txt

## Save / share (excalidraw parity)

- [x] Design persists to localStorage, restores on reload
- [x] Export to file (.breakscale)
- [x] Import from file, drag-and-drop onto the canvas
- [x] Export as PNG / SVG
- [x] Share link: topology encoded in the URL hash, read-only for the recipient
- [x] Named saves, a list of your own designs
- [ ] Live collaboration (later, maybe)

## UI ideas (from a competitor's build, worth taking)

- [x] Search box over the 33 components
- [x] Adjustable size for the rail, the inspector and the charts strip
- [x] A visible button to bring the diagram back on screen
- [x] Minimap for large diagrams (off by default, toggle in Settings)
- [x] Name the design + a "saved" indicator, so people know work persists
- [ ] Canvas toggles surfaced in the inspector: snap, grid, minimap, edge labels
- [ ] Component count by category ("3 network, 2 database")
- [ ] Baseline rate x pattern multiplier, clearer than a raw slider

## Product

- [x] Cloud vendor mode: AWS / GCP / Azure / generic
  - [x] Vendor names per component (Database -> RDS / Cloud SQL / Azure SQL)
  - [x] Real instance classes and their actual limits (db.r6g.large, n2-standard-4)
  - [x] Defaults derived from published specs, cited in the source
  - [x] Picker in preferences, generic stays the default
  - [x] Vendor pricing gathered and cited (43 hourly prices, all sourced)
- [ ] Challenges ("5k rps under 200ms p99")
- [x] Request tracer (queued vs service time)
- [x] Cost model
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
