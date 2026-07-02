// ToolSearchTool — the model's lookup mechanism for deferred tools.
// Deferred tools (currently MCP) appear in the provider tools array as a
// name + searchHint only; their full schemas are not in the prompt. When
// the model needs to call one, it invokes ToolSearch with a keyword query
// or a `select:name1,name2` form to retrieve the schemas, then emits the
// real tool_use on the next turn.
//
// The factory (buildToolSearchTool) closes over a getter so the search
// always reflects the current deferred-tool inventory. Phase 12 wires it
// once per session in the tool registry.
//
// Source of pattern: harness-build-plan.md §"Phase 12";
// claude-code-reverse-engineering.md §10.4 / §11.4.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import { safeStaticToolDescription } from '../tool/staticDescription.js';
import type { Tool } from '../tool/types.js';

const inputSchema = z.object({
  query: z
    .string()
    .describe(
      "Either a keyword to match against deferred tool names and descriptions, or 'select:name1,name2,...' to fetch named tools verbatim.",
    ),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  matched: Array<{ name: string; description: string; inputSchema: unknown }>;
};

const SELECT_PREFIX = 'select:';

export function buildToolSearchTool(
  getDeferredTools: () => Tool<unknown, unknown>[],
): Tool<Input, Output> {
  return buildTool<Input, Output>({
    name: 'ToolSearch',
    description: () =>
      'Look up the full input schema of one or more deferred tools (e.g. MCP-provided tools). ' +
      "Pass a keyword to search names and descriptions, or 'select:name1,name2' to fetch named tools verbatim. " +
      'Use this before calling any tool whose description ends in "(deferred — call ToolSearch to fetch full schema)".',
    inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderHint: { kind: 'tree' },
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    async call(input) {
      const deferred = getDeferredTools();
      const matched = matchTools(input.query, deferred);
      return {
        data: { matched },
        observation:
          matched.length === 0
            ? {
                status: 'warning',
                summary: `no deferred tools matched "${input.query}"`,
                next_actions: [
                  'try a broader keyword query, or check that any MCP servers are connected (call HarnessInfo with section: "mcp")',
                  'if you know the tool name, use the form `select:<name>` to fetch its schema directly',
                ],
              }
            : {
                status: 'success',
                summary: `${matched.length} deferred tool${matched.length === 1 ? '' : 's'} matched`,
              },
      };
    },
    renderResult: (out) => {
      if (out.matched.length === 0) {
        return { content: 'No matching deferred tools.' };
      }
      const formatted = out.matched
        .map(
          (t) =>
            `### ${t.name}\n${t.description}\n\nInput schema:\n\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``,
        )
        .join('\n\n---\n\n');
      return { content: formatted };
    },
  });
}

export function matchTools(query: string, deferred: Tool<unknown, unknown>[]): Output['matched'] {
  const trimmed = query.trim();

  if (trimmed.startsWith(SELECT_PREFIX)) {
    const names = trimmed
      .slice(SELECT_PREFIX.length)
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const byName = new Map(deferred.map((t) => [t.name, t]));
    return names.flatMap((n) => {
      const t = byName.get(n);
      return t ? [toMatch(t)] : [];
    });
  }

  const lower = trimmed.toLowerCase();
  if (lower.length === 0) {
    return deferred.map(toMatch);
  }
  return deferred
    .filter((t) => {
      if (t.name.toLowerCase().includes(lower)) return true;
      const hint = t.searchHint?.toLowerCase() ?? '';
      return hint.includes(lower);
    })
    .map(toMatch);
}

function toMatch(tool: Tool<unknown, unknown>): Output['matched'][number] {
  const description = describeStatic(tool);
  return {
    name: tool.name,
    description,
    // Prefer the verbatim JSON Schema (MCP tools); fall back to whatever
    // the orchestrator would otherwise serialize.
    inputSchema: tool.inputJSONSchema ?? null,
  };
}

function describeStatic(tool: Tool<unknown, unknown>): string {
  // Static, crash-safe resolution shared with schemaSerialization / systemPrompt
  // / budget: an input-dependent throw, an async (possibly rejecting)
  // description, or a non-string return all degrade to the tool name without
  // crashing the lookup (see tool/staticDescription.ts).
  return safeStaticToolDescription(tool);
}
