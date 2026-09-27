import { NODE_KINDS } from '../../src/clipboard';
import { GLOSSARY_BY_ID, type GlossaryEntry } from '../../src/content/glossary';
import { makeNode } from '../../src/sim/presets';
import type { NodeKind } from '../../src/sim/types';

/** Where a kind's glossary entry lives, when its id is not the kind itself. */
const GLOSSARY_ID: Partial<Record<NodeKind, string>> = {
  lb: 'load-balancer',
  db: 'database',
  replica: 'read-replica',
  ratelimiter: 'rate-limiter',
};

export function glossaryFor(kind: NodeKind): GlossaryEntry | undefined {
  return GLOSSARY_BY_ID.get(GLOSSARY_ID[kind] ?? kind);
}

export function defaultLabel(kind: NodeKind): string {
  return makeNode(kind, 0, 0).label;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every name a model might reach for, per kind: the kind, the label the
 * canvas gives it, and the glossary's term and aliases. So 'loadbalancer',
 * 'Load Balancer' and 'database' all lead back to a real kind.
 */
const NAMES = new Map<string, NodeKind>();
for (const kind of NODE_KINDS) {
  const entry = glossaryFor(kind);
  for (const name of [
    kind,
    defaultLabel(kind),
    entry?.term,
    ...(entry?.aliases ?? []),
  ]) {
    if (name && !NAMES.has(squash(name))) NAMES.set(squash(name), kind);
  }
}

export function suggestKind(word: string): NodeKind | null {
  const s = squash(word);
  return NAMES.get(s) ?? NAMES.get(s.replace(/s$/, '')) ?? null;
}
