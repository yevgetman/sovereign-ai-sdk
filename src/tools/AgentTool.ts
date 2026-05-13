// Phase 13.5 — AgentTool. Thin buildTool() wrapper over the SubagentScheduler:
// validates the input, looks up the scheduler from ToolContext, and returns
// a bounded summary plus child session id and trace id. The scheduler owns
// concurrency, lineage, and cancellation; this tool owns the surface the
// model sees.
//
// The `subagent_type` enum is left as `z.string()` here. The registry's
// patchSchemasAgainstAvailable() rewrites it to a closed enum at tool-pool
// assembly time so the model only sees the agents this harness has actually
// loaded — same pattern Phase 12 will adopt for ToolSearchTool's
// `tool_names` enum.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';

const AgentToolInputSchema = z.object({
  subagent_type: z.string().min(1).describe('The name of the loaded sub-agent to delegate to.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      'The task description for the sub-agent. Be specific — the agent runs as a separate session and only receives this prompt.',
    ),
});

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

export type AgentToolOutput = {
  childSessionId: string;
  agentName: string;
  resolvedProvider: string;
  resolvedModel: string;
  terminalReason: string;
  iterationsUsed: number;
  toolCallCount: number;
  durationMs: number;
  summary: string;
};

export const AgentTool = buildTool<AgentToolInput, AgentToolOutput>({
  name: 'AgentTool',
  searchHint: 'Delegate a focused task to a specialized sub-agent.',
  description: () =>
    [
      'Delegate a focused task to a specialized sub-agent that runs as its own session with a bounded toolset and budget.',
      'Use sub-agents when the parent task benefits from a fresh context, a constrained read-only exploration, or an independent verification step.',
      'The sub-agent returns a concise summary; full traces live in the trace log, not in this result.',
    ].join(' '),
  inputSchema: AgentToolInputSchema,
  displayInput: (input) => `${input.subagent_type}: ${input.prompt}`,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  renderHint: { kind: 'markdown' },
  async call(input, ctx) {
    const scheduler = ctx.subagentScheduler;
    if (!scheduler) {
      throw new Error(
        'AgentTool: no subagent scheduler in ToolContext (harness bootstrap did not wire one)',
      );
    }
    const agents = ctx.agents;
    if (!agents || !agents.byName.has(input.subagent_type)) {
      const available = agents ? [...agents.byName.keys()].sort().join(', ') : '(none loaded)';
      throw new Error(
        `AgentTool: unknown subagent_type '${input.subagent_type}'. Available: ${available}`,
      );
    }
    const parentToolPool = ctx.parentToolPool ?? [];
    const result = await scheduler.delegate({
      agentName: input.subagent_type,
      prompt: input.prompt,
      parentSessionId: ctx.sessionId,
      ...(ctx.signal !== undefined ? { parentSignal: ctx.signal } : {}),
      parentToolPool,
      parentToolContext: ctx,
      ...(ctx.canUseTool !== undefined ? { canUseTool: ctx.canUseTool } : {}),
      ...(ctx.memoryManager !== undefined ? { memoryManager: ctx.memoryManager } : {}),
      ...(ctx.traceRecorder !== undefined ? { traceRecorder: ctx.traceRecorder } : {}),
    });
    return {
      data: {
        childSessionId: result.childSessionId,
        agentName: result.agentName,
        resolvedProvider: result.resolvedProvider,
        resolvedModel: result.resolvedModel,
        terminalReason: result.terminal.reason,
        iterationsUsed: result.iterationsUsed,
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
        summary: result.summary,
      },
      observation: {
        status:
          result.terminal.reason === 'completed' || result.terminal.reason === 'max_turns'
            ? 'success'
            : 'error',
        summary: `${result.agentName} → ${result.terminal.reason} (${result.iterationsUsed} turns, ${result.toolCallCount} tool calls)`,
        artifacts: [`session:${result.childSessionId}`],
      },
    };
  },
  renderResult(output) {
    const lines = [
      `<subagent_result name="${output.agentName}" session="${output.childSessionId}" lane="${output.resolvedProvider}/${output.resolvedModel}" turns="${output.iterationsUsed}" tool_calls="${output.toolCallCount}" duration_ms="${output.durationMs}" terminal="${output.terminalReason}">`,
      output.summary,
      '</subagent_result>',
    ];
    return {
      content: lines.join('\n'),
      isError: !(output.terminalReason === 'completed' || output.terminalReason === 'max_turns'),
    };
  },
}) as unknown as import('../tool/types.js').Tool<unknown, unknown>;
