// Tool orchestration. Phase 4: contiguous-class partitioning, concurrent
// execution capped at CONCURRENT_CAP, path-scoped overlap detection that
// serializes a write against any other access on the same path, and
// order-preserving result re-insertion (Promise.all completion order is
// thrown away — output blocks land in original tool-call order). Per-tool
// result rendering via Tool.renderResult lifted the BashTool special case
// out of this module — the orchestrator no longer knows about individual
// tools' output shapes.
//
// Sequential semantics are preserved when every block in a partition is
// concurrency-unsafe (the Phase 2/3 default for `buildTool`'s fail-closed
// defaults), so existing tools continue to behave identically until they
// opt into `isConcurrencySafe(input): true`.
//
// Source of pattern: Claude Code src/services/tools/toolOrchestration.ts;
// path-scoped serialization mirrors hermes-reverse-engineering.md §2.6.

import { isAbsolute, resolve } from 'node:path';
import type { CanUseTool } from '../permissions/types.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { ContentBlock, Message, UserMessage } from './types.js';

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

/** Maximum number of tool calls dispatched in a single Promise.all batch.
 * Bigger concurrent batches risk thundering herd against the filesystem,
 * the model's context window for partial results, or hitting open-file
 * limits. 10 matches Claude Code. */
export const CONCURRENT_CAP = 10;

type IndexedBlock = { block: ToolUseBlock; index: number };

type Partition =
  | { mode: 'serial'; items: IndexedBlock[] }
  | { mode: 'concurrent'; items: IndexedBlock[] };

/**
 * Execute every `tool_use` block in `blocks` against the given tool pool
 * and yield exactly one `user` message containing the corresponding
 * `tool_result` blocks in the same order. Internally the run is split
 * into concurrent and serial partitions per `tool.isConcurrencySafe`,
 * and concurrent partitions are further split into path-conflict-free
 * sub-batches. Completion order is thrown away — the final block array
 * matches the input order regardless of timing.
 */
export async function* runTools(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool<unknown, unknown>[],
  canUseTool?: CanUseTool,
): AsyncGenerator<Message, void> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const results: (ToolResultBlock | undefined)[] = new Array(blocks.length);

  const partitions = partitionToolCalls(blocks, toolsByName);

  for (const partition of partitions) {
    if (partition.mode === 'serial') {
      await runSerialPartition(partition.items, ctx, toolsByName, canUseTool, results);
    } else {
      await runConcurrentPartition(partition.items, ctx, toolsByName, canUseTool, results);
    }
  }

  const resolved: ToolResultBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const r = results[i];
    if (r === undefined) {
      // Defensive: every block must produce a result. If we ever ship a
      // partition that misses a slot, surface it as a tool_result error
      // rather than yielding a malformed message.
      const block = blocks[i];
      resolved.push({
        type: 'tool_result',
        tool_use_id: block ? block.id : '',
        content: 'orchestration error: tool result missing',
        is_error: true,
      });
    } else {
      resolved.push(r);
    }
  }

  const userMessage: UserMessage = { role: 'user', content: resolved };
  yield userMessage;
}

// ──────────────────────────────────────────────────────────────────────
// Partitioning — group contiguous same-class blocks. The class is "serial"
// when `tool.isConcurrencySafe(input)` returns false (or the tool is
// missing — we let `executeOne` produce the unknown-tool error in serial
// context) and "concurrent" when it returns true. A single change in
// concurrency class closes the current partition and opens a new one.
// ──────────────────────────────────────────────────────────────────────

export function partitionToolCalls(
  blocks: ToolUseBlock[],
  toolsByName: Map<string, Tool<unknown, unknown>>,
): Partition[] {
  const partitions: Partition[] = [];
  let current: IndexedBlock[] = [];
  let currentMode: 'serial' | 'concurrent' | null = null;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const tool = toolsByName.get(block.name);
    const concurrent = tool ? safeIsConcurrencySafe(tool, block.input) : false;
    const mode: 'serial' | 'concurrent' = concurrent ? 'concurrent' : 'serial';

    if (mode === currentMode) {
      current.push({ block, index: i });
    } else {
      if (current.length > 0 && currentMode) {
        partitions.push({ mode: currentMode, items: current });
      }
      current = [{ block, index: i }];
      currentMode = mode;
    }
  }
  if (current.length > 0 && currentMode) {
    partitions.push({ mode: currentMode, items: current });
  }
  return partitions;
}

// ──────────────────────────────────────────────────────────────────────
// Serial dispatch — strictly sequential, preserves the Phase 2/3 default
// behavior. ToolResult.newMessages will eventually splice into history
// here (Phase 9 skill activation hints); for Phase 4 we ignore them.
// ──────────────────────────────────────────────────────────────────────

async function runSerialPartition(
  items: IndexedBlock[],
  ctx: ToolContext,
  toolsByName: Map<string, Tool<unknown, unknown>>,
  canUseTool: CanUseTool | undefined,
  out: (ToolResultBlock | undefined)[],
): Promise<void> {
  for (const item of items) {
    out[item.index] = await executeOne(item.block, ctx, toolsByName, canUseTool);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Concurrent dispatch — split into path-conflict-free sub-batches, run
// each with Promise.all (capped at CONCURRENT_CAP), preserve original
// indices regardless of completion order.
// ──────────────────────────────────────────────────────────────────────

async function runConcurrentPartition(
  items: IndexedBlock[],
  ctx: ToolContext,
  toolsByName: Map<string, Tool<unknown, unknown>>,
  canUseTool: CanUseTool | undefined,
  out: (ToolResultBlock | undefined)[],
): Promise<void> {
  const subBatches = splitByPathOverlap(items, toolsByName, ctx.cwd);

  for (const batch of subBatches) {
    // Cap at CONCURRENT_CAP — split the batch into waves if needed.
    for (let start = 0; start < batch.length; start += CONCURRENT_CAP) {
      const wave = batch.slice(start, start + CONCURRENT_CAP);
      const waveResults = await Promise.all(
        wave.map((item) => executeOne(item.block, ctx, toolsByName, canUseTool)),
      );
      for (let j = 0; j < wave.length; j++) {
        const item = wave[j];
        const result = waveResults[j];
        if (item && result) out[item.index] = result;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Path-scoped sub-batching. Walks blocks in order; opens a new sub-batch
// whenever the next block would conflict with anything already in the
// current sub-batch. Conflict = at least one block is a writer AND their
// affected paths overlap (same file, or one is a parent dir of the other).
// Blocks without `affectedPaths` (Bash, Grep, Glob) never conflict.
// ──────────────────────────────────────────────────────────────────────

export function splitByPathOverlap(
  items: IndexedBlock[],
  toolsByName: Map<string, Tool<unknown, unknown>>,
  cwd: string,
): IndexedBlock[][] {
  const subBatches: IndexedBlock[][] = [];
  let current: IndexedBlock[] = [];

  for (const item of items) {
    if (current.length > 0 && conflictsWithAny(item, current, toolsByName, cwd)) {
      subBatches.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) subBatches.push(current);
  return subBatches;
}

function conflictsWithAny(
  candidate: IndexedBlock,
  others: IndexedBlock[],
  toolsByName: Map<string, Tool<unknown, unknown>>,
  cwd: string,
): boolean {
  const candidateTool = toolsByName.get(candidate.block.name);
  if (!candidateTool) return false;
  const candidatePaths = getAffectedPaths(candidateTool, candidate.block.input, cwd);
  if (candidatePaths.length === 0) return false;
  const candidateIsWriter = !safeIsReadOnly(candidateTool, candidate.block.input);

  for (const other of others) {
    const otherTool = toolsByName.get(other.block.name);
    if (!otherTool) continue;
    const otherPaths = getAffectedPaths(otherTool, other.block.input, cwd);
    if (otherPaths.length === 0) continue;
    const otherIsWriter = !safeIsReadOnly(otherTool, other.block.input);
    // Two readers on the same/overlapping path are still safe to run in
    // parallel (idempotent reads). Only a writer-vs-anything overlap forces
    // serialization.
    if (!candidateIsWriter && !otherIsWriter) continue;
    if (anyPathsOverlap(candidatePaths, otherPaths)) return true;
  }
  return false;
}

function anyPathsOverlap(a: string[], b: string[]): boolean {
  for (const p of a) {
    for (const q of b) {
      if (pathsOverlap(p, q)) return true;
    }
  }
  return false;
}

/** Two normalized absolute paths overlap if they're identical or one is a
 *  proper ancestor of the other on the filesystem hierarchy. */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aSlash = a.endsWith('/') ? a : `${a}/`;
  const bSlash = b.endsWith('/') ? b : `${b}/`;
  return b.startsWith(aSlash) || a.startsWith(bSlash);
}

function getAffectedPaths(tool: Tool<unknown, unknown>, input: unknown, cwd: string): string[] {
  if (!tool.affectedPaths) return [];
  try {
    const raw = tool.affectedPaths(input);
    return raw.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
  } catch {
    return [];
  }
}

function safeIsConcurrencySafe(tool: Tool<unknown, unknown>, input: unknown): boolean {
  try {
    return tool.isConcurrencySafe(input);
  } catch {
    return false; // fail-closed
  }
}

function safeIsReadOnly(tool: Tool<unknown, unknown>, input: unknown): boolean {
  try {
    return tool.isReadOnly(input);
  } catch {
    return false; // fail-closed
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-block dispatch — unchanged from Phase 3 except the result formatter
// is now generic. A thrown error, validation failure, unknown-tool name,
// or permission denial becomes is_error=true on that block's tool_result.
// The outer turn loop never throws from here.
// ──────────────────────────────────────────────────────────────────────

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

function formatToolResult(
  tool: Tool<unknown, unknown>,
  toolUseId: string,
  data: unknown,
): ToolResultBlock {
  if (tool.renderResult) {
    const rendered = tool.renderResult(data);
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: rendered.content,
      ...(rendered.isError ? { is_error: true as const } : {}),
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  };
}
