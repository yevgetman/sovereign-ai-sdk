// src/memory/scope.ts
// Resolves the project identity for memory routing. Returns a tagged union
// describing whether the current session has a "project" identity (bundle
// manifest, bundle path hash, or git remote) or is running in
// general-purpose harness mode (no project memory).
//
// Resolution order (Item 19 — memory project-scoping):
//   1. bundle.index.projectId       (operator-declared, preferred)
//   2. hash of canonical bundle path (auto, stable per-machine)
//   3. git remote via tryGitProjectId(cwd)
//   4. {kind: 'none'}                (harness mode)
//
// Bundle precedence over git is intentional: a bundle stored inside a git
// repo (common for Sovereign AI deployments) takes the bundle's identity,
// not the underlying git remote.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Bundle } from '../bundle/types.js';
import { tryGitProjectId } from '../util/project.js';

export type ProjectScope = { kind: 'project'; id: string; name: string } | { kind: 'none' };

export interface ResolveProjectScopeOpts {
  cwd: string;
  bundle: Bundle | null;
  /** Reserved for future expansion (e.g., reading harness-level overrides).
   *  Unused in v1; accept for forward-compat. */
  harnessHome?: string;
}

/** Read a bundle-index field as a trimmed non-empty string, or undefined.
 *  Defense-in-depth: the loader's `normalizeBundleIndex` drops non-string
 *  values, but a fake/future caller may hand us a raw index whose `repo`/
 *  `projectId` is numeric or a list — `(123).trim()` would crash boot. */
function trimmedStringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveProjectScope(opts: ResolveProjectScopeOpts): ProjectScope {
  const { cwd, bundle } = opts;

  // 1. Bundle with explicit manifest projectId.
  if (bundle !== null) {
    const id = trimmedStringField(bundle.index.projectId);
    if (id !== undefined) {
      const name = trimmedStringField(bundle.index.repo) ?? id;
      return { kind: 'project', id, name };
    }

    // 2. Bundle without manifest projectId — hash canonical path.
    const realRoot = (() => {
      try {
        return realpathSync(bundle.root);
      } catch {
        return bundle.root;
      }
    })();
    const hashedId = createHash('sha256').update(`bundle:${realRoot}`).digest('hex').slice(0, 16);
    const name = trimmedStringField(bundle.index.repo) ?? basename(realRoot);
    return { kind: 'project', id: hashedId, name };
  }

  // 3. Git repo — strict check (no realpath fallback).
  const gitProject = tryGitProjectId(cwd);
  if (gitProject !== null) {
    return { kind: 'project', id: gitProject.id, name: gitProject.name };
  }

  // 4. None — harness/general-purpose mode.
  return { kind: 'none' };
}
