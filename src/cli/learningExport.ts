// src/cli/learningExport.ts
// Phase 13.4 — `harness learning export <project-id>` CLI handler.
// Read-only; emits each instinct as a .md file (or to stdout when no
// --output specified).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { stringify as stringifyYaml } from 'yaml';
import { resolveHarnessHome } from '../config/paths.js';
import { InstinctStore } from '../learning/instinctStore.js';
import type { Instinct } from '../learning/types.js';

export interface LearningExportOpts {
  projectId: string;
  output?: string;
  harnessHome?: string;
}

export interface ExportResult {
  projectId: string;
  count: number;
  destination: string | null; // null when emitted to stdout
  files: string[]; // when destination !== null
}

export function runLearningExport(opts: LearningExportOpts): ExportResult {
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  const store = new InstinctStore(harnessHome);
  const instincts = store.list(opts.projectId);
  const result: ExportResult = {
    projectId: opts.projectId,
    count: instincts.length,
    destination: opts.output ?? null,
    files: [],
  };
  if (opts.output === undefined) {
    return result;
  }
  if (!existsSync(opts.output)) {
    mkdirSync(opts.output, { recursive: true });
  }
  for (const instinct of instincts) {
    const path = join(opts.output, `${instinct.id}.md`);
    writeFileSync(path, renderInstinctFile(instinct, store, opts.projectId));
    result.files.push(path);
  }
  return result;
}

export function renderInstinctFile(
  instinct: Instinct,
  store: InstinctStore,
  projectId: string,
): string {
  const { body } = store.readWithBody(projectId, instinct.id);
  const fm = stringifyYaml(instinct);
  return `---\n${fm}---\n${body}`;
}

export function formatExportResult(result: ExportResult): string {
  if (result.count === 0) {
    return chalk.dim(`no instincts found for project ${result.projectId}\n`);
  }
  if (result.destination === null) {
    return `${chalk.bold(result.count)} instinct(s) for ${result.projectId} (use --output <dir> to write to disk)\n`;
  }
  return `${chalk.bold(`${result.count}`)} instinct(s) exported to ${chalk.cyan(result.destination)}\n`;
}
