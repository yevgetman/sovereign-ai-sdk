// Phase E T5 — per-user memory namespace tests.
//
// A real principal's memory lives under `<home>/users/{userId}/memory/…`
// (the existing global + projects/{projectId} layout, nested under the
// per-user prefix). The implicit single principal (userId undefined — the
// no-principals / legacy / open-mode case) keeps the EXISTING top-level
// `<home>/memory/…` paths, BYTE-IDENTICAL to today.
//
// SECURITY-LOAD-BEARING: the userId becomes a filesystem path segment, so a
// malicious userId ('../evil', 'a/b', '') must throw at the path boundary via
// validatePrincipalId — never traverse out of the per-user namespace. The two
// users alice and bob must be provably isolated: alice's MEMORY.md content is
// invisible to bob's manager.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  memoryPath,
  projectMemoryPath,
  replaceMemoryFile,
  replaceProjectMemoryFile,
} from '../../src/memory/bounded.js';
import { createDefaultMemoryManager } from '../../src/memory/provider.js';
import type { ProjectScope } from '../../src/memory/scope.js';

const PROJECT_ID = 'proj1';
const PROJECT_SCOPE: ProjectScope = { kind: 'project', id: PROJECT_ID, name: 'p' };

describe('per-user memory paths (global)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-umem-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('userId resolves global MEMORY.md under users/{userId}/memory/', () => {
    expect(memoryPath(home, 'MEMORY.md', 'alice')).toBe(
      join(home, 'users', 'alice', 'memory', 'MEMORY.md'),
    );
  });

  test('userId resolves global USER.md under users/{userId}/memory/', () => {
    expect(memoryPath(home, 'USER.md', 'alice')).toBe(
      join(home, 'users', 'alice', 'memory', 'USER.md'),
    );
  });

  test('undefined userId keeps the EXISTING legacy global path (byte-identical)', () => {
    expect(memoryPath(home, 'MEMORY.md')).toBe(join(home, 'memory', 'MEMORY.md'));
    expect(memoryPath(home, 'USER.md')).toBe(join(home, 'memory', 'USER.md'));
  });
});

describe('per-user memory paths (project)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-umem-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('userId resolves project MEMORY.md under users/{userId}/memory/projects/<id>/', () => {
    expect(projectMemoryPath(home, PROJECT_ID, 'alice')).toBe(
      join(home, 'users', 'alice', 'memory', 'projects', PROJECT_ID, 'MEMORY.md'),
    );
  });

  test('undefined userId keeps the EXISTING legacy project path (byte-identical)', () => {
    expect(projectMemoryPath(home, PROJECT_ID)).toBe(
      join(home, 'memory', 'projects', PROJECT_ID, 'MEMORY.md'),
    );
  });
});

describe('per-user memory path boundary — malicious userId throws', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-umem-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  for (const bad of ['../evil', 'a/b', '', '.', '..', './x', 'a\0b']) {
    test(`memoryPath rejects userId ${JSON.stringify(bad)}`, () => {
      expect(() => memoryPath(home, 'MEMORY.md', bad)).toThrow();
    });

    test(`projectMemoryPath rejects userId ${JSON.stringify(bad)}`, () => {
      expect(() => projectMemoryPath(home, PROJECT_ID, bad)).toThrow();
    });
  }
});

describe('createDefaultMemoryManager — per-user isolation', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-umem-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("alice's global memory is invisible to bob's manager", async () => {
    // Arrange — write under alice's namespace only.
    replaceMemoryFile('MEMORY.md', 'alice secret notes', home, 'alice');

    // Act
    const aliceMgr = createDefaultMemoryManager(home, PROJECT_SCOPE, 'alice');
    const bobMgr = createDefaultMemoryManager(home, PROJECT_SCOPE, 'bob');
    const aliceSnap = await aliceMgr.prefetchSnapshot('hi');
    const bobSnap = await bobMgr.prefetchSnapshot('hi');

    // Assert
    expect(aliceSnap).toContain('alice secret notes');
    expect(bobSnap).not.toContain('alice secret notes');
  });

  test("alice's project memory is invisible to bob's manager", async () => {
    replaceProjectMemoryFile(PROJECT_ID, 'alice project notes', home, 'alice');

    const aliceMgr = createDefaultMemoryManager(home, PROJECT_SCOPE, 'alice');
    const bobMgr = createDefaultMemoryManager(home, PROJECT_SCOPE, 'bob');
    const aliceSnap = await aliceMgr.prefetchSnapshot('hi');
    const bobSnap = await bobMgr.prefetchSnapshot('hi');

    expect(aliceSnap).toContain('alice project notes');
    expect(bobSnap).not.toContain('alice project notes');
  });

  test('no-userId manager uses the legacy path and does not see alice', async () => {
    // Legacy content lives at the top-level path; alice's at users/alice/.
    replaceMemoryFile('MEMORY.md', 'legacy global notes', home);
    replaceMemoryFile('MEMORY.md', 'alice secret notes', home, 'alice');

    const legacyMgr = createDefaultMemoryManager(home, PROJECT_SCOPE);
    const aliceMgr = createDefaultMemoryManager(home, PROJECT_SCOPE, 'alice');
    const legacySnap = await legacyMgr.prefetchSnapshot('hi');
    const aliceSnap = await aliceMgr.prefetchSnapshot('hi');

    expect(legacySnap).toContain('legacy global notes');
    expect(legacySnap).not.toContain('alice secret notes');
    expect(aliceSnap).toContain('alice secret notes');
    expect(aliceSnap).not.toContain('legacy global notes');
  });

  test('createDefaultMemoryManager with malicious userId throws on prefetch boundary', async () => {
    const mgr = createDefaultMemoryManager(home, PROJECT_SCOPE, '../evil');
    await expect(mgr.prefetchSnapshot('hi')).rejects.toThrow();
  });
});
