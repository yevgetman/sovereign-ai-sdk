// The turn loop — async generator yielding typed events. Phase 2: wraps
// the Phase-1 single-turn body in a while-loop. When the assistant
// message contains `tool_use` blocks, dispatches to `runTools()`, yields
// the resulting user message (with tool_result blocks), and loops for a
// continuation turn. Terminates when the assistant responds without any
// tool_use, when maxTurns is hit, when aborted, or on error.
//
// History discipline: we build the history internally. The caller passes
// `messages` as the input seed; every assistant reply and tool-result
// user message is appended to the internal history, which is what's sent
// on the next iteration's provider.stream() call. The caller's array is
// not mutated.
//
// Source of pattern: Claude Code src/query.ts (lesson: core loop shape is
// a one-way door; use async generator from day one).

import {
  DEFAULT_MICROCOMPACT_CONFIG,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '../compact/microcompact.js';
import { LoopDetectorState } from '../loop/detector.js';
import { toToolSchemas } from '../mcp/schemaSerialization.js';
import { injectMemoryIntoLatestUserMessage } from '../memory/injection.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { type TurnSummary, detectStall } from '../util/stall.js';
import { runTools } from './orchestrator.js';
import { injectRecallIntoLatestUserMessage } from './recallInjection.js';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  QueryParams,
  StopReason,
  StreamEvent,
  Terminal,
  TokenUsage,
} from './types.js';

const DEFAULT_MAX_TURNS = 100;

// The TokenUsage fields carried by usage_delta events. Mirrors the
// usageAccumulator's field list (kept local — the boundary forbids importing
// its internals). `reasoningTokens` (T1) is an informational subset of
// outputTokens; it merges like the rest.
const USAGE_DELTA_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'reasoningTokens',
] as const satisfies readonly (keyof TokenUsage)[];

/** Merge one `usage_delta` into the call's running usage, last-seen PER FIELD.
 *  Anthropic emits input + cache at message_start then output at message_delta
 *  (a second delta that omits the earlier fields); a whole-object overwrite
 *  would drop them. Immutable: returns a NEW object spreading `prev`, then
 *  copies only the DEFINED fields of `delta` (never writing an explicit-
 *  undefined key — respecting exactOptionalPropertyTypes). Identical to the old
 *  `usage = delta` behavior when a call emits a single delta. */
function mergeUsage(prev: TokenUsage | undefined, delta: TokenUsage): TokenUsage {
  const merged: TokenUsage = { ...prev };
  for (const field of USAGE_DELTA_FIELDS) {
    const value = delta[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

/** Run one user turn, including provider streaming and tool-use continuation turns. */
export async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal> {
  const {
    provider,
    model,
    messages,
    systemPrompt,
    tools,
    maxTokens,
    temperature,
    effort,
    maxTurns = DEFAULT_MAX_TURNS,
    signal,
    cacheEnabled = true,
  } = params;

  // biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see createAgent AgentConfig.tools.
  const toolPool: Tool<any, any>[] = tools ?? [];
  const toolCtx: ToolContext | undefined = params.toolContext;
  const canUseTool = params.canUseTool;
  const hookRunner = params.hookRunner;
  const sessionId = params.sessionId ?? toolCtx?.sessionId;
  const cwd = params.cwd ?? toolCtx?.cwd;
  const recordTrace = makeTraceRecorder(params.traceRecorder);
  const loopDetector = new LoopDetectorState();
  let loopDetectionCount = 0;
  let totalToolCallCount = 0;
  // Phase 13.3 — sliding window of TurnSummary records for stall detection.
  const recentTurnSummaries: TurnSummary[] = [];
  const originalUserText = latestUserText(messages);
  let history: Message[] = params.memoryManager
    ? await injectMemoryIntoLatestUserMessage(messages, params.memoryManager)
    : [...messages];

  // Learning loop (Recall): after memory injection, prepend recalled lessons to
  // the latest user message. Optional thunk bound by the host; query() stays
  // project-agnostic. Empty injectionText leaves history unchanged (same ref).
  if (params.recall) {
    const recalled = await params.recall(originalUserText);
    history = injectRecallIntoLatestUserMessage(history, recalled.injectionText);
  }

  // Both memory + recall injection PREPEND their blocks to the latest user
  // message's first text block, keeping `originalUserText` as the trailing
  // suffix. Capture the injected prefix now so that if a UserPromptSubmit hook
  // rewrites the prompt below, we can preserve the injected context instead of
  // letting the whole-block rewrite silently wipe MEMORY.md / <learned-context>.
  // Empty when nothing was injected.
  const injectedPrefix =
    originalUserText !== undefined ? extractInjectedPrefix(history, originalUserText) : '';

  // UserPromptSubmit: runs once before turn 0. A hook can deny (terminating
  // immediately) or rewrite the prompt text in the latest user message.
  if (hookRunner && sessionId && cwd && originalUserText !== undefined) {
    const result = await hookRunner(
      'UserPromptSubmit',
      {
        hookEventName: 'UserPromptSubmit',
        session_id: sessionId,
        cwd,
        prompt: originalUserText,
      },
      signal,
    );
    if (result.block) {
      const terminal: Terminal = {
        reason: 'error',
        error: new Error(result.reason ?? 'prompt rejected by UserPromptSubmit hook'),
      };
      await fireStopHook(hookRunner, sessionId, cwd, terminal.reason, signal);
      return terminal;
    }
    if (typeof result.rewrittenPrompt === 'string') {
      // Re-apply the injected memory/recall prefix in front of the hook's
      // rewritten text. The hook only ever sees + returns the user prompt, so
      // without this the whole-block rewrite would drop that turn's injected
      // context. `injectedPrefix` is '' when nothing was injected → identical
      // to the plain rewrite.
      history = rewriteLatestUserText(history, `${injectedPrefix}${result.rewrittenPrompt}`);
    }
  }

  async function maybeFireStop(reason: Terminal['reason']): Promise<void> {
    if (hookRunner && sessionId && cwd) {
      await fireStopHook(hookRunner, sessionId, cwd, reason, signal);
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      recordTrace({ type: 'interrupt', stage: `turn-${turn}-pre-stream`, iso: nowIso() });
      await maybeFireStop('interrupted');
      return { reason: 'interrupted' };
    }

    recordTrace({ type: 'turn_start', turn, iso: nowIso() });

    let assistant: AssistantMessage | undefined;
    let stopReason: StopReason | undefined;
    let usage: TokenUsage | undefined;
    const requestStart = Date.now();
    let firstEventAt: number | undefined;

    recordTrace({
      type: 'provider_request',
      provider: provider.name,
      model,
      purpose: 'main',
      messageCount: history.length,
      systemBytes: systemPrompt.reduce((n, s) => n + Buffer.byteLength(s.text, 'utf8'), 0),
      iso: nowIso(),
    });

    try {
      for await (const event of provider.stream({
        model,
        system: systemPrompt,
        messages: history,
        ...(toolPool.length > 0 ? { tools: toToolSchemas(toolPool) } : {}),
        maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(signal ? { signal } : {}),
        cacheEnabled,
      })) {
        if (firstEventAt === undefined) firstEventAt = Date.now();
        if (event.type === 'assistant_message') {
          assistant = event.message;
        }
        if (event.type === 'usage_delta') {
          usage = mergeUsage(usage, event.usage);
        }
        if (event.type === 'message_stop') {
          stopReason = event.stop_reason;
        }
        yield event;
      }
    } catch (err) {
      if (signal?.aborted) {
        recordTrace({ type: 'interrupt', stage: `turn-${turn}-stream`, iso: nowIso() });
        await maybeFireStop('interrupted');
        return { reason: 'interrupted' };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      await maybeFireStop('error');
      return { reason: 'error', error };
    }

    recordTrace({
      type: 'provider_response',
      provider: provider.name,
      model,
      purpose: 'main',
      usage: usage ?? {},
      latencyMs: Date.now() - requestStart,
      ...(firstEventAt !== undefined ? { ttftMs: firstEventAt - requestStart } : {}),
      stopReason: stopReason ?? 'end_turn',
      iso: nowIso(),
    });

    if (!assistant) {
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error('provider stream ended without an assistant_message'),
      };
    }

    history.push(assistant);

    const toolUseBlocks = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    // Loop detection runs once per turn. Snapshot = this turn's tool calls
    // + the concatenated assistant text. The first detection injects a
    // guidance message and continues; the second terminates the run.
    const detection = loopDetector.addAndCheck({
      toolCalls: toolUseBlocks.map((b) => ({ name: b.name, input: b.input })),
      assistantText: assistantText(assistant),
    });
    // `pendingGuidanceText` carries the loop-detector guidance into the next
    // user message we emit this turn. Anthropic requires that an assistant
    // message containing `tool_use` be IMMEDIATELY followed by a user message
    // containing matching `tool_result` blocks — pushing a separate text-only
    // guidance message between them produces "tool_use ids were found
    // without tool_result blocks immediately after" (HTTP 400). When the
    // assistant emitted no tool_use (content-only loop), we emit guidance as
    // its own user message; nothing to orphan.
    let pendingGuidanceText: string | undefined;
    const consumeGuidance = (msg: Message): Message => {
      if (!pendingGuidanceText || msg.role !== 'user') return msg;
      const merged: Message = {
        role: 'user',
        content: [...msg.content, { type: 'text', text: pendingGuidanceText }],
      };
      pendingGuidanceText = undefined;
      return merged;
    };

    if (detection) {
      loopDetectionCount++;
      const info = {
        detector: detection.detector,
        hash: detection.hash,
        repetitionCount: detection.repetitionCount,
        occurrence: loopDetectionCount,
      } as const;
      yield { type: 'loop_detected', info } as StreamEvent;
      recordTrace({
        type: 'loop_detected',
        detector: detection.detector,
        repetitionCount: detection.repetitionCount,
        hash: detection.hash,
        iso: nowIso(),
      });
      if (loopDetectionCount === 1) {
        // First strike: carry guidance into THIS turn's next user message
        // (the tool_result emitted after dispatch), so the loop continues
        // with a course-correction nudge. On a content-only turn there are
        // no tool_use blocks to dispatch — so this turn TERMINATES below at
        // the `toolUseBlocks.length === 0` branch (a content-only turn never
        // continues). Pushing a standalone guidance user message here would
        // leave history ending on a user message that can never be acted on;
        // the NEXT user turn would then append a second consecutive user
        // message → Anthropic 400 "roles must alternate" → session broken.
        // So we only set pendingGuidanceText when there IS a continuation
        // (tool_use present); the loop_detected event + trace above still
        // fire either way, preserving the telemetry.
        if (toolUseBlocks.length > 0) {
          pendingGuidanceText =
            'It looks like the same action is repeating. Stop and try a different approach: ' +
            'check whether the prior step actually achieved the goal, change your tool, change ' +
            'your inputs, or ask for clarification before continuing.';
        }
      } else {
        // Second-strike abort: if this turn's assistant message contained
        // tool_use blocks, we must yield matching tool_result blocks before
        // returning. Anthropic requires every tool_use to be IMMEDIATELY
        // followed by a tool_result; without this the persisted history
        // (REPL turnMessages, sessionDb) is left in a 400-rejected state
        // and the next user message is unrecoverable. Mirrors the
        // signal-aborted dispatch path below.
        if (toolUseBlocks.length > 0) {
          const msg = synthesizeToolResultMessage(
            toolUseBlocks,
            'tool call interrupted by loop detector',
          );
          history.push(msg);
          yield msg;
        }
        await maybeFireStop('error');
        return {
          reason: 'error',
          error: new Error(
            `aborted by loop detector after ${loopDetectionCount} detections (${detection.detector})`,
          ),
        };
      }
    }

    if (stopReason === 'max_tokens') {
      if (toolUseBlocks.length > 0) {
        const msg = consumeGuidance(
          synthesizeToolResultMessage(
            toolUseBlocks,
            'tool call was not executed because the assistant response hit max_tokens before completing the turn',
          ),
        );
        history.push(msg);
        yield msg;
      }
      await maybeFireStop('max_tokens');
      return { reason: 'max_tokens' };
    }

    if (toolUseBlocks.length === 0) {
      if (params.memoryManager && originalUserText !== undefined) {
        await params.memoryManager.syncTurn(originalUserText, assistantText(assistant));
      }
      await maybeFireStop('completed');
      return { reason: 'completed' };
    }

    if (toolPool.length === 0) {
      const msg = consumeGuidance(
        synthesizeToolResultMessage(
          toolUseBlocks,
          'tool call could not run: no tools were provided',
        ),
      );
      history.push(msg);
      yield msg;
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error(
          `assistant requested ${toolUseBlocks.length} tool call(s) but no tools were provided`,
        ),
      };
    }

    if (!toolCtx) {
      const msg = consumeGuidance(
        synthesizeToolResultMessage(
          toolUseBlocks,
          'tool call could not run: no toolContext was provided',
        ),
      );
      history.push(msg);
      yield msg;
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error('tool_use encountered but no toolContext was passed in QueryParams'),
      };
    }

    // Propagate the query-level signal into the tool context so long-running
    // tools (BashTool's subprocess) and permission prompts can abort on
    // Ctrl-C. Phase 2 omitted this — latent until Phase 3 made it observable.
    const turnCtx: ToolContext = signal ? { ...toolCtx, signal } : toolCtx;

    try {
      for await (const msg of runTools(
        toolUseBlocks,
        turnCtx,
        toolPool,
        canUseTool,
        hookRunner,
        recordTrace,
      )) {
        const out = consumeGuidance(msg);
        history.push(out);
        yield out;
      }
      // Phase 13.3 — notify the review manager after a successful tool
      // batch. Sub-agent calls are silently no-op'd by the session-id
      // guard inside ReviewManager, so this unconditional call is safe.
      toolCtx.reviewManager?.onToolIteration(toolCtx.sessionId);
      // Phase 13.3 — stall / no-op detection. Tracks file edits, memory
      // writes, decisions, and tool errors per turn over a 3-turn sliding
      // window. Emits an advisory trace event on stall — never blocks.
      {
        const fileEditTools = new Set(['FileEdit', 'FileWrite']);
        const memoryWriteTools = new Set(['memory', 'memory_propose']);
        let fileEditCount = 0;
        let memoryWriteCount = 0;
        let toolErrorCount = 0;
        for (const block of toolUseBlocks) {
          if (fileEditTools.has(block.name)) fileEditCount += 1;
          if (memoryWriteTools.has(block.name)) memoryWriteCount += 1;
        }
        // Tool errors are surfaced via tool_result blocks with is_error=true.
        // Inspect the most recent user message (synthesized by runTools) for them.
        const lastMsg = history[history.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          for (const c of lastMsg.content) {
            if (
              typeof c === 'object' &&
              c !== null &&
              'type' in c &&
              c.type === 'tool_result' &&
              'is_error' in c &&
              c.is_error === true
            ) {
              toolErrorCount += 1;
            }
          }
        }
        const summary: TurnSummary = {
          fileEditCount,
          memoryWriteCount,
          decisionCount: 0, // TODO(phase 13.3+): wire decision tracking when infrastructure lands
          toolErrorCount,
          // ux-fixes round 2 — any tool call (read or write) counts as
          // progress so research-only turns don't trip the stall detector.
          toolCallCount: toolUseBlocks.length,
        };
        recentTurnSummaries.push(summary);
        if (recentTurnSummaries.length > 6) recentTurnSummaries.shift();
        const stall = detectStall(recentTurnSummaries);
        if (stall.stalled) {
          recordTrace({ type: 'stall_detected', reason: stall.reason, turn, iso: nowIso() });
        }
      }
      // Microcompaction: clear stale tool results before the next provider
      // call. Fires INSIDE the turn loop (mid-prompt), but tool_results
      // from the current user-prompt burst are protected by a turn-boundary
      // exclusion in `collectCompactableRefs` so the agent can still
      // reference them in the next iteration's assistant message. See
      // src/compact/microcompact.ts header for the rationale (backlog
      // Item 22, soak case G4).
      const mcConfig = params.microcompactConfig ?? DEFAULT_MICROCOMPACT_CONFIG;
      const toolNameMap = buildToolNameMap(history);
      if (shouldMicrocompact(history, mcConfig, toolNameMap)) {
        const { messages: compacted, result: mcResult } = microcompact(
          history,
          toolNameMap,
          mcConfig,
        );
        if (mcResult.cleared > 0) {
          history.length = 0;
          history.push(...compacted);
          recordTrace({
            type: 'microcompact',
            cleared: mcResult.cleared,
            estimatedTokensSaved: mcResult.estimatedTokensSaved,
            keptRecent: mcResult.keptRecent,
            iso: nowIso(),
          });
          yield { type: 'microcompact', info: mcResult } as StreamEvent;
        }
      }
      // Backlog item 24 — checkin guard. Accumulate per-turn tool-call count
      // after microcompaction so history is clean before we pause.
      totalToolCallCount += toolUseBlocks.length;
      if (
        params.maxToolCallsBeforeCheckin !== undefined &&
        totalToolCallCount >= params.maxToolCallsBeforeCheckin
      ) {
        return { reason: 'checkin', toolCallCount: totalToolCallCount };
      }
    } catch (err) {
      if (signal?.aborted) {
        const msg = consumeGuidance(
          synthesizeToolResultMessage(
            toolUseBlocks,
            'tool call interrupted before a result was available',
          ),
        );
        history.push(msg);
        yield msg;
        recordTrace({ type: 'interrupt', stage: `turn-${turn}-tool-dispatch`, iso: nowIso() });
        await maybeFireStop('interrupted');
        return { reason: 'interrupted' };
      }
      const message = err instanceof Error ? err.message : String(err);
      const msg = consumeGuidance(
        synthesizeToolResultMessage(
          toolUseBlocks,
          `tool orchestration failed before a result was available: ${message}`,
        ),
      );
      history.push(msg);
      yield msg;
      const error = err instanceof Error ? err : new Error(String(err));
      await maybeFireStop('error');
      return { reason: 'error', error };
    }
  }

  await maybeFireStop('max_turns');
  return { reason: 'max_turns' };
}

/** Fire the Stop hook. Failures are swallowed — a misbehaving Stop hook must
 *  not turn a 'completed' run into an 'error'. */
async function fireStopHook(
  runner: import('../hooks/types.js').HookRunner,
  sessionId: string,
  cwd: string,
  reason: Terminal['reason'],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runner('Stop', { hookEventName: 'Stop', session_id: sessionId, cwd, reason }, signal);
  } catch {
    // Stop hooks are observers; never propagate.
  }
}

function rewriteLatestUserText(messages: Message[], next: string): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const idx = message.content.findIndex((block) => block.type === 'text');
    if (idx === -1) continue;
    const updatedContent = message.content.slice();
    updatedContent[idx] = { type: 'text', text: next };
    const out = messages.slice();
    out[i] = { ...message, content: updatedContent };
    return out;
  }
  return messages;
}

/** Return the memory/recall context prepended to the latest user message's
 *  first text block. Both injectors prepend their block and keep
 *  `originalUserText` as the trailing suffix, so the prefix is everything
 *  before that suffix. Returns '' when no injection happened (the block equals
 *  the original text) or the block no longer ends with the original text. */
function extractInjectedPrefix(messages: Message[], originalUserText: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const block = message.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return '';
    if (block.text === originalUserText) return '';
    if (block.text.endsWith(originalUserText)) {
      return block.text.slice(0, block.text.length - originalUserText.length);
    }
    return '';
  }
  return '';
}

function latestUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const text = message.content.find((block) => block.type === 'text');
    return text?.type === 'text' ? text.text : undefined;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function synthesizeToolResultMessage(blocks: ToolUseBlock[], content: string): Message {
  return {
    role: 'user',
    content: blocks.map((block) => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content,
      is_error: true,
    })),
  };
}

// toToolSchemas + zodToJsonSchemaShallow moved to src/mcp/schemaSerialization.ts
// in Phase 12 — they now also handle deferred-tool descriptions and
// MCP-supplied JSON Schemas. Imported at the top of this file.

/** Wrap an optional trace handler with a no-throw shim. Returns a no-op
 *  recorder when none is supplied so call sites don't need null checks. */
function makeTraceRecorder(
  handler: ((event: TraceEvent) => void) | undefined,
): (event: TraceEvent) => void {
  if (!handler) return () => {};
  return (event) => {
    try {
      handler(event);
    } catch {
      // A misbehaving recorder must not turn a working session into an error.
    }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
