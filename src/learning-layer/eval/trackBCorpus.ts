// src/learning-layer/eval/trackBCorpus.ts — read the instinct corpus after
// synthesis to verify what the live synthesizer actually wrote.
//
// The synthesizer may file an instinct as project-scoped (under the project's
// own id) or, via the cross-project promotion path, global (under _global).
// Recall reads both, so verification must too. Thin wrapper over InstinctStore
// (the sync FS reader); kept separate from the Track-B runner so the runner
// stays focused on orchestration.

import { InstinctStore } from '../../learning/instinctStore.js';
import { GLOBAL_PROJECT_ID } from '../../learning/paths.js';
import type { Instinct } from '../../learning/types.js';

/** All instincts visible to recall for `projectId`: the project's own corpus
 *  plus the shared `_global` corpus (deduped by id, project entries first). */
export function readInstinctsForProject(harnessHome: string, projectId: string): Instinct[] {
  const store = new InstinctStore(harnessHome);
  const seen = new Set<string>();
  const out: Instinct[] = [];
  for (const scope of [projectId, GLOBAL_PROJECT_ID]) {
    for (const inst of store.list(scope)) {
      if (seen.has(inst.id)) continue;
      seen.add(inst.id);
      out.push(inst);
    }
  }
  return out;
}
