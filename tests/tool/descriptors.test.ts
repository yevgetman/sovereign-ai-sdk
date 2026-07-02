// Task 2.6 — canonical tool descriptors (src/tool/descriptors.ts).
//
// The subscription-executor (proprietary src/runtime/subprocessExecutor.ts)
// used to hardcode three const maps that canonicalize delegated Claude Code
// tool calls into the harness's native vocabulary. Those maps now DERIVE from
// the open descriptor table; this file is the byte-identity proof:
//
//   1. The ORIGINAL executor literals are frozen below as the expectation —
//      the maps rebuilt from CANONICAL_TOOL_DESCRIPTORS (and read through the
//      lookup helpers) must deep-equal them exactly.
//   2. Descriptor invariants — unique native names, no duplicate aliases
//      across tools, no alias shadowing a native name — so a future table edit
//      cannot silently corrupt alias resolution (Map building is last-wins).

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import { CANONICAL_TOOL_DESCRIPTORS } from '@yevgetman/sov-sdk/tool/descriptors';
import { aliasToNativeName, dropsFor, renamesFor } from '@yevgetman/sov-sdk/tool/descriptors';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { HarnessInfoSnapshot } from '@yevgetman/sov-sdk/tools/HarnessInfoTool';
// The FULL tool registry is the canonical native-name source for the Task-2.9
// alias-shadow invariant below. src/tool/registry.ts is PROPRIETARY — tests are
// not boundary-gated (the dependency-cruiser `no-open-to-proprietary` rule
// applies `from: src/**` OPEN files only), so THIS TEST imports it rather than
// the open descriptors module ever doing so.
import {
  LEARNING_ONLY_TOOLS,
  REVIEW_ONLY_TOOLS,
  assembleToolPool,
} from '../../src/tool/registry.js';
import { WORKFLOW_RUN_TOOL_NAME } from '../../src/tools/WorkflowRunTool.js';

// ── The executor's ORIGINAL hardcoded literals (frozen expectation) ─────────
// Copied VERBATIM from src/runtime/subprocessExecutor.ts as of commit 1f86c10
// (pre-refactor). Do not edit these to make the test pass: they are the
// byte-identity contract for observation canonicalization.

const ORIGINAL_CLAUDE_TO_NATIVE_TOOL_NAME: Readonly<Record<string, string>> = {
  Read: 'FileRead',
  Write: 'FileWrite',
  Edit: 'FileEdit',
};

const ORIGINAL_INPUT_KEY_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FileRead: { file_path: 'path' },
  FileWrite: { file_path: 'path' },
  FileEdit: { file_path: 'path' },
};

const ORIGINAL_INPUT_KEYS_TO_DROP: Readonly<Record<string, readonly string[]>> = {
  Bash: ['description'],
};

describe('canonical tool descriptors — byte-identity with the executor originals', () => {
  test('the alias map derived from the table equals the original literal', () => {
    const derived = Object.fromEntries(
      CANONICAL_TOOL_DESCRIPTORS.flatMap((descriptor) =>
        (descriptor.aliases ?? []).map((alias) => [alias, descriptor.name]),
      ),
    );
    expect(derived).toEqual({ ...ORIGINAL_CLAUDE_TO_NATIVE_TOOL_NAME });
  });

  test('the rename map derived from the table equals the original literal', () => {
    const derived = Object.fromEntries(
      CANONICAL_TOOL_DESCRIPTORS.filter(
        (descriptor) => descriptor.inputKeyRenames !== undefined,
      ).map((descriptor) => [descriptor.name, descriptor.inputKeyRenames]),
    );
    expect(derived).toEqual({ ...ORIGINAL_INPUT_KEY_RENAMES });
  });

  test('the drop map derived from the table equals the original literal', () => {
    const derived = Object.fromEntries(
      CANONICAL_TOOL_DESCRIPTORS.filter(
        (descriptor) => descriptor.inputKeysToDrop !== undefined,
      ).map((descriptor) => [descriptor.name, descriptor.inputKeysToDrop]),
    );
    expect(derived).toEqual({ ...ORIGINAL_INPUT_KEYS_TO_DROP });
  });

  test('aliasToNativeName resolves every original alias and nothing else', () => {
    for (const [alias, native] of Object.entries(ORIGINAL_CLAUDE_TO_NATIVE_TOOL_NAME)) {
      expect(aliasToNativeName(alias)).toBe(native);
    }
    // Names already native (or foreign with no native equivalent) do not resolve.
    expect(aliasToNativeName('Bash')).toBeUndefined();
    expect(aliasToNativeName('Grep')).toBeUndefined();
    expect(aliasToNativeName('Glob')).toBeUndefined();
    expect(aliasToNativeName('WebFetch')).toBeUndefined();
    expect(aliasToNativeName('mcp__server__do_thing')).toBeUndefined();
    // A native name is not an alias of itself.
    expect(aliasToNativeName('FileRead')).toBeUndefined();
  });

  test('renamesFor / dropsFor return exactly the original per-tool entries', () => {
    for (const [name, renames] of Object.entries(ORIGINAL_INPUT_KEY_RENAMES)) {
      expect(renamesFor(name)).toEqual({ ...renames });
    }
    for (const [name, drops] of Object.entries(ORIGINAL_INPUT_KEYS_TO_DROP)) {
      expect(dropsFor(name)).toEqual([...drops]);
    }
    // Tools absent from the original maps stay absent.
    expect(renamesFor('Bash')).toBeUndefined();
    expect(dropsFor('FileRead')).toBeUndefined();
    expect(renamesFor('Grep')).toBeUndefined();
    expect(dropsFor('Glob')).toBeUndefined();
  });

  test('helpers are prototype-safe (Object-literal inheritance cannot leak)', () => {
    // The original Record-literal lookups inherited Object.prototype members
    // (e.g. INPUT_KEYS_TO_DROP['toString'] was a function → `new Set(fn)`
    // throws). The Map-backed helpers must return undefined instead.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(aliasToNativeName(key)).toBeUndefined();
      expect(renamesFor(key)).toBeUndefined();
      expect(dropsFor(key)).toBeUndefined();
    }
  });
});

describe('canonical tool descriptors — table invariants', () => {
  test('native names are unique', () => {
    const names = CANONICAL_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('no duplicate aliases across tools', () => {
    const aliases = CANONICAL_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.aliases ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  test('no alias shadows a native name', () => {
    const names = new Set(CANONICAL_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name));
    for (const descriptor of CANONICAL_TOOL_DESCRIPTORS) {
      for (const alias of descriptor.aliases ?? []) {
        expect(names.has(alias)).toBe(false);
      }
    }
  });

  test('every rename target key differs from its source key', () => {
    for (const descriptor of CANONICAL_TOOL_DESCRIPTORS) {
      for (const [from, to] of Object.entries(descriptor.inputKeyRenames ?? {})) {
        expect(from).not.toBe(to);
      }
    }
  });

  // Fixtures for the full-registry shadow test: a minimal agent registry (so
  // patchSchemasAgainstAvailable keeps AgentTool + task_create in the pool) and
  // a HarnessInfo snapshot factory (so HarnessInfoTool enters it). Mirrors
  // tests/tool/renderHintCoverage.test.ts.
  function fakeAgentRegistry(): AgentRegistry {
    const agent: AgentDefinition = {
      name: 'fake-agent',
      description: 'test fixture agent for the alias-shadow invariant',
      systemPrompt: 'you are a test fixture',
      allowedTools: [],
      maxTurns: 1,
      readOnly: true,
      supportsMissionState: false,
      inheritParentTools: false,
      allowedSubagents: [],
      path: '/dev/null/fake-agent.md',
      realpath: '/dev/null/fake-agent.md',
      dir: '/dev/null',
      source: 'project',
      trustTier: 'trusted',
    };
    return { agents: [agent], byName: new Map([[agent.name, agent]]) };
  }

  function fakeHarnessInfoSnapshot(): HarnessInfoSnapshot {
    return {
      permissionMode: 'default',
      settingsLayers: [],
      mcpServers: [],
      tools: { native: [], mcp: [] },
      slashCommands: [],
      agents: [],
    };
  }

  test('no descriptor alias shadows ANY native tool name in the FULL registry', () => {
    // Task 2.9 (inherited from the 2.6 review) — the narrower shadow test above
    // only checks names IN the descriptor table; this one checks the whole
    // native vocabulary, so e.g. adding `aliases: ['Grep']` (Grep is native but
    // has no descriptor) fails here. Alias resolution rewrites a foreign name
    // to `descriptor.name`; an alias that equals ANY native name would silently
    // hijack calls to that real tool.
    //
    // The native-name set is built from the same canonical sources the
    // renderHint-coverage test uses: the assembled pool (with a fake agent
    // registry + harnessInfoSnapshot + webSearch config so the conditional
    // tools — AgentTool, task_create, HarnessInfo, WebSearch — all enter it)
    // plus the review-only / learning-only sets and the runtime-bound
    // `workflow_run` (its name constant; the tool itself needs a live Runtime).
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'descriptor-shadow-test',
      agents: fakeAgentRegistry(),
      webSearch: { provider: 'tavily', apiKey: 'tvly-test' },
    };
    const pool = assembleToolPool(ctx, { harnessInfoSnapshot: fakeHarnessInfoSnapshot });
    const nativeNames = new Set<string>([
      ...pool.map((tool) => tool.name),
      ...REVIEW_ONLY_TOOLS.map((tool) => tool.name),
      ...LEARNING_ONLY_TOOLS.map((tool) => tool.name),
      WORKFLOW_RUN_TOOL_NAME,
    ]);
    // Sanity: the set really carries the full breadth — if pool assembly ever
    // stops surfacing these, the coverage this test thinks it has disappears.
    const expectedBreadth = [
      'AgentTool',
      'Bash',
      'FileEdit',
      'FileRead',
      'FileWrite',
      'Glob',
      'Grep',
      'HarnessInfo',
      'ToolSearch',
      'WebFetch',
      'WebSearch',
      'instinct_list',
      'memory_propose',
      'skill_propose',
      'task_create',
      'workflow_run',
    ];
    for (const name of expectedBreadth) {
      expect(nativeNames.has(name)).toBe(true);
    }
    for (const descriptor of CANONICAL_TOOL_DESCRIPTORS) {
      for (const alias of descriptor.aliases ?? []) {
        expect(nativeNames.has(alias)).toBe(false);
      }
    }
  });

  test('descriptor aliases mirror the aliases declared on the open tool defs', async () => {
    // The tool defs in src/tools/ are the AUTHORITATIVE alias truth; the
    // descriptor table must agree with them (FileRead:['Read'], etc.).
    const { FileReadTool } = await import('@yevgetman/sov-sdk/tools/FileReadTool');
    const { FileWriteTool } = await import('@yevgetman/sov-sdk/tools/FileWriteTool');
    const { FileEditTool } = await import('@yevgetman/sov-sdk/tools/FileEditTool');
    for (const tool of [FileReadTool, FileWriteTool, FileEditTool]) {
      const descriptor = CANONICAL_TOOL_DESCRIPTORS.find((entry) => entry.name === tool.name);
      expect(descriptor?.aliases).toEqual(tool.aliases as string[]);
    }
  });
});
