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

import { safeStaticToolDescription } from '../tool/staticDescription.js';
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
  // Static, crash-safe resolution shared with systemPrompt / ToolSearch /
  // budget: degrades an input-dependent throw, an async (possibly rejecting)
  // description, or a non-string return to the tool name — see
  // tool/staticDescription.ts for the full corner rationale.
  return safeStaticToolDescription(tool);
}

type ZodDef = {
  typeName?: string;
  type?: unknown;
  description?: unknown;
  innerType?: unknown;
  shape?: unknown;
  element?: unknown;
  values?: unknown;
  value?: unknown;
  entries?: unknown;
};

type ZodSchema = {
  _def?: ZodDef;
  def?: ZodDef;
  description?: unknown;
  isOptional?: () => boolean;
};

/**
 * Minimal zod→JSON-Schema conversion. Covers what the harness's own tools
 * need: object/string/number/boolean/array/enum/literal, optional &
 * default unwrapping, and `.describe()` propagation.
 *
 * Reads zod 3 (`_def.typeName`) and zod 4 (`def.type`) so a consumer can
 * still pass a schema built by either major. The emitted shape stays the
 * zod 3 wire result: defaults and `z.unknown()` stay out of `required`,
 * and `.default()` does not become `additionalProperties` or `$schema`.
 */
export function zodToJsonSchemaShallow(schema: unknown): unknown {
  const s = schema as ZodSchema | null;
  if (!s || typeof s !== 'object') return { type: 'object' };
  const def = s._def ?? s.def;
  if (!def) return { type: 'object' };
  const kind = schemaKind(def);

  // Unwrap wrappers. A description on the wrapper wins over the inner one,
  // so `field.describe('...').optional()` and `field.optional().describe('...')`
  // both survive. `prefault` is the zod 4 form of a parsed empty default.
  if (kind === 'optional' || kind === 'default' || kind === 'prefault') {
    const inner = zodToJsonSchemaShallow(def.innerType);
    const description = schemaDescription(s);
    return description && typeof inner === 'object' && inner
      ? { ...(inner as object), description }
      : inner;
  }

  let result: Record<string, unknown> = {};
  if (kind === 'object') {
    const rawShape = def.shape;
    const shape = typeof rawShape === 'function' ? rawShape() : rawShape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (shape && typeof shape === 'object') {
      for (const key of Object.keys(shape as Record<string, unknown>)) {
        const field = (shape as Record<string, unknown>)[key];
        properties[key] = zodToJsonSchemaShallow(field);
        if (!fieldIsOptional(field)) required.push(key);
      }
    }
    result = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  } else if (kind === 'string') {
    result = { type: 'string' };
  } else if (kind === 'number') {
    result = { type: 'number' };
  } else if (kind === 'boolean') {
    result = { type: 'boolean' };
  } else if (kind === 'array') {
    result = { type: 'array', items: zodToJsonSchemaShallow(def.element ?? def.type) };
  } else if (kind === 'enum') {
    result = { type: 'string', enum: enumValues(def) };
  } else if (kind === 'literal') {
    // JSON-Schema `const` form. Anthropic accepts it; OpenAI tolerates it.
    result = { const: literalValue(def) };
  } else if (kind === 'nullable') {
    return zodToJsonSchemaShallow(def.innerType);
  } else if (kind === 'unknown' || kind === 'any') {
    // MCP wrappers use z.unknown() as a passthrough; emit a permissive
    // object so providers accept any shape from the model.
    result = { type: 'object', additionalProperties: true };
  }

  const description = schemaDescription(s);
  if (description && !('description' in result)) {
    result.description = description;
  }
  return result;
}

function schemaKind(def: ZodDef): string | undefined {
  switch (def.typeName) {
    case 'ZodOptional':
      return 'optional';
    case 'ZodDefault':
      return 'default';
    case 'ZodObject':
      return 'object';
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return 'array';
    case 'ZodEnum':
      return 'enum';
    case 'ZodLiteral':
      return 'literal';
    case 'ZodNullable':
      return 'nullable';
    case 'ZodUnknown':
      return 'unknown';
    case 'ZodAny':
      return 'any';
    default:
      break;
  }
  return typeof def.type === 'string' ? def.type : undefined;
}

function schemaDescription(schema: ZodSchema): string | undefined {
  if (typeof schema.description === 'string') return schema.description;
  const def = schema._def ?? schema.def;
  return typeof def?.description === 'string' ? def.description : undefined;
}

function fieldIsOptional(field: unknown): boolean {
  if (!field || typeof field !== 'object') return false;
  const candidate = field as ZodSchema;
  return typeof candidate.isOptional === 'function' ? candidate.isOptional() : false;
}

function enumValues(def: ZodDef): unknown[] {
  if (Array.isArray(def.values)) return def.values;
  if (def.entries && typeof def.entries === 'object') return Object.values(def.entries);
  return [];
}

function literalValue(def: ZodDef): unknown {
  if (def.typeName === 'ZodLiteral') return def.value;
  if (Array.isArray(def.values)) return def.values[0];
  return def.value;
}
