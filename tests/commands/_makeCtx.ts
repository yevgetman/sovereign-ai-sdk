// Shared CommandContext stub for slash-command tests. Each individual
// test overrides only the pieces it cares about — the boilerplate
// no-op defaults live here so adding new fields to CommandContext
// doesn't ripple to every test.

import { COMMANDS, buildCommandRegistry } from '../../src/commands/registry.js';
import type { CommandContext } from '../../src/commands/types.js';

export function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  let model = 'claude-sonnet-4-6';
  return {
    sessionId: 'session-1',
    cwd: process.cwd(),
    providerName: 'anthropic',
    bundlePath: null,
    get model() {
      return model;
    },
    setModel: (next) => {
      model = next;
    },
    clearHistory: () => 'conversation history cleared into child session session-2',
    getCost: () => ({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      estimatedCostUsd: 0.0123,
      compactionInputTokens: 0,
      compactionOutputTokens: 0,
      estimatedCompactionCostUsd: 0,
    }),
    compact: async () => ({
      parentSessionId: 'session-1',
      newSessionId: 'session-2',
      summary: 'summary',
      tail: [],
      compactedMessages: 3,
      estimatedBeforeTokens: 1200,
      estimatedAfterTokens: 300,
      usedAuxiliary: false,
    }),
    rollback: async () => 'rolled back to parent session session-1',
    tools: [],
    registry: buildCommandRegistry(COMMANDS),
    listSessions: () => [],
    getMetrics: () => ({
      sessionId: 'session-1',
      startedAtMs: Date.now() - 1000,
      agentActiveMs: 0,
      apiTimeMs: 0,
      toolTimeMs: 0,
      toolCalls: 0,
      toolOk: 0,
      toolErr: 0,
    }),
    skills: { skills: [], byName: new Map() },
    getLastAssistantText: () => null,
    getMessages: () => [],
    getPermissions: () => ({ mode: 'default', alwaysAllow: [], layers: [] }),
    requestExit: () => {},
    getBudgetReport: () => ({ components: [], totals: { estimated: 0 } }),
    expandToolBlock: () => ({ ok: false, total: 0 }),
    ...overrides,
  };
}
