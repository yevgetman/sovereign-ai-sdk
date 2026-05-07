// src/learning/project.ts
// Stable per-project identity. Tries `git remote get-url origin` first;
// falls back to realpath(cwd) hash. Cached for the session lifetime so
// repeated lookups are cheap.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';

const cache = new Map<string, { id: string; name: string }>();

export function getProjectId(cwd: string): { id: string; name: string } {
  const cached = cache.get(cwd);
  if (cached) return cached;

  // 1. git remote
  const gitResult = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (gitResult.status === 0 && gitResult.stdout.trim().length > 0) {
    const remote = gitResult.stdout.trim();
    const id = createHash('sha256').update(remote).digest('hex').slice(0, 16);
    const name = nameFromRemote(remote);
    const result = { id, name };
    cache.set(cwd, result);
    return result;
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

/** Test-only helper to clear the cache. */
export function _resetProjectIdCache(): void {
  cache.clear();
}

function nameFromRemote(remote: string): string {
  const last = remote
    .replace(/\.git\/?$/, '')
    .split('/')
    .pop();
  return last ?? 'unknown';
}
