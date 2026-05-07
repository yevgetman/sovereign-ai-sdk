// MemoryManager provider rules: bundled provider is always allowed, but only
// one external provider may be active at once.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceMemoryFile, replaceProjectMemoryFile } from '../../src/memory/bounded.js';
import {
  BuiltinMarkdownMemoryProvider,
  MemoryManager,
  type MemoryProvider,
  createDefaultMemoryManager,
} from '../../src/memory/provider.js';

function external(id: string): MemoryProvider {
  return {
    id,
    builtin: false,
    isAvailable: () => true,
    initialize: async () => {},
    getToolSchemas: () => [],
    handleToolCall: async () => '',
    prefetchSnapshot: async () => '',
    syncTurn: async () => {},
    onMemoryWrite: async () => {},
    onDelegation: async () => {},
    onSessionStart: async () => {},
    onSessionEnd: async () => {},
    shutdown: async () => {},
  };
}

describe('MemoryManager', () => {
  test('allows bundled plus one external provider, rejects a second external', () => {
    const manager = new MemoryManager();
    manager.addProvider(new BuiltinMarkdownMemoryProvider('/tmp/harness-memory-test'));
    manager.addProvider(external('one'));
    expect(() => manager.addProvider(external('two'))).toThrow(/only one external/);
  });
});

describe('BuiltinMarkdownMemoryProvider — project scope', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-pmemprov-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('snapshot omits project block when no projectScope passed', async () => {
    replaceMemoryFile('MEMORY.md', 'global notes', home);
    const provider = new BuiltinMarkdownMemoryProvider(home);
    const snap = await provider.prefetchSnapshot('hello');
    expect(snap).toContain('global notes');
    expect(snap).not.toContain('scope="project"');
  });

  test('snapshot omits project block when projectScope.kind is none', async () => {
    replaceMemoryFile('MEMORY.md', 'global notes', home);
    const provider = new BuiltinMarkdownMemoryProvider(home, { kind: 'none' });
    const snap = await provider.prefetchSnapshot('hello');
    expect(snap).not.toContain('scope="project"');
  });

  test('snapshot omits project block when project file empty', async () => {
    replaceMemoryFile('MEMORY.md', 'global notes', home);
    const provider = new BuiltinMarkdownMemoryProvider(home, {
      kind: 'project',
      id: 'proj1',
      name: 'p',
    });
    const snap = await provider.prefetchSnapshot('hello');
    expect(snap).not.toContain('scope="project"');
  });

  test('snapshot includes project block when project file populated', async () => {
    replaceMemoryFile('MEMORY.md', 'global notes', home);
    replaceProjectMemoryFile('proj1', 'project notes', home);
    const provider = new BuiltinMarkdownMemoryProvider(home, {
      kind: 'project',
      id: 'proj1',
      name: 'sov-docs',
    });
    const snap = await provider.prefetchSnapshot('hello');
    expect(snap).toContain('global notes');
    expect(snap).toContain('project notes');
    expect(snap).toContain('project="sov-docs"');
  });

  test('snapshot includes project block even when global empty', async () => {
    replaceProjectMemoryFile('proj1', 'project notes', home);
    const provider = new BuiltinMarkdownMemoryProvider(home, {
      kind: 'project',
      id: 'proj1',
      name: 'p',
    });
    const snap = await provider.prefetchSnapshot('hello');
    expect(snap).toContain('project notes');
    expect(snap).toContain('scope="project"');
  });

  test('createDefaultMemoryManager forwards projectScope', async () => {
    replaceProjectMemoryFile('proj1', 'project notes', home);
    const mgr = createDefaultMemoryManager(home, { kind: 'project', id: 'proj1', name: 'p' });
    const snap = await mgr.prefetchSnapshot('hello');
    expect(snap).toContain('project notes');
  });
});
