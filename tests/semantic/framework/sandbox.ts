// Per-test sandbox builder. Each semantic test gets a fresh tempdir and
// isolated harness state — HARNESS_HOME, HARNESS_CONFIG, sessions DB. The
// sandbox is the only component that touches the filesystem outside its
// own directory tree, and every path it produces lives under one root.
// cleanup() removes the entire root, so a crashed test cannot leak state.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TestSetup } from './types.js';

export interface Sandbox {
  /** Root tempdir; everything else lives under it. */
  rootDir: string;
  /** Working directory the binary runs in. */
  cwd: string;
  /** Env additions to merge on top of process.env when spawning the binary. */
  envAdditions: Record<string, string>;
  /** Path to pass via `--db <path>`. */
  dbPath: string;
  /** Idempotent cleanup. Safe to call after a crash. */
  cleanup(): void;
}

export function createSandbox(opts: { setup?: TestSetup } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'sov-semantic-'));
  const home = join(root, 'harness-home');
  const cwd = join(root, 'cwd');
  const cfg = join(root, 'config.json');
  const db = join(root, 'sessions.db');

  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(cfg, '{}');

  for (const f of opts.setup?.files ?? []) {
    const target = resolve(cwd, f.path);
    if (!target.startsWith(`${cwd}/`) && target !== cwd) {
      throw new Error(`setup file path escapes sandbox cwd: ${f.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  for (const f of opts.setup?.homeFiles ?? []) {
    const target = resolve(home, f.path);
    if (!target.startsWith(`${home}/`) && target !== home) {
      throw new Error(`setup homeFile path escapes sandbox harness home: ${f.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }

  // Sandbox vars must win over user-supplied env — listed last on purpose.
  const envAdditions: Record<string, string> = {
    ...(opts.setup?.env ?? {}),
    HARNESS_HOME: home,
    HARNESS_CONFIG: cfg,
  };

  let cleaned = false;
  return {
    rootDir: root,
    cwd,
    envAdditions,
    dbPath: db,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
