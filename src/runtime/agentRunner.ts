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

  /** Optional seed history. When set, `run()` uses this array verbatim as the
   *  model's starting context INSTEAD of building a single-message seed from
   *  the `run(prompt)` argument (the prompt is then ignored). The caller is
   *  responsible for ordering — the array must already end with the new user
   *  message the turn is responding to (i.e. `[...priorMessages, newUser]`) and
   *  must be provider-valid (run `repairMissingToolResults` first so an
   *  orphaned tool_use from a prior turn doesn't reject). AgentRunner never
   *  persists; the caller owns the session DB. This is how the channel pipeline
   *  hydrates a continuous conversation's prior history into the model context
   *  while keeping the headless turn loop. */
  initialMessages?: Message[];

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
  /** Phase 13.4 follow-up (Item 7) — distinct tool names invoked across
   *  the child's run, deduplicated and sorted for stable serialization.
   *  Used by ReviewManager to triage skill-shaped children (>= 4 calls
   *  AND >= 3 distinct tools fires review-skill in addition to
   *  review-memory). May be empty when the child made zero tool calls. */
  distinctToolNames: string[];
  /** Full message history of the run, including the seed user prompt,
   *  every assistant message, and every tool_result-carrying user
   *  message yielded between turns. The caller can pass this to the
   *  trajectory writer (the SubagentScheduler does this) so child
   *  sessions get captured as standalone trajectory records, not just
   *  as summary text inside the parent's record. */
  messages: Message[];
};

/** Runs an agent loop end-to-end starting from a single user prompt.
 *  Yields StreamEvents and Messages from query() unchanged; returns a
 *  structured AgentRunnerResult on terminal. */
export class AgentRunner {
  constructor(private readonly opts: AgentRunnerOpts) {}

  async *run(prompt: string): AsyncGenerator<StreamEvent | Message, AgentRunnerResult> {
    // When the caller supplies `initialMessages`, use them verbatim as the seed
    // (the conversation's prior history already ending with the new user
    // message) and ignore `prompt`. Otherwise build the legacy single-message
    // seed from the prompt — the default for sub-agents + cron, which always
    // cold-start from one instruction string.
    const seedMessages: Message[] =
      this.opts.initialMessages !== undefined
        ? this.opts.initialMessages
        : [{ role: 'user', content: [{ type: 'text', text: prompt }] }];

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
    // Phase 13.4 follow-up (Item 7) — track distinct tool names alongside
    // the call counter so ReviewManager can triage skill-shaped children.
    const distinctTools = new Set<string>();
    let terminal: Terminal = { reason: 'error', error: new Error('AgentRunner: never terminated') };
    // Track the full conversation history for trajectory capture.
    // query() yields:
    //   - StreamEvents (with `type` field) — assistant_message carries
    //     the assistant turn; we append to messages on those events.
    //   - User Messages (with `role: 'user'`) — yielded between turns
    //     to carry tool_result blocks; we append those directly.
    // The seed user prompt is in messages from the start.
    const messages: Message[] = [...seedMessages];

    try {
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          terminal = step.value;
          break;
        }
        const ev = step.value;
        if (ev && typeof ev === 'object') {
          if ('type' in ev) {
            if (ev.type === 'message_stop') iterationsUsed++;
            if (ev.type === 'assistant_message') {
              finalAssistant = ev.message;
              messages.push(ev.message);
              for (const block of ev.message.content) {
                if (block.type === 'tool_use') {
                  toolCallCount++;
                  distinctTools.add(block.name);
                }
              }
            }
          } else if ('role' in ev && ev.role === 'user') {
            messages.push(ev);
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
      distinctToolNames: Array.from(distinctTools).sort(),
      messages,
    };
  }
}
