/*
 * Put jsdom's localStorage back.
 *
 * Node 26 defines `localStorage` on globalThis as a getter that returns
 * undefined unless the process was started with --localstorage-file. Vitest's
 * jsdom environment refuses to install any global the runtime has already
 * defined, and localStorage is on neither its built-in key list nor the
 * per-environment additions, so jsdom's own Storage never lands and every test
 * that reads or writes it fails with "Cannot read properties of undefined". A
 * `// @vitest-environment jsdom` pragma cannot help, because the environment is
 * not what is missing: document and the rest are all there.
 *
 * Vitest keeps the JSDOM instance on `globalThis.jsdom` and deletes it again at
 * teardown, so reading through it is what keeps this honest. A getter rather
 * than a fixed value because a worker runs many files: a value captured from
 * one jsdom file would still be sitting here, backed by a closed window, when
 * the next file runs. Resolving on every read gives each jsdom file its own
 * Storage, and gives the node environment undefined, which is what it has
 * today.
 *
 * sessionStorage is left alone: Node's built-in one works without a flag, so it
 * is the wrong object rather than a missing one, and no test depends on it.
 */
Object.defineProperty(globalThis, 'localStorage', {
  get: () =>
    (globalThis as { jsdom?: { window: { localStorage: unknown } } }).jsdom?.window
      .localStorage,
  configurable: true,
});
