import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const REPO = resolve(import.meta.dirname, '..');

/**
 * The view a chat host draws, as ONE html file.
 *
 * A host serves the view from a resource, not from a web server, so there
 * is nowhere for a second file to be fetched from: scripts, styles and the
 * handwriting font for canvas notes are all inlined. The font is asked for
 * at `/fonts/...`, a path only the website serves, so it is aliased back to
 * the file in public/ and inlined like everything else.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'widget'),
  plugins: [react(), viteSingleFile()],
  publicDir: false,
  resolve: {
    alias: [{ find: /^\/fonts\//, replacement: `${REPO}/public/fonts/` }],
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: false,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'widget/widget.html'),
    },
  },
});
