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

import { appendSubdirectoryHints } from '../context/subdirectoryHints.js';
import type { HookRunner } from '../hooks/types.js';
import type { CanUseTool } from '../permissions/types.js';
import type { Tool, ToolContext, ToolObservation } from '../tool/types.js';
import { resolveToolPath } from '../tools/pathUtils.js';
import type { TraceEvent } from '../trace/types.js';
import type { ObservationStatus } from './observePort.js';
import type { ContentBlock, Message, UserMessage } from './types.js';

type TraceRecorder = (event: TraceEvent) => void;
const NO_TRACE: TraceRecorder = () => {};

function nowIso(): string {
  return new Date().toISOString();
}

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
  hookRunner?: HookRunner,
  traceRecorder?: TraceRecorder,
): AsyncGenerator<Message, void> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const results: (ToolResultBlock | undefined)[] = new Array(blocks.length);
  const recordTrace = traceRecorder ?? NO_TRACE;

  const partitions = partitionToolCalls(blocks, toolsByName);

  for (const partition of partitions) {
    if (partition.mode === 'serial') {
      await runSerialPartition(
        partition.items,
        ctx,
        toolsByName,
        canUseTool,
        hookRunner,
        recordTrace,
        results,
      );
    } else {
      await runConcurrentPartition(
        partition.items,
        ctx,
        toolsByName,
        canUseTool,
        hookRunner,
        recordTrace,
        results,
      );
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
  hookRunner: HookRunner | undefined,
  recordTrace: TraceRecorder,
  out: (ToolResultBlock | undefined)[],
): Promise<void> {
  for (const item of items) {
    out[item.index] = await executeOne(
      item.block,
      ctx,
      toolsByName,
      canUseTool,
      hookRunner,
      recordTrace,
    );
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
  hookRunner: HookRunner | undefined,
  recordTrace: TraceRecorder,
  out: (ToolResultBlock | undefined)[],
): Promise<void> {
  const subBatches = splitByPathOverlap(items, toolsByName, ctx.cwd);

  for (const batch of subBatches) {
    // Cap at CONCURRENT_CAP — split the batch into waves if needed.
    for (let start = 0; start < batch.length; start += CONCURRENT_CAP) {
      const wave = batch.slice(start, start + CONCURRENT_CAP);
      const waveResults = await Promise.all(
        wave.map((item) =>
          executeOne(item.block, ctx, toolsByName, canUseTool, hookRunner, recordTrace),
        ),
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
    return raw.map((p) => resolveToolPath(p, cwd));
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
// Per-block dispatch. A thrown error, validation failure, unknown-tool
// name, permission denial, or invalid permission-updated input becomes
// is_error=true on that block's tool_result. The outer turn loop never
// throws from here.
// ──────────────────────────────────────────────────────────────────────

async function executeOne(
  block: ToolUseBlock,
  ctx: ToolContext,
  toolsByName: Map<string, Tool<unknown, unknown>>,
  canUseTool?: CanUseTool,
  hookRunner?: HookRunner,
  recordTrace: TraceRecorder = NO_TRACE,
): Promise<ToolResultBlock> {
  // Phase 13.4 follow-up (backlog item 5) — track the terminal observation
  // status so every early-return path in this dispatcher can notify the
  // learning observer with the correct ObservationStatus value. Without this
  // bookkeeping the corpus would only ever see success/error; denied and
  // cancelled outcomes (which short-circuit before tool.call() runs) would
  // silently disappear and the synthesizer could not learn negative
  // examples ("user rejects this pattern").
  const dispatchStart = Date.now();
  const tool = toolsByName.get(block.name);
  if (!tool) {
    // Unknown-tool: no schema-validated input to record, but observer's
    // null-tolerant serializer accepts the raw block input. Still fire so
    // the corpus reflects model attempts to call non-existent tools — a
    // useful negative-example signal in itself.
    notifyLearningObserver(ctx, block.name, block.input, 'error', Date.now() - dispatchStart, {
      traceId: block.id,
    });
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `unknown tool: ${block.name}`,
      is_error: true,
    };
  }

  // Pre-call cancellation: if the turn was already aborted by the time we
  // reach this block (fast-failing Promise.all wave or Ctrl-C between
  // partitions), surface the result as cancelled rather than running the
  // tool with an aborted signal.
  if (ctx.signal?.aborted) {
    notifyLearningObserver(ctx, tool.name, block.input, 'cancelled', Date.now() - dispatchStart, {
      traceId: block.id,
    });
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'tool dispatch cancelled before execution',
      is_error: true,
    };
  }

  // Tools that own their input schema externally (Phase 12: MCP via
  // inputJSONSchema) skip the local Zod validation — the underlying tool
  // implementation rejects invalid input itself, and forcing a Zod parse
  // here would either block valid inputs or require a permissive
  // z.unknown() that adds no safety. Native tools keep strict Zod parsing.
  let callInput: unknown;
  if (tool.inputJSONSchema) {
    callInput = block.input;
  } else {
    const parsed = tool.inputSchema.safeParse(block.input);
    if (!parsed.success) {
      notifyLearningObserver(ctx, tool.name, block.input, 'error', Date.now() - dispatchStart, {
        traceId: block.id,
      });
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `input validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        is_error: true,
      };
    }
    callInput = parsed.data;
  }
  if (canUseTool) {
    const perm = await canUseTool(tool, callInput, ctx);
    recordTrace({
      type: 'permission_check',
      tool: tool.name,
      decision: perm.behavior === 'allow' ? 'allow' : 'deny',
      ...(perm.reason !== undefined ? { reason: perm.reason } : {}),
      transformed: perm.updatedInput !== undefined,
      iso: nowIso(),
    });
    if (perm.behavior === 'deny') {
      notifyLearningObserver(ctx, tool.name, callInput, 'denied', Date.now() - dispatchStart, {
        traceId: block.id,
      });
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: perm.reason ? `permission denied: ${perm.reason}` : 'permission denied',
        is_error: true,
      };
    }
    if (perm.updatedInput !== undefined) {
      // Same Zod-skip rule as initial parsing: MCP tools own their schema.
      if (tool.inputJSONSchema) {
        callInput = perm.updatedInput;
      } else {
        const updated = tool.inputSchema.safeParse(perm.updatedInput);
        if (!updated.success) {
          notifyLearningObserver(
            ctx,
            tool.name,
            perm.updatedInput,
            'error',
            Date.now() - dispatchStart,
            { traceId: block.id },
          );
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `permission-updated input validation failed: ${updated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            is_error: true,
          };
        }
        callInput = updated.data;
      }
    }
  }

  // PreToolUse: runs after permissions resolve to allow, before tool.call().
  // The hook can deny (returning is_error) or rewrite the input (re-validated
  // through the same schema before reaching the tool).
  if (hookRunner) {
    const pre = await hookRunner(
      'PreToolUse',
      {
        hookEventName: 'PreToolUse',
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        tool_name: tool.name,
        tool_input: callInput,
      },
      ctx.signal,
    );
    if (pre.block) {
      // Hook denials are semantically equivalent to permission denials —
      // a policy-layer rejection of the call. Surface as 'denied' so the
      // corpus treats both gates uniformly.
      notifyLearningObserver(ctx, tool.name, callInput, 'denied', Date.now() - dispatchStart, {
        traceId: block.id,
      });
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: pre.reason ? `hook denied: ${pre.reason}` : 'hook denied',
        is_error: true,
      };
    }
    if (pre.updatedInput !== undefined) {
      if (tool.inputJSONSchema) {
        callInput = pre.updatedInput;
      } else {
        const updated = tool.inputSchema.safeParse(pre.updatedInput);
        if (!updated.success) {
          notifyLearningObserver(
            ctx,
            tool.name,
            pre.updatedInput,
            'error',
            Date.now() - dispatchStart,
            { traceId: block.id },
          );
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `hook-updated input validation failed: ${updated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            is_error: true,
          };
        }
        callInput = updated.data;
      }
    }
  }

  // Semantic input validation: tools may declare validateInput() for checks
  // Zod can't express (e.g. WebFetch's scheme + private-host/SSRF guard).
  // Runs on the final callInput (after permission + hook rewrites) so the
  // input that's actually executed is the one checked. {ok:false} short-
  // circuits to an is_error tool_result; tool.call() is never reached.
  if (tool.validateInput) {
    const validation = await tool.validateInput(callInput, ctx);
    if (!validation.ok) {
      notifyLearningObserver(ctx, tool.name, callInput, 'error', Date.now() - dispatchStart, {
        traceId: block.id,
      });
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `input validation failed: ${validation.reason}`,
        is_error: true,
      };
    }
  }

  recordTrace({ type: 'tool_start', tool: tool.name, toolUseId: block.id, iso: nowIso() });
  const callStart = Date.now();
  let result: { data: unknown; observation?: ToolObservation };
  let toolError: Error | undefined;
  try {
    result = await tool.call(callInput, ctx);
  } catch (err) {
    toolError = err instanceof Error ? err : new Error(String(err));
    result = { data: `tool threw: ${toolError.message}` };
  }
  const callDuration = Date.now() - callStart;

  const formatted = toolError
    ? ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.data as string,
        is_error: true,
      } as const)
    : formatToolResult(tool, block.id, result.data, result.observation);

  if (toolError) {
    recordTrace({
      type: 'tool_error',
      tool: tool.name,
      toolUseId: block.id,
      durationMs: callDuration,
      message: toolError.message,
      iso: nowIso(),
    });
  } else {
    recordTrace({
      type: 'tool_end',
      tool: tool.name,
      toolUseId: block.id,
      durationMs: callDuration,
      outputBytes: Buffer.byteLength(formatted.content, 'utf8'),
      iso: nowIso(),
    });
  }

  // PostToolUse: runs whether the tool succeeded or threw. additionalContext
  // is appended to the tool_result content with a separator so the model
  // sees both the original output and the hook's annotation.
  let final: ToolResultBlock = formatted;
  if (hookRunner) {
    const post = await hookRunner(
      'PostToolUse',
      {
        hookEventName: 'PostToolUse',
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        tool_name: tool.name,
        tool_input: callInput,
        tool_output: result.data,
        is_error: final.is_error === true,
      },
      ctx.signal,
    );
    if (post.additionalContext) {
      final = { ...final, content: `${final.content}\n\n---\n${post.additionalContext}` };
    }
  }

  // Phase 13.4 — internal observation intercept. Fires after PostToolUse so
  // we capture the terminal state the model actually sees. Fire-and-forget
  // by contract — `observe()` never throws and never blocks.
  //
  // Backlog item 5 (resolved) — full 4-state ObservationStatus mapping:
  //   - 'success'   — tool returned cleanly, no error envelope
  //   - 'error'     — tool threw, returned `observation.status === 'error'`,
  //                   or input validation / unknown-tool short-circuit fired
  //   - 'denied'    — permission gate or PreToolUse hook denied (notified
  //                   from the early-return path above this site)
  //   - 'cancelled' — turn was aborted before tool.call() began OR the
  //                   tool threw with an already-aborted signal (the post-
  //                   hoc check below)
  // The denied / error early-return paths fire their own observe() calls
  // before returning so they never reach this site; the cancelled-mid-call
  // case is detected by inspecting ctx.signal.aborted alongside toolError.
  if (ctx.learningObserver) {
    const observedStatus: ObservationStatus = (() => {
      if (toolError !== undefined) {
        return ctx.signal?.aborted === true ? 'cancelled' : 'error';
      }
      return result.observation?.status === 'error' ? 'error' : 'success';
    })();
    ctx.learningObserver.observe({
      toolName: tool.name,
      toolInput: callInput,
      status: observedStatus,
      durationMs: callDuration,
      ...(result.observation !== undefined
        ? {
            observationEnvelope: {
              status: result.observation.status,
              summary: result.observation.summary,
            },
          }
        : {}),
      traceId: block.id, // tool_use_id, always present
    });
  }

  return maybeAppendHints(tool.name, callInput, ctx, final);
}

/**
 * Fire-and-forget bridge to the learning observer for early-return paths
 * inside `executeOne`. Centralized so all four ObservationStatus values
 * flow through identical plumbing — by extracting this helper we keep the
 * status-mapping logic out of every short-circuit branch and ensure that
 * adding a new early-return path is a one-line change.
 *
 * Exported for unit tests that exercise the 4-state mapping without
 * spinning up the full orchestrator.
 */
export function notifyLearningObserver(
  ctx: ToolContext,
  toolName: string,
  toolInput: unknown,
  status: ObservationStatus,
  durationMs: number,
  extras: { traceId?: string } = {},
): void {
  if (!ctx.learningObserver) return;
  ctx.learningObserver.observe({
    toolName,
    toolInput,
    status,
    durationMs,
    ...(extras.traceId !== undefined ? { traceId: extras.traceId } : {}),
  });
}

function maybeAppendHints(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
  block: ToolResultBlock,
): ToolResultBlock {
  if (!ctx.subdirectoryHintState || block.is_error === true) return block;
  return {
    ...block,
    content: appendSubdirectoryHints({
      toolName,
      input,
      content: block.content,
      cwd: ctx.cwd,
      state: ctx.subdirectoryHintState,
    }),
  };
}

function formatToolResult(
  tool: Tool<unknown, unknown>,
  toolUseId: string,
  data: unknown,
  observation: ToolObservation | undefined,
): ToolResultBlock {
  const baseContent = tool.renderResult
    ? tool.renderResult(data)
    : { content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) };
  // Envelope (Phase 12.5) is rendered as a plain-text header before the
  // tool's own content. Provider-agnostic; no JSON in tool_result.
  // status === 'error' forces is_error even if renderResult didn't set it.
  const envelopeHeader = observation ? renderObservationHeader(observation) : '';
  const content = envelopeHeader
    ? `${envelopeHeader}\n\n${baseContent.content}`
    : baseContent.content;
  const isError = baseContent.isError === true || observation?.status === 'error';
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true as const } : {}),
  };
}

function renderObservationHeader(o: ToolObservation): string {
  const lines: string[] = [`status: ${o.status}`, `summary: ${o.summary}`];
  if (o.next_actions && o.next_actions.length > 0) {
    lines.push('next_actions:');
    for (const action of o.next_actions) lines.push(`  - ${action}`);
  }
  if (o.artifacts && o.artifacts.length > 0) {
    lines.push('artifacts:');
    for (const artifact of o.artifacts) lines.push(`  - ${artifact}`);
  }
  return lines.join('\n');
}
