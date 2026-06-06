// src/learning-layer/recall/readInstincts.ts — Persist-backed reader for the instinct corpus (project + _global), fail-open on per-file read/parse errors.

import { parseInstinct } from '../../learning/instinctSerde.js';
import { GLOBAL_PROJECT_ID, instinctsKeyPrefix } from '../../learning/paths.js';
import type { Instinct } from '../../learning/types.js';
import type { PersistPort } from '../ports.js';

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
