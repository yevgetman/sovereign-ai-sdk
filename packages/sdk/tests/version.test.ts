// VERSION format + SHA-source regression pins — backlog #37, audit E2/E4.
//
// The SHA suffix is now DETERMINISTIC and GIT-FREE: the only source is the SDK's
// own `<packageRoot>/.bun-tag`. No `git rev-parse` subprocess runs at runtime, so
// NO consumer layout can leak a foreign HEAD into VERSION (which would otherwise
// travel over the wire via mcp/client and onto disk via transcript records). We
// pin both the format and the elimination of runtime git.
//
// Phase 3 (the package move): VERSION is the SDK PACKAGE's version (the 0.1.x
// line from packages/sdk/package.json, resolved by version.ts's runtime walk-up),
// NOT the harness root's 0.6.x line — so the base is read from THIS package's
// manifest, located relative to this test file.

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION, composeVersion, resolveShaSuffix } from '@yevgetman/sov-sdk/version';

const SEMVER_OR_SEMVER_WITH_SHA = /^\d+\.\d+\.\d+(-[a-f0-9]{7,})?$/;

const SDK_PACKAGE_JSON = join(import.meta.dir, '..', 'package.json');
const VERSION_SOURCE_PATH = join(import.meta.dir, '..', 'src', 'version.ts');

function readPackageVersion(): string {
  const raw = readFileSync(SDK_PACKAGE_JSON, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('VERSION', () => {
  test('matches bare semver or semver-with-short-sha shape', () => {
    expect(VERSION).toMatch(SEMVER_OR_SEMVER_WITH_SHA);
  });

  test('starts with the package.json version field', () => {
    const baseVersion = readPackageVersion();
    expect(VERSION.startsWith(baseVersion)).toBe(true);
  });

  // No `.bun-tag` ships in the SDK's own dev checkout, so a plain dev/source-mode
  // import reports the BARE base version — never a live git SHA. (A release build
  // that wants an embedded SHA injects it at build time; runtime git is gone.)
  test('is the bare base version in a plain source-mode import (no runtime git SHA)', () => {
    expect(VERSION).toBe(readPackageVersion());
  });
});

// ── audit E4: eliminate the runtime-git SHA class BY REMOVAL. The shipped module
// must contain no `git` spawn at all — that is the only spoof-proof guarantee.
describe('version module — no runtime git (class eliminated by elimination)', () => {
  test('the source imports no subprocess API and makes no spawn/exec call', () => {
    const src = readFileSync(VERSION_SOURCE_PATH, 'utf8');
    // The definitive guarantee: with no child_process import there is no way to
    // spawn git (or anything) at runtime — the SHA-leak class cannot recur.
    expect(src).not.toContain('child_process');
    expect(src).not.toContain('spawnSync');
    expect(src).not.toContain('execFileSync');
    expect(src).not.toContain('execSync(');
  });
});

// ── audit E4 (F17/F18/F19 + C8 class, closed): the SHA resolver must NEVER read a
// consumer's git repo. Every historical leak layout is exercised here; all yield
// NO suffix because resolveShaSuffix only reads `.bun-tag` and never walks a repo.
describe('resolveShaSuffix — deterministic, never leaks a consumer HEAD', () => {
  /** Turn `dir` into a real git repo with a resolvable HEAD, returning its short
   *  SHA. The `-c` identity/gpg flags keep it independent of global git config. */
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

  /** Build a scratch consumer git repo, place the SDK package at `relPkgRoot`
   *  under it, and assert resolveShaSuffix returns null (never the consumer SHA). */
  function expectNoLeak(prefix: string, relPkgRootSegments: readonly string[]): void {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    try {
      const consumerSha = initScratchGitRepo(scratch);
      const pkgRoot = join(scratch, ...relPkgRootSegments);
      mkdirSync(join(pkgRoot, 'src'), { recursive: true });
      writeFileSync(
        join(pkgRoot, 'package.json'),
        JSON.stringify({ name: '@yevgetman/sov-sdk', version: '0.1.0' }),
      );
      // A broad workspaces glob at the consumer root — the C8 spoof shape.
      writeFileSync(
        join(scratch, 'package.json'),
        JSON.stringify({ name: 'consumer', version: '9.9.9', workspaces: ['packages/*'] }),
      );

      const suffix = resolveShaSuffix(pkgRoot);

      expect(suffix).toBeNull();
      expect(suffix).not.toBe(consumerSha);
      expect(composeVersion('0.1.0', suffix)).toBe('0.1.0');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  test('installed under node_modules yields no suffix', () => {
    expectNoLeak('sov-version-nm-', ['node_modules', '@yevgetman', 'sov-sdk']);
  });

  test('vendored (source-copied) outside node_modules yields no suffix', () => {
    expectNoLeak('sov-version-vendor-', ['vendor', 'sov-sdk']);
  });

  test('vendored as a WORKSPACE MEMBER (broad glob) yields no suffix', () => {
    expectNoLeak('sov-version-ws-', ['packages', 'sov-sdk']);
  });

  // THE E4 residual: the SDK source vendored at the CANONICAL `packages/sdk` path
  // — the standard monorepo convention. The old path heuristic accepted this and
  // spawned git in the consumer repo, leaking their HEAD. With runtime git gone
  // it is just another null.
  test('vendored at the canonical packages/sdk path yields no suffix (E4)', () => {
    expectNoLeak('sov-version-canonical-', ['packages', 'sdk']);
  });

  test("the SDK's own source checkout yields no suffix (no .bun-tag → bare version)", () => {
    const ownPkgRoot = join(import.meta.dir, '..');
    expect(resolveShaSuffix(ownPkgRoot)).toBeNull();
  });
});

describe('resolveShaSuffix — .bun-tag is the one trusted SHA source', () => {
  test('a valid 40-hex .bun-tag yields its short SHA', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sov-version-buntag-'));
    try {
      const fullSha = 'a89b03c1234567890abcdef1234567890abcdef0';
      writeFileSync(join(scratch, 'package.json'), JSON.stringify({ version: '0.1.0' }));
      writeFileSync(join(scratch, '.bun-tag'), `${fullSha}\n`);

      const suffix = resolveShaSuffix(scratch);

      expect(suffix).toBe(fullSha.slice(0, 7));
      expect(composeVersion('0.1.0', suffix)).toBe(`0.1.0-${fullSha.slice(0, 7)}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('a malformed .bun-tag (not 40-hex) is ignored → no suffix', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sov-version-buntag-bad-'));
    try {
      writeFileSync(join(scratch, 'package.json'), JSON.stringify({ version: '0.1.0' }));
      writeFileSync(join(scratch, '.bun-tag'), 'not-a-sha\n');
      expect(resolveShaSuffix(scratch)).toBeNull();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('a null package root (Bun-compiled /$bunfs/ mode) yields no suffix', () => {
    expect(resolveShaSuffix(null)).toBeNull();
  });
});
