import { packageInventory, preflightPackageScanner, scanReleasePayload } from './release-scan';
// scripts/release-upload.ts — Phase 21 M2 release upload step.
//
// Usage: bun scripts/release-upload.ts <version> [--dry-run]
//
// Reads build/release/<version>/sov-<target>.tar.gz (sov-windows-x64.zip for
// windows) for every target in TARGETS, generates SHA256SUMS alongside them,
// and runs `gh release create` against yevgetman/sov-releases. Idempotent: if
// the release for <version> already exists, prints a notice and exits 0.
//
// Required env:
//   SOV_RELEASES_PATH — path to a sov-releases checkout (for CHANGELOG.md)
//   GH_TOKEN          — required unless --dry-run

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exit } from 'node:process';
import {
  OWNER,
  PUBLIC_REPO,
  TARGETS,
  artifactName,
  die,
  note,
  repoRoot,
  sha256,
} from './release-shared';

// Derived from TARGETS (the single source of truth the build step iterates) so
// the upload set can never drift from what was built. A hardcoded list here
// previously omitted linux-arm64 after it was added to TARGETS, silently
// publishing a release missing that target. artifactName() also owns the
// per-target extension (tar.gz vs zip), so this never hard-codes one.
export const EXPECTED_ARTIFACT_NAMES: readonly string[] = TARGETS.map(artifactName);

export type CollectResult = { ok: true; artifacts: string[] } | { ok: false; error: string };

export function collectArtifacts(releaseDir: string): CollectResult {
  const missing: string[] = [];
  const present: string[] = [];
  for (const name of EXPECTED_ARTIFACT_NAMES) {
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
      error: `missing artifacts in ${releaseDir}: ${missing.join(', ')}`,
    };
  }
  return { ok: true, artifacts: present };
}

export function generateSums(releaseDir: string, artifacts: string[]): string {
  const lines = artifacts
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

/** Recheck downloaded/current bytes. A stale clean receipt never authorizes upload. */
export function verifyUploadArtifacts(releaseDir: string): void {
  preflightPackageScanner();
  for (const target of TARGETS) {
    const artifact = join(releaseDir, artifactName(target));
    scanReleasePayload(artifact, target, {
      required: packageInventory(target),
      receipt: `${artifact}.scan.json`,
    });
  }
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
  const collected = collectArtifacts(releaseDir);
  if (!collected.ok) die(collected.error);

  verifyUploadArtifacts(releaseDir);
  const sumsPath = generateSums(releaseDir, collected.artifacts);
  note(`wrote ${sumsPath}`);

  const publicRepoPath = process.env.SOV_RELEASES_PATH ?? '';
  const notesFilePath = join(publicRepoPath, 'CHANGELOG.md');
  if (!existsSync(notesFilePath)) {
    die(`SOV_RELEASES_PATH/CHANGELOG.md not found at ${notesFilePath}`);
  }

  const ghArgs = buildGhCreateArgs({
    version,
    notesFilePath,
    assets: [...collected.artifacts, sumsPath],
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
