// Bounded markdown memory files. Writes fail when over cap so the agent must
// consolidate intentionally instead of appending forever.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import { validatePrincipalId } from '../util/principals.js';
import { SECURE_FILE_MODE, chmodSafe, secureMkdir } from '../util/secureFs.js';

export type MemoryFile = 'MEMORY.md' | 'USER.md';

export const MEMORY_CAPS: Record<MemoryFile, number> = {
  'MEMORY.md': 2_200,
  'USER.md': 1_375,
};

const PROJECT_DIR_NAME = 'projects';
const PROJECT_MEMORY_FILE: MemoryFile = 'MEMORY.md';

export type MemoryReadResult = {
  file: MemoryFile;
  path: string;
  content: string;
  current_chars: number;
  cap: number;
};

export type MemoryReplaceResult =
  | (MemoryReadResult & { ok: true })
  | {
      ok: false;
      file: MemoryFile;
      path: string;
      error: string;
      current_chars: number;
      cap: number;
    };

export function normalizeMemoryFile(file: string): MemoryFile {
  const normalized = file.trim().toUpperCase();
  if (normalized === 'MEMORY' || normalized === 'MEMORY.MD') return 'MEMORY.md';
  if (normalized === 'USER' || normalized === 'USER.MD') return 'USER.md';
  throw new Error(`unknown memory file: ${file}`);
}

/** Phase E T5 — the memory root for a given principal. When `userId` is
 *  provided it is the per-user namespace `<harnessHome>/users/{userId}/memory`;
 *  when undefined it is the legacy top-level `<harnessHome>/memory` (BYTE-
 *  IDENTICAL to pre-Phase-E behavior). SECURITY-LOAD-BEARING: `userId` becomes
 *  a filesystem path segment, so it is validated (validatePrincipalId rejects
 *  separators, `.`/`..`, empty, and control chars) BEFORE it is joined into any
 *  path. */
function memoryRoot(harnessHome: string, userId?: string): string {
  if (userId === undefined) return join(harnessHome, 'memory');
  validatePrincipalId(userId);
  return join(harnessHome, 'users', userId, 'memory');
}

export function memoryPath(harnessHome: string, file: MemoryFile, userId?: string): string {
  return join(memoryRoot(harnessHome, userId), file);
}

export function readMemoryFile(
  file: MemoryFile,
  harnessHome = resolveHarnessHome(),
  userId?: string,
): MemoryReadResult {
  const path = memoryPath(harnessHome, file, userId);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return {
    file,
    path,
    content,
    current_chars: content.length,
    cap: MEMORY_CAPS[file],
  };
}

export function readAllMemory(
  harnessHome = resolveHarnessHome(),
  userId?: string,
): Record<MemoryFile, MemoryReadResult> {
  return {
    'MEMORY.md': readMemoryFile('MEMORY.md', harnessHome, userId),
    'USER.md': readMemoryFile('USER.md', harnessHome, userId),
  };
}

export function replaceMemoryFile(
  file: MemoryFile,
  content: string,
  harnessHome = resolveHarnessHome(),
  userId?: string,
): MemoryReplaceResult {
  const path = memoryPath(harnessHome, file, userId);
  const cap = MEMORY_CAPS[file];
  if (content.length > cap) {
    return {
      ok: false,
      file,
      path,
      error: 'at capacity; use replace to consolidate',
      current_chars: content.length,
      cap,
    };
  }
  // Memory holds arbitrary agent-recorded facts (MEMORY.md / USER.md); like the
  // other HARNESS_HOME state sinks it must not be world-readable on a shared /
  // multi-tenant host (audit F10/F16 — this sink was missed): dir 0700, file 0600.
  secureMkdir(memoryRoot(harnessHome, userId));
  writeFileSync(path, content, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  chmodSafe(path, SECURE_FILE_MODE);
  return { ok: true, ...readMemoryFile(file, harnessHome, userId) };
}

/** SECURITY-LOAD-BEARING: `projectId` becomes a filesystem path segment
 *  (`…/projects/<projectId>/MEMORY.md`). Its preferred source is the bundle
 *  manifest's `projectId` (resolveProjectScope case 1), which is operator-
 *  supplied and only string-checked at load — a bundle `index.yaml` with
 *  `projectId: "../../../tmp/pwned"` would otherwise read/write project memory
 *  OUTSIDE the memory root (the git/hash sources are already hex, but the guard
 *  lives at this single path choke point so every caller — read and write — is
 *  covered, mirroring the `userId` guard in memoryRoot). Rejects path
 *  separators, the traversal segments `.`/`..`, empty, and NUL; a legitimate
 *  dotted slug (`acme.web`) is still allowed. */
function assertSafeProjectId(projectId: string): void {
  if (
    projectId.length === 0 ||
    projectId === '.' ||
    projectId === '..' ||
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId.includes('\0')
  ) {
    throw new Error(
      `invalid project id ${JSON.stringify(projectId)}: must be a single path segment (no path separators, '.', '..', or NUL)`,
    );
  }
}

export function projectMemoryPath(harnessHome: string, projectId: string, userId?: string): string {
  assertSafeProjectId(projectId);
  return join(memoryRoot(harnessHome, userId), PROJECT_DIR_NAME, projectId, PROJECT_MEMORY_FILE);
}

export function readProjectMemoryFile(
  projectId: string,
  harnessHome = resolveHarnessHome(),
  userId?: string,
): MemoryReadResult {
  const path = projectMemoryPath(harnessHome, projectId, userId);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return {
    file: PROJECT_MEMORY_FILE,
    path,
    content,
    current_chars: content.length,
    cap: MEMORY_CAPS[PROJECT_MEMORY_FILE],
  };
}

export function replaceProjectMemoryFile(
  projectId: string,
  content: string,
  harnessHome = resolveHarnessHome(),
  userId?: string,
): MemoryReplaceResult {
  const path = projectMemoryPath(harnessHome, projectId, userId);
  const cap = MEMORY_CAPS[PROJECT_MEMORY_FILE];
  if (content.length > cap) {
    return {
      ok: false,
      file: PROJECT_MEMORY_FILE,
      path,
      error: 'at capacity; use replace to consolidate',
      current_chars: content.length,
      cap,
    };
  }
  // Same defense-in-depth as replaceMemoryFile: per-project memory is
  // agent-recorded content — dir 0700, file 0600 (audit F10/F16).
  secureMkdir(join(memoryRoot(harnessHome, userId), PROJECT_DIR_NAME, projectId));
  writeFileSync(path, content, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  chmodSafe(path, SECURE_FILE_MODE);
  return { ok: true, ...readProjectMemoryFile(projectId, harnessHome, userId) };
}
