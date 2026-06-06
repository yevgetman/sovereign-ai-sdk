// src/learning/instinctStore.ts
// Phase 13.4 — read/write Instinct .md files. Per-project + global stores
// share the same on-disk shape: YAML frontmatter (matches the InstinctSchema)
// + markdown body for evidence summary / human-readable notes.

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseInstinct, serializeInstinct } from './instinctSerde.js';
import {
  GLOBAL_PROJECT_ID,
  ensureGlobalLearningDirs,
  ensureLearningDirs,
  instinctPath,
  instinctsDir,
  learningRoot,
} from './paths.js';
import type { Instinct } from './types.js';

export class InstinctStore {
  /** Phase E T6 — `userId` namespaces the whole store under
   *  `<harnessHome>/users/{userId}/learning/…`. Undefined → the legacy
   *  top-level `<harnessHome>/learning/…` paths (byte-identical to
   *  pre-Phase-E behavior). Validated at the path boundary in paths.ts. */
  constructor(
    private readonly harnessHome: string,
    private readonly userId?: string,
  ) {}

  /** List all instincts for a given project (or `_global` for global). */
  list(projectId: string): Instinct[] {
    const dir = instinctsDir(this.harnessHome, projectId, this.userId);
    if (!existsSync(dir)) return [];
    const out: Instinct[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        out.push(this.read(projectId, file.replace(/\.md$/, '')));
      } catch {
        // skip malformed records — don't poison the corpus on a single
        // bad write
      }
    }
    return out;
  }

  /** Read the instinct (frontmatter only — body discarded). */
  read(projectId: string, instinctId: string): Instinct {
    const path = instinctPath(this.harnessHome, projectId, instinctId, this.userId);
    const raw = readFileSync(path, 'utf-8');
    return parseInstinct(raw, instinctId).instinct;
  }

  /** Read both frontmatter (parsed) and body (markdown text). */
  readWithBody(projectId: string, instinctId: string): { instinct: Instinct; body: string } {
    const path = instinctPath(this.harnessHome, projectId, instinctId, this.userId);
    const raw = readFileSync(path, 'utf-8');
    return parseInstinct(raw, instinctId);
  }

  /** Write an instinct, overwriting any existing record at the same id.
   *  Ensures the target directory exists. */
  write(instinct: Instinct, body: string): void {
    if (instinct.scope === 'global') {
      ensureGlobalLearningDirs(this.harnessHome, this.userId);
    } else if (instinct.project_id !== null) {
      ensureLearningDirs(this.harnessHome, instinct.project_id, this.userId);
    } else {
      throw new Error('instinct with scope=project must have a non-null project_id');
    }
    const projectId = instinct.scope === 'global' ? GLOBAL_PROJECT_ID : (instinct.project_id ?? '');
    const path = instinctPath(this.harnessHome, projectId, instinct.id, this.userId);
    writeFileSync(path, serializeInstinct(instinct, body));
  }

  /** Remove an instinct from disk. No-op if missing. */
  remove(projectId: string, instinctId: string): void {
    const path = instinctPath(this.harnessHome, projectId, instinctId, this.userId);
    if (existsSync(path)) unlinkSync(path);
  }

  /** Walk learning/ to enumerate every project that has at least one
   *  instinct directory (excludes _global). Used by cross-project
   *  promotion. Scoped to this store's user namespace. */
  listAllProjects(): string[] {
    const root = learningRoot(this.harnessHome, this.userId);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === GLOBAL_PROJECT_ID) continue;
      if (existsSync(instinctsDir(this.harnessHome, entry.name, this.userId))) {
        out.push(entry.name);
      }
    }
    return out;
  }
}
