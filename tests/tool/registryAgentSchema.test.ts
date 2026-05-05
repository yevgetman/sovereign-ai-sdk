// Phase 13.5 — patchSchemasAgainstAvailable() should rewrite AgentTool's
// `subagent_type` enum to the loaded agent set, and drop AgentTool entirely
// when no agents are loaded.

import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import { assembleToolPool } from '../../src/tool/registry.js';
import type { ToolContext } from '../../src/tool/types.js';

function makeAgent(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: 'be concise',
    allowedTools: ['Read'],
    maxTurns: 5,
    readOnly: true,
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
