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
import { injectMemoryIntoLatestUserMessage } from '../memory/injection.js';
import type { Tool, ToolContext } from '../tool/types.js';
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
      await maybeFireStop('interrupted');
      return { reason: 'interrupted' };
    }

    let assistant: AssistantMessage | undefined;
    let stopReason: StopReason | undefined;

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
        if (event.type === 'assistant_message') {
          assistant = event.message;
        }
        if (event.type === 'message_stop') {
          stopReason = event.stop_reason;
        }
        yield event;
      }
    } catch (err) {
      if (signal?.aborted) {
        await maybeFireStop('interrupted');
        return { reason: 'interrupted' };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      await maybeFireStop('error');
      return { reason: 'error', error };
    }

    if (!assistant) {
      await maybeFireStop('error');
      return {
        reason: 'error',
        error: new Error('provider stream ended without an assistant_message'),
      };
    }

    history.push(assistant);

    const toolUseBlocks = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

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
      for await (const msg of runTools(toolUseBlocks, turnCtx, toolPool, canUseTool, hookRunner)) {
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

function toToolSchemas(
  tools: Tool<unknown, unknown>[],
): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((t) => ({
    name: t.name,
    description: describeToStatic(t),
    input_schema: zodToJsonSchemaShallow(t.inputSchema),
  }));
}

function describeToStatic(tool: Tool<unknown, unknown>): string {
  // `Tool.description` is `(input) => string | Promise<string>` — the input
  // shaping lets per-call tools tune their description (Claude Code pattern).
  // For schema-publication we need a static description, so we call with
  // `undefined` (valid for tools that ignore the argument). Tools that
  // actually use the input during schema construction must expose a static
  // fallback; Phase 2 tools don't.
  const result = tool.description(undefined as never);
  if (result instanceof Promise) {
    // Lazily-async descriptions aren't supported yet — fall back to the name.
    return tool.name;
  }
  return result;
}

/**
 * Minimal zod→JSON-Schema conversion. Covers what the harness's own tools
 * need: object/string/number/boolean/array/enum/literal, optional &
 * default unwrapping, and `.describe()` propagation. Phase 5.5 or 9.5
 * will swap in a proper library (`zod-to-json-schema`) when a tool needs
 * nested unions or refinements.
 */
function zodToJsonSchemaShallow(schema: unknown): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: pragmatic introspection
  const s = schema as any;
  if (!s || typeof s !== 'object') return { type: 'object' };
  const def = s._def;
  if (!def) return { type: 'object' };

  // Unwrap wrappers; the wrapped type's description, if any, wins. The
  // wrapper's own description (set on the optional/default shell) is
  // grafted onto the unwrapped result so `field.describe('...').optional()`
  // and `field.optional().describe('...')` both work.
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') {
    const inner = zodToJsonSchemaShallow(def.innerType);
    return def.description && typeof inner === 'object' && inner
      ? { ...(inner as object), description: def.description }
      : inner;
  }

  let result: Record<string, unknown> = {};
  if (def.typeName === 'ZodObject') {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = zodToJsonSchemaShallow(field);
      if (!field.isOptional?.()) required.push(key);
    }
    result = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  } else if (def.typeName === 'ZodString') {
    result = { type: 'string' };
  } else if (def.typeName === 'ZodNumber') {
    result = { type: 'number' };
  } else if (def.typeName === 'ZodBoolean') {
    result = { type: 'boolean' };
  } else if (def.typeName === 'ZodArray') {
    result = { type: 'array', items: zodToJsonSchemaShallow(def.type) };
  } else if (def.typeName === 'ZodEnum') {
    result = { type: 'string', enum: def.values };
  } else if (def.typeName === 'ZodLiteral') {
    // JSON-Schema `const` form. Anthropic accepts it; OpenAI tolerates it.
    result = { const: def.value };
  } else if (def.typeName === 'ZodNullable') {
    const inner = zodToJsonSchemaShallow(def.innerType);
    return inner;
  }

  if (def.description && !('description' in result)) {
    result.description = def.description;
  }
  return result;
}
