// Tests for resolveProjectScope (Item 19 — memory project-scoping). Covers
// the four resolution branches plus edge cases: empty/whitespace projectId,
// bundle precedence over git, name fallbacks.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Bundle } from '../../src/bundle/types.js';
import { __test_resetProjectIdCache } from '../../src/learning/project.js';
import { resolveProjectScope } from '../../src/memory/scope.js';

interface FakeBundleOverrides {
  root?: string;
  projectId?: string;
  repo?: string;
}

function makeFakeBundle(overrides: FakeBundleOverrides = {}): Bundle {
  return {
    root: overrides.root ?? '/tmp/fake-bundle-does-not-exist',
    index: {
      ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
      ...(overrides.repo !== undefined ? { repo: overrides.repo } : {}),
    },
    business: new Map(),
    state: { context: null, preferences: null, decisionsMade: null, sessionLog: null },
    schemaPaths: { entity: '', decision: '', openQuestion: '', tags: '' },
  };
}

describe('resolveProjectScope', () => {
  beforeEach(() => {
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    __test_resetProjectIdCache();
  });

  test('bundle with manifest projectId returns it directly', () => {
    const bundle = makeFakeBundle({ projectId: 'sovereign-ai-docs', repo: 'sovereign-ai-docs' });
    const scope = resolveProjectScope({ cwd: '/tmp/anywhere', bundle });
    expect(scope).toEqual({ kind: 'project', id: 'sovereign-ai-docs', name: 'sovereign-ai-docs' });
  });

  test('bundle with manifest projectId but no repo uses projectId as name', () => {
    const bundle = makeFakeBundle({ projectId: 'my-bundle' });
    const scope = resolveProjectScope({ cwd: '/tmp', bundle });
    expect(scope).toEqual({ kind: 'project', id: 'my-bundle', name: 'my-bundle' });
  });

  test('bundle with manifest projectId trims surrounding whitespace', () => {
    const bundle = makeFakeBundle({ projectId: '  trimmed-id  ' });
    const scope = resolveProjectScope({ cwd: '/tmp', bundle });
    expect(scope).toEqual({ kind: 'project', id: 'trimmed-id', name: 'trimmed-id' });
  });

  test('bundle without manifest projectId hashes canonical path', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sov-bundle-'));
    try {
      const bundle = makeFakeBundle({ root: tmpRoot, repo: 'my-bundle' });
      const scope = resolveProjectScope({ cwd: '/tmp', bundle });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      expect(scope.id).toMatch(/^[a-f0-9]{16}$/);
      // Name comes from the repo field when set.
      expect(scope.name).toBe('my-bundle');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('bundle without manifest or repo uses basename of canonical root as name', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sov-bundle-'));
    try {
      const bundle = makeFakeBundle({ root: tmpRoot });
      const scope = resolveProjectScope({ cwd: '/tmp', bundle });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      expect(scope.name).toBe(basename(realpathSync(tmpRoot)));
      expect(scope.id).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('bundle with whitespace-only projectId falls through to hash', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sov-bundle-'));
    try {
      const bundle = makeFakeBundle({ root: tmpRoot, projectId: '   ' });
      const scope = resolveProjectScope({ cwd: '/tmp', bundle });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      // Should be the hash, not the empty string.
      expect(scope.id).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('bundle with empty-string projectId falls through to hash', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sov-bundle-'));
    try {
      const bundle = makeFakeBundle({ root: tmpRoot, projectId: '' });
      const scope = resolveProjectScope({ cwd: '/tmp', bundle });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      expect(scope.id).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('bundle path hash is stable across calls (same root → same id)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sov-bundle-'));
    try {
      const bundle1 = makeFakeBundle({ root: tmpRoot });
      const bundle2 = makeFakeBundle({ root: tmpRoot });
      const a = resolveProjectScope({ cwd: '/tmp', bundle: bundle1 });
      const b = resolveProjectScope({ cwd: '/tmp', bundle: bundle2 });
      expect(a.kind).toBe('project');
      expect(b.kind).toBe('project');
      if (a.kind === 'project' && b.kind === 'project') {
        expect(a.id).toBe(b.id);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('no bundle, git repo cwd → uses git remote', () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'sov-gittest-'));
    try {
      spawnSync('git', ['init', '-q', tmpCwd]);
      spawnSync('git', ['-C', tmpCwd, 'remote', 'add', 'origin', 'git@github.com:test/fake.git']);
      const scope = resolveProjectScope({ cwd: tmpCwd, bundle: null });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      expect(scope.id).toMatch(/^[a-f0-9]{16}$/);
      expect(scope.name).toBe('test/fake');
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test('no bundle, no git → kind: none (harness mode)', () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'sov-nogit-'));
    try {
      const scope = resolveProjectScope({ cwd: tmpCwd, bundle: null });
      expect(scope).toEqual({ kind: 'none' });
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test('no bundle, git repo without origin remote → kind: none', () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'sov-gitnoremote-'));
    try {
      spawnSync('git', ['init', '-q', tmpCwd]);
      // Deliberately no `git remote add origin …`
      const scope = resolveProjectScope({ cwd: tmpCwd, bundle: null });
      expect(scope).toEqual({ kind: 'none' });
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test('bundle takes precedence over git when both present', () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'sov-both-'));
    try {
      spawnSync('git', ['init', '-q', tmpCwd]);
      spawnSync('git', ['-C', tmpCwd, 'remote', 'add', 'origin', 'git@github.com:wrong/repo.git']);
      const bundle = makeFakeBundle({ projectId: 'right-bundle' });
      const scope = resolveProjectScope({ cwd: tmpCwd, bundle });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      expect(scope.id).toBe('right-bundle');
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test('bundle path hash takes precedence over git when manifest absent', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sov-bundleroot-'));
    const tmpCwd = mkdtempSync(join(tmpdir(), 'sov-gitcwd-'));
    try {
      spawnSync('git', ['init', '-q', tmpCwd]);
      spawnSync('git', ['-C', tmpCwd, 'remote', 'add', 'origin', 'git@github.com:wrong/repo.git']);
      const bundle = makeFakeBundle({ root: tmpRoot });
      const scope = resolveProjectScope({ cwd: tmpCwd, bundle });
      expect(scope.kind).toBe('project');
      if (scope.kind !== 'project') return;
      // Should be the bundle hash, not the git remote hash.
      expect(scope.id).toMatch(/^[a-f0-9]{16}$/);
      // Name should NOT be 'wrong/repo'.
      expect(scope.name).not.toBe('wrong/repo');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
