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

/**
 * Derive a human-readable project name from a git remote URL.
 *
 * Returns the trailing two path segments (`owner/repo`) when the URL has
 * sufficient depth, preserving nested-namespace context for hosts like
 * GitLab subgroups. Falls back to a single segment when the URL is bare
 * (e.g., `https://example.com/repo.git`).
 *
 * Examples:
 *   git@github.com:owner/myrepo.git           → "owner/myrepo"
 *   https://github.com/owner/myrepo.git       → "owner/myrepo"
 *   https://gitlab.com/group/sub/repo.git     → "sub/repo"
 *   git@bitbucket.org:team/proj.git           → "team/proj"
 *   https://example.com/repo.git              → "repo"
 *
 * Handles trailing slashes, missing `.git`, http/https, and SSH
 * (`git@host:owner/repo.git`) shapes.
 */
function nameFromRemote(remote: string): string {
  // Normalise SSH form `git@host:owner/repo.git` → `owner/repo.git` by
  // stripping everything up to the first `:` that follows the user@host.
  // Also tolerate trailing slash and missing `.git`.
  const stripped = remote
    .trim()
    .replace(/\.git\/?$/, '') // drop trailing .git or .git/
    .replace(/\/+$/, ''); // drop any remaining trailing slash

  // Cut off the scheme + host. Two shapes to handle:
  //   - SSH:    git@host:path/to/repo
  //   - HTTPS:  https://host/path/to/repo
  let pathPart: string;
  if (stripped.includes('://')) {
    // Drop scheme + host: keep everything after the first single slash
    // following the host.
    const afterScheme = stripped.split('://')[1] ?? stripped;
    const firstSlash = afterScheme.indexOf('/');
    pathPart = firstSlash >= 0 ? afterScheme.slice(firstSlash + 1) : afterScheme;
  } else if (stripped.includes(':') && !stripped.startsWith('/')) {
    // SSH form. Take everything after the first `:`.
    const colonIdx = stripped.indexOf(':');
    pathPart = stripped.slice(colonIdx + 1);
  } else {
    pathPart = stripped;
  }

  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return 'unknown';
  if (segments.length === 1) return segments[0] ?? 'unknown';

  // Two or more segments: keep the trailing two so `owner/repo` and
  // nested namespaces both surface useful context.
  const last = segments[segments.length - 1];
  const secondLast = segments[segments.length - 2];
  if (!last || !secondLast) return last ?? 'unknown';
  return `${secondLast}/${last}`;
}
