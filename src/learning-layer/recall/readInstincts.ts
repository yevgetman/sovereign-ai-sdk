// src/learning-layer/recall/readInstincts.ts — Persist-backed reader for the instinct corpus (project + _global), fail-open on per-file read/parse errors.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { parseInstinct } from '../../learning/instinctSerde.js';
import { GLOBAL_PROJECT_ID, instinctsDir, instinctsKeyPrefix } from '../../learning/paths.js';
import type { Instinct } from '../../learning/types.js';
import type { PersistPort } from '../ports.js';

const recordedInstinctKeys = new Map<string, readonly string[]>();

function instinctScope(projectId: string, userId?: string): string {
  return `${userId ?? ''}\0${projectId}`;
}

function fileIdentity(path: string): string {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : `error:${code ?? 'unknown'}`;
  }
}

/** Directory and file identity for the project and `_global` corpora.
 *  Stats only. A logical turn uses this to skip list/read while the files are unchanged. */
export function instinctCorpusStamp(
  harnessHome: string,
  projectId: string,
  userId?: string,
): string {
  const dirs = [
    instinctsDir(harnessHome, projectId, userId),
    instinctsDir(harnessHome, GLOBAL_PROJECT_ID, userId),
  ];
  const keys = recordedInstinctKeys.get(instinctScope(projectId, userId)) ?? [];
  return JSON.stringify({
    dirs: dirs.map((dir) => [dir, fileIdentity(dir)]),
    files: keys.map((key) => [key, fileIdentity(join(harnessHome, key))]),
  });
}

/** Read all instincts for `projectId` plus the shared `_global` corpus through
 *  the Persist port. Non-`.md` keys are ignored; any file that fails to read or
 *  parse is skipped (fail-open) rather than throwing.
 *
 *  Phase E T6 — `userId` namespaces BOTH the project and `_global` corpora
 *  under `users/{userId}/learning/…`; undefined reads the legacy top-level
 *  corpus (byte-identical to pre-Phase-E behavior). The `_global` corpus is
 *  per-user too, so cross-user global instincts never leak. */
export async function readInstincts(
  persist: PersistPort,
  projectId: string,
  userId?: string,
): Promise<Instinct[]> {
  const prefixes = [
    ...new Set([
      instinctsKeyPrefix(projectId, userId),
      instinctsKeyPrefix(GLOBAL_PROJECT_ID, userId),
    ]),
  ];
  const keyLists = await Promise.all(prefixes.map((prefix) => persist.list(prefix)));
  const mdKeys = keyLists.flat().filter((key) => key.endsWith('.md'));
  recordedInstinctKeys.set(instinctScope(projectId, userId), mdKeys);

  const collected: Instinct[] = [];
  for (const key of mdKeys) {
    try {
      const raw = await persist.read(key);
      if (raw === null) continue;
      collected.push(parseInstinct(raw).instinct);
    } catch {
      // fail-open: a malformed or unreadable instinct file must not break recall
    }
  }
  return collected;
}
