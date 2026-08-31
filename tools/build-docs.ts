/**
 * Generate the documentation site's example pages into the docs repository.
 *
 *   bun run tools/build-docs.ts ../breakscale-docs
 *
 * The docs live in their own repository so that the simulator's own repo does
 * not have to grant a docs host push access, but the CONTENT belongs to this
 * one, because it is generated from the presets and measured by the engine.
 * Running this after a preset changes is what keeps the two honest, and the
 * pages say in their own text that the numbers were measured rather than
 * written down.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS } from '../src/sim/presets.ts';
import { writeExamplePages } from './example-pages.ts';

const target = process.argv[2];
if (!target) {
  console.error('usage: bun run tools/build-docs.ts <path-to-docs-repo>');
  process.exit(1);
}

const ids = writeExamplePages(join(target, 'examples'));

/**
 * Put the examples in the navigation, leaving everything else in docs.json
 * exactly as it was. Rewritten rather than hand-edited so that adding a
 * preset does not mean remembering to add a line here as well.
 */
const configPath = join(target, 'docs.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  navigation: { pages: unknown[] };
};

const group = {
  group: 'Examples',
  pages: ids.map((id) => `examples/${id}`),
};

const pages = config.navigation.pages.filter(
  (p) =>
    !(
      typeof p === 'object' &&
      p !== null &&
      (p as { group?: string }).group === 'Examples'
    ),
);
config.navigation.pages = [...pages, group];
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(`wrote ${ids.length} example pages to ${join(target, 'examples')}`);
console.log(`presets: ${PRESETS.length}`);
