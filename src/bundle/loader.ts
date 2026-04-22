// Bundle loader. Reads a harness bundle's manifest + tier-3 state into
// memory. Tier-1 (business) content is loaded lazily via getBusinessDoc().
//
// This is the Sovereign AI-specific interface to the docs repo or a
// client's extracted bundle.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Bundle, BundleIndex } from './types.js';

const READ_IF_EXISTS = async (p: string): Promise<string | null> => {
  if (!existsSync(p)) return null;
  return readFile(p, 'utf8');
};

/**
 * Load a harness bundle from disk. Eagerly loads manifest and tier-3 state
 * (memory + CONTEXT); leaves tier-1 business content unloaded until a
 * specific doc is requested.
 *
 * Phase 0: loads index + state. Phase 1: used to populate the system prompt.
 * Phase 6: invalidation on file changes.
 */
export async function loadBundle(rootPath: string): Promise<Bundle> {
  const root = resolve(rootPath);
  const indexPath = join(root, 'index.yaml');
  if (!existsSync(indexPath)) {
    throw new Error(`No index.yaml at ${indexPath} — is this a harness bundle root?`);
  }
  const indexText = await readFile(indexPath, 'utf8');
  const index = parseYaml(indexText) as BundleIndex;

  const state = {
    context: await READ_IF_EXISTS(join(root, 'state/CONTEXT.md')),
    preferences: await READ_IF_EXISTS(join(root, 'state/memory/preferences.md')),
    decisionsMade: await READ_IF_EXISTS(join(root, 'state/memory/decisions-made.md')),
    sessionLog: await READ_IF_EXISTS(join(root, 'state/memory/session-log.md')),
  };

  const schemaPaths = {
    entity: join(root, 'harness/schemas/entity.json'),
    decision: join(root, 'harness/schemas/decision.json'),
    openQuestion: join(root, 'harness/schemas/open-question.json'),
    tags: join(root, 'harness/schemas/tags.yaml'),
  };

  return {
    root,
    index,
    business: new Map(),
    state,
    schemaPaths,
  };
}

/**
 * Tail-read the session log. Returns the last N entries (rough heuristic:
 * split on '\n## ' headings). Phase 0: placeholder — returns whole file.
 */
export function tailSessionLog(bundle: Bundle, _n = 5): string {
  return bundle.state.sessionLog ?? '';
}
