// src/util/project.ts
// Strict git-only project-id lookup + its private name-from-remote helper.
// Pure leaf: only Node builtins (child_process/crypto). Tries
// `git remote get-url origin`; returns null when no origin remote is set.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Strict git-only project-id lookup. Returns the {id, name} pair derived
 * from `git remote get-url origin` when the cwd is inside a git repo with
 * an `origin` remote configured; returns `null` otherwise.
 *
 * Unlike `getProjectId`, this helper does NOT fall back to a realpath
 * hash — callers that need a "is this cwd a git project?" yes/no signal
 * (e.g., the memory subsystem's project-scope resolver) want a strict
 * negative answer when no remote is set, not a synthetic hash-based id.
 *
 * The id is a 16-char SHA-256 hex slice of the remote URL — same format
 * as `getProjectId` so identifiers stay comparable across the two paths.
 */
export function tryGitProjectId(cwd: string): { id: string; name: string } | null {
  const gitResult = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (gitResult.status !== 0) return null;
  const remote = gitResult.stdout.trim();
  if (remote.length === 0) return null;
  const id = createHash('sha256').update(remote).digest('hex').slice(0, 16);
  const name = nameFromRemote(remote);
  return { id, name };
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
