import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renderGlossaryPage } from './tools/glossary-page.ts';

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

export default defineConfig({
  plugins: [react(), glossaryPage()],
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
