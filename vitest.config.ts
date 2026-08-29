import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine is pure TypeScript with no DOM, so most tests need no
    // environment at all. Component tests opt into jsdom per file with a
    // // @vitest-environment jsdom pragma.
    environment: 'node',
    // Repairs localStorage for the files that opt into jsdom. See the
    // comment in vitest.setup.ts for what Node broke and why.
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/sim/**', 'src/content/**', 'src/components/format.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
