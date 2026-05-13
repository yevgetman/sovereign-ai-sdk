// Phase 16.1 M3.2 — every native tool in the assembled pool declares a
// renderHint per spec §7. Backstop test: when a new tool ships without one,
// this fails until the author picks a hint.
//
// Coverage breadth: the assembled pool ctx supplies a fake agent registry
// (so AgentTool + task_create stay in the pool — patchSchemasAgainstAvailable
// drops them when ctx.agents is missing) and a harnessInfoSnapshot factory
// (so HarnessInfoTool also enters the pool). MCP-wrapped tools are exercised
// in their own test against a synthetic McpToolMeta + minimal pool stub.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import { wrapMcpTool } from '../../src/mcp/toolWrapper.js';
import type { McpCallResult, McpClientPool, McpToolMeta } from '../../src/mcp/types.js';
import {
  LEARNING_ONLY_TOOLS,
  REVIEW_ONLY_TOOLS,
  assembleToolPool,
} from '../../src/tool/registry.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import type { HarnessInfoSnapshot } from '../../src/tools/HarnessInfoTool.js';

function fakeAgentRegistry(): AgentRegistry {
  const agent: AgentDefinition = {
    name: 'fake-agent',
    description: 'test fixture agent for renderHint coverage',
    systemPrompt: 'you are a test fixture',
    allowedTools: [],
    maxTurns: 1,
    readOnly: true,
    supportsMissionState: false,
    path: '/dev/null/fake-agent.md',
    realpath: '/dev/null/fake-agent.md',
    dir: '/dev/null',
    source: 'project',
    trustTier: 'trusted',
  };
  return {
    agents: [agent],
    byName: new Map([[agent.name, agent]]),
  };
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

describe('renderHint coverage', () => {
  test('every native tool in the assembled pool declares a renderHint', () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'coverage-test',
      harnessHome: tmpdir(),
      agents: fakeAgentRegistry(),
    };
    const pool = assembleToolPool(ctx, {
      harnessInfoSnapshot: fakeHarnessInfoSnapshot,
    });
    // Sanity: with agents + harnessInfoSnapshot wired the pool must include
    // AgentTool, task_create, and HarnessInfo. If the registry/factory ever
    // stops surfacing these, the coverage we think we have here disappears.
    const names = new Set(pool.map((t) => t.name));
    expect(names.has('AgentTool')).toBe(true);
    expect(names.has('task_create')).toBe(true);
    expect(names.has('HarnessInfo')).toBe(true);
    const missing = collectMissing(pool);
    expect(missing).toEqual([]);
  });

  test('every review-only tool declares a renderHint', () => {
    const missing = collectMissing(REVIEW_ONLY_TOOLS);
    expect(missing).toEqual([]);
  });

  test('every learning-only tool declares a renderHint', () => {
    const missing = collectMissing(LEARNING_ONLY_TOOLS);
    expect(missing).toEqual([]);
  });

  test('MCP-wrapped tools declare a renderHint via the wrapper default', () => {
    const meta: McpToolMeta = {
      serverName: 'fixture',
      toolName: 'echo',
      description: 'echo back the input',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    };
    const pool: McpClientPool = {
      servers: () => [],
      tools: () => [],
      call: async (): Promise<McpCallResult> => ({ text: '', isError: false }),
      shutdown: async () => {},
    };
    const wrapped = wrapMcpTool(meta, pool);
    expect(wrapped.renderHint).toBeDefined();
  });
});

function collectMissing(tools: Tool<unknown, unknown>[]): string[] {
  const missing: string[] = [];
  for (const tool of tools) {
    if (tool.renderHint === undefined) missing.push(tool.name);
  }
  return missing;
}
