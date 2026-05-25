// scripts/release.ts — Phase 21 M2 local-orchestrator entry point.
//
// Usage: bun run release v0.x.y [--dry-run]
//
// Performs local-only pre-flight (clean git, on master, package.json
// version matches, gh auth, Bun/Go versions, SOV_RELEASES_PATH set),
// then invokes scripts/release-build-target.ts per target and
// scripts/release-upload.ts. Tags + pushes the private repo at the end
// (which fires the CI workflow if it's enabled — the workflow's upload
// step is idempotent and will silently skip an already-published release).
//
// CI does NOT invoke this file; CI calls release-build-target.ts and
// release-upload.ts directly. This file is the laptop fallback.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';
import {
  TARGETS,
  capture,
  die,
  note,
  repoRoot,
  run,
  satisfies,
} from './release-shared';

function readPackageJsonVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8'));
  return pkg.version as string;
}

function preflightLocal(version: string, dryRun: boolean): void {
  note('pre-flight checks...');

  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    die(`bad version "${version}" — expected vMAJOR.MINOR.PATCH (optionally -suffix)`);
  }

  const pkgVersion = readPackageJsonVersion();
  const expectedTag = `v${pkgVersion}`;
  if (version !== expectedTag) {
    die(
      `version arg "${version}" does not match package.json version "${pkgVersion}" (expected tag "${expectedTag}")`,
    );
  }

  const status = capture('git', ['status', '--porcelain']);
  if (status !== '') die(`git working tree not clean:\n${status}`);

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'master') die(`not on master (on "${branch}")`);

  note('running lint...');
  run('bun', ['run', 'lint']);
  note('running typecheck...');
  run('bun', ['run', 'typecheck']);
  note('running test...');
  run('bun', ['run', 'test']);

  if (!dryRun) {
    const ghStatus = spawnSync('gh', ['auth', 'status'], {
      env: { ...process.env, GH_TOKEN: '' },
    });
    if (ghStatus.status !== 0) die('gh CLI not authenticated — run: gh auth login');
  }

  const bunVer = capture('bun', ['--version']);
  if (!satisfies(bunVer, '1.2.0')) die(`bun version too old: ${bunVer} (need ≥1.2.0)`);

  const goVerLine = capture('go', ['version']); // "go version go1.24.0 darwin/arm64"
  const goVer = goVerLine.match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? '0';
  if (!satisfies(goVer, '1.24.0')) die(`go version too old: ${goVer} (need ≥1.24)`);

  const publicRoot = process.env.SOV_RELEASES_PATH;
  if (!publicRoot || !existsSync(join(publicRoot, 'LICENSE.txt'))) {
    die(
      'SOV_RELEASES_PATH must point at a local clone of yevgetman/sov-releases ' +
        '(LICENSE.txt not found there).',
    );
  }

  note('pre-flight ok');
}

function tagAndPush(version: string): void {
  note(`tagging ${version}...`);
  run('git', ['tag', version]);
  run('git', ['push', 'origin', version]);
}

// ---------- main ----------

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!version) die('usage: bun run release v0.x.y [--dry-run]');

preflightLocal(version, dryRun);

for (const target of TARGETS) {
  run('bun', ['scripts/release-build-target.ts', target.name, version]);
}

// Clear GH_TOKEN so the gh CLI in release-upload.ts uses the keyring
// auth instead of any stale env token. CI explicitly sets GH_TOKEN
// (via SOV_RELEASES_TOKEN secret) and does NOT invoke this script —
// only the local laptop path runs through here.
run(
  'bun',
  [
    'scripts/release-upload.ts',
    version,
    ...(dryRun ? ['--dry-run'] : []),
  ],
  { env: { ...process.env, GH_TOKEN: '' } },
);

if (dryRun) {
  note(`dry-run complete. Artifacts in ${join(repoRoot(), 'build', 'release', version)}`);
  note('skipped: git tag/push, gh release create');
  exit(0);
}

tagAndPush(version);
note('done.');
