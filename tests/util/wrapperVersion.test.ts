// Task 3.1 (SDK consumable packaging) — wrapper version-source pins.
// Phase 3 moves src/version.ts (OPEN) into packages/sdk/src/, where its
// `../package.json` import resolves to the SDK's OWN manifest (0.1.x line).
// The proprietary wrapper (sov --version, --harness-version forwarding, the
// gateway + OpenAI /health routes) must stay on the HARNESS release line
// (0.6.x), so it reads src/wrapperVersion.ts — pinned to the ROOT
// package.json. These pins mirror tests/version.test.ts so wrapperVersion
// keeps the same shape + dev-build SHA-suffix semantics (backlog #37):
//   1. bare semver OR semver-with-short-SHA shape;
//   2. always starts with the ROOT package.json `version` field;
//   3. inside a git checkout, exactly `<root-version>-<short-sha>`.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../../src/wrapperVersion.js';

const SEMVER_OR_SEMVER_WITH_SHA = /^\d+\.\d+\.\d+(-[a-f0-9]{7,})?$/;

function readRootPackageVersion(): string {
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

describe('wrapperVersion VERSION', () => {
  test('matches bare semver or semver-with-short-sha shape', () => {
    expect(VERSION).toMatch(SEMVER_OR_SEMVER_WITH_SHA);
  });

  test('starts with the ROOT package.json version field', () => {
    const rootVersion = readRootPackageVersion();
    expect(VERSION.startsWith(rootVersion)).toBe(true);
  });

  test('includes the resolved git short SHA when run inside a git checkout', () => {
    const sha = resolveGitShaForTest();
    // Skip-by-pass-through outside a git checkout — the format regex above
    // already covers the bare-semver branch in those environments.
    if (sha === null) {
      expect(VERSION).toMatch(SEMVER_OR_SEMVER_WITH_SHA);
      return;
    }
    const rootVersion = readRootPackageVersion();
    expect(VERSION).toBe(`${rootVersion}-${sha}`);
  });
});
