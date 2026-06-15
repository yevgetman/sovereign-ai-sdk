// Filesystem layout for user-level session transcripts (2026-06-15 — see
// docs/specs/2026-06-15-session-transcripts-design.md). Mirrors Claude Code's
// `~/.claude/projects/<slug>/<sessionId>.jsonl` ergonomic, with Phase-E per-user
// scoping and the trace writer's path-traversal hardening.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { validatePrincipalId } from '../server/principals.js';

const PROJECTS_DIR_NAME = 'projects';
const MAX_SLUG_LEN = 200;

/** The transcripts projects-root for a principal under `base` (= the configured
 *  transcripts dir, or `$HARNESS_HOME`). No owner → `<base>/projects` (legacy /
 *  single-principal, byte-identical convention); with owner →
 *  `<base>/users/<id>/projects` (Phase-E scoped). Mirrors `learningRoot` /
 *  `memoryRoot`; validates the principal id before it becomes a path segment. */
export function transcriptsRoot(base: string, userId?: string): string {
  if (userId === undefined) return join(base, PROJECTS_DIR_NAME);
  validatePrincipalId(userId);
  return join(base, 'users', userId, PROJECTS_DIR_NAME);
}

/** Human-readable, browsable slug of a cwd (the Claude-Code rule): realpath-
 *  canonicalize (best-effort), NFC-normalize, then every non-alphanumeric → `-`.
 *  Long paths are truncated and suffixed with a stable hash so distinct deep
 *  paths don't collide. e.g. `/Users/x/code/foo` → `-Users-x-code-foo`. */
export function slugifyCwd(cwd: string): string {
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    // cwd may not exist yet (tests / transient) — slug the raw value.
  }
  const slug = canonical.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG_LEN) return slug;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${slug.slice(0, MAX_SLUG_LEN)}-${hash}`;
}

/** Sanitize a sessionId into a filename stem that can never traverse the FS.
 *  Mirrors the trace writer's `safeTraceFilenameStem`: collapse `..` runs, then
 *  allowlist word chars, `.`, `-`, and the `:` channel-key delimiter; replace
 *  anything else (path separators, control chars, …) with `_`. */
function safeSessionStem(sessionId: string): string {
  return sessionId.replace(/\.\.+/g, (m) => '_'.repeat(m.length)).replace(/[^A-Za-z0-9_.:-]/g, '_');
}

/** Resolve `<projectsRoot>/<slug(cwd)>/<safe(sessionId)>.jsonl`, asserting the
 *  result stays under `<projectsRoot>/<slug>` (defense-in-depth vs traversal —
 *  the slug has no separators and the stem is sanitized, but the assertion is a
 *  belt-and-suspenders invariant future refactors must preserve). */
export function resolveTranscriptPath(
  projectsRoot: string,
  cwd: string,
  sessionId: string,
): string {
  const projectDir = resolve(join(projectsRoot, slugifyCwd(cwd)));
  const candidate = resolve(join(projectDir, `${safeSessionStem(sessionId)}.jsonl`));
  if (candidate !== projectDir && !candidate.startsWith(projectDir + sep)) {
    throw new Error(`[transcript] refused to write outside project dir: ${sessionId}`);
  }
  return candidate;
}
