import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isReleaseSourceInput,
  reviewedInputs,
  reviewedLicense,
} from '../../scripts/release-inputs';

function fixtureGit(root: string): string {
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=Build Test',
      '-c',
      'user.email=build@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ],
  ]) {
    const result = spawnSync('git', ['-C', root, ...args]);
    if (result.status !== 0) throw new Error('fixture git setup failed');
  }
  return spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

describe('reviewed release inputs', () => {
  test('excludes configuration, captured state, tests, and stale outputs', () => {
    for (const path of [
      '.env',
      'src/.env.local',
      'src/.harness/private.json',
      'packages/sdk/tests/secret.ts',
      'packages/sdk/dist/index.js',
      'bundle-default/state/session.json',
    ]) {
      expect(isReleaseSourceInput(path)).toBe(false);
    }
    for (const path of [
      'src/main.ts',
      'bun.lock',
      'packages/sdk/src/index.ts',
      'bundle-default/state/.gitkeep',
      'bundle-default/BUNDLE-CONTRACT.md',
    ]) {
      expect(isReleaseSourceInput(path)).toBe(true);
    }
  });

  test('pins regular tracked inputs and refuses staged, unstaged, or untracked compile inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-inputs-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/main.ts'), 'source');
      writeFileSync(join(root, 'bun.lock'), '{}');
      const revision = fixtureGit(root);
      const input = reviewedInputs(root);
      expect(input.revision).toBe(revision);
      expect(input.files).toEqual(['bun.lock', 'src/main.ts']);
      expect(input.digest).toHaveLength(64);
      writeFileSync(join(root, 'src/main.ts'), 'dirty');
      expect(() => reviewedInputs(root)).toThrow(/committed and clean/);
      spawnSync('git', ['-C', root, 'add', '.']);
      expect(() => reviewedInputs(root)).toThrow(/committed and clean/);
      spawnSync('git', ['-C', root, 'reset', '--hard', '-q', 'HEAD']);
      writeFileSync(join(root, 'src/untracked.ts'), 'private input');
      expect(() => reviewedInputs(root)).toThrow(/committed and clean/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('license bytes must equal the pinned reviewed revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'sov-license-'));
    try {
      writeFileSync(join(root, 'LICENSE.txt'), 'Copyright legal notices. Provider contact.');
      const revision = fixtureGit(root);
      expect(reviewedLicense(root, revision).sha256).toHaveLength(64);
      expect(() => reviewedLicense(root, '0'.repeat(40))).toThrow(/reviewed revision/);
      writeFileSync(join(root, 'LICENSE.txt'), 'changed contact');
      expect(() => reviewedLicense(root, revision)).toThrow(/reviewed revision/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
