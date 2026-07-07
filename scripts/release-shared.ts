// scripts/release-shared.ts — utilities shared by release-build-target.ts,
// release-upload.ts, and the local-orchestrator release.ts. Lifted from
// the M1 release.ts so both the local path and the CI path call the same
// code.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exit } from 'node:process';

export const OWNER = 'yevgetman';
export const PUBLIC_REPO = 'sov-releases';

export type TargetName = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64';

export interface Target {
  name: TargetName;
  bunTarget: 'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-x64' | 'bun-linux-arm64';
  goos: 'darwin' | 'linux';
  goarch: 'arm64' | 'amd64';
}

export const TARGETS: readonly Target[] = [
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', goos: 'darwin', goarch: 'arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', goos: 'darwin', goarch: 'amd64' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64', goos: 'linux', goarch: 'amd64' },
  // linux-arm64: the arch ARM Linux containers run (e.g. the Appleo platform's
  // aarch64 gateway container, Graviton). Previously absent, which forced an
  // ad-hoc cross-compile with no official versioned artifact — this makes it a
  // first-class, published release target.
  { name: 'linux-arm64', bunTarget: 'bun-linux-arm64', goos: 'linux', goarch: 'arm64' },
];

export function die(msg: string): never {
  process.stderr.write(`release: ${msg}\n`);
  exit(1);
}

export function note(msg: string): void {
  process.stdout.write(`release: ${msg}\n`);
}

export function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? repoRoot(),
    env: opts.env ?? process.env,
  });
  if (result.status !== 0) {
    die(`${bin} ${args.join(' ')} → exit ${result.status}`);
  }
}

export function capture(
  bin: string,
  args: string[],
  opts: { cwd?: string } = {},
): string {
  const result = spawnSync(bin, args, { cwd: opts.cwd ?? repoRoot() });
  if (result.status !== 0) {
    die(`${bin} ${args.join(' ')} → exit ${result.status}`);
  }
  return result.stdout.toString().trim();
}

export function sha256(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

export function satisfies(have: string, need: string): boolean {
  const parse = (v: string) => v.split('.').map((p) => parseInt(p, 10));
  const a = parse(have);
  const b = parse(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

export function repoRoot(): string {
  return resolve(import.meta.dir, '..');
}
