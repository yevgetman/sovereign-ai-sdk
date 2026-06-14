// src/learning/paths.ts
// Canonical filesystem layout for learning/* artifacts under $HARNESS_HOME.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validatePrincipalId } from '../server/principals.js';

export const GLOBAL_PROJECT_ID = '_global';

/** Safe project-id segment: ASCII alphanumerics + `-` and `_`. `.` is
 *  intentionally excluded so `.`, `..`, `a.b` all fail alongside separators
 *  (`/`, `\`) and whitespace. The `_global` sentinel passes. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Validate a project id before it is joined into a filesystem path.
 *  SECURITY-LOAD-BEARING (FIX 4, defense-in-depth): an instinct's `project_id`
 *  is synthesizer-LLM-supplied and validated only as a string upstream, so a
 *  traversal value like `../../x` would escape the learning dir. Mirrors
 *  validatePrincipalId in src/server/principals.ts. Legitimate ids (a 16-char
 *  SHA-256 hex slice from getProjectId, or a `name-hash` style id) all pass. */
function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `invalid project id ${JSON.stringify(projectId)}: must match ${PROJECT_ID_RE} (ASCII alphanumerics, '-', '_', at least one char)`,
    );
  }
}

/** Validate an instinct id before it is joined into a filesystem path.
 *  SECURITY-LOAD-BEARING (defense-in-depth, sibling of FIX 4 for the SECOND
 *  path segment): the instinct id is synthesizer-LLM-supplied and validated
 *  only as `z.string().min(1)` at the tool-input boundary
 *  (InstinctViewTool / InstinctUpdateConfidenceTool), so a traversal value
 *  like `../../../../tmp/secret` (or `../../alice/.../real` for a cross-user
 *  instinct read) would escape the project's instincts dir. Same safe charset
 *  as the project id; `.` is excluded so `.`/`..`/`a.b` all fail. Legitimate
 *  ids (`<timestamp>-<hex>` from newInstinctId) pass. */
function validateInstinctId(instinctId: string): void {
  if (!PROJECT_ID_RE.test(instinctId)) {
    throw new Error(
      `invalid instinct id ${JSON.stringify(instinctId)}: must match ${PROJECT_ID_RE} (ASCII alphanumerics, '-', '_', at least one char)`,
    );
  }
}

/** Phase E T6 — the learning root for a given principal. When `userId` is
 *  provided the corpus is namespaced under `<harnessHome>/users/{userId}/learning`;
 *  when undefined it is the legacy top-level `<harnessHome>/learning` (BYTE-
 *  IDENTICAL to pre-Phase-E behavior). SECURITY-LOAD-BEARING: `userId` becomes a
 *  filesystem path segment, so it is validated (validatePrincipalId rejects
 *  separators, `.`/`..`, empty, whitespace, and control chars) BEFORE it is
 *  joined into any path. Mirrors `memoryRoot` in src/memory/bounded.ts. */
export function learningRoot(harnessHome: string, userId?: string): string {
  if (userId === undefined) return join(harnessHome, 'learning');
  validatePrincipalId(userId);
  return join(harnessHome, 'users', userId, 'learning');
}

export function projectRoot(harnessHome: string, projectId: string, userId?: string): string {
  // FIX 4 — the single chokepoint every learning path builder (observationsPath,
  // instinctsDir, instinctPath, ensureLearningDirs) flows through. Validate the
  // project id here so a traversal value can never reach `join`.
  validateProjectId(projectId);
  return join(learningRoot(harnessHome, userId), projectId);
}

export function observationsPath(harnessHome: string, projectId: string, userId?: string): string {
  return join(projectRoot(harnessHome, projectId, userId), 'observations.jsonl');
}

export function instinctsDir(harnessHome: string, projectId: string, userId?: string): string {
  return join(projectRoot(harnessHome, projectId, userId), 'instincts');
}

export function instinctPath(
  harnessHome: string,
  projectId: string,
  instinctId: string,
  userId?: string,
): string {
  // Sibling of FIX 4 — the single chokepoint all instinct read/write builders
  // (InstinctStore.read/readWithBody/write/remove) flow through. Validate the
  // instinct id here so a traversal value can never reach `join` (projectId is
  // already validated via instinctsDir → projectRoot).
  validateInstinctId(instinctId);
  return join(instinctsDir(harnessHome, projectId, userId), `${instinctId}.md`);
}

export function ensureLearningDirs(harnessHome: string, projectId: string, userId?: string): void {
  mkdirSync(instinctsDir(harnessHome, projectId, userId), { recursive: true });
}

export function ensureGlobalLearningDirs(harnessHome: string, userId?: string): void {
  mkdirSync(instinctsDir(harnessHome, GLOBAL_PROJECT_ID, userId), { recursive: true });
}

/** Phase E T6 — the harnessHome-RELATIVE instincts key prefix for the Persist
 *  port (which roots every key under $HARNESS_HOME). Mirrors `instinctsDir` but
 *  returns a forward-slash key fragment, not an absolute OS path. With a real
 *  `userId` the prefix is `users/{userId}/learning/{projectId}/instincts`; with
 *  none it is the legacy `learning/{projectId}/instincts`. SECURITY-LOAD-BEARING:
 *  `userId` is validated here too (defense-in-depth at the key boundary). */
export function instinctsKeyPrefix(projectId: string, userId?: string): string {
  // FIX 4 — `projectId` is a path/key segment here too (defense-in-depth at the
  // Persist key boundary, mirroring the userId validation below).
  validateProjectId(projectId);
  if (userId === undefined) return `learning/${projectId}/instincts`;
  validatePrincipalId(userId);
  return `users/${userId}/learning/${projectId}/instincts`;
}
