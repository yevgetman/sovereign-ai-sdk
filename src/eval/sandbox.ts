// Phase 10.5 part 2 — per-golden sandbox. Each golden runs in a fresh
// tempdir with its own HARNESS_HOME / HARNESS_CONFIG / sessions.db so
// runs cannot leak state into each other or into the user's real
// `.harness` tree. Mirrors `tests/semantic/framework/sandbox.ts` but is
// importable from `src/` (eval is production-side, not test-side).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FileSeedMap } from './types.js';

export type EvalSandbox = {
  /** Tempdir root; cleanup() removes the whole tree. */
  rootDir: string;
  /** Working directory the subprocess runs in. */
  cwd: string;
  /** Path under `rootDir` for the per-run sessions DB (passed via `--db`). */
  dbPath: string;
  /** Env additions to merge on top of process.env. */
  envAdditions: Record<string, string>;
  /** Idempotent. Safe to call after a crash. */
  cleanup(): void;
};

export function createEvalSandbox(seed?: FileSeedMap): EvalSandbox {
  const root = mkdtempSync(join(tmpdir(), 'sov-eval-'));
  const home = join(root, 'harness-home');
  const cwd = join(root, 'cwd');
  const cfg = join(root, 'config.json');
  const db = join(root, 'sessions.db');

  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(cfg, '{}');

  for (const [path, content] of Object.entries(seed ?? {})) {
    const target = resolve(cwd, path);
    if (!target.startsWith(`${cwd}/`) && target !== cwd) {
      throw new Error(`seed path escapes sandbox cwd: ${path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const envAdditions: Record<string, string> = {
    HARNESS_HOME: home,
    HARNESS_CONFIG: cfg,
  };

  let cleaned = false;
  return {
    rootDir: root,
    cwd,
    dbPath: db,
    envAdditions,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; an open file handle on Linux can leave
        // junk in /tmp but that's a transient nuisance.
      }
    },
  };
}
