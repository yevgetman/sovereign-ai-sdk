// src/learning/paths.ts
// Canonical filesystem layout for learning/* artifacts under $HARNESS_HOME.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const GLOBAL_PROJECT_ID = '_global';

export function learningRoot(harnessHome: string): string {
  return join(harnessHome, 'learning');
}

export function projectRoot(harnessHome: string, projectId: string): string {
  return join(learningRoot(harnessHome), projectId);
}

export function observationsPath(harnessHome: string, projectId: string): string {
  return join(projectRoot(harnessHome, projectId), 'observations.jsonl');
}

export function instinctsDir(harnessHome: string, projectId: string): string {
  return join(projectRoot(harnessHome, projectId), 'instincts');
}

export function instinctPath(harnessHome: string, projectId: string, instinctId: string): string {
  return join(instinctsDir(harnessHome, projectId), `${instinctId}.md`);
}

export function ensureLearningDirs(harnessHome: string, projectId: string): void {
  mkdirSync(instinctsDir(harnessHome, projectId), { recursive: true });
}

export function ensureGlobalLearningDirs(harnessHome: string): void {
  mkdirSync(instinctsDir(harnessHome, GLOBAL_PROJECT_ID), { recursive: true });
}
