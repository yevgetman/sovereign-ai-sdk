// Phase 13.5 — sub-agent scheduler. Owns the per-parent child cap, lane
// concurrency caps, write-path lock, per-child timeout, parent-child
// session lineage, and provider/model resolution for delegated work.
//
// AgentTool wraps `delegate()` through buildTool(); the scheduler is the
// only path to spawn a child. Tests inject mock providers and a mock
// session-DB factory.
//
// Scope deliberately narrow:
//   - Child runs through AgentRunner (Phase 13.3).
//   - Tool filtering: parent pool ∩ agent.allowedTools (name-only) −
//     SUBAGENT_EXCLUDED_TOOLS. Pattern constraints inside allowedTools
//     entries (e.g. `Bash(git log *)`) are NOT enforced at this layer
//     in v0 — the parent's canUseTool still applies. Tightening this is
//     a follow-up: layer agent-defined rules into the canUseTool stack.
//   - Cancellation: parent's AbortSignal composes with a per-child
//     timeout via AbortSignal.any(); both children and parent share one
//     cancellation tree.
//   - Path lock: write-capable children acquire a single global write
//     mutex (Semaphore(1)) — the v0 path-lock primitive. Per-path
//     locking can land later when there's a real consumer.

import { SUBAGENT_EXCLUDED_TOOLS } from '../agents/exclusions.js';
import type { AgentDefinition, AgentRegistry } from '../agents/types.js';
import type { AssistantMessage, SystemSegment, Terminal } from '../core/types.js';
import type { MemoryRuntime } from '../memory/provider.js';
import type { CanUseTool } from '../permissions/types.js';
import type { ResolvedProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import { findCapableModel } from '../router/capabilities.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { TraceWriter } from '../trace/writer.js';
import { tryWriteTrajectory } from '../trajectory/writer.js';
import { AgentRunner } from './agentRunner.js';
import type { LaneSemaphores } from './laneSemaphores.js';
import type { Semaphore } from './semaphore.js';

const DEFAULT_MAX_CHILDREN = 4;
const DEFAULT_PER_TURN_TIMEOUT_MS = 60_000;
const FRONTIER_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'openrouter']);

export type SubagentSchedulerOpts = {
  agents: AgentRegistry;
  laneSemaphores: LaneSemaphores;
  /** v0 profile-scoped write lock — Semaphore(1). Write-capable children
   *  serialize through it. Read-only children skip it. */
  writeLock: Semaphore;
  /** Caller-supplied provider resolution. Tests inject mocks; the REPL
   *  passes a closure that calls resolveProvider() with the live
   *  settings/credentials. */
  resolveProvider: (providerName: string, model: string | undefined) => ResolvedProvider;
  /** Caller-supplied child session creation. Returns the new sessionId.
   *  The caller is responsible for writing the parent_session_id link
   *  to the session DB. */
  createChildSession: (input: {
    parentSessionId: string;
    agentName: string;
    provider: string;
    model: string;
    systemPrompt: SystemSegment[];
  }) => string;
  /** Providers the harness has credentials for. Used by capability-
   *  profile role resolution. Defaults to the four registered providers. */
  availableProviders?: readonly string[];
  /** Default provider/model when the agent declares neither model nor
   *  role, AND when role resolution finds no match. */
  defaultProvider: string;
  defaultModel: string;
  /** Cap on concurrent active children per parent session. */
  maxChildrenPerParent?: number;
  /** Per-child wall-clock timeout in ms. Falls back to
   *  agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS. */
  perChildTimeoutMs?: number;
  /** maxTokens to pass to the child's AgentRunner. */
  maxTokens: number;
  /** Phase 13.1 trajectory archive root for child-session capture.
   *  When set, every child completion writes a standalone trajectory
   *  record to `<artifactsRoot>/trajectories/{samples,failed}.jsonl`.
   *  The caller chooses the path: REPL uses
   *  `<bundle>/state/artifacts` when a bundle is loaded, else
   *  `<harnessHome>`. Omit to skip child trajectory writes (useful in
   *  tests that don't want disk side-effects). */
  artifactsRoot?: string;
  /** Backlog Item 8 — when set, every child delegation also gets its
   *  own per-child trace file at `<harnessHome>/traces/<childSessionId>
   *  .jsonl`, in addition to the wrapped events flowing through the
   *  parent's recorder. Gives `sov trace show <childId>` a fast path
   *  that doesn't need to filter the parent timeline. Omit in tests
   *  that don't want disk side-effects — the parent recorder still
   *  receives every tagged event. */
  harnessHome?: string;
};

export type DelegateInput = {
  agentName: string;
  prompt: string;
  parentSessionId: string;
  parentSignal?: AbortSignal;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  canUseTool?: CanUseTool;
  memoryManager?: MemoryRuntime;
  traceRecorder?: (event: TraceEvent) => void;
};

export type DelegateResult = {
  childSessionId: string;
  agentName: string;
  resolvedProvider: string;
  resolvedModel: string;
  terminal: Terminal;
  summary: string;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
  /** Phase 13.4 follow-up (Item 7) — distinct tool names invoked by the
   *  child, deduplicated and sorted. Threaded from AgentRunnerResult so
   *  ReviewManager can triage skill-shaped children downstream. Empty
   *  when the child never reached the runner (e.g. early-error paths). */
  distinctToolNames: string[];
  durationMs: number;
};

export class SubagentScheduler {
  private childCounts = new Map<string, number>();

  constructor(private readonly opts: SubagentSchedulerOpts) {}

  /** Active child count for the given parent session. */
  activeChildren(parentSessionId: string): number {
    return this.childCounts.get(parentSessionId) ?? 0;
  }

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    const agent = this.opts.agents.byName.get(input.agentName);
    if (!agent) {
      throw new Error(`unknown subagent: '${input.agentName}'`);
    }

    const maxChildren = this.opts.maxChildrenPerParent ?? DEFAULT_MAX_CHILDREN;
    const current = this.childCounts.get(input.parentSessionId) ?? 0;
    if (current >= maxChildren) {
      throw new Error(
        `subagent cap reached for parent '${input.parentSessionId}' (max=${maxChildren})`,
      );
    }

    const { providerName, modelName } = this.resolveProviderModel(agent);
    const lane = laneFor(providerName);

    const laneRelease = await this.opts.laneSemaphores.acquire(lane, input.parentSignal);
    let writeLockRelease: (() => void) | undefined;
    try {
      if (!agent.readOnly) {
        writeLockRelease = await this.opts.writeLock.acquire(input.parentSignal);
      }

      const tools = filterToolsForChild(input.parentToolPool, agent.allowedTools);
      const childSessionId = this.opts.createChildSession({
        parentSessionId: input.parentSessionId,
        agentName: agent.name,
        provider: providerName,
        model: modelName,
        systemPrompt: [{ text: agent.systemPrompt, cacheable: true }],
      });

      this.childCounts.set(input.parentSessionId, current + 1);

      // Backlog Item 8 — per-child trace file lives alongside the
      // consolidated parent trace. We construct it once per delegation
      // and drain it in the finally below so every event the child
      // emits ends up in `<harnessHome>/traces/<childSessionId>.jsonl`
      // before delegate() returns.
      const childTraceWriter =
        this.opts.harnessHome !== undefined
          ? new TraceWriter({
              sessionId: childSessionId,
              harnessHome: this.opts.harnessHome,
            })
          : undefined;

      try {
        const resolved = this.opts.resolveProvider(providerName, modelName);

        const timeoutMs =
          this.opts.perChildTimeoutMs ?? agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const composed: AbortSignal =
          input.parentSignal !== undefined
            ? AbortSignal.any([input.parentSignal, timeoutSignal])
            : timeoutSignal;

        const childToolContext: ToolContext = {
          ...input.parentToolContext,
          sessionId: childSessionId,
        };

        const systemPrompt: SystemSegment[] = [{ text: agent.systemPrompt, cacheable: true }];

        // Phase 13.3 (B1) — inject the child's sessionId into every trace event
        // the runner emits, so consolidated parent traces remain debuggable.
        // Without this, child events arrive with sessionId: null and you can't
        // filter "what did the child do" without correlating timestamps.
        //
        // Backlog Item 8 — when a per-child writer exists, also fork the
        // tagged event into the child's own file. Either parent recorder
        // or child writer may be absent independently; both are best-effort.
        const wrappedTraceRecorder =
          input.traceRecorder !== undefined || childTraceWriter !== undefined
            ? (event: TraceEvent) => {
                const tagged = {
                  ...event,
                  sessionId: childSessionId,
                } as TraceEvent;
                input.traceRecorder?.(tagged);
                childTraceWriter?.record(tagged);
              }
            : undefined;

        const runner = new AgentRunner({
          provider: resolved.transport as unknown as LLMProvider,
          model: resolved.model,
          systemPrompt,
          maxTokens: this.opts.maxTokens,
          tools,
          toolContext: childToolContext,
          ...(input.canUseTool !== undefined ? { canUseTool: input.canUseTool } : {}),
          ...(input.memoryManager !== undefined ? { memoryManager: input.memoryManager } : {}),
          ...(wrappedTraceRecorder !== undefined ? { traceRecorder: wrappedTraceRecorder } : {}),
          maxTurns: agent.maxTurns,
          sessionId: childSessionId,
          parentSessionId: input.parentSessionId,
          signal: composed,
        });

        const startedAt = Date.now();
        const gen = runner.run(input.prompt);
        let result: Awaited<ReturnType<typeof drainRunner>>;
        try {
          result = await drainRunner(gen);
        } catch (err) {
          // Timeout aborts manifest as a thrown error from query.next();
          // surface as an interrupted terminal.
          const message = err instanceof Error ? err.message : String(err);
          return {
            childSessionId,
            agentName: agent.name,
            resolvedProvider: providerName,
            resolvedModel: modelName,
            terminal: { reason: 'interrupted', error: new Error(message) },
            summary: `[child interrupted: ${message}]`,
            iterationsUsed: 0,
            toolCallCount: 0,
            distinctToolNames: [],
            durationMs: Date.now() - startedAt,
          };
        }
        const summary = extractSummary(result.finalAssistant);
        // Phase 13.1 trajectory capture for child sessions. The REPL
        // captures parent sessions at REPL exit; sub-agent sessions
        // run inside SubagentScheduler.delegate() and never see that
        // hook, so without an explicit write here children would only
        // appear inside the parent's record as the rendered summary —
        // their full conversation (turns, tool calls, reasoning) would
        // be lost from the fine-tune archive. We write per-child here
        // so each successful child becomes its own samples.jsonl entry.
        // Errors land in failed.jsonl per the bucket-split contract.
        // Best-effort: tryWriteTrajectory swallows filesystem errors
        // (Invariant #10) — a child write failure must not break the
        // parent turn.
        if (this.opts.artifactsRoot !== undefined && result.messages.length > 0) {
          await tryWriteTrajectory({
            messages: result.messages,
            terminal: result.terminal,
            metadata: {
              sessionId: childSessionId,
              provider: providerName,
              model: modelName,
              toolCallCount: result.toolCallCount,
              iterationsUsed: result.iterationsUsed,
              // Per-child cost telemetry not currently aggregated by
              // AgentRunner — leave as 0 in v0. Parent rolls up its
              // own cost via the existing usage_delta path.
              estimatedCostUsd: 0,
            },
            artifactsRoot: this.opts.artifactsRoot,
          });
        }
        // Phase 13.6 — on_delegation hook. Fire after a *successful*
        // child completion so the parent's memory provider can capture
        // the delegation as a learnable observation. We treat
        // `completed` and `max_turns` as success here: max_turns means
        // the child hit its iteration cap cleanly (the run was useful
        // for as far as it got). Errors and interrupts skip the hook —
        // those are not durable memory candidates. The hook receives
        // the prompt and the rendered summary as `(task, result)`;
        // richer metadata (childSessionId, durationMs, traceId) is
        // captured separately via the trace stream.
        if (
          input.memoryManager !== undefined &&
          (result.terminal.reason === 'completed' || result.terminal.reason === 'max_turns')
        ) {
          // Best-effort — never block the scheduler return on a memory
          // provider error. Failures route to the trace stream so the
          // operator can diagnose without breaking the parent turn.
          try {
            await input.memoryManager.onDelegation(input.prompt, summary);
          } catch (err) {
            input.traceRecorder?.({
              type: 'memory_error',
              sessionId: childSessionId,
              op: 'onDelegation',
              message: err instanceof Error ? err.message : String(err),
            } as unknown as TraceEvent);
          }
        }
        // Phase 13.3 — review-fork notify. Forwards user-invoked child
        // completions to the parent's ReviewManager so the child's trajectory
        // feeds into the review pipeline. Skipped for review-* agents to
        // prevent recursion (the review fork itself is a child) and for
        // non-success terminal reasons. The reviewManager lives on the parent's
        // ToolContext (set in terminalRepl.ts at session boot).
        if (shouldFireReviewOnDelegation(agent.name, result.terminal.reason)) {
          try {
            input.parentToolContext.reviewManager?.onChildCompletion({
              childSessionId,
              taskId: childSessionId, // v0: no separate task id concept here; sessionId doubles
              traceId: childSessionId, // trace files are keyed by sessionId
              iterationsUsed: result.iterationsUsed,
              toolCallCount: result.toolCallCount,
              // Phase 13.4 follow-up (Item 7) — surface distinct-tool count
              // so ReviewManager can fire review-skill alongside review-memory
              // when the child's shape suggests a procedural workflow.
              distinctToolCount: result.distinctToolNames.length,
            });
          } catch (err) {
            input.traceRecorder?.({
              type: 'memory_error',
              sessionId: childSessionId,
              op: 'onChildCompletion',
              message: err instanceof Error ? err.message : String(err),
            } as unknown as TraceEvent);
          }
        }
        return {
          childSessionId,
          agentName: agent.name,
          resolvedProvider: providerName,
          resolvedModel: modelName,
          terminal: result.terminal,
          summary,
          ...(result.finalAssistant !== undefined ? { finalAssistant: result.finalAssistant } : {}),
          iterationsUsed: result.iterationsUsed,
          toolCallCount: result.toolCallCount,
          distinctToolNames: result.distinctToolNames,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        const after = this.childCounts.get(input.parentSessionId) ?? 1;
        if (after <= 1) this.childCounts.delete(input.parentSessionId);
        else this.childCounts.set(input.parentSessionId, after - 1);
        // Backlog Item 8 — drain the per-child trace writer so every queued
        // append lands on disk before delegate() returns. Best-effort: the
        // writer swallows fs errors internally so this never throws.
        await childTraceWriter?.close();
      }
    } finally {
      writeLockRelease?.();
      laneRelease();
    }
  }

  private resolveProviderModel(agent: AgentDefinition): {
    providerName: string;
    modelName: string;
  } {
    if (agent.model !== undefined) {
      const slashIdx = agent.model.indexOf('/');
      if (slashIdx > 0) {
        return {
          providerName: agent.model.slice(0, slashIdx),
          modelName: agent.model.slice(slashIdx + 1),
        };
      }
      return { providerName: this.opts.defaultProvider, modelName: agent.model };
    }
    if (agent.role !== undefined) {
      const available = this.opts.availableProviders ?? [
        'anthropic',
        'openai',
        'openrouter',
        'ollama',
      ];
      const profile = findCapableModel(agent.role, available);
      if (profile) {
        return { providerName: profile.provider, modelName: profile.model };
      }
    }
    return { providerName: this.opts.defaultProvider, modelName: this.opts.defaultModel };
  }
}

/** Phase 13.3 — guard for the review-fork notify branch in delegate(). The
 *  guard skips review-* agents (preventing infinite recursion) and skips
 *  non-success terminal reasons (errors / interrupts / max_tokens are not
 *  durable distillation candidates). */
export function shouldFireReviewOnDelegation(agentName: string, terminalReason: string): boolean {
  if (
    agentName === 'review-memory' ||
    agentName === 'review-skill' ||
    agentName === 'review-consolidate'
  ) {
    return false;
  }
  return terminalReason === 'completed' || terminalReason === 'max_turns';
}

function laneFor(providerName: string): 'local' | 'frontier' {
  if (FRONTIER_PROVIDERS.has(providerName)) return 'frontier';
  return 'local';
}

/** v0 tool filter: keep parent tools whose canonical name appears in
 *  agent.allowedTools (extracting the prefix before any `(...)` pattern),
 *  minus the global subagent exclusion set. Pattern enforcement inside
 *  matched tool calls (e.g. `Bash(git log *)`) is left to the parent's
 *  canUseTool — see the file header. */
function filterToolsForChild(
  parentPool: readonly Tool<unknown, unknown>[],
  allowedTools: readonly string[],
): Tool<unknown, unknown>[] {
  const allowed = new Set<string>();
  for (const entry of allowedTools) {
    const parenIdx = entry.indexOf('(');
    const name = parenIdx > 0 ? entry.slice(0, parenIdx) : entry;
    allowed.add(name.trim());
  }
  return parentPool.filter(
    (tool) => allowed.has(tool.name) && !SUBAGENT_EXCLUDED_TOOLS.has(tool.name),
  );
}

function extractSummary(assistant: AssistantMessage | undefined): string {
  if (!assistant) return '';
  const texts = assistant.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text);
  return texts.join('\n').trim();
}

async function drainRunner(
  gen: AsyncGenerator<
    unknown,
    {
      terminal: Terminal;
      finalAssistant?: AssistantMessage;
      iterationsUsed: number;
      toolCallCount: number;
      distinctToolNames: string[];
      messages: import('../core/types.js').Message[];
    }
  >,
): Promise<{
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
  distinctToolNames: string[];
  messages: import('../core/types.js').Message[];
}> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}
