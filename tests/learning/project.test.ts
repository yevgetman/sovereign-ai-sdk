import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';

describe('getProjectId', () => {
  let cwd: string;

  beforeEach(() => {
    __test_resetProjectIdCache();
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

  test('uses git remote URL when present (SSH owner/repo form)', () => {
    spawnSync('git', ['init', '-q', cwd]);
    spawnSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:owner/myrepo.git']);
    const result = getProjectId(cwd);
    // Item 15: nameFromRemote now preserves owner/repo context.
    expect(result.name).toBe('owner/myrepo');
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

// Item 15: exercise nameFromRemote indirectly via getProjectId across the
// full URL-shape matrix the harness sees in the wild. We use git config
// rather than spawning real fetches so the tests are hermetic.
describe('getProjectId — nameFromRemote URL shape coverage', () => {
  let cwd: string;

  beforeEach(() => {
    __test_resetProjectIdCache();
    cwd = mkdtempSync(join(tmpdir(), 'sov-projid-shape-'));
    spawnSync('git', ['init', '-q', cwd]);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function setRemote(url: string): void {
    // Remove any existing origin to allow re-set across test cases.
    spawnSync('git', ['-C', cwd, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
    spawnSync('git', ['-C', cwd, 'remote', 'add', 'origin', url]);
    __test_resetProjectIdCache();
  }

  test('SSH GitHub form → owner/repo', () => {
    setRemote('git@github.com:owner/myrepo.git');
    expect(getProjectId(cwd).name).toBe('owner/myrepo');
  });

  test('HTTPS GitHub form → owner/repo', () => {
    setRemote('https://github.com/owner/myrepo.git');
    expect(getProjectId(cwd).name).toBe('owner/myrepo');
  });

  test('HTTPS nested-namespace (GitLab subgroup) → trailing two segments', () => {
    setRemote('https://example.com/group/sub/repo.git');
    expect(getProjectId(cwd).name).toBe('sub/repo');
  });

  test('SSH Bitbucket form → team/proj', () => {
    setRemote('git@bitbucket.org:team/proj.git');
    expect(getProjectId(cwd).name).toBe('team/proj');
  });

  test('HTTPS without .git suffix → owner/repo', () => {
    setRemote('https://github.com/owner/myrepo');
    expect(getProjectId(cwd).name).toBe('owner/myrepo');
  });

  test('HTTPS with trailing slash → owner/repo', () => {
    setRemote('https://github.com/owner/myrepo.git/');
    expect(getProjectId(cwd).name).toBe('owner/myrepo');
  });

  test('HTTP (insecure) form → owner/repo', () => {
    setRemote('http://github.com/owner/myrepo.git');
    expect(getProjectId(cwd).name).toBe('owner/myrepo');
  });

  test('Bare host/repo (no namespace to preserve) → repo', () => {
    setRemote('https://example.com/repo.git');
    expect(getProjectId(cwd).name).toBe('repo');
  });
});
