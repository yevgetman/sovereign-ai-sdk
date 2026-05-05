// Phase 13.3 — AgentRunner. A focused wrapper around the query() turn loop
// that owns the non-UI plumbing every agent execution needs:
//
//   - Build the user message from a string prompt.
//   - Wire query()'s parameters from the constructor's standing config.
//   - Track the final assistant message, iteration count, and tool-call count.
//   - Carry parent-child lineage (parentSessionId) through into the result
//     so the caller can persist it to the session DB if desired.
//
// AgentRunner is the abstraction sub-agents (Phase 13.5) consume: the
// scheduler creates a child session record, builds a filtered tool pool,
// and hands an AgentRunner the agent's prompt. AgentRunner runs the loop
// to terminal and returns a structured result.
//
// The REPL keeps its inline query() call. Its per-event loop is woven with
// UI rendering (toolSlot, diff inline, indicator, footer) — that's not
// pure plumbing and doesn't belong in AgentRunner. A future refactor may
// pull more REPL plumbing through, but the spec's gain ("CLI uses
// AgentRunner") is marginal next to the cost of moving UI concerns.
//
// Design invariants:
//   - query() is unchanged (Invariant #1).
//   - All StreamEvents from query() flow through to the caller.
//   - The user-prompt seed is the only message AgentRunner injects; the
//     caller does not pre-build a messages array.

import { query } from '../core/query.js';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
  Terminal,
} from '../core/types.js';
import type { HookRunner } from '../hooks/types.js';
import type { MemoryRuntime } from '../memory/provider.js';
import type { CanUseTool } from '../permissions/types.js';
import type { LLMProvider } from '../providers/types.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';

export type AgentRunnerOpts = {
  provider: LLMProvider;
  model: string;
  systemPrompt: SystemSegment[];
  maxTokens: number;

  /** Child session id; the caller (REPL or sub-agent scheduler) is
   *  responsible for creating the session record. AgentRunner only
   *  reads it. */
  sessionId: string;
  /** Set when this runner is executing as a sub-agent. Echoed into the
   *  AgentRunnerResult so the caller can persist parent-child lineage
   *  to the session DB. AgentRunner does not write to the DB itself. */
  parentSessionId?: string;

  tools?: Tool<unknown, unknown>[];
  /** Required when `tools` is set. Same contract as query().toolContext. */
  toolContext?: ToolContext;
  canUseTool?: CanUseTool;

  memoryManager?: MemoryRuntime;
  hookRunner?: HookRunner;
  traceRecorder?: (event: TraceEvent) => void;

  maxTurns?: number;
  cacheEnabled?: boolean;
  signal?: AbortSignal;
  cwd?: string;
};

export type AgentRunnerResult = {
  sessionId: string;
  parentSessionId?: string;
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
};

/** Runs an agent loop end-to-end starting from a single user prompt.
 *  Yields StreamEvents and Messages from query() unchanged; returns a
 *  structured AgentRunnerResult on terminal. */
export class AgentRunner {
  constructor(private readonly opts: AgentRunnerOpts) {}

  async *run(prompt: string): AsyncGenerator<StreamEvent | Message, AgentRunnerResult> {
    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    };
    const seedMessages: Message[] = [userMessage];

    const gen = query({
      provider: this.opts.provider,
      model: this.opts.model,
      messages: seedMessages,
      systemPrompt: this.opts.systemPrompt,
      maxTokens: this.opts.maxTokens,
      ...(this.opts.tools !== undefined ? { tools: this.opts.tools } : {}),
      ...(this.opts.toolContext !== undefined ? { toolContext: this.opts.toolContext } : {}),
      ...(this.opts.canUseTool !== undefined ? { canUseTool: this.opts.canUseTool } : {}),
      ...(this.opts.memoryManager !== undefined ? { memoryManager: this.opts.memoryManager } : {}),
      ...(this.opts.hookRunner !== undefined ? { hookRunner: this.opts.hookRunner } : {}),
      ...(this.opts.traceRecorder !== undefined ? { traceRecorder: this.opts.traceRecorder } : {}),
      ...(this.opts.maxTurns !== undefined ? { maxTurns: this.opts.maxTurns } : {}),
      ...(this.opts.cacheEnabled !== undefined ? { cacheEnabled: this.opts.cacheEnabled } : {}),
      ...(this.opts.signal !== undefined ? { signal: this.opts.signal } : {}),
      sessionId: this.opts.sessionId,
      ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
    });

    let finalAssistant: AssistantMessage | undefined;
    let iterationsUsed = 0;
    let toolCallCount = 0;
    let terminal: Terminal = { reason: 'error', error: new Error('AgentRunner: never terminated') };

    try {
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          terminal = step.value;
          break;
        }
        const ev = step.value;
        if (ev && typeof ev === 'object' && 'type' in ev) {
          if (ev.type === 'message_stop') iterationsUsed++;
          if (ev.type === 'assistant_message') {
            finalAssistant = ev.message;
            for (const block of ev.message.content) {
              if (block.type === 'tool_use') toolCallCount++;
            }
          }
        }
        yield ev;
      }
    } catch (err) {
      terminal = { reason: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }

    return {
      sessionId: this.opts.sessionId,
      ...(this.opts.parentSessionId !== undefined
        ? { parentSessionId: this.opts.parentSessionId }
        : {}),
      terminal,
      ...(finalAssistant !== undefined ? { finalAssistant } : {}),
      iterationsUsed,
      toolCallCount,
    };
  }
}
