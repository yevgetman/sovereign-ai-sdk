// Phase 13.5 — patchSchemasAgainstAvailable() should rewrite AgentTool's
// `subagent_type` enum to the loaded agent set, and drop AgentTool entirely
// when no agents are loaded.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '@yevgetman/sov-sdk/agents/types';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { z } from 'zod';
import { assembleToolPool } from '../../src/tool/registry.js';

function makeAgent(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'be concise',
    allowedTools: ['Read'],
    maxTurns: 5,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: false,
    allowedSubagents: [],
    path: `/tmp/${name}.md`,
    realpath: `/tmp/${name}.md`,
    dir: '/tmp',
    source: 'bundle',
    trustTier: 'builtin',
    ...overrides,
  };
}

function makeRegistry(
  names: string[],
  overrides: Record<string, Partial<AgentDefinition>> = {},
): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const n of names) byName.set(n, makeAgent(n, overrides[n]));
  return {
    agents: names.map((n) => makeAgent(n, overrides[n])),
    byName,
  };
}

describe('patchSchemasAgainstAvailable — AgentTool subagent_type enum', () => {
  test('drops AgentTool from the pool when no agents are loaded', () => {
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: 'parent' };
    const pool = assembleToolPool(ctx);
    expect(pool.find((t) => t.name === 'AgentTool')).toBeUndefined();
  });

  test('keeps AgentTool when agents are loaded and rewrites subagent_type to enum', () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore', 'verify', 'plan']),
    };
    const pool = assembleToolPool(ctx);
    const agentTool = pool.find((t) => t.name === 'AgentTool');
    expect(agentTool).toBeDefined();
    // Validate that the schema now accepts only the registered agent names.
    const schema = agentTool?.inputSchema as z.ZodType<{
      subagent_type: string;
      prompt: string;
    }>;
    // Valid agent name passes validation.
    expect(() => schema.parse({ subagent_type: 'explore', prompt: 'hello' })).not.toThrow();
    // Unknown agent name is rejected by the enum.
    expect(() => schema.parse({ subagent_type: 'mystery', prompt: 'hello' })).toThrow();
  });

  test("subagent_type enum description lists each agent's description and whenToUse", () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore', 'verify'], {
        explore: {
          description: 'Fast read-only codebase explorer',
          whenToUse: 'when the parent needs to find files by name or symbol',
        },
        verify: {
          description: 'Independent claim checker',
          whenToUse: 'when the parent has produced a claim that needs an independent check',
        },
      }),
    };
    const pool = assembleToolPool(ctx);
    const agentTool = pool.find((t) => t.name === 'AgentTool');
    expect(agentTool).toBeDefined();
    // The model reads the description text on the subagent_type field
    // every time AgentTool is in the pool. Confirm the enrichment
    // shows up there.
    const schema = agentTool?.inputSchema as z.ZodObject<{
      subagent_type: z.ZodEnum<[string, ...string[]]>;
      prompt: z.ZodString;
    }>;
    const fieldDesc = schema.shape.subagent_type.description ?? '';
    expect(fieldDesc).toContain('Available sub-agents:');
    expect(fieldDesc).toContain('explore: Fast read-only codebase explorer');
    expect(fieldDesc).toContain('Use when: when the parent needs to find files');
    expect(fieldDesc).toContain('verify: Independent claim checker');
    expect(fieldDesc).toContain('claim that needs an independent check');
  });

  test('subagent_type description omits the trigger clause for agents without whenToUse', () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['minimal'], {
        minimal: {
          description: 'No trigger predicate',
          // whenToUse omitted
        },
      }),
    };
    const pool = assembleToolPool(ctx);
    const agentTool = pool.find((t) => t.name === 'AgentTool');
    const schema = agentTool?.inputSchema as z.ZodObject<{
      subagent_type: z.ZodEnum<[string, ...string[]]>;
      prompt: z.ZodString;
    }>;
    const fieldDesc = schema.shape.subagent_type.description ?? '';
    expect(fieldDesc).toContain('minimal: No trigger predicate');
    // Should NOT contain a "Use when:" clause since whenToUse wasn't set.
    expect(fieldDesc).not.toContain('Use when:');
  });
});

describe('patchSchemasAgainstAvailable — task_create subagent_type enum', () => {
  test('drops task_create from the pool when no agents are loaded', () => {
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: 'parent' };
    const pool = assembleToolPool(ctx);
    expect(pool.find((t) => t.name === 'task_create')).toBeUndefined();
  });

  test('keeps task_create when agents are loaded and rewrites subagent_type to enum', () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore', 'verify', 'plan']),
    };
    const pool = assembleToolPool(ctx);
    const taskCreate = pool.find((t) => t.name === 'task_create');
    expect(taskCreate).toBeDefined();
    const schema = taskCreate?.inputSchema as z.ZodObject<{
      subagent_type: z.ZodEnum<[string, ...string[]]>;
      prompt: z.ZodString;
    }>;
    // Valid agent name passes validation.
    expect(() => schema.parse({ subagent_type: 'explore', prompt: 'hello' })).not.toThrow();
    // Unknown agent name is rejected by the enum.
    expect(() => schema.parse({ subagent_type: 'mystery', prompt: 'hello' })).toThrow();
    // Each tool's own `prompt` description survives the rewrite — load-bearing
    // assertion. AgentTool and task_create have DIFFERENT prompt descriptions;
    // if rewriteSubagentTypeSchema hardcoded one tool's shape, this would fail.
    const taskCreatePromptDesc = schema.shape.prompt.description ?? '';
    expect(taskCreatePromptDesc).toBe(
      'The task description for the sub-agent. The agent runs as a separate session and only receives this prompt.',
    );
    // Sanity-check that AgentTool's prompt description is different and also
    // preserved through the same patching pass.
    const agentTool = pool.find((t) => t.name === 'AgentTool');
    const agentSchema = agentTool?.inputSchema as z.ZodObject<{
      subagent_type: z.ZodEnum<[string, ...string[]]>;
      prompt: z.ZodString;
    }>;
    const agentPromptDesc = agentSchema.shape.prompt.description ?? '';
    expect(agentPromptDesc).toBe(
      'The task description for the sub-agent. Be specific — the agent runs as a separate session and only receives this prompt.',
    );
    expect(agentPromptDesc).not.toBe(taskCreatePromptDesc);
  });
});
