// scripts/release-upload.ts — Phase 21 M2 release upload step.
//
// Usage: bun scripts/release-upload.ts <version> [--dry-run]
//
// Reads build/release/<version>/sov-{darwin-arm64,darwin-x64,linux-x64}.tar.gz,
// generates SHA256SUMS alongside them, and runs `gh release create` against
// yevgetman/sov-releases. Idempotent: if the release for <version> already
// exists, prints a notice and exits 0.
//
// Required env:
//   SOV_RELEASES_PATH — path to a sov-releases checkout (for CHANGELOG.md)
//   GH_TOKEN          — required unless --dry-run

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exit } from 'node:process';
import { OWNER, PUBLIC_REPO, die, note, repoRoot, sha256 } from './release-shared';

const EXPECTED_TARBALL_NAMES = [
  'sov-darwin-arm64.tar.gz',
  'sov-darwin-x64.tar.gz',
  'sov-linux-x64.tar.gz',
] as const;

export type CollectResult =
  | { ok: true; tarballs: string[] }
  | { ok: false; error: string };

export function collectTarballs(releaseDir: string): CollectResult {
  const missing: string[] = [];
  const present: string[] = [];
  for (const name of EXPECTED_TARBALL_NAMES) {
    const p = join(releaseDir, name);
    if (existsSync(p)) {
      present.push(p);
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `missing tarballs in ${releaseDir}: ${missing.join(', ')}`,
    };
  }
  return { ok: true, tarballs: present };
}

export function generateSums(releaseDir: string, tarballs: string[]): string {
  const lines = tarballs
    .map((p) => {
      const hash = sha256(p);
      const name = basename(p);
      return `${hash}  ${name}`;
    })
    .join('\n');
  const out = join(releaseDir, 'SHA256SUMS');
  writeFileSync(out, `${lines}\n`);
  return out;
}

export function buildGhCreateArgs(opts: {
  version: string;
  notesFilePath: string;
  assets: string[];
}): string[] {
  return [
    'release',
    'create',
    opts.version,
    '--repo',
    `${OWNER}/${PUBLIC_REPO}`,
    '--title',
    `Sovereign AI SDK ${opts.version}`,
    '--notes-file',
    opts.notesFilePath,
    ...opts.assets,
  ];
}

function releaseExists(version: string): boolean {
  const r = spawnSync('gh', ['release', 'view', version, '--repo', `${OWNER}/${PUBLIC_REPO}`], {
    stdio: 'pipe',
  });
  return r.status === 0;
}

// CLI entry: only runs when invoked directly, not when imported by tests.
if (import.meta.path === Bun.main) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!version) die('usage: bun scripts/release-upload.ts <version> [--dry-run]');

  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    die(`bad version "${version}" — expected vMAJOR.MINOR.PATCH (optionally -suffix)`);
  }

  const releaseDir = join(repoRoot(), 'build', 'release', version);
  const tarballs = collectTarballs(releaseDir);
  if (!tarballs.ok) die(tarballs.error);

  const sumsPath = generateSums(releaseDir, tarballs.tarballs);
  note(`wrote ${sumsPath}`);

  const publicRepoPath = process.env.SOV_RELEASES_PATH ?? '';
  const notesFilePath = join(publicRepoPath, 'CHANGELOG.md');
  if (!existsSync(notesFilePath)) {
    die(`SOV_RELEASES_PATH/CHANGELOG.md not found at ${notesFilePath}`);
  }

  const ghArgs = buildGhCreateArgs({
    version,
    notesFilePath,
    assets: [...tarballs.tarballs, sumsPath],
  });

  if (dryRun) {
    note('dry-run — would invoke:');
    note(`  gh ${ghArgs.join(' ')}`);
    exit(0);
  }

  if (releaseExists(version)) {
    note(
      `release ${version} already exists at https://github.com/${OWNER}/${PUBLIC_REPO}/releases/tag/${version}; skipping upload`,
    );
    exit(0);
  }

  note(`uploading release ${version}...`);
  const r = spawnSync('gh', ghArgs, { stdio: 'inherit' });
  if (r.status !== 0) die(`gh release create → exit ${r.status}`);
  note(`released: https://github.com/${OWNER}/${PUBLIC_REPO}/releases/tag/${version}`);
}
