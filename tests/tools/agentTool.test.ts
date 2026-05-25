// Phase 13.5 — AgentTool tests. AgentTool is a thin wrapper around the
// SubagentScheduler — these tests exercise its input validation, error
// surfaces, and renderResult shape against a stub scheduler. Scheduler
// behavior is tested separately in tests/runtime/scheduler.test.ts.

import { describe, expect, test } from 'bun:test';
import type { AgentDefinition, AgentRegistry } from '../../src/agents/types.js';
import type { AssistantMessage } from '../../src/core/types.js';
import type { DelegateInput } from '../../src/runtime/scheduler.js';
import type { ToolContext, ToolResult } from '../../src/tool/types.js';
import { AgentTool } from '../../src/tools/AgentTool.js';

function makeAgent(name: string): AgentDefinition {
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
  };
}

function makeRegistry(names: string[]): AgentRegistry {
  const byName = new Map<string, AgentDefinition>();
  for (const n of names) byName.set(n, makeAgent(n));
  return { agents: names.map((n) => makeAgent(n)), byName };
}

// Use NonNullable so test fixtures can assign directly into the optional
// ToolContext.subagentScheduler field under `exactOptionalPropertyTypes`.
type SchedulerStub = NonNullable<ToolContext['subagentScheduler']>;

function makeStubScheduler(
  opts: {
    resultOverride?: Partial<{
      childSessionId: string;
      agentName: string;
      resolvedProvider: string;
      resolvedModel: string;
      summary: string;
      finalAssistant?: AssistantMessage;
      iterationsUsed: number;
      toolCallCount: number;
      durationMs: number;
      terminalReason: 'completed' | 'error' | 'interrupted' | 'max_turns' | 'max_tokens';
    }>;
    delegateCalls?: unknown[];
  } = {},
): SchedulerStub {
  return {
    activeChildren: () => 0,
    delegate: async (input: DelegateInput) => {
      opts.delegateCalls?.push(input);
      const reason = opts.resultOverride?.terminalReason ?? 'completed';
      return {
        childSessionId: opts.resultOverride?.childSessionId ?? 'child-test',
        agentName: opts.resultOverride?.agentName ?? input.agentName,
        resolvedProvider: opts.resultOverride?.resolvedProvider ?? 'anthropic',
        resolvedModel: opts.resultOverride?.resolvedModel ?? 'claude-haiku-4-5-20251001',
        terminal: { reason },
        summary: opts.resultOverride?.summary ?? 'fake summary',
        ...(opts.resultOverride?.finalAssistant !== undefined
          ? { finalAssistant: opts.resultOverride.finalAssistant }
          : {}),
        iterationsUsed: opts.resultOverride?.iterationsUsed ?? 1,
        toolCallCount: opts.resultOverride?.toolCallCount ?? 0,
        durationMs: opts.resultOverride?.durationMs ?? 42,
      };
    },
  } as unknown as SchedulerStub;
}

describe('AgentTool', () => {
  test('throws when no scheduler is wired in ToolContext', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore']),
    };
    await expect(AgentTool.call({ subagent_type: 'explore', prompt: 'hi' }, ctx)).rejects.toThrow(
      /no subagent scheduler/,
    );
  });

  test('throws when subagent_type is not in the registry', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore', 'plan']),
      subagentScheduler: makeStubScheduler(),
    };
    await expect(AgentTool.call({ subagent_type: 'mystery', prompt: 'hi' }, ctx)).rejects.toThrow(
      /unknown subagent_type 'mystery'/,
    );
  });

  test('delegates to scheduler and returns structured result', async () => {
    const calls: unknown[] = [];
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore']),
      subagentScheduler: makeStubScheduler({ delegateCalls: calls }),
    };
    const result = await AgentTool.call({ subagent_type: 'explore', prompt: 'find auth' }, ctx);
    expect(calls).toHaveLength(1);
    const r = result as ToolResult<{
      agentName: string;
      summary: string;
      terminalReason: string;
      childSessionId: string;
    }>;
    expect(r.data.agentName).toBe('explore');
    expect(r.data.summary).toBe('fake summary');
    expect(r.data.terminalReason).toBe('completed');
    expect(r.data.childSessionId).toBe('child-test');
    expect(r.observation?.status).toBe('success');
  });

  test('marks observation status=error when terminal is not completed/max_turns', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore']),
      subagentScheduler: makeStubScheduler({
        resultOverride: { terminalReason: 'error' },
      }),
    };
    const result = await AgentTool.call({ subagent_type: 'explore', prompt: 'hi' }, ctx);
    const r = result as ToolResult<unknown>;
    expect(r.observation?.status).toBe('error');
  });

  test('renderResult wraps summary in subagent_result tags', () => {
    const out = (AgentTool.renderResult as NonNullable<typeof AgentTool.renderResult>)({
      childSessionId: 'child-1',
      agentName: 'explore',
      resolvedProvider: 'anthropic',
      resolvedModel: 'claude-haiku-4-5-20251001',
      terminalReason: 'completed',
      iterationsUsed: 3,
      toolCallCount: 2,
      durationMs: 1234,
      summary: 'Found auth module at src/auth.ts',
    } as unknown as Parameters<NonNullable<typeof AgentTool.renderResult>>[0]);
    expect(out.content).toContain('<subagent_result');
    expect(out.content).toContain('Found auth module at src/auth.ts');
    expect(out.content).toContain('</subagent_result>');
    expect(out.isError).toBe(false);
  });

  test('renderResult flags is_error when terminal is not completed/max_turns', () => {
    const out = (AgentTool.renderResult as NonNullable<typeof AgentTool.renderResult>)({
      childSessionId: 'child-1',
      agentName: 'explore',
      resolvedProvider: 'anthropic',
      resolvedModel: 'm',
      terminalReason: 'interrupted',
      iterationsUsed: 0,
      toolCallCount: 0,
      durationMs: 10,
      summary: '',
    } as unknown as Parameters<NonNullable<typeof AgentTool.renderResult>>[0]);
    expect(out.isError).toBe(true);
  });

  test('marks observation status=error when completed but summary is empty', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      sessionId: 'parent',
      agents: makeRegistry(['explore']),
      subagentScheduler: makeStubScheduler({
        resultOverride: { terminalReason: 'completed', summary: '' },
      }),
    };
    const result = await AgentTool.call({ subagent_type: 'explore', prompt: 'hi' }, ctx);
    const r = result as ToolResult<unknown>;
    expect(r.observation?.status).toBe('error');
  });

  test('renderResult flags isError when completed but summary is empty', () => {
    const out = (AgentTool.renderResult as NonNullable<typeof AgentTool.renderResult>)({
      childSessionId: 'child-1',
      agentName: 'frontier-task',
      resolvedProvider: 'anthropic',
      resolvedModel: 'claude-opus-4-7',
      terminalReason: 'completed',
      iterationsUsed: 2,
      toolCallCount: 1,
      durationMs: 120004,
      summary: '',
    } as unknown as Parameters<NonNullable<typeof AgentTool.renderResult>>[0]);
    expect(out.isError).toBe(true);
  });
});
