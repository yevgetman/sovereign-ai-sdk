// src/learning/paths.ts
// Canonical filesystem layout for learning/* artifacts under $HARNESS_HOME.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validatePrincipalId } from '../server/principals.js';

export const GLOBAL_PROJECT_ID = '_global';

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
  if (userId === undefined) return `learning/${projectId}/instincts`;
  validatePrincipalId(userId);
  return `users/${userId}/learning/${projectId}/instincts`;
}
