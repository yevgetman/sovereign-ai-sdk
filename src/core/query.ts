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
import { runTools } from './orchestrator.js';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  QueryParams,
  StopReason,
  StreamEvent,
  Terminal,
} from './types.js';

const DEFAULT_MAX_TURNS = 100;

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
    maxTurns = DEFAULT_MAX_TURNS,
    signal,
    cacheEnabled = true,
  } = params;

  const toolPool: Tool<unknown, unknown>[] = tools ?? [];
  const toolCtx: ToolContext | undefined = params.toolContext;
  const canUseTool = params.canUseTool;
  const hookRunner = params.hookRunner;
  const sessionId = params.sessionId ?? toolCtx?.sessionId;
  const cwd = params.cwd ?? toolCtx?.cwd;
  const recordTrace = makeTraceRecorder(params.traceRecorder);
  const loopDetector = new LoopDetectorState();
  let loopDetectionCount = 0;
  const originalUserText = latestUserText(messages);
  let history: Message[] = params.memoryManager
    ? await injectMemoryIntoLatestUserMessage(messages, params.memoryManager)
    : [...messages];

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
      history = rewriteLatestUserText(history, result.rewrittenPrompt);
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
    let usage: import('./types.js').TokenUsage | undefined;
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
        ...(signal ? { signal } : {}),
        cacheEnabled,
      })) {
        if (firstEventAt === undefined) firstEventAt = Date.now();
        if (event.type === 'assistant_message') {
          assistant = event.message;
        }
        if (event.type === 'usage_delta') {
          usage = event.usage;
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
        const guidance: Message = {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'It looks like the same action is repeating. Stop and try a different approach: ' +
                'check whether the prior step actually achieved the goal, change your tool, change ' +
                'your inputs, or ask for clarification before continuing.',
            },
          ],
        };
        history.push(guidance);
        yield guidance;
      } else {
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
        const msg = synthesizeToolResultMessage(
          toolUseBlocks,
          'tool call was not executed because the assistant response hit max_tokens before completing the turn',
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
      const msg = synthesizeToolResultMessage(
        toolUseBlocks,
        'tool call could not run: no tools were provided',
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
      const msg = synthesizeToolResultMessage(
        toolUseBlocks,
        'tool call could not run: no toolContext was provided',
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
        history.push(msg);
        yield msg;
      }
      // Microcompaction: clear stale tool results before the next provider call.
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
    } catch (err) {
      if (signal?.aborted) {
        const msg = synthesizeToolResultMessage(
          toolUseBlocks,
          'tool call interrupted before a result was available',
        );
        history.push(msg);
        yield msg;
        recordTrace({ type: 'interrupt', stage: `turn-${turn}-tool-dispatch`, iso: nowIso() });
        await maybeFireStop('interrupted');
        return { reason: 'interrupted' };
      }
      const message = err instanceof Error ? err.message : String(err);
      const msg = synthesizeToolResultMessage(
        toolUseBlocks,
        `tool orchestration failed before a result was available: ${message}`,
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
