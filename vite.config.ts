import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
