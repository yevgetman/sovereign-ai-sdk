// H3 — direct unit tests for the extracted hook/mcp merge helpers
// (`mergeHookEvents` / `mergeMcpServers`). The loaders (`loadHookSettings`,
// `loadMcpServerSettings`) now CALL these, so the layered-merge + collision
// semantics live here and are independently exercisable (for the plugin
// disclosure + future v2 plugin-hook/mcp merging). These tests pin the small,
// pure contract; the loader tests in settings.test.ts pin the end-to-end
// byte-identical behavior.

import { describe, expect, test } from 'bun:test';
import {
  type HookMergeState,
  type McpMergeState,
  emptyHookMergeState,
  emptyMcpMergeState,
  mergeHookEvents,
  mergeMcpServers,
} from '../../src/config/settings.js';

describe('mergeHookEvents', () => {
  test('concatenates events across layers, preserving call order, immutably', () => {
    const layerA = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'a.sh' }] }],
    };
    const layerB = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'b.sh' }] }],
      PostToolUse: [{ hooks: [{ type: 'command' as const, command: 'audit.sh' }] }],
    };

    const start: HookMergeState = emptyHookMergeState();
    const afterA = mergeHookEvents(start, layerA);
    const afterB = mergeHookEvents(afterA, layerB);

    // First layer pushed first, second appended — concatenation, not shadowing.
    expect(afterB.PreToolUse.map((c) => c.hooks[0]?.command)).toEqual(['a.sh', 'b.sh']);
    expect(afterB.PostToolUse.map((c) => c.hooks[0]?.command)).toEqual(['audit.sh']);
    expect(afterB.UserPromptSubmit).toEqual([]);
    expect(afterB.Stop).toEqual([]);

    // Immutable — the inputs are never mutated.
    expect(start.PreToolUse).toEqual([]);
    expect(afterA.PreToolUse.map((c) => c.hooks[0]?.command)).toEqual(['a.sh']);
  });

  test('an empty layer leaves the accumulator unchanged', () => {
    const start = emptyHookMergeState();
    const after = mergeHookEvents(start, {});
    expect(after).toEqual(emptyHookMergeState());
  });
});

describe('mergeMcpServers', () => {
  test('concatenates servers by alias across layers, immutably', () => {
    const start: McpMergeState = emptyMcpMergeState();
    const afterA = mergeMcpServers(
      start,
      { user_fs: { type: 'stdio', command: 'fsd' } },
      'userPath',
    );
    const afterB = mergeMcpServers(
      afterA,
      { project_db: { type: 'stdio', command: 'dbd' } },
      'projectPath',
    );
    expect(Object.keys(afterB.servers).sort()).toEqual(['project_db', 'user_fs']);
    // Inputs not mutated.
    expect(Object.keys(start.servers)).toEqual([]);
    expect(Object.keys(afterA.servers)).toEqual(['user_fs']);
  });

  test('a duplicate alias across layers throws naming both sources', () => {
    const afterA = mergeMcpServers(
      emptyMcpMergeState(),
      { fs: { type: 'stdio', command: 'fs-user' } },
      'userPath',
    );
    expect(() =>
      mergeMcpServers(afterA, { fs: { type: 'stdio', command: 'fs-project' } }, 'projectPath'),
    ).toThrow(/fs/);
  });

  test('two REMOTE aliases normalizing to the same env fragment throw', () => {
    const afterA = mergeMcpServers(
      emptyMcpMergeState(),
      { 'foo-bar': { type: 'http', url: 'https://a.example.com' } },
      'path1',
    );
    expect(() =>
      mergeMcpServers(afterA, { foo_bar: { type: 'http', url: 'https://b.example.com' } }, 'path2'),
    ).toThrow(/SOV_MCP_FOO_BAR|env var|collid/i);
  });

  test('a stdio alias colliding on env fragment with a remote alias does NOT throw', () => {
    const afterA = mergeMcpServers(
      emptyMcpMergeState(),
      { 'foo-bar': { type: 'stdio', command: 'fsd' } },
      'path1',
    );
    const afterB = mergeMcpServers(
      afterA,
      { foo_bar: { type: 'http', url: 'https://b.example.com' } },
      'path2',
    );
    expect(Object.keys(afterB.servers).sort()).toEqual(['foo-bar', 'foo_bar']);
  });
});
