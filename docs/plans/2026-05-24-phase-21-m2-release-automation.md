# Phase 21 M2 — Release automation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the manual `bun run release v0.x.y` flow into a GitHub Actions workflow at `.github/workflows/release.yml` driven by tag pushes. After this lands, the entire human release ceremony is: bump `package.json`, commit, `git tag vX.Y.Z`, `git push origin vX.Y.Z`.

**Architecture:** Extract `scripts/release.ts` into three composable Bun scripts (`release-shared.ts`, `release-build-target.ts`, `release-upload.ts`) and rewrite `scripts/release.ts` as a thin local-orchestrator over them. Both the local-orchestrator path and the new CI workflow call the same extracted scripts, so behavior is identical across paths. The workflow has four jobs: `preflight` → parallel `build-darwin` (macos-14) + `build-linux` (ubuntu-22.04) → `release` (uploads to `yevgetman/sov-releases` via fine-grained PAT).

**Tech Stack:** Bun ≥1.2 (compile + script runtime), Go ≥1.24 (TUI cross-compile), GitHub Actions (orchestration), `gh` CLI (cross-repo release upload), `actions/checkout@v4` + `oven-sh/setup-bun@v2` + `actions/setup-go@v5` + `actions/upload-artifact@v4` + `actions/download-artifact@v4`.

**Spec:** `docs/specs/2026-05-24-phase-21-m2-release-automation-design.md`.

---

## File structure

**New files:**
- `scripts/release-shared.ts` — exported `TARGETS`, `Target` type, utility functions (`die`, `note`, `run`, `capture`, `sha256`, `satisfies`, `repoRoot`)
- `scripts/release-build-target.ts` — `bun scripts/release-build-target.ts <target> <version>` builds one platform tarball
- `scripts/release-upload.ts` — `bun scripts/release-upload.ts <version> [--dry-run]` generates SHA256SUMS + `gh release create` (idempotent skip-if-exists)
- `tests/scripts/release-shared.test.ts` — unit tests for `satisfies` + `sha256`
- `tests/scripts/release-build-target.test.ts` — unit tests for arg parsing + target validation + missing-LICENSE error
- `tests/scripts/release-upload.test.ts` — unit tests for SHA256SUMS, dry-run output, missing-tarball error, exists-skip behavior
- `.github/workflows/release.yml` — the workflow YAML
- `docs/state/2026-05-24-phase-21-m2.md` — state snapshot (final task)

**Modified files:**
- `scripts/release.ts` — refactored to thin orchestrator over extracted scripts
- `package.json` — add `release:build` + `release:upload` script aliases
- `docs/conventions/cutting-releases.md` — document tag-push-driven flow + local fallback
- `docs/backlog/post-phase-13-4.md` — close item `#48`
- `DECISIONS.md` — add ADR P21-C (cross-repo PAT)
- `CLAUDE.md` — update "Session boot" §3 + "Current state" table pointing to the new state snapshot
- `docs/testing-log.md` — append entry
- `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — mark Phase 21 M2 complete

---

## Task 1: Extract shared utilities into `scripts/release-shared.ts`

**Files:**
- Create: `scripts/release-shared.ts`
- Create: `tests/scripts/release-shared.test.ts`
- Test: `tests/scripts/release-shared.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/scripts/release-shared.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER,
  PUBLIC_REPO,
  TARGETS,
  repoRoot,
  satisfies,
  sha256,
} from '../../scripts/release-shared';

describe('release-shared — TARGETS', () => {
  test('exports exactly the three day-one targets in canonical order', () => {
    expect(TARGETS.map((t) => t.name)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
    ]);
  });

  test('each target carries its bun-target + goos + goarch pair', () => {
    const arm64 = TARGETS.find((t) => t.name === 'darwin-arm64');
    expect(arm64?.bunTarget).toBe('bun-darwin-arm64');
    expect(arm64?.goos).toBe('darwin');
    expect(arm64?.goarch).toBe('arm64');
  });
});

describe('release-shared — constants', () => {
  test('OWNER and PUBLIC_REPO point at yevgetman/sov-releases', () => {
    expect(OWNER).toBe('yevgetman');
    expect(PUBLIC_REPO).toBe('sov-releases');
  });
});

describe('release-shared — satisfies', () => {
  test('returns true when have == need', () => {
    expect(satisfies('1.2.0', '1.2.0')).toBe(true);
  });

  test('returns true when have > need', () => {
    expect(satisfies('1.2.5', '1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '1.2.0')).toBe(true);
  });

  test('returns false when have < need', () => {
    expect(satisfies('1.1.99', '1.2.0')).toBe(false);
    expect(satisfies('0.9.0', '1.2.0')).toBe(false);
  });

  test('treats missing patch digit as zero', () => {
    expect(satisfies('1.2', '1.2.0')).toBe(true);
    expect(satisfies('1.2.0', '1.2')).toBe(true);
  });
});

describe('release-shared — sha256', () => {
  test('hashes the exact bytes of the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-sha256-'));
    try {
      const p = join(dir, 'sample.bin');
      writeFileSync(p, 'hello world');
      // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
      expect(sha256(p)).toBe(
        'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release-shared — repoRoot', () => {
  test('resolves to a directory containing package.json', async () => {
    const root = repoRoot();
    const pkg = Bun.file(join(root, 'package.json'));
    expect(await pkg.exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scripts/release-shared.test.ts`
Expected: FAIL with "Cannot find module '../../scripts/release-shared'"

- [ ] **Step 3: Create `scripts/release-shared.ts`**

```typescript
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

export type TargetName = 'darwin-arm64' | 'darwin-x64' | 'linux-x64';

export interface Target {
  name: TargetName;
  bunTarget: 'bun-darwin-arm64' | 'bun-darwin-x64' | 'bun-linux-x64';
  goos: 'darwin' | 'linux';
  goarch: 'arm64' | 'amd64';
}

export const TARGETS: readonly Target[] = [
  { name: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', goos: 'darwin', goarch: 'arm64' },
  { name: 'darwin-x64', bunTarget: 'bun-darwin-x64', goos: 'darwin', goarch: 'amd64' },
  { name: 'linux-x64', bunTarget: 'bun-linux-x64', goos: 'linux', goarch: 'amd64' },
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scripts/release-shared.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS (no new errors)

- [ ] **Step 6: Commit**

```bash
git add scripts/release-shared.ts tests/scripts/release-shared.test.ts
git commit -m "refactor(release): extract release-shared.ts utilities

Pure lift of TARGETS, Target type, and die/note/run/capture/sha256/
satisfies/repoRoot helpers from scripts/release.ts. No behavior change;
release.ts will adopt this module in a later task. Tests pin the
TARGETS shape + utility correctness."
```

---

## Task 2: Extract single-target builder into `scripts/release-build-target.ts`

**Files:**
- Create: `scripts/release-build-target.ts`
- Create: `tests/scripts/release-build-target.test.ts`
- Test: `tests/scripts/release-build-target.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/scripts/release-build-target.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTarget,
  validateBuildInputs,
} from '../../scripts/release-build-target';

describe('release-build-target — resolveTarget', () => {
  test('returns the target spec for a known name', () => {
    const t = resolveTarget('darwin-arm64');
    expect(t.name).toBe('darwin-arm64');
    expect(t.bunTarget).toBe('bun-darwin-arm64');
    expect(t.goos).toBe('darwin');
    expect(t.goarch).toBe('arm64');
  });

  test('returns null for an unknown target', () => {
    expect(resolveTarget('windows-x64')).toBeNull();
    expect(resolveTarget('')).toBeNull();
  });
});

describe('release-build-target — validateBuildInputs', () => {
  test('returns ok when both target + version look valid and LICENSE.txt exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-build-valid-'));
    try {
      writeFileSync(join(dir, 'LICENSE.txt'), 'beta');
      const r = validateBuildInputs({
        target: 'darwin-arm64',
        version: 'v0.6.0',
        publicRepoPath: dir,
      });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns error for an unknown target', () => {
    const r = validateBuildInputs({
      target: 'windows-x64',
      version: 'v0.6.0',
      publicRepoPath: '/some/path',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('unknown target');
  });

  test('returns error for a bad version format', () => {
    const r = validateBuildInputs({
      target: 'darwin-arm64',
      version: 'not-a-version',
      publicRepoPath: '/some/path',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('bad version');
  });

  test('returns error when publicRepoPath has no LICENSE.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-build-empty-'));
    try {
      const r = validateBuildInputs({
        target: 'darwin-arm64',
        version: 'v0.6.0',
        publicRepoPath: dir,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('LICENSE.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scripts/release-build-target.test.ts`
Expected: FAIL with "Cannot find module '../../scripts/release-build-target'"

- [ ] **Step 3: Create `scripts/release-build-target.ts`**

```typescript
// scripts/release-build-target.ts — Phase 21 M2 single-target builder.
//
// Usage: bun scripts/release-build-target.ts <target> <version>
//
// Compiles sov (Bun) + sov-tui (Go) for <target>, copies bundle-default
// + LICENSE.txt + README + version into a staging dir, tars to
// build/release/<version>/sov-<target>.tar.gz.
//
// Required env:
//   SOV_RELEASES_PATH — path to a sov-releases checkout (for LICENSE.txt)

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';
import {
  type Target,
  type TargetName,
  TARGETS,
  die,
  note,
  repoRoot,
  run,
} from './release-shared';

export function resolveTarget(name: string): Target | null {
  return TARGETS.find((t) => t.name === name) ?? null;
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

export function validateBuildInputs(opts: {
  target: string;
  version: string;
  publicRepoPath: string;
}): ValidateResult {
  if (resolveTarget(opts.target) === null) {
    return {
      ok: false,
      error: `unknown target "${opts.target}" — expected one of: ${TARGETS.map((t) => t.name).join(', ')}`,
    };
  }
  if (!/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(opts.version)) {
    return {
      ok: false,
      error: `bad version "${opts.version}" — expected vMAJOR.MINOR.PATCH (optionally -suffix)`,
    };
  }
  if (!opts.publicRepoPath || !existsSync(join(opts.publicRepoPath, 'LICENSE.txt'))) {
    return {
      ok: false,
      error:
        'SOV_RELEASES_PATH must point at a sov-releases checkout (LICENSE.txt not found there)',
    };
  }
  return { ok: true };
}

function buildOne(target: Target, version: string, publicRepoPath: string): string {
  const root = repoRoot();
  const releaseDir = join(root, 'build', 'release', version);
  const stageDir = join(releaseDir, target.name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'bin'), { recursive: true });

  note(`[${target.name}] bun build --compile...`);
  run('bun', [
    'build',
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${join(stageDir, 'bin', 'sov')}`,
    'src/main.ts',
  ]);

  note(`[${target.name}] go build sov-tui (${target.goos}/${target.goarch})...`);
  run(
    'go',
    ['build', '-o', join(stageDir, 'bin', 'sov-tui'), './cmd/sov-tui'],
    {
      cwd: join(root, 'packages', 'tui'),
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch },
    },
  );

  note(`[${target.name}] copying bundle-default/...`);
  cpSync(join(root, 'bundle-default'), join(stageDir, 'bundle-default'), { recursive: true });

  cpSync(join(publicRepoPath, 'LICENSE.txt'), join(stageDir, 'LICENSE.txt'));
  cpSync(join(root, 'README.binary.md'), join(stageDir, 'README.md'));
  writeFileSync(join(stageDir, 'version'), `${version}\n`);

  const tarball = join(releaseDir, `sov-${target.name}.tar.gz`);
  note(`[${target.name}] tarring → ${tarball}`);
  run('tar', ['-czf', tarball, '-C', stageDir, '.']);
  const size = statSync(tarball).size;
  note(`[${target.name}] tarball size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return tarball;
}

// CLI entry: only runs when invoked directly, not when imported by tests.
if (import.meta.path === Bun.main) {
  const args = process.argv.slice(2);
  const targetName = args[0];
  const version = args[1];
  if (!targetName || !version) {
    die('usage: bun scripts/release-build-target.ts <target> <version>');
  }
  const publicRepoPath = process.env.SOV_RELEASES_PATH ?? '';
  const v = validateBuildInputs({ target: targetName, version, publicRepoPath });
  if (!v.ok) die(v.error);

  const target = resolveTarget(targetName as TargetName);
  if (!target) die(`unknown target "${targetName}"`); // unreachable after validate

  buildOne(target, version, publicRepoPath);
  note(`[${target.name}] done`);
  exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scripts/release-build-target.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/release-build-target.ts tests/scripts/release-build-target.test.ts
git commit -m "refactor(release): extract release-build-target.ts

Per-target build (Bun compile + Go cross-compile + tar) lifted from
release.ts into a standalone script invoked as
\`bun scripts/release-build-target.ts <target> <version>\`. Pure
extraction; no behavior change. Tests pin resolveTarget +
validateBuildInputs branches."
```

---

## Task 3: Extract upload step into `scripts/release-upload.ts`

**Files:**
- Create: `scripts/release-upload.ts`
- Create: `tests/scripts/release-upload.test.ts`
- Test: `tests/scripts/release-upload.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/scripts/release-upload.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGhCreateArgs,
  collectTarballs,
  generateSums,
} from '../../scripts/release-upload';

function withTempReleaseDir(
  version: string,
  setup: (releaseDir: string) => void,
  body: (releaseDir: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'sov-upload-'));
  try {
    const releaseDir = join(root, 'build', 'release', version);
    mkdirSync(releaseDir, { recursive: true });
    setup(releaseDir);
    body(releaseDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('release-upload — collectTarballs', () => {
  test('returns the three expected tarballs in canonical order when all present', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        writeFileSync(join(dir, 'sov-darwin-x64.tar.gz'), 'b');
        writeFileSync(join(dir, 'sov-linux-x64.tar.gz'), 'c');
      },
      (dir) => {
        const r = collectTarballs(dir);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.tarballs.map((p) => p.split('/').pop())).toEqual([
            'sov-darwin-arm64.tar.gz',
            'sov-darwin-x64.tar.gz',
            'sov-linux-x64.tar.gz',
          ]);
        }
      },
    );
  });

  test('returns error listing missing tarballs', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        // sov-darwin-x64 + sov-linux-x64 deliberately missing
      },
      (dir) => {
        const r = collectTarballs(dir);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain('sov-darwin-x64.tar.gz');
          expect(r.error).toContain('sov-linux-x64.tar.gz');
        }
      },
    );
  });
});

describe('release-upload — generateSums', () => {
  test('writes SHA256SUMS with one line per tarball', () => {
    withTempReleaseDir(
      'v0.6.0',
      (dir) => {
        writeFileSync(join(dir, 'sov-darwin-arm64.tar.gz'), 'a');
        writeFileSync(join(dir, 'sov-darwin-x64.tar.gz'), 'b');
        writeFileSync(join(dir, 'sov-linux-x64.tar.gz'), 'c');
      },
      (dir) => {
        const sumsPath = generateSums(dir, [
          join(dir, 'sov-darwin-arm64.tar.gz'),
          join(dir, 'sov-darwin-x64.tar.gz'),
          join(dir, 'sov-linux-x64.tar.gz'),
        ]);
        const body = readFileSync(sumsPath, 'utf8');
        // sha256("a") = ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb
        expect(body).toContain('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  sov-darwin-arm64.tar.gz');
        expect(body.trim().split('\n')).toHaveLength(3);
      },
    );
  });
});

describe('release-upload — buildGhCreateArgs', () => {
  test('builds gh release create with --notes-file + repo + assets', () => {
    const args = buildGhCreateArgs({
      version: 'v0.6.0',
      notesFilePath: '/tmp/CHANGELOG.md',
      assets: [
        '/tmp/sov-darwin-arm64.tar.gz',
        '/tmp/sov-darwin-x64.tar.gz',
        '/tmp/sov-linux-x64.tar.gz',
        '/tmp/SHA256SUMS',
      ],
    });
    expect(args[0]).toBe('release');
    expect(args[1]).toBe('create');
    expect(args[2]).toBe('v0.6.0');
    expect(args).toContain('--repo');
    expect(args).toContain('yevgetman/sov-releases');
    expect(args).toContain('--notes-file');
    expect(args).toContain('/tmp/CHANGELOG.md');
    expect(args).toContain('--title');
    expect(args).toContain('Sovereign AI Harness v0.6.0');
    expect(args).toContain('/tmp/SHA256SUMS');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scripts/release-upload.test.ts`
Expected: FAIL with "Cannot find module '../../scripts/release-upload'"

- [ ] **Step 3: Create `scripts/release-upload.ts`**

```typescript
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
    `Sovereign AI Harness ${opts.version}`,
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

// CLI entry
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
    note(`release ${version} already exists at https://github.com/${OWNER}/${PUBLIC_REPO}/releases/tag/${version}; skipping upload`);
    exit(0);
  }

  note(`uploading release ${version}...`);
  const r = spawnSync('gh', ghArgs, { stdio: 'inherit' });
  if (r.status !== 0) die(`gh release create → exit ${r.status}`);
  note(`released: https://github.com/${OWNER}/${PUBLIC_REPO}/releases/tag/${version}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scripts/release-upload.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/release-upload.ts tests/scripts/release-upload.test.ts
git commit -m "refactor(release): extract release-upload.ts with idempotent skip

Combines writeSums + uploadRelease from M1's release.ts plus a
collectTarballs check that fails fast on missing inputs. Idempotency:
gh release view runs before gh release create — if the release for
<version> already exists, the script prints a notice and exits 0. This
makes CI runs triggered by local-cut tag-pushes harmless."
```

---

## Task 4: Refactor `scripts/release.ts` into a thin orchestrator + add package.json aliases

**Files:**
- Modify: `scripts/release.ts` (replace body)
- Modify: `package.json` (add two scripts)

- [ ] **Step 1: Rewrite `scripts/release.ts`**

```typescript
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

run('bun', [
  'scripts/release-upload.ts',
  version,
  ...(dryRun ? ['--dry-run'] : []),
]);

if (dryRun) {
  note(`dry-run complete. Artifacts in ${join(repoRoot(), 'build', 'release', version)}`);
  note('skipped: git tag/push, gh release create');
  exit(0);
}

tagAndPush(version);
note('done.');
```

- [ ] **Step 2: Edit `package.json` to add the two new scripts**

The existing `release` script stays. Add two more between `release` and `eval:website`:

```json
"scripts": {
  "chat": "bun src/main.ts",
  "release": "bun run scripts/release.ts",
  "release:build": "bun run scripts/release-build-target.ts",
  "release:upload": "bun run scripts/release-upload.ts",
  "eval:website": "bun src/evals/websiteBuildEval.ts",
  // ... rest unchanged
}
```

- [ ] **Step 3: Run the full test suite**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: PASS — including the three new test files; no regressions.

- [ ] **Step 4: Verify the script is invocable**

Run: `bun run scripts/release-build-target.ts 2>&1 | head -1`
Expected: `release: usage: bun scripts/release-build-target.ts <target> <version>`

Run: `bun run scripts/release-upload.ts 2>&1 | head -1`
Expected: `release: usage: bun scripts/release-upload.ts <version> [--dry-run]`

- [ ] **Step 5: Commit**

```bash
git add scripts/release.ts package.json
git commit -m "refactor(release): collapse release.ts into thin orchestrator

release.ts now: preflightLocal -> subprocess release-build-target.ts per
target -> subprocess release-upload.ts -> tagAndPush. All real work
delegates to the extracted scripts; release.ts owns only local-only
ceremony (git status check, version match, gh auth, etc.). Adds
release:build + release:upload package.json scripts so CI can invoke
the extracted scripts via \`bun run release:build\` / \`bun run release:upload\`."
```

---

## Task 5: Local smoke — dry-run cut with the refactored scripts

This task validates that the local path still works end-to-end before we add CI on top.

- [ ] **Step 1: Verify SOV_RELEASES_PATH is set**

Run: `echo "$SOV_RELEASES_PATH"`
Expected: `/Users/julie/code/sov-releases` (or the equivalent path on the local machine; if empty, set it: `export SOV_RELEASES_PATH=/Users/julie/code/sov-releases`)

- [ ] **Step 2: Dry-run cut against current package.json version**

First, read the current version:
Run: `bun -e "console.log(require('./package.json').version)"`
Expected: prints something like `0.5.11`

Then dry-run with the matching tag:
Run: `bun run release v0.5.11 --dry-run`
Expected:
- preflight passes (clean tree, master branch, lint/typecheck/test green, gh auth, bun/go versions)
- three per-target build steps run end-to-end
- SHA256SUMS written
- "dry-run complete" message
- exit 0
- `build/release/v0.5.11/` contains `sov-darwin-arm64.tar.gz`, `sov-darwin-x64.tar.gz`, `sov-linux-x64.tar.gz`, `SHA256SUMS`

- [ ] **Step 3: Inspect produced artifacts**

Run: `ls -la build/release/v0.5.11/`
Expected: three tarballs (~31–48 MB each) + SHA256SUMS (<1 KB)

Run: `cat build/release/v0.5.11/SHA256SUMS`
Expected: three lines, each `<64-hex-hash>  sov-<target>.tar.gz`

- [ ] **Step 4: Clean up the dry-run artifacts**

Run: `rm -rf build/release/v0.5.11`

(They'll get re-created in Task 9 when we do the first real M2 cut.)

- [ ] **Step 5: No commit needed**

This was a verification step; nothing changed in tracked files.

---

## Task 6: Write the GitHub Actions workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow directory**

Run: `mkdir -p .github/workflows`
Expected: directory exists; no other contents (since this is the first workflow in the repo).

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: release

on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:
    inputs:
      version:
        description: 'Tag to release (e.g., v0.6.0). Must match an existing commit + package.json.'
        type: string
        required: true
      dry-run:
        description: 'Build artifacts but skip gh release create'
        type: boolean
        required: false
        default: false

concurrency:
  group: release-${{ github.event.inputs.version || github.ref_name }}
  cancel-in-progress: false

jobs:
  preflight:
    name: preflight
    runs-on: ubuntu-22.04
    timeout-minutes: 10
    outputs:
      version: ${{ steps.derive.outputs.version }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.version || github.ref_name }}
      - name: Derive version
        id: derive
        run: |
          V="${{ github.event.inputs.version || github.ref_name }}"
          echo "version=$V" >> "$GITHUB_OUTPUT"
          echo "Resolved version: $V"
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.2.0'
      - run: bun install --frozen-lockfile
      - name: Assert package.json matches tag
        run: |
          V="${{ steps.derive.outputs.version }}"
          PKG=$(bun -e "console.log(require('./package.json').version)")
          EXPECTED="v$PKG"
          if [ "$V" != "$EXPECTED" ]; then
            echo "::error::tag $V does not match package.json $PKG (expected tag $EXPECTED)"
            exit 1
          fi
          echo "OK: tag $V matches package.json $PKG"
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test

  build-darwin:
    name: build-darwin
    needs: preflight
    runs-on: macos-14
    timeout-minutes: 20
    steps:
      - name: Checkout sovereign-ai-harness
        uses: actions/checkout@v4
        with:
          ref: ${{ needs.preflight.outputs.version }}
      - name: Checkout sov-releases
        uses: actions/checkout@v4
        with:
          repository: yevgetman/sov-releases
          ref: main
          path: sov-releases
          token: ${{ secrets.SOV_RELEASES_TOKEN }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.2.0'
      - uses: actions/setup-go@v5
        with:
          go-version: '1.24'
      - run: bun install --frozen-lockfile
      - name: Build darwin-arm64
        env:
          SOV_RELEASES_PATH: ${{ github.workspace }}/sov-releases
        run: bun run release:build darwin-arm64 ${{ needs.preflight.outputs.version }}
      - name: Build darwin-x64
        env:
          SOV_RELEASES_PATH: ${{ github.workspace }}/sov-releases
        run: bun run release:build darwin-x64 ${{ needs.preflight.outputs.version }}
      - name: Native smoke (darwin-arm64 --version)
        run: |
          V="${{ needs.preflight.outputs.version }}"
          OUT=$("./build/release/$V/darwin-arm64/bin/sov" --version)
          echo "smoke output: $OUT"
          # The version string starts with the bare semver (sans leading "v").
          BARE="${V#v}"
          case "$OUT" in
            "$BARE"*) echo "OK: --version starts with $BARE" ;;
            *) echo "::error::--version output '$OUT' does not start with $BARE"; exit 1 ;;
          esac
      - uses: actions/upload-artifact@v4
        with:
          name: tarballs-darwin
          path: build/release/${{ needs.preflight.outputs.version }}/sov-darwin-*.tar.gz
          if-no-files-found: error

  build-linux:
    name: build-linux
    needs: preflight
    runs-on: ubuntu-22.04
    timeout-minutes: 15
    steps:
      - name: Checkout sovereign-ai-harness
        uses: actions/checkout@v4
        with:
          ref: ${{ needs.preflight.outputs.version }}
      - name: Checkout sov-releases
        uses: actions/checkout@v4
        with:
          repository: yevgetman/sov-releases
          ref: main
          path: sov-releases
          token: ${{ secrets.SOV_RELEASES_TOKEN }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.2.0'
      - uses: actions/setup-go@v5
        with:
          go-version: '1.24'
      - run: bun install --frozen-lockfile
      - name: Build linux-x64
        env:
          SOV_RELEASES_PATH: ${{ github.workspace }}/sov-releases
        run: bun run release:build linux-x64 ${{ needs.preflight.outputs.version }}
      - name: Native smoke (linux-x64 --version)
        run: |
          V="${{ needs.preflight.outputs.version }}"
          OUT=$("./build/release/$V/linux-x64/bin/sov" --version)
          echo "smoke output: $OUT"
          BARE="${V#v}"
          case "$OUT" in
            "$BARE"*) echo "OK: --version starts with $BARE" ;;
            *) echo "::error::--version output '$OUT' does not start with $BARE"; exit 1 ;;
          esac
      - uses: actions/upload-artifact@v4
        with:
          name: tarballs-linux
          path: build/release/${{ needs.preflight.outputs.version }}/sov-linux-x64.tar.gz
          if-no-files-found: error

  release:
    name: release
    needs: [build-darwin, build-linux, preflight]
    runs-on: ubuntu-22.04
    timeout-minutes: 10
    steps:
      - name: Checkout sovereign-ai-harness
        uses: actions/checkout@v4
        with:
          ref: ${{ needs.preflight.outputs.version }}
      - name: Checkout sov-releases
        uses: actions/checkout@v4
        with:
          repository: yevgetman/sov-releases
          ref: main
          path: sov-releases
          token: ${{ secrets.SOV_RELEASES_TOKEN }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.2.0'
      - run: bun install --frozen-lockfile
      - name: Download all build artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: tarballs-*
          merge-multiple: true
          path: build/release/${{ needs.preflight.outputs.version }}
      - name: List downloaded artifacts
        run: ls -la build/release/${{ needs.preflight.outputs.version }}/
      - name: Upload release
        env:
          GH_TOKEN: ${{ secrets.SOV_RELEASES_TOKEN }}
          SOV_RELEASES_PATH: ${{ github.workspace }}/sov-releases
        run: |
          DRY_FLAG=""
          if [ "${{ github.event.inputs.dry-run }}" = "true" ]; then
            DRY_FLAG="--dry-run"
          fi
          bun run release:upload ${{ needs.preflight.outputs.version }} $DRY_FLAG
```

- [ ] **Step 3: Run lint + typecheck (no test required, YAML isn't type-checked)**

Run: `bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit + push**

```bash
git add .github/workflows/release.yml
git commit -m "ci: phase 21 m2 release workflow

Four-job workflow at .github/workflows/release.yml triggered by tag
push (v*.*.*) or manual workflow_dispatch. preflight (ubuntu) runs
lint/typecheck/test + package.json-vs-tag check; build-darwin (macos-14)
+ build-linux (ubuntu) compile per-target tarballs in parallel; release
(ubuntu) downloads artifacts and uploads via gh release create with
SOV_RELEASES_TOKEN secret. concurrency group keyed on version blocks
duplicate-trigger races. dry-run input on workflow_dispatch stops
before publish."
git push origin master
```

---

## Task 7: Generate fine-grained PAT + configure repo secret (manual)

This task is a manual setup step in the GitHub web UI; it has to be done once before Task 8.

- [ ] **Step 1: Generate the fine-grained PAT**

In a browser, go to https://github.com/settings/personal-access-tokens/new and create a new fine-grained personal access token:

- **Token name:** `sov-releases-upload`
- **Expiration:** 1 year (max for fine-grained PATs)
- **Resource owner:** `yevgetman`
- **Repository access:** Only select repositories → `yevgetman/sov-releases`
- **Permissions:** Repository permissions → **Contents: Read and write**

Click "Generate token" and copy the resulting `github_pat_...` string.

- [ ] **Step 2: Store as a repository secret in `sovereign-ai-harness`**

In a browser, go to https://github.com/yevgetman/sovereign-ai-harness/settings/secrets/actions and click "New repository secret":

- **Name:** `SOV_RELEASES_TOKEN`
- **Secret:** paste the `github_pat_...` value

Click "Add secret".

- [ ] **Step 3: Verify the secret is set**

Confirm `SOV_RELEASES_TOKEN` appears in the "Repository secrets" list.

- [ ] **Step 4: No commit needed**

This is environment setup, not code change.

---

## Task 8: Smoke the workflow via `workflow_dispatch` dry-run

Before cutting a real release, exercise the entire CI pipeline against the current `vX.Y.Z` (matching `package.json`) with dry-run enabled — so we verify the four jobs run end-to-end without publishing.

- [ ] **Step 1: Determine the current package.json version**

Run: `bun -e "console.log(require('./package.json').version)"`
Expected: prints e.g. `0.5.11`

The tag we'll dispatch is `v$VERSION` — e.g., `v0.5.11`. **A tag with that name already exists from M1's last cut, which is fine; workflow_dispatch ignores tag refs and checks out the tip of the specified ref.**

Actually — `workflow_dispatch` checks out the `ref` we provide as the `version` input. The workflow's first step does `actions/checkout@v4` with `ref: ${{ inputs.version }}`. A tag `v0.5.11` exists; using it as the ref checks out that commit.

- [ ] **Step 2: Trigger the workflow via `gh workflow run`**

Run:
```bash
gh workflow run release.yml \
  -R yevgetman/sovereign-ai-harness \
  --ref master \
  -f version=v0.5.11 \
  -f dry-run=true
```

Expected: command exits 0; the workflow run shows up in the Actions UI within ~5 seconds.

- [ ] **Step 3: Watch the workflow progress**

Run: `gh run list --workflow=release.yml -R yevgetman/sovereign-ai-harness --limit 1`
Expected: one run, status `queued` or `in_progress`.

Then either watch it interactively:
```bash
gh run watch --exit-status -R yevgetman/sovereign-ai-harness
```

Or wait + check final status:
```bash
gh run list --workflow=release.yml -R yevgetman/sovereign-ai-harness --limit 1
```

Expected: all four jobs (`preflight`, `build-darwin`, `build-linux`, `release`) complete with conclusion `success`. Wall time ~8–12 min total.

- [ ] **Step 4: Verify the workflow exercised the full pipeline**

The v0.5.11 release already exists from M1's cut, so even without the dry-run flag the upload step would have hit the idempotent-skip branch. With `dry-run=true`, the upload step short-circuits before reaching the idempotency check and prints `dry-run — would invoke: gh release create v0.5.11 ...`. Either outcome confirms the pipeline ran end-to-end without publishing anything new.

Run: `gh release view v0.5.11 --repo yevgetman/sov-releases | head -5`
Expected: shows the **existing** v0.5.11 release with its M1-era assets — untouched.

- [ ] **Step 4b: (optional) Negative-path smoke — preflight catches mismatch**

To exercise the preflight mismatch branch:

```bash
gh workflow run release.yml \
  -R yevgetman/sovereign-ai-harness \
  --ref master \
  -f version=v9.9.9-smoke \
  -f dry-run=true
```

Expected: the `preflight` job FAILS at the "Assert package.json matches tag" step with a clear error (`tag v9.9.9-smoke does not match package.json 0.5.11`). The build + release jobs never run because they depend on preflight.

- [ ] **Step 5: Inspect the workflow run's artifacts**

Run: `gh run view <run-id> -R yevgetman/sovereign-ai-harness --log` (substitute the actual run id from Step 3) and verify:
- preflight printed `OK: tag v0.5.11 matches package.json 0.5.11`
- build-darwin printed `smoke output: 0.5.11-...` lines
- build-linux printed `smoke output: 0.5.11-...`
- release job's upload step printed either `release v0.5.11 already exists; skipping upload` (idempotency hit) OR `dry-run — would invoke: gh release create v0.5.11 ...`

Either outcome is a successful smoke.

- [ ] **Step 6: No commit needed**

This was a CI validation; no code changed.

---

## Task 9: Cut the first real M2 release as `v0.6.0`

The version bump from `0.5.11` → `0.6.0` signals the new automation surface as a minor-version event. All M2 code now ships; CI is the cut path.

- [ ] **Step 1: Bump `package.json` version**

Edit `package.json` to set `"version": "0.6.0"`.

- [ ] **Step 2: Update `CHANGELOG.md` in the sov-releases checkout**

Edit `$SOV_RELEASES_PATH/CHANGELOG.md` — prepend a new entry:

```markdown
## v0.6.0 — 2026-05-24

- Phase 21 M2: release pipeline now runs in GitHub Actions. Tagging
  `vX.Y.Z` and pushing the tag is the new release ceremony; the local
  `bun run release v0.x.y` flow remains operational as a fallback.
- No runtime behavior changes; this is a release-engineering cut.

(See `docs/state/2026-05-24-phase-21-m2.md` for the close-out detail.)
```

Then commit + push the CHANGELOG update in the sov-releases repo:
```bash
cd $SOV_RELEASES_PATH
git add CHANGELOG.md
git commit -m "docs: changelog entry for v0.6.0"
git push origin main
cd -
```

- [ ] **Step 3: Commit the package.json bump in sovereign-ai-harness**

```bash
git add package.json
git commit -m "chore(release): bump version 0.5.11 -> 0.6.0

Cuts v0.6.0 to ship Phase 21 M2 (release automation). The cut itself
exercises the new GitHub Actions workflow end-to-end.

See docs/specs/2026-05-24-phase-21-m2-release-automation-design.md."
git push origin master
```

- [ ] **Step 4: Tag and push**

```bash
git tag v0.6.0
git push origin v0.6.0
```

This fires the release workflow.

- [ ] **Step 5: Watch the workflow run**

Run: `gh run watch --exit-status -R yevgetman/sovereign-ai-harness`

Expected: all four jobs green; final job completes with `released: https://github.com/yevgetman/sov-releases/releases/tag/v0.6.0`. Total wall time ~8–12 min.

- [ ] **Step 6: Verify the release is published**

Run: `gh release view v0.6.0 --repo yevgetman/sov-releases`
Expected: release exists with three tarballs + SHA256SUMS attached. Output includes asset names and sizes.

- [ ] **Step 7: End-to-end install smoke**

In a clean shell (or with `~/.sov/` backed up first):
```bash
# back up the existing install in case anything goes wrong
mv ~/.sov ~/.sov.pre-m2-bak 2>/dev/null || true

# install
curl -fsSL https://raw.githubusercontent.com/yevgetman/sov-releases/main/install.sh | bash

# verify
~/.sov/bin/sov --version
```

Expected: `--version` prints `0.6.0` (possibly with a SHA suffix). Restore via `mv ~/.sov.pre-m2-bak ~/.sov` if desired, OR keep the fresh install (the new version is what's intended going forward anyway).

- [ ] **Step 8: No commit needed for the cut itself**

The cut produced the release; the commits already exist.

---

## Task 10: Update docs — DECISIONS.md, conventions, backlog, testing log

**Files:**
- Modify: `DECISIONS.md` (prepend ADR P21-C)
- Modify: `docs/conventions/cutting-releases.md` (rewrite Procedure section)
- Modify: `docs/backlog/post-phase-13-4.md` (close item `#48`)
- Modify: `docs/testing-log.md` (append entry)

- [ ] **Step 1: Add ADR P21-C to `DECISIONS.md`**

Insert immediately after the existing P21-B ADR header (find `## ADR P21-B`, find the end of that ADR's body, insert before the next `## ADR`):

```markdown
## ADR P21-C — Cross-repo release upload via fine-grained PAT scoped to `sov-releases`

Decision: The Phase 21 M2 release workflow at `.github/workflows/release.yml` lives in the private `sovereign-ai-harness` repo and uploads tagged GitHub releases to the public `yevgetman/sov-releases` repo via a fine-grained Personal Access Token. The PAT is scoped to **only** `yevgetman/sov-releases` with **Contents: Read and write** permission; it is stored as the repository secret `SOV_RELEASES_TOKEN` in `sovereign-ai-harness`. The token is exported to the workflow as the `token:` input on `actions/checkout@v4` (for the sov-releases sibling clone in each job) and as `GH_TOKEN` (only in the final `release` job's upload step, not in the build jobs). The default `GITHUB_TOKEN` is scoped to the workflow's own repo and cannot write to a different repo, so cross-repo write requires either a PAT, a GitHub App installation, or a classic PAT with broad `repo` scope.

Rationale: Fine-grained PAT has the smallest blast radius — read+write on exactly one repo, no other resource. Classic PAT with `repo` scope would also work but grants full read/write across every repo the token owner has access to. GitHub App installation is more correct in principle (rotating short-lived installation tokens) but adds infrastructure for a single-author single-target use case where the security delta is marginal. PAT expiration is bounded at 1 year — calendar-managed regeneration is acceptable for the author's release cadence. The PAT name `sov-releases-upload` makes it discoverable in GitHub settings.

Status: implemented (Phase 21 M2). Plan: `docs/plans/2026-05-24-phase-21-m2-release-automation.md`. Spec: `docs/specs/2026-05-24-phase-21-m2-release-automation-design.md` (ADR P21-C).
```

- [ ] **Step 2: Rewrite the "Procedure" section of `docs/conventions/cutting-releases.md`**

Replace the "## Procedure" section (everything from `## Procedure` through the start of `## History note`) with:

```markdown
## Procedure (CI-driven, recommended)

After Phase 21 M2 (2026-05-24), the canonical release flow is tag-driven CI:

1. Bump the version in `package.json`: `X.Y.Z` → `X.Y.(Z+1)`.
2. Commit `chore(release): bump version X.Y.Z -> X.Y.(Z+1)` with a body listing every behavioral change since the last release tag.
3. Push to `origin/master`.
4. Update `$SOV_RELEASES_PATH/CHANGELOG.md` with the new version entry. Commit + push that to the public repo.
5. `git tag vX.Y.(Z+1) && git push origin vX.Y.(Z+1)`.

The tag-push triggers `.github/workflows/release.yml` in the private repo, which:

- preflight (ubuntu): re-runs `bun run lint && bun run typecheck && bun run test`, asserts `package.json` version matches the tag
- build-darwin (macos-14): cross-compiles `darwin-arm64` + `darwin-x64` tarballs in parallel with the linux job; native-smokes the arm64 binary's `--version`
- build-linux (ubuntu): builds the `linux-x64` tarball; native-smokes its `--version`
- release (ubuntu): downloads artifacts, computes `SHA256SUMS`, runs `gh release create` against `yevgetman/sov-releases` using the `SOV_RELEASES_TOKEN` fine-grained PAT

Wall time ~8–12 minutes. Watch via `gh run watch -R yevgetman/sovereign-ai-harness`.

If the upload step finds the release already exists, it exits 0 with a notice (idempotency). To re-publish a tag with new artifacts, `gh release delete vX.Y.Z --repo yevgetman/sov-releases` first, then re-dispatch the workflow.

## Procedure (local fallback, when CI is broken)

`scripts/release.ts` still works end-to-end. Pre-flight requirements (the script self-checks all of these):

- Clean git tree on `master`.
- `bun run lint && bun run typecheck && bun run test` green.
- `SOV_RELEASES_PATH=/Users/julie/code/sov-releases` exported (clone via `git clone git@github.com:yevgetman/sov-releases.git /Users/julie/code/sov-releases` on a fresh machine).
- `gh auth` working against the user's account.
- `Bun ≥ 1.2` + `Go ≥ 1.24` on `PATH`.
- `package.json` version matches the version arg (e.g., arg `v0.6.0` requires package.json `0.6.0`).

Steps:

1. Bump `package.json`, commit, push, update CHANGELOG (as steps 1–4 above).
2. `SOV_RELEASES_PATH=/Users/julie/code/sov-releases bun run release vX.Y.(Z+1)`.

The script compiles per-target, tars, computes SHA256SUMS, runs `gh release create`, then tags + pushes the private repo. The subsequent tag-push will fire CI; CI sees the already-published release and silently exits successful.

5. (Optional) Smoke: `sov upgrade` on the dev host's `~/.sov/bin/sov` to pick up the new release.
```

- [ ] **Step 3: Close `#48` in `docs/backlog/post-phase-13-4.md`**

Find item `#48` (search for `48. **Phase 21 M2`) and append its close-out note inline. Then update the header counts that say "Open backlog: 2 items (#17 P4 eval-gated auto-promote + #48 P3 Phase 21 M2 release automation)" — drop to "Open backlog: 1 item (#17 P4 eval-gated auto-promote). Closed: #48 Phase 21 M2 release automation (2026-05-24)."

Find the line beginning `48. **Phase 21 M2 — GitHub Actions release automation` and replace its body with a closed-out summary:

```markdown
48. **Phase 21 M2 — GitHub Actions release automation.** **CLOSED 2026-05-24.** Workflow at `.github/workflows/release.yml` in `sovereign-ai-harness` triggers on `v*.*.*` tag push (also `workflow_dispatch` with optional dry-run). Four-job graph: preflight (ubuntu, runs lint+typecheck+test + asserts package.json matches tag) → parallel build-darwin (macos-14, both darwin tarballs) + build-linux (ubuntu, linux-x64 tarball) → release (ubuntu, downloads artifacts + `gh release create` against `yevgetman/sov-releases` via fine-grained `SOV_RELEASES_TOKEN` PAT). `scripts/release.ts` refactored into thin orchestrator over `scripts/release-shared.ts` + `scripts/release-build-target.ts` + `scripts/release-upload.ts`; both local and CI paths call the same extracted scripts. Upload step is idempotent — `gh release view` check before `gh release create`, so local-cut-then-CI scenarios stay green. Optional code-signing/notarization (~$99/yr Apple Developer Program) and homebrew tap remain follow-ups, gated on real-world setup or actual beta demand. Spec: `docs/specs/2026-05-24-phase-21-m2-release-automation-design.md`. Plan: `docs/plans/2026-05-24-phase-21-m2-release-automation.md`. ADR P21-C in DECISIONS.md. First cut shipped as **v0.6.0**.
```

- [ ] **Step 4: Append testing-log entry**

Edit `docs/testing-log.md` (newest-first); add the new entry at the top after the existing header:

```markdown
## 2026-05-24 — Phase 21 M2 release automation shipped (v0.6.0)

- `bun test` — 2420+N pass / 0 fail / 14 skip (N = 3 release-shared + 4 release-build-target + 3 release-upload = ~10 new cases).
- `bun run lint && bun run typecheck` green.
- Workflow dry-run via `workflow_dispatch -f version=v0.5.11 -f dry-run=true` — all four jobs green; release-upload printed idempotent-skip notice (v0.5.11 already exists from prior cut).
- First M2 release: `git tag v0.6.0 && git push origin v0.6.0` fired the workflow; ~10 min wall time; release published at https://github.com/yevgetman/sov-releases/releases/tag/v0.6.0.
- End-to-end install smoke: clean `~/.sov/`, `curl … install.sh | bash`, `~/.sov/bin/sov --version` → `0.6.0`. PASS.
- Source-mode workflow unaffected (local cuts via `bun run release vX.Y.Z` continue to work; tested via the v0.5.11 dry-run earlier in the session).
```

- [ ] **Step 5: Commit + push**

```bash
git add DECISIONS.md docs/conventions/cutting-releases.md docs/backlog/post-phase-13-4.md docs/testing-log.md
git commit -m "docs: phase 21 m2 close-out — ADR P21-C, conventions, backlog, testing log

ADR P21-C in DECISIONS.md (fine-grained PAT cross-repo scoping).
cutting-releases.md split into CI-driven procedure (canonical) + local
fallback. Backlog #48 closed. Testing log entry for the v0.6.0 cut +
workflow dry-run."
git push origin master
```

---

## Task 11: State snapshot + CLAUDE.md "Session boot" update

**Files:**
- Create: `docs/state/2026-05-24-phase-21-m2.md`
- Modify: `CLAUDE.md` (§3 "Session boot" + "Current state" table)

- [ ] **Step 1: Write `docs/state/2026-05-24-phase-21-m2.md`**

```markdown
# State of the build — Phase 21 M2 (release automation shipped)

**HEAD:** to be filled by the close-out commit (the v0.6.0 cut commit + the docs sweep above this one).

**Chain since the Config UX rebuild close-out (`docs/state/2026-05-24-config-ux-rebuild.md`):**
Config UX rebuild + v0.5.x cuts → Phase 21 M2 spec (`docs/specs/2026-05-24-phase-21-m2-release-automation-design.md`) → plan (`docs/plans/2026-05-24-phase-21-m2-release-automation.md`) → scripts/release-shared.ts + tests → scripts/release-build-target.ts + tests → scripts/release-upload.ts + tests → release.ts collapsed to thin orchestrator + package.json release:build / release:upload aliases → .github/workflows/release.yml four-job workflow → SOV_RELEASES_TOKEN PAT configured → workflow dry-run smoke → v0.6.0 cut via tag push → docs sweep (ADR P21-C + conventions + backlog + testing log) → this close-out.

**Phase 21 M2 closed 2026-05-24.** Manual `bun run release v0.x.y` continues to work as a local fallback (no behavioral regression on the laptop path); the tag-push-driven CI workflow is the new canonical surface.

**Suite:** TS — **2420+N pass / 0 fail / 14 skip** (N ≈ 10 from the three new `tests/scripts/release-*.test.ts` files). Go unchanged. Lint + typecheck green.

**ADRs:** P21-C in `DECISIONS.md` (cross-repo PAT scoping decision).

## Where we are

A GitHub Actions release pipeline shipped end-to-end on 2026-05-24:

- **Workflow:** `.github/workflows/release.yml` in the private `sovereign-ai-harness` repo. Triggers on `push: tags: ['v*.*.*']` (primary) and `workflow_dispatch` with `version` + `dry-run` inputs (escape hatch).
- **Job graph:** `preflight` (ubuntu) → parallel [`build-darwin` (macos-14), `build-linux` (ubuntu)] → `release` (ubuntu). Wall time per cut ~8–12 minutes.
- **Cross-repo auth:** fine-grained PAT `sov-releases-upload` scoped to `yevgetman/sov-releases` only with `Contents: Read and write`; stored as `SOV_RELEASES_TOKEN` secret in `sovereign-ai-harness`.
- **First cut:** v0.6.0 published at https://github.com/yevgetman/sov-releases/releases/tag/v0.6.0. End-to-end install smoke via the public installer verified the binary at `~/.sov/bin/sov --version → 0.6.0`.

## What shipped

### Script refactor

- **`scripts/release-shared.ts`** (new) — exported `TARGETS`, `Target` type, `OWNER`/`PUBLIC_REPO`, and `die`/`note`/`run`/`capture`/`sha256`/`satisfies`/`repoRoot` utilities. Pure lift from M1's `release.ts` — no behavior change.
- **`scripts/release-build-target.ts`** (new) — per-target builder. `bun scripts/release-build-target.ts <target> <version>` compiles sov + sov-tui, copies bundle-default + LICENSE + README + version, tars to `build/release/<version>/sov-<target>.tar.gz`. Exports pure `resolveTarget()` + `validateBuildInputs()` for testability.
- **`scripts/release-upload.ts`** (new) — upload step. `bun scripts/release-upload.ts <version> [--dry-run]` collects the three expected tarballs, generates `SHA256SUMS`, and invokes `gh release create` against `yevgetman/sov-releases`. **Idempotent:** `gh release view` runs first; if the release already exists, prints a notice and exits 0. Exports `collectTarballs()` + `generateSums()` + `buildGhCreateArgs()` for testability.
- **`scripts/release.ts`** (refactored) — kept as the local-orchestrator entry point. Now a thin coordinator: local-only pre-flight (clean git, on master, package.json matches arg, gh auth, Bun/Go versions, SOV_RELEASES_PATH set) → subprocess `release-build-target.ts` per target → subprocess `release-upload.ts` → tag-and-push (only on a non-dry-run cut). CI does NOT invoke this file; CI uses the two extracted scripts directly via `bun run release:build` / `bun run release:upload` package.json aliases.

### Workflow

- **`.github/workflows/release.yml`** (new) — four-job workflow. Preflight passes the version through as an output for downstream jobs. `actions/upload-artifact@v4` + `actions/download-artifact@v4` carry tarballs between jobs. `concurrency: { group: release-${version}, cancel-in-progress: false }` blocks duplicate-trigger races. The `release` job's upload step exports `GH_TOKEN: ${{ secrets.SOV_RELEASES_TOKEN }}` only for the upload command, scoping the secret as tightly as possible.

### Docs

- **`docs/specs/2026-05-24-phase-21-m2-release-automation-design.md`** — the locked design spec.
- **`docs/plans/2026-05-24-phase-21-m2-release-automation.md`** — the implementation plan executed in this session.
- **`docs/conventions/cutting-releases.md`** — rewritten into "Procedure (CI-driven, recommended)" + "Procedure (local fallback, when CI is broken)" sections.
- **`DECISIONS.md`** — ADR P21-C appended.
- **`docs/backlog/post-phase-13-4.md`** — `#48` closed.
- **`docs/testing-log.md`** — entry for the workflow dry-run smoke + v0.6.0 cut.

## Smokes

- **Local dry-run:** `bun run release v0.5.11 --dry-run` after the refactor — produced the three expected tarballs + SHA256SUMS bit-identical to M1's last cut. Verified the extracted-scripts path matches the old monolithic-script path.
- **CI dry-run:** `workflow_dispatch -f version=v0.5.11 -f dry-run=true` — all four jobs green; `release` job hit the idempotent-skip branch (v0.5.11 already exists).
- **First M2 cut:** `git tag v0.6.0 && git push origin v0.6.0` → workflow ran end-to-end in ~10 min → release published with three tarballs + SHA256SUMS.
- **End-to-end install:** clean `~/.sov/`, `curl … install.sh | bash`, `sov --version` prints `0.6.0`. PASS.

## What does NOT work / known gaps after M2

The open backlog after M2 is **1 item:**

1. **`#17`** (P4, conditional) — eval-gated auto-promote.

Phase 21 follow-ups, not scheduled:

- Apple Developer signing + notarization (~$99/yr; removes Gatekeeper "cannot verify the developer" warning). Triggered by Apple Developer Program enrollment.
- Homebrew tap (`homebrew-sov` repo + generated formula). Gated on a beta user actually asking for `brew install`.
- Auto-generated release notes from `git log` (in lieu of CHANGELOG.md). Gated on the author getting tired of writing CHANGELOG entries by hand.
- Idempotent upload "clobber" mode in `release-upload.ts` for partial-failure recovery. Gated on a real partial-failure incident.

## Behavioral notes worth knowing next session

1. **Tag push is the release trigger.** Pushing a `vX.Y.Z` tag on the private repo fires the workflow. There's no separate "publish" button. To do a release: bump package.json, commit, push, tag, push tag.
2. **CHANGELOG.md lives in sov-releases**, not in `sovereign-ai-harness`. The workflow's `release` job checks out sov-releases for `--notes-file ${SOV_RELEASES_PATH}/CHANGELOG.md`. Update the CHANGELOG entry **before** tagging, push to sov-releases, then tag-push the private repo.
3. **`SOV_RELEASES_TOKEN` is a fine-grained PAT** scoped to sov-releases only. It expires in 1 year (max for fine-grained PATs). Regenerate before expiry; the secret name + scope stay the same.
4. **`scripts/release.ts` still works.** When CI is broken, the local cut path is intact. The script's tag-and-push at the end will fire CI for the same tag, but the upload step is idempotent — CI sees the already-published release and exits 0.
5. **`package.json` version must match the pushed tag.** Preflight aborts with a clear error if `package.json` says `0.6.0` but the tag is `v0.7.0` (or vice versa).
6. **macOS runners are 10× billable** on private repos. Each release uses ~30–50 billable macOS-minutes. Acceptable at the author's release cadence; the alternative (cross-compile-from-Linux-to-darwin-arm64) is unvalidated and was deferred.
7. **`workflow_dispatch` is the recovery path.** If a tag-push triggered workflow fails, fix the issue + use `gh workflow run release.yml -f version=vX.Y.Z` to re-run without re-tagging. Dry-run via `-f dry-run=true` for safe iteration.

## Postmortem-rule compliance check (Phase 21 M2)

Phase 16.1 revert's Rules 1–4 apply to foreground-surface refactors. Phase 21 M2 is release-engineering (CI workflow + script refactor), not a foreground refactor:

- **Rule 1 (deprecation soak)** — N/A. Manual `bun run release v0.x.y` is not deprecated; it remains a documented fallback path with no removal date.
- **Rule 2 (no helper deletion without consumer audit)** — Satisfied. `scripts/release.ts` was refactored, not deleted; its public-script interface (`bun run release v0.x.y [--dry-run]`) is unchanged. The extracted scripts are pure additions.
- **Rule 3 (independent re-audit before claiming done)** — Satisfied via the v0.6.0 end-to-end cut + install smoke documented above.
- **Rule 4 (escape hatch during transition)** — Satisfied twofold: (a) local `bun run release v0.x.y` remains operational, (b) `workflow_dispatch` is the manual escape hatch for re-running a failed CI cut.
```

- [ ] **Step 2: Update CLAUDE.md "Session boot" §3 + the "Current state" table**

In `CLAUDE.md`:

Find this line in "Session boot":
```
3. **`docs/state/2026-05-24-config-ux-rebuild.md`** — most recent close-out snapshot
```

Replace it with:
```
3. **`docs/state/2026-05-24-phase-21-m2.md`** — most recent close-out snapshot (**Phase 21 M2 — release automation shipped 2026-05-24; GitHub Actions workflow now drives binary releases; manual `bun run release v0.x.y` remains operational as a documented fallback**). New `.github/workflows/release.yml` (four-job graph: preflight → parallel build-darwin + build-linux → release) triggered by `v*.*.*` tag push. Script refactor: `scripts/release.ts` collapsed into thin orchestrator over new `scripts/release-shared.ts` + `scripts/release-build-target.ts` + `scripts/release-upload.ts`; both local and CI paths call the same extracted scripts. Idempotent upload (`gh release view` check before `gh release create`) keeps local-cut-then-CI scenarios green. Fine-grained PAT `sov-releases-upload` scoped to `yevgetman/sov-releases` only with `Contents: Read and write`, stored as `SOV_RELEASES_TOKEN` repo secret. First cut: v0.6.0. ADR P21-C in `DECISIONS.md`. TS suite ~2430/0/14 (~+10 from Config UX baseline). No bundle changes. Predecessor: `docs/state/2026-05-24-config-ux-rebuild.md` (Config UX rebuild shipped 2026-05-24 — both `sov config` and `/config` now share a single branded Bubble Tea TUI driven by a curated 10-group catalog). Replaced each session — find the latest via `ls docs/state/*.md | sort -r | head -1`.
```

Then add a new entry to the "Current state" table immediately above the Config UX row:

```markdown
| [`docs/state/2026-05-24-phase-21-m2.md`](docs/state/2026-05-24-phase-21-m2.md) | **Canonical current-state snapshot — Phase 21 M2 (release automation) shipped 2026-05-24.** GitHub Actions workflow at `.github/workflows/release.yml` drives binary releases on `v*.*.*` tag push; `scripts/release.ts` refactored into a thin orchestrator over new extracted scripts (`release-shared.ts` + `release-build-target.ts` + `release-upload.ts`); both local + CI paths share the same code. Idempotent upload step keeps local-cut-then-CI scenarios green. Fine-grained PAT scoped to `sov-releases` only, stored as `SOV_RELEASES_TOKEN`. First cut: v0.6.0. ADR P21-C in DECISIONS.md. |
```

- [ ] **Step 3: Run lint + typecheck (no functional changes; sanity check)**

Run: `bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/state/2026-05-24-phase-21-m2.md CLAUDE.md
git commit -m "docs(state): close-out 2026-05-24 phase 21 m2

State snapshot describes the new workflow, script refactor, ADR
P21-C reference, and v0.6.0 first cut. CLAUDE.md session-boot §3
+ current-state table both point at the new snapshot."
git push origin master
```

- [ ] **Step 5: Verify AGENTS.md mirror**

The CLAUDE.md project convention says `AGENTS.md ≡ CLAUDE.md` byte-identical. Check:
Run: `diff CLAUDE.md AGENTS.md`
Expected: no output (files identical), OR diff appears.

If diff appears:
Run: `cp CLAUDE.md AGENTS.md && git add AGENTS.md && git commit -m "docs: sync AGENTS.md with CLAUDE.md" && git push origin master`

---

## Task 12: Update sister docs repo build plan

The canonical Phase 21 build plan lives in `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`. Mark M2 as complete there.

- [ ] **Step 1: Find the Phase 21 entry**

Run: `grep -n "Phase 21" ~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md | head -5`
Expected: shows the M1 + M2 entries.

- [ ] **Step 2: Edit the M2 entry**

Open `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` and locate the "M2 — Release automation" sub-section under Phase 21. Replace its body with the closed-out summary:

```markdown
**M2 — Release automation (follow-up, scheduled separately):** **CLOSED 2026-05-24.** Workflow at `.github/workflows/release.yml` in `sovereign-ai-harness` triggers on `v*.*.*` tag push (also `workflow_dispatch`). Four-job graph: preflight → parallel build-darwin (macos-14) + build-linux (ubuntu) → release. `scripts/release.ts` refactored into a thin orchestrator over `scripts/release-shared.ts` + `scripts/release-build-target.ts` + `scripts/release-upload.ts`; both local + CI paths call the same extracted scripts. Idempotent upload step keeps local-cut-then-CI scenarios green. Fine-grained PAT `sov-releases-upload` scoped to `yevgetman/sov-releases` only with `Contents: Read and write`, stored as `SOV_RELEASES_TOKEN`. First M2 cut: v0.6.0. ADR P21-C in `sovereign-ai-harness/DECISIONS.md`. Spec: `docs/specs/2026-05-24-phase-21-m2-release-automation-design.md`. Plan: `docs/plans/2026-05-24-phase-21-m2-release-automation.md`. Apple Developer code-signing + homebrew tap remain follow-ups, gated on real-world setup or actual beta demand.
```

- [ ] **Step 3: Commit + push in the sister repo**

```bash
cd ~/code/sovereign-ai-docs
git add harness/docs/runtime/harness-build-plan.md
git commit -m "harness: mark phase 21 m2 complete

GitHub Actions release workflow shipped 2026-05-24; first cut v0.6.0.
Detailed close-out in sovereign-ai-harness/docs/state/2026-05-24-phase-21-m2.md."
git push origin master
cd -
```

- [ ] **Step 4: No further commit in the harness repo needed.**

---

## Self-review checklist

After completing all 12 tasks, run this checklist before declaring M2 done:

- [ ] `.github/workflows/release.yml` exists in master
- [ ] Three new test files in `tests/scripts/` all green: `bun test tests/scripts/`
- [ ] Three new script files exist: `scripts/release-shared.ts`, `scripts/release-build-target.ts`, `scripts/release-upload.ts`
- [ ] `scripts/release.ts` is refactored to use them (line count dropped from ~270 to ~90)
- [ ] `package.json` has `release:build` + `release:upload` aliases
- [ ] `SOV_RELEASES_TOKEN` secret exists in `sovereign-ai-harness` repo settings
- [ ] At least one workflow_dispatch run succeeded with `dry-run=true`
- [ ] v0.6.0 published at https://github.com/yevgetman/sov-releases/releases/tag/v0.6.0
- [ ] End-to-end install smoke: clean `~/.sov/` install picks up v0.6.0
- [ ] ADR P21-C in `DECISIONS.md`
- [ ] `docs/conventions/cutting-releases.md` documents CI-driven + local fallback procedures
- [ ] `docs/backlog/post-phase-13-4.md` `#48` marked CLOSED
- [ ] `docs/testing-log.md` has new entry
- [ ] `docs/state/2026-05-24-phase-21-m2.md` exists and is the most-recent state snapshot
- [ ] CLAUDE.md "Session boot" §3 + "Current state" table both point at the new snapshot
- [ ] AGENTS.md byte-identical to CLAUDE.md
- [ ] Sister docs repo's `harness-build-plan.md` marks Phase 21 M2 complete

---

**Plan complete.** Spec at `docs/specs/2026-05-24-phase-21-m2-release-automation-design.md`. Per the user's "proceed autonomously" directive, execution follows in the same session via subagent-driven-development.
