#!/usr/bin/env bun
// External-consumer canary (spec §9.3): for each open package, `npm pack` it,
// install the TARBALL into a throwaway scratch project, and run a consumer
// script under BOTH `node` and `bun`. This proves the PUBLISHED shape (the
// package.json `exports` map → compiled dist) resolves for a real external app
// — not the in-repo source. Run via `bun run canary`.
//
// Node-API-only (no Bun globals) so it is itself runtime-agnostic.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

interface CanarySpec {
  name: string;
  pkgDir: string;
  consumer: string;
  token: string;
  extraInstalls?: string[];
}

function packTarball(pkgDir: string): string {
  // `npm pack --json` runs `prepack` (→ build) and emits the tarball + a JSON manifest.
  const out = execFileSync('npm', ['pack', '--json'], { cwd: pkgDir }).toString();
  const filename = JSON.parse(out)[0].filename as string;
  return join(pkgDir, filename);
}

function runCanary(spec: CanarySpec): void {
  const scratch = mkdtempSync(join(tmpdir(), 'sov-canary-'));
  try {
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'sov-canary-consumer', version: '0.0.0', type: 'module', private: true }, null, 2),
    );
    const tarball = packTarball(spec.pkgDir);
    try {
      execFileSync('npm', ['install', '--no-save', tarball, ...(spec.extraInstalls ?? [])], {
        cwd: scratch,
        stdio: 'ignore',
      });
      copyFileSync(spec.consumer, join(scratch, 'consumer.mjs'));
      for (const runtime of ['node', 'bun']) {
        const out = execFileSync(runtime, ['consumer.mjs'], { cwd: scratch }).toString();
        if (!out.includes(spec.token)) {
          throw new Error(`${spec.name} canary FAILED under ${runtime}: expected '${spec.token}', got:\n${out}`);
        }
        console.log(`  ✔ ${spec.name} consumable under ${runtime}`);
      }
    } finally {
      rmSync(tarball, { force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('External-consumer canary:');
runCanary({
  name: '@yevgetman/sov-protocol',
  pkgDir: join(repo, 'packages/protocol'),
  consumer: join(here, 'protocol-consumer.mjs'),
  token: 'PROTOCOL_OK',
});
// SDK canary is registered in Phase 3 once the core package exists.
console.log('All consumer canaries passed.');
