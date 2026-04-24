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

import type { Tool, ToolContext } from '../tool/types.js';
import { runTools } from './orchestrator.js';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  QueryParams,
  StreamEvent,
  Terminal,
} from './types.js';

const DEFAULT_MAX_TURNS = 10;

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

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
  } = params;

  const toolPool: Tool<unknown, unknown>[] = tools ?? [];
  const toolCtx: ToolContext | undefined = params.toolContext;
  const history: Message[] = [...messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return { reason: 'interrupted' };

    let assistant: AssistantMessage | undefined;

    try {
      for await (const event of provider.stream({
        model,
        system: systemPrompt,
        messages: history,
        ...(toolPool.length > 0 ? { tools: toToolSchemas(toolPool) } : {}),
        maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === 'assistant_message') {
          assistant = event.message;
        }
        yield event;
      }
    } catch (err) {
      if (signal?.aborted) return { reason: 'interrupted' };
      return { reason: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (!assistant) {
      return {
        reason: 'error',
        error: new Error('provider stream ended without an assistant_message'),
      };
    }

    history.push(assistant);

    const toolUseBlocks = assistant.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      return { reason: 'completed' };
    }

    if (toolPool.length === 0) {
      return {
        reason: 'error',
        error: new Error(
          `assistant requested ${toolUseBlocks.length} tool call(s) but no tools were provided`,
        ),
      };
    }

    if (!toolCtx) {
      return {
        reason: 'error',
        error: new Error('tool_use encountered but no toolContext was passed in QueryParams'),
      };
    }

    try {
      for await (const msg of runTools(toolUseBlocks, toolCtx, toolPool)) {
        history.push(msg);
        yield msg;
      }
    } catch (err) {
      return { reason: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  return { reason: 'max_turns' };
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
 * Minimal zod→JSON-Schema conversion for Phase 2. Enough to describe the
 * tools we ship (object with scalar/number/string/optional fields). Phase
 * 5.5 or 9.5 will swap in a proper library (`zod-to-json-schema`) when we
 * have a tool with nested unions or refinements.
 */
function zodToJsonSchemaShallow(schema: unknown): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: pragmatic introspection
  const s = schema as any;
  if (!s || typeof s !== 'object') return { type: 'object' };
  const def = s._def;
  if (!def) return { type: 'object' };
  if (def.typeName === 'ZodObject') {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = zodToJsonSchemaShallow(field);
      if (!field.isOptional?.()) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
  if (def.typeName === 'ZodOptional') return zodToJsonSchemaShallow(def.innerType);
  if (def.typeName === 'ZodString') return { type: 'string' };
  if (def.typeName === 'ZodNumber') return { type: 'number' };
  if (def.typeName === 'ZodBoolean') return { type: 'boolean' };
  if (def.typeName === 'ZodArray') {
    return { type: 'array', items: zodToJsonSchemaShallow(def.type) };
  }
  return {};
}
