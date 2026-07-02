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
//
// Phase 3 (the package move): VERSION is the SDK PACKAGE's version (the
// 0.1.x line from packages/sdk/package.json, resolved by version.ts's
// runtime walk-up), NOT the harness root's 0.6.x line — so the base is
// read from THIS package's manifest, located relative to this test file
// (bun test runs with cwd at the workspace root).

import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION, composeVersion, resolveShaSuffix } from '@yevgetman/sov-sdk/version';

const SEMVER_OR_SEMVER_WITH_SHA = /^\d+\.\d+\.\d+(-[a-f0-9]{7,})?$/;

const SDK_PACKAGE_JSON = join(import.meta.dir, '..', 'package.json');

function readPackageVersion(): string {
  const raw = readFileSync(SDK_PACKAGE_JSON, 'utf8');
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

// ── audit F17/F18/F19: the SHA resolver must NEVER read a consumer's git repo.
// resolveShaSuffix walks up from PKG_DIR to discover a git repo; when the SDK is
// installed as a dependency that walk escapes node_modules into the CONSUMER's
// .git and stamps their private HEAD into VERSION, which then leaks over the
// wire (mcp/client clientInfo.version) and onto disk (transcript records). The
// gate must short-circuit to the bare base version for any installed layout.
describe('resolveShaSuffix (ownership gate)', () => {
  /** Turn `dir` into a real git repo with a resolvable HEAD, returning its
   *  short SHA. The `-c` identity/gpg flags keep it independent of global git
   *  config. */
  function initScratchGitRepo(dir: string): string {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'README'), 'scratch consumer\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=canary',
        '-c',
        'user.email=canary@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'init',
      ],
      { cwd: dir },
    );
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    }).trim();
  }

  test('installed under node_modules inside a consumer git repo yields NO sha suffix (no consumer-SHA leak)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sov-version-gate-'));
    try {
      // The exact leak condition: the consumer's cwd IS a git repo with a real
      // HEAD, and the SDK lives under its node_modules.
      const consumerSha = initScratchGitRepo(scratch);
      const pkgRoot = join(scratch, 'node_modules', '@yevgetman', 'sov-sdk');
      const pkgDir = join(pkgRoot, 'dist');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgRoot, 'package.json'),
        JSON.stringify({ name: '@yevgetman/sov-sdk', version: '0.1.0' }),
      );

      const suffix = resolveShaSuffix(pkgDir, pkgRoot);

      expect(suffix).toBeNull();
      expect(suffix).not.toBe(consumerSha);
      expect(composeVersion('0.1.0', suffix)).toBe('0.1.0');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("the SDK's own source checkout still resolves a live sha suffix (no dev regression)", () => {
    // The live dev layout: PKG_DIR = packages/sdk/src, package root =
    // packages/sdk, both owned by the enclosing monorepo git worktree.
    const ownPkgDir = join(import.meta.dir, '..', 'src');
    const ownPkgRoot = join(import.meta.dir, '..');

    const suffix = resolveShaSuffix(ownPkgDir, ownPkgRoot);
    const head = resolveGitShaForTest();

    if (head === null) {
      // Non-git environment (e.g. tarball CI): no suffix, never a foreign SHA.
      expect(suffix).toBeNull();
    } else {
      expect(suffix).toBe(head);
    }
  });
});
