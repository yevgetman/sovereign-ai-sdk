// Tool orchestration. Phase 3: `runTools` looks up each tool_use block in
// the provided tool pool, validates its input via the tool's zod schema,
// asks the permission decider if one is provided, and then dispatches
// sequentially. Yields a single user message with one tool_result block
// per input block (in the same order). A thrown error, validation failure,
// unknown-tool name, or permission denial becomes is_error=true on that
// block's tool_result — the outer turn loop never throws from here.
//
// Sequential execution is deliberate in Phase 2/3. Phase 4 restructures for
// path-scoped concurrency via `isConcurrencySafe(input)`. The interface
// yields an AsyncGenerator today so Phase 4 can yield intermediate batches
// without changing the caller shape (Invariant #5 — one pipe).
//
// Source of pattern: Claude Code src/services/tools/toolOrchestration.ts.

import type { CanUseTool } from '../permissions/types.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { BashTool, formatBashOutput, isBashError } from '../tools/BashTool.js';
import type { ContentBlock, Message, UserMessage } from './types.js';

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

/**
 * Execute every `tool_use` block in `blocks` against the given tool pool
 * and yield exactly one `user` message containing the corresponding
 * `tool_result` blocks in the same order. The generator shape leaves room
 * for Phase 4 to yield per-batch intermediate messages without callers
 * needing to change.
 */
export async function* runTools(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool<unknown, unknown>[],
  canUseTool?: CanUseTool,
): AsyncGenerator<Message, void> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const resultBlocks: ToolResultBlock[] = [];

  for (const block of blocks) {
    resultBlocks.push(await executeOne(block, ctx, toolsByName, canUseTool));
  }

  const userMessage: UserMessage = {
    role: 'user',
    content: resultBlocks,
  };
  yield userMessage;
}

async function executeOne(
  block: ToolUseBlock,
  ctx: ToolContext,
  toolsByName: Map<string, Tool<unknown, unknown>>,
  canUseTool?: CanUseTool,
): Promise<ToolResultBlock> {
  const tool = toolsByName.get(block.name);
  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `unknown tool: ${block.name}`,
      is_error: true,
    };
  }

  const parsed = tool.inputSchema.safeParse(block.input);
  if (!parsed.success) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `input validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      is_error: true,
    };
  }

  if (canUseTool) {
    const perm = await canUseTool(tool, parsed.data, ctx);
    if (perm.behavior === 'deny') {
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: perm.reason ? `permission denied: ${perm.reason}` : 'permission denied',
        is_error: true,
      };
    }
    // Phase 3 ignores perm.updatedInput; Phase 7 will re-validate and swap.
  }

  try {
    const result = await tool.call(parsed.data, ctx);
    return formatToolResult(tool, block.id, result.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `tool threw: ${msg}`,
      is_error: true,
    };
  }
}

/**
 * Turn a tool's structured output into a tool_result block. Bash has a
 * bespoke formatter + is_error decision so the model sees a tidy string
 * with the exit code called out. Other tools fall back to JSON.
 *
 * When Phase 4+ adds more tools, promote this to a per-tool formatter
 * interface on Tool itself (`renderResult?: (out: O) => {content, is_error}`).
 */
function formatToolResult(
  tool: Tool<unknown, unknown>,
  toolUseId: string,
  data: unknown,
): ToolResultBlock {
  if (tool.name === BashTool.name) {
    const bashData = data as ReturnType<typeof JSON.parse> & Parameters<typeof formatBashOutput>[0];
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: formatBashOutput(bashData),
      ...(isBashError(bashData) ? { is_error: true as const } : {}),
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  };
}
