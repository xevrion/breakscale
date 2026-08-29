/**
 * No em dashes in anything a reader sees.
 *
 * AGENTS.md puts this under Copy: "No em dashes. Use a comma, a semicolon, or
 * a second sentence." The glossary already had its own assertion, which is
 * why the one that shipped was in a component instead: an empty state reading
 * "Nothing to measure yet — add a component to get started."
 *
 * This covers the rest of the interface. Comments are exempt, deliberately:
 * the rule is about the voice the product speaks in, and index.css alone
 * carries dozens of em dashes in prose written for whoever edits it next.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every .tsx under src, minus tests. */
function componentFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) componentFiles(path, out);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
      out.push(path);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Both block forms go first, `{/* ... *\/}` included, because a JSX comment is
 * a block comment inside an expression container and the outer braces would
 * otherwise survive and confuse nothing, but the prose inside them would.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));

describe('interface copy', () => {
  it('uses no em dashes outside comments', () => {
    const offenders: string[] = [];
    for (const file of componentFiles(ROOT)) {
      const lines = withoutComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (line.includes('—')) {
          offenders.push(
            `${file.slice(ROOT.length)}:${i + 1} ${line.trim().slice(0, 80)}`,
          );
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
