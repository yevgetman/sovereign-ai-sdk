// VERSION format regression pins — backlog #37. After lifting the resolved
// git short SHA into the version string, ensure:
//   1. The exported string matches bare-semver OR semver-with-SHA — so the
//      pin is robust both inside a git checkout (the normal dev + post-`sov
//      upgrade` global-install case) and outside one (e.g., tarball install,
//      missing git on PATH).
//   2. The exported string starts with the exact `version` field from
//      `package.json` — pins that the bare version is always the leading
//      component, so the `<base>-<sha>` shape is enforced rather than the
//      SHA replacing the base.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';

const SEMVER_OR_SEMVER_WITH_SHA = /^\d+\.\d+\.\d+(-[a-f0-9]{7,})?$/;

function readPackageVersion(): string {
  const pkgPath = join(process.cwd(), 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

function resolveGitShaForTest(): string | null {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

describe('VERSION', () => {
  test('matches bare semver or semver-with-short-sha shape', () => {
    expect(VERSION).toMatch(SEMVER_OR_SEMVER_WITH_SHA);
  });

  test('starts with the package.json version field', () => {
    const baseVersion = readPackageVersion();
    expect(VERSION.startsWith(baseVersion)).toBe(true);
  });

  test('includes the resolved git short SHA when run inside a git checkout', () => {
    const sha = resolveGitShaForTest();
    // Skip-by-pass-through outside a git checkout — the format regex above
    // already covers the bare-semver branch in those environments.
    if (sha === null) {
      expect(VERSION).toMatch(SEMVER_OR_SEMVER_WITH_SHA);
      return;
    }
    const baseVersion = readPackageVersion();
    expect(VERSION).toBe(`${baseVersion}-${sha}`);
  });
});
