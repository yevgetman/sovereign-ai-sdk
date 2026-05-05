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

        const runner = new AgentRunner({
          provider: resolved.transport as unknown as LLMProvider,
          model: resolved.model,
          systemPrompt,
          maxTokens: this.opts.maxTokens,
          tools,
          toolContext: childToolContext,
          ...(input.canUseTool !== undefined ? { canUseTool: input.canUseTool } : {}),
          ...(input.memoryManager !== undefined ? { memoryManager: input.memoryManager } : {}),
          ...(input.traceRecorder !== undefined ? { traceRecorder: input.traceRecorder } : {}),
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
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          childSessionId,
          agentName: agent.name,
          resolvedProvider: providerName,
          resolvedModel: modelName,
          terminal: result.terminal,
          summary: extractSummary(result.finalAssistant),
          ...(result.finalAssistant !== undefined ? { finalAssistant: result.finalAssistant } : {}),
          iterationsUsed: result.iterationsUsed,
          toolCallCount: result.toolCallCount,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        const after = this.childCounts.get(input.parentSessionId) ?? 1;
        if (after <= 1) this.childCounts.delete(input.parentSessionId);
        else this.childCounts.set(input.parentSessionId, after - 1);
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
    }
  >,
): Promise<{
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
}> {
  for (;;) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}
