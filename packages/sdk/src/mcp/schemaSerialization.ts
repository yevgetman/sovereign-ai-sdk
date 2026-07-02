// Build the provider-bound `tools` array. Three paths in priority order:
//   1. shouldDefer → emit { name, description: searchHint || description,
//      input_schema: minimal-passthrough }. The model sees the tool exists
//      but can't construct a call until it fetches the full schema via
//      ToolSearchTool. Saves prompt tokens; cache stays warm because the
//      search-hint string changes only when the tool inventory changes.
//   2. inputJSONSchema present (MCP) → emit verbatim. The MCP server
//      defines its own JSON Schema; we don't reinterpret it.
//   3. Otherwise → run the existing minimal Zod→JSONSchema converter.
//
// Source of pattern: harness-build-plan.md §"Phase 12";
// claude-code-reverse-engineering.md §11.2 + §10.4 (deferred tools).

import type { Tool } from '../tool/types.js';

export type ProviderToolSchema = {
  name: string;
  description: string;
  input_schema: unknown;
};

const DEFERRED_PASSTHROUGH_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

// biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see createAgent AgentConfig.tools.
export function toToolSchemas(tools: Tool<any, any>[]): ProviderToolSchema[] {
  return tools.map((t) => buildOne(t));
}

function buildOne(tool: Tool<unknown, unknown>): ProviderToolSchema {
  if (tool.shouldDefer) {
    return {
      name: tool.name,
      description: deferredDescription(tool),
      input_schema: DEFERRED_PASSTHROUGH_SCHEMA,
    };
  }
  if (tool.inputJSONSchema) {
    return {
      name: tool.name,
      description: describeToStatic(tool),
      input_schema: tool.inputJSONSchema,
    };
  }
  return {
    name: tool.name,
    description: describeToStatic(tool),
    input_schema: zodToJsonSchemaShallow(tool.inputSchema),
  };
}

function deferredDescription(tool: Tool<unknown, unknown>): string {
  const hint = tool.searchHint?.trim();
  if (hint) return `${hint} (deferred — call ToolSearch to fetch full schema)`;
  const fallback = describeToStatic(tool);
  return `${fallback} (deferred — call ToolSearch to fetch full schema)`;
}

function describeToStatic(tool: Tool<unknown, unknown>): string {
  // `Tool.description` is `(input) => string | Promise<string>` — the input
  // shaping lets per-call tools tune their description (Claude Code pattern).
  // For schema-publication we need a static description, so we call with
  // `undefined` (valid for tools that ignore the argument). A consumer tool
  // whose description is input-dependent can throw on the `undefined` sentinel;
  // degrade to the tool name rather than crashing the whole provider request
  // (mirrors the guards in context/systemPrompt.ts and context/budget.ts).
  try {
    const result = tool.description(undefined as never);
    if (result instanceof Promise) {
      // Lazily-async descriptions aren't supported yet — fall back to the name.
      return tool.name;
    }
    return result;
  } catch {
    return tool.name;
  }
}

/**
 * Minimal zod→JSON-Schema conversion. Covers what the harness's own tools
 * need: object/string/number/boolean/array/enum/literal, optional &
 * default unwrapping, and `.describe()` propagation.
 */
export function zodToJsonSchemaShallow(schema: unknown): unknown {
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
  } else if (def.typeName === 'ZodUnknown' || def.typeName === 'ZodAny') {
    // MCP wrappers use z.unknown() as a passthrough; emit a permissive
    // object so providers accept any shape from the model.
    result = { type: 'object', additionalProperties: true };
  }

  if (def.description && !('description' in result)) {
    result.description = def.description;
  }
  return result;
}
