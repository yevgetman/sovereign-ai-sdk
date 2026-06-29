// src/learning/project.ts
// Stable per-project identity. Tries `git remote get-url origin` first;
// falls back to realpath(cwd) hash. Cached for the session lifetime so
// repeated lookups are cheap.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { tryGitProjectId } from '../util/project.js';

// `tryGitProjectId` was relocated to src/util/project.ts (open-core
// relocation); it is re-exported here so proprietary importers keep working
// unchanged, and `getProjectId` below continues to call it.
export { tryGitProjectId };

const cache = new Map<string, { id: string; name: string }>();

export function getProjectId(cwd: string): { id: string; name: string } {
  const cached = cache.get(cwd);
  if (cached) return cached;

  // 1. git remote
  const gitResult = tryGitProjectId(cwd);
  if (gitResult !== null) {
    cache.set(cwd, gitResult);
    return gitResult;
  }

  // 2. realpath(cwd) fallback
  const realCwd = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  })();
  const id = createHash('sha256').update(realCwd).digest('hex').slice(0, 16);
  const name = basename(realCwd);
  const result = { id, name };
  cache.set(cwd, result);
  return result;
}

/**
 * @internal Test-only escape hatch — DO NOT call from production code.
 *
 * Clears the in-memory project-id cache so tests can use distinct cwd
 * fixtures without inheriting earlier resolutions. The double-underscore
 * + `test_` prefix is a strong signal that this surface is not part of
 * the supported API. Production callers will trip linter/IDE warnings
 * via the `@internal` JSDoc tag.
 *
 * If a future refactor makes the cache injectable (e.g., a
 * `ProjectIdResolver` class), prefer that path and remove this helper.
 */
export function __test_resetProjectIdCache(): void {
  cache.clear();
}
