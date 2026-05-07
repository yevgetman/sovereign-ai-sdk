import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetProjectIdCache, getProjectId } from '../../src/learning/project.js';

describe('getProjectId', () => {
  let cwd: string;

  beforeEach(() => {
    _resetProjectIdCache();
    cwd = mkdtempSync(join(tmpdir(), 'sov-projid-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('falls back to realpath hash when not a git repo', () => {
    const result = getProjectId(cwd);
    expect(result.id).toMatch(/^[a-f0-9]{16}$/);
    expect(result.name.length).toBeGreaterThan(0);
  });

  test('uses git remote URL when present', () => {
    spawnSync('git', ['init', '-q', cwd]);
    spawnSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:owner/myrepo.git']);
    const result = getProjectId(cwd);
    expect(result.name).toBe('myrepo');
    // hash should be of the remote URL, not the cwd
    expect(result.id).toMatch(/^[a-f0-9]{16}$/);
  });

  test('caches result for same cwd', () => {
    const a = getProjectId(cwd);
    const b = getProjectId(cwd);
    expect(a).toBe(b); // same object reference
  });

  test('different cwd → different id when no shared git remote', () => {
    const cwd2 = mkdtempSync(join(tmpdir(), 'sov-projid-2-'));
    try {
      const a = getProjectId(cwd);
      const b = getProjectId(cwd2);
      expect(a.id).not.toBe(b.id);
    } finally {
      rmSync(cwd2, { recursive: true, force: true });
    }
  });
});
