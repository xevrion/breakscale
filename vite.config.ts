import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renderGlossaryPage } from './tools/glossary-page.ts';
import { SITE_ORIGIN } from './tools/site.ts';

/**
 * Emit /glossary as a static HTML page, generated from the same
 * `src/content/glossary.ts` the app reads.
 *
 * A hundred plain-language definitions are exactly what a search engine or an
 * AI assistant quotes, and all of them were locked inside the JS bundle where
 * a crawler sees an empty div. Generating rather than hand-writing means the
 * page cannot drift from the tooltips.
 *
 * Also served in dev, so the page can be opened and read without a build.
 */
function glossaryPage(): Plugin {
  const ROUTE = '/glossary';
  return {
    name: 'breakscale-glossary-page',
    apply: () => true,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url !== ROUTE && url !== `${ROUTE}.html` && url !== `${ROUTE}/`) {
          return next();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(renderGlossaryPage());
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        // `glossary.html` rather than `glossary/index.html`: Vercel serves
        // the clean /glossary URL for either, and one file is easier to
        // reason about than a directory holding one thing.
        fileName: 'glossary.html',
        source: renderGlossaryPage(),
      });
    },
  };
}

/**
 * Rewrite the placeholder origin in the static metadata files.
 *
 * `index.html`, `sitemap.xml`, `robots.txt` and `llms.txt` all state the site's
 * absolute URL, because a canonical link, an og:url and a sitemap entry cannot
 * be relative. Hand-editing them meant fourteen strings across seven files and
 * one of them silently left behind on the next move.
 *
 * They keep the production origin as their literal text, so the files are
 * readable and correct as they sit in the repo. This only substitutes when the
 * build is running somewhere else, which is what stops a preview deployment
 * publishing a canonical that claims to be production.
 */
function siteOrigin(): Plugin {
  const PLACEHOLDER = 'https://breakscale.vercel.app';
  const swap = (text: string) =>
    SITE_ORIGIN === PLACEHOLDER ? text : text.split(PLACEHOLDER).join(SITE_ORIGIN);

  return {
    name: 'breakscale-site-origin',
    apply: 'build',
    transformIndexHtml: swap,
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset') continue;
        if (!/\.(xml|txt|html)$/.test(file.fileName)) continue;
        if (typeof file.source !== 'string') continue;
        file.source = swap(file.source);
      }
    },
    /*
     * public/ is copied byte for byte and never enters the bundle, so
     * sitemap.xml, robots.txt and llms.txt are not reachable from
     * generateBundle above. They are rewritten on disk once the copy has
     * happened instead.
     */
    closeBundle() {
      if (SITE_ORIGIN === PLACEHOLDER) return;
      const out = resolve(process.cwd(), 'dist');
      for (const name of ['sitemap.xml', 'robots.txt', 'llms.txt']) {
        const file = resolve(out, name);
        if (!existsSync(file)) continue;
        writeFileSync(file, swap(readFileSync(file, 'utf8')));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), glossaryPage(), siteOrigin()],
  build: {
    /*
     * Split the dependencies out of the app chunk.
     *
     * React and the icon set change on a release cadence measured in months,
     * while the app changes daily. Shipping them in one file means every
     * deploy invalidates the whole download for returning visitors. Two files
     * means a returning visitor re-fetches only what actually changed.
     *
     * This is a caching win rather than a first-load one: the same bytes still
     * arrive on a cold visit. Deeper splitting was considered and rejected,
     * because the canvas, the engine and the charts are all on screen within a
     * second of load, so deferring any of them would only trade one wait for
     * another.
     */
    rollupOptions: {
      output: {
        // Rolldown takes a function here, not the object form Rollup accepted.
        manualChunks(id: string) {
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
    // The app chunk sits near the default 500kB warning. Raised so the build
    // output stays readable.
    chunkSizeWarningLimit: 600,
  },
});
