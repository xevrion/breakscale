import { readFile, writeFile } from 'node:fs/promises';
import { buildReadme, extractFieldDocs } from '../src/readme';

// Rendered at build time: the setting descriptions are read out of the
// engine's own source, which the bundled server no longer has.
const types = await readFile(
  new URL('../../src/sim/types.ts', import.meta.url),
  'utf8',
);
await writeFile(
  new URL('../dist/readme.md', import.meta.url),
  buildReadme(extractFieldDocs(types)),
);
