// Bounded markdown memory files. Writes fail when over cap so the agent must
// consolidate intentionally instead of appending forever.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import { validatePrincipalId } from '../util/principals.js';

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
  mkdirSync(memoryRoot(harnessHome, userId), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return { ok: true, ...readMemoryFile(file, harnessHome, userId) };
}

export function projectMemoryPath(harnessHome: string, projectId: string, userId?: string): string {
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
  mkdirSync(join(memoryRoot(harnessHome, userId), PROJECT_DIR_NAME, projectId), {
    recursive: true,
  });
  writeFileSync(path, content, 'utf8');
  return { ok: true, ...readProjectMemoryFile(projectId, harnessHome, userId) };
}
