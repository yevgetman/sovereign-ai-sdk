// Bounded markdown memory files. Writes fail when over cap so the agent must
// consolidate intentionally instead of appending forever.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';

export type MemoryFile = 'MEMORY.md' | 'USER.md';

export const MEMORY_CAPS: Record<MemoryFile, number> = {
  'MEMORY.md': 2_200,
  'USER.md': 1_375,
};

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

export function memoryPath(harnessHome: string, file: MemoryFile): string {
  return join(harnessHome, 'memory', file);
}

export function readMemoryFile(
  file: MemoryFile,
  harnessHome = resolveHarnessHome(),
): MemoryReadResult {
  const path = memoryPath(harnessHome, file);
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
): Record<MemoryFile, MemoryReadResult> {
  return {
    'MEMORY.md': readMemoryFile('MEMORY.md', harnessHome),
    'USER.md': readMemoryFile('USER.md', harnessHome),
  };
}

export function replaceMemoryFile(
  file: MemoryFile,
  content: string,
  harnessHome = resolveHarnessHome(),
): MemoryReplaceResult {
  const path = memoryPath(harnessHome, file);
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
  mkdirSync(join(harnessHome, 'memory'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return { ok: true, ...readMemoryFile(file, harnessHome) };
}
