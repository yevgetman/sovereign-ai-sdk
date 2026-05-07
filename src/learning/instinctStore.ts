// src/learning/instinctStore.ts
// Phase 13.4 — read/write Instinct .md files. Per-project + global stores
// share the same on-disk shape: YAML frontmatter (matches the InstinctSchema)
// + markdown body for evidence summary / human-readable notes.

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  GLOBAL_PROJECT_ID,
  ensureGlobalLearningDirs,
  ensureLearningDirs,
  instinctPath,
  instinctsDir,
  learningRoot,
} from './paths.js';
import { type Instinct, InstinctSchema } from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export class InstinctStore {
  constructor(private readonly harnessHome: string) {}

  /** List all instincts for a given project (or `_global` for global). */
  list(projectId: string): Instinct[] {
    const dir = instinctsDir(this.harnessHome, projectId);
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
    const path = instinctPath(this.harnessHome, projectId, instinctId);
    const raw = readFileSync(path, 'utf-8');
    const m = raw.match(FRONTMATTER_RE);
    if (!m) {
      throw new Error(`malformed instinct ${instinctId}: missing frontmatter`);
    }
    const data = parseYaml(m[1] ?? '') as Record<string, unknown>;
    return InstinctSchema.parse(data);
  }

  /** Read both frontmatter (parsed) and body (markdown text). */
  readWithBody(projectId: string, instinctId: string): { instinct: Instinct; body: string } {
    const path = instinctPath(this.harnessHome, projectId, instinctId);
    const raw = readFileSync(path, 'utf-8');
    const m = raw.match(FRONTMATTER_RE);
    if (!m) {
      throw new Error(`malformed instinct ${instinctId}: missing frontmatter`);
    }
    const data = parseYaml(m[1] ?? '') as Record<string, unknown>;
    return {
      instinct: InstinctSchema.parse(data),
      body: m[2] ?? '',
    };
  }

  /** Write an instinct, overwriting any existing record at the same id.
   *  Ensures the target directory exists. */
  write(instinct: Instinct, body: string): void {
    if (instinct.scope === 'global') {
      ensureGlobalLearningDirs(this.harnessHome);
    } else if (instinct.project_id !== null) {
      ensureLearningDirs(this.harnessHome, instinct.project_id);
    } else {
      throw new Error('instinct with scope=project must have a non-null project_id');
    }
    const projectId = instinct.scope === 'global' ? GLOBAL_PROJECT_ID : (instinct.project_id ?? '');
    const path = instinctPath(this.harnessHome, projectId, instinct.id);
    const fm = stringifyYaml(instinct);
    writeFileSync(path, `---\n${fm}---\n${body}`);
  }

  /** Remove an instinct from disk. No-op if missing. */
  remove(projectId: string, instinctId: string): void {
    const path = instinctPath(this.harnessHome, projectId, instinctId);
    if (existsSync(path)) unlinkSync(path);
  }

  /** Walk learning/ to enumerate every project that has at least one
   *  instinct directory (excludes _global). Used by cross-project
   *  promotion. */
  listAllProjects(): string[] {
    const root = learningRoot(this.harnessHome);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === GLOBAL_PROJECT_ID) continue;
      if (existsSync(instinctsDir(this.harnessHome, entry.name))) {
        out.push(entry.name);
      }
    }
    return out;
  }
}
