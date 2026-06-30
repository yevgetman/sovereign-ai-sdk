// Phase 13.5 — sub-agent scheduler. Owns the per-parent child cap, lane
// concurrency caps, write-path lock, per-child timeout, parent-child
// session lineage, and provider/model resolution for delegated work.
//
// AgentTool wraps `delegate()` through buildTool(); the scheduler is the
// only path to spawn a child. Tests inject mock providers and a mock
// session-DB factory.
//
// Scope deliberately narrow:
//   - Child runs through the open SDK's createAgent() turn loop (pure parity
//     with the prior native turn loop the scheduler drove inline).
//   - Tool filtering: parent pool ∩ agent.allowedTools (matched by tool
//     name OR alias) − SUBAGENT_EXCLUDED_TOOLS. Pattern constraints inside allowedTools
//     entries (e.g. `Bash(git log *)`) are NOT enforced at this layer
//     in v0 — the parent's canUseTool still applies. Tightening this is
//     a follow-up: layer agent-defined rules into the canUseTool stack.
//   - Cancellation: parent's AbortSignal composes with a per-child
//     timeout via AbortSignal.any(); both children and parent share one
//     cancellation tree.
//   - Path lock (2026-06-15): write-capable children acquire a write SCOPE on
//     the PathLockManager. Disjoint declared scopes run concurrently;
//     overlapping ones (and any child with no declared scope, which acquires
//     `{kind:'all'}` ≡ the whole tree) serialize — so model-driven delegation
//     is unchanged while workflow tasks declaring disjoint paths parallelize.

import { createAgent } from '../agent/createAgent.js';
import { buildSubagentExclusions } from '../agents/exclusions.js';
import type { AgentDefinition, AgentRegistry } from '../agents/types.js';
import type { LaneConfig, SubscriptionExecutorConfig } from '../config/schema.js';
import { findCapableModel } from '../core/capabilities.js';
import type { AssistantMessage, SystemSegment, Terminal } from '../core/types.js';
import type { MemoryRuntime } from '../memory/provider.js';
import type { CanUseTool } from '../permissions/types.js';
import { wrapCanUseToolWithWriteScope } from '../permissions/writeScope.js';
import type { ResolvedProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import type { DelegationLifecycleEvent } from '../tool/ports.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';
import { TraceWriter } from '../trace/writer.js';
import { tryWriteTrajectory } from '../trajectory/writer.js';
import type { RunSubprocessExecutor, SubprocessExecutorResult } from './executorPort.js';
import type { LaneSemaphores } from './laneSemaphores.js';
import type { PathLockManager, PathScope } from './pathLock.js';

/** SPIKE — the role that, when `subscriptionExecutor.enabled`, routes a
 *  delegation to a headless `claude -p` subprocess instead of the harness's
 *  own AgentRunner loop. */
const SUBSCRIPTION_EXECUTOR_ROLE = 'subscription-executor';

const DEFAULT_MAX_CHILDREN = 4;
const DEFAULT_PER_TURN_TIMEOUT_MS = 60_000;
const FRONTIER_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'openrouter']);

export type SubagentSchedulerOpts = {
  agents: AgentRegistry;
  laneSemaphores: LaneSemaphores;
  /** Path-granular write lock (2026-06-15). Write-capable children acquire a
   *  write SCOPE; disjoint scopes run concurrently, overlapping ones serialize.
   *  A child with no declared scope acquires `{kind:'all'}` (the whole tree) —
   *  byte-identical to the old global Semaphore(1). Read-only children skip it. */
  pathLock: PathLockManager;
  /** Caller-supplied provider resolution. Tests inject mocks; the REPL
   *  passes a closure that calls resolveProvider() with the live
   *  settings/credentials. */
  resolveProvider: (providerName: string, model: string | undefined) => ResolvedProvider;
  /** Caller-supplied child session creation. Returns the new sessionId.
   *  The caller is responsible for writing the parent_session_id link
   *  to the session DB.
   *
   *  Phase 2 T1 — the scheduler now also threads two attribution hints so
   *  the runtime closure can stamp router-routed children with richer
   *  metadata shapes:
   *
   *  - `lane`: non-null when the agent's role resolved through the lane
   *    registry (one of the four router roles). Carries the lane name +
   *    resolved provider/model so downstream telemetry can group on it.
   *  - `isDelegator`: true when the child is the delegator session itself
   *    (agent.role === 'delegator'). Drives the `routing-delegator` shape.
   *
   *  Both fields default to `null`/`false` for non-router children so the
   *  legacy `{ agentName, kind: 'subagent' }` metadata stays in place. */
  createChildSession: (input: {
    parentSessionId: string;
    agentName: string;
    provider: string;
    model: string;
    systemPrompt: SystemSegment[];
    lane: { name: string; provider: string; model: string } | null;
    isDelegator: boolean;
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
  /** Phase 1 T7 — lane-aware role resolution hook. When provided, the
   *  scheduler consults this callback BEFORE falling through to the
   *  Phase 13.2 capability profile in `resolveProviderModel`. The runtime
   *  passes a closure backed by the assembled lane registry so configured
   *  roles (`cheap-task`, `moderate-task`, `frontier-task`, `delegator`)
   *  resolve to the operator's (provider, model) pin. Returning
   *  `undefined` falls through to the existing capability table —
   *  keeping the path purely additive for unknown roles. `agent.model`
   *  still wins over both paths when explicitly pinned. */
  resolveLane?: (role: string) => LaneConfig | undefined;
  /** SPIKE (off by default) — opt-in headless Claude Code sub-agent executor
   *  config. When `enabled: true`, a delegation whose resolved agent has
   *  `role === 'subscription-executor'` is handed to a spawned `claude -p`
   *  subprocess (via `runSubprocessExecutor` below) INSTEAD of the normal
   *  AgentRunner loop. The subprocess returns the same result shape, so the
   *  entire downstream tail of `delegate()` (summary, trajectory, memory hook,
   *  review, lifecycle) is byte-unchanged. Absent or `enabled !== true` →
   *  the branch is inert and every delegation takes the normal path. */
  subscriptionExecutor?: SubscriptionExecutorConfig;
  /** SPIKE — INJECTED subscription-executor port (tests feed canned JSONL; the
   *  proprietary `buildRuntime` injects the real `runSubprocessExecutor`). Only
   *  consulted on the subscription-executor branch — but REQUIRED there: with the
   *  open→proprietary default fallback removed (Task 1.5), `delegate()` throws a
   *  clear error if that branch is reached without this port injected. Optional
   *  on the type so the many non-subprocess construction sites need not supply
   *  it. */
  runSubprocessExecutor?: RunSubprocessExecutor;
};

export type DelegateInput = {
  agentName: string;
  prompt: string;
  parentSessionId: string;
  parentSignal?: AbortSignal;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  canUseTool?: CanUseTool;
  /** 2026-06-15 multi-agent workflows — the child's declared write scope for
   *  path-granular locking. Absent ⇒ `{kind:'all'}` (whole tree; serializes
   *  with everything — the legacy global-lock behavior). A `globs` scope both
   *  (a) lets disjoint write-capable children run in parallel and (b) is
   *  ENFORCED: the child's writes outside the scope are denied (see
   *  wrapCanUseToolWithWriteScope), so under-declaration fails closed. */
  writeScope?: PathScope;
  /** 2026-06-15 multi-agent workflows — a per-task cost-lane override (a lane
   *  role name like 'frontier-task'). When set + the lane resolves, the child
   *  routes through that lane's (provider, model) regardless of the agent's own
   *  role/model. Absent ⇒ normal agent resolution. */
  roleOverride?: string;
  /** 2026-06-15 multi-agent workflows — per-call override of the per-parent
   *  child cap. The workflow engine bounds its own phase fan-out to a fixed
   *  width and passes that width here so a wide (operator-declared) parallel
   *  fan-out is NOT silently truncated by the default recursion-guard cap
   *  (DEFAULT_MAX_CHILDREN). Wins over `opts.maxChildrenPerParent`. Absent ⇒
   *  the construction-time default. */
  maxChildrenOverride?: number;
  memoryManager?: MemoryRuntime;
  traceRecorder?: (event: TraceEvent) => void;
  /** Phase 2 T3 — per-child timeout override resolved at dispatch time.
   *  AgentTool reads the target agent's lane timeout from
   *  `ctx.laneRegistry?.lookup(agent.role)?.timeoutMs` and threads it
   *  here when a lane was hit. Wins over `opts.perChildTimeoutMs` and
   *  the `agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS` fallback. Absent
   *  means "fall through to the construction-time defaults", preserving
   *  every existing call site that never sets this field. */
  perChildTimeoutMsOverride?: number;
  /** Phase 2 T4 — delegation lifecycle recorder. Fires at start + at every
   *  return path of `delegate()` (success, interrupted). The runtime
   *  constructs a closure per turn that synthesizes the four delegator_*
   *  SSE events from these lifecycle calls; see
   *  `src/router/progressEvents.ts`. Purely additive — when absent, the
   *  scheduler behaves identically to its pre-T4 surface. */
  delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void;
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
   *  child, deduplicated and sorted. Threaded from the child's RunResult so
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

  /** Names of every agent `delegate()` can resolve — the exact registry the
   *  workflow engine validates `task.agent` against (so a workflow that passes
   *  validation can never hit `unknown subagent` at delegate time). */
  agentNames(): string[] {
    return [...this.opts.agents.byName.keys()];
  }

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    const agent = this.opts.agents.byName.get(input.agentName);
    if (!agent) {
      throw new Error(`unknown subagent: '${input.agentName}'`);
    }

    // Executor selection (hoisted from the body so the write-lock decision below
    // can account for it). When the resolved agent's role is the subscription-
    // executor AND the config enables it, the task runs in a headless `claude -p`
    // subprocess instead of the harness's own AgentRunner. Off-by-default and
    // inert for every other role / when the config is absent.
    const useSubprocessExecutor =
      this.opts.subscriptionExecutor?.enabled === true && agent.role === SUBSCRIPTION_EXECUTOR_ROLE;

    // FIX 2 — reserve the per-parent slot ATOMICALLY at entry, BEFORE the first
    // `await`. AgentTool/task_create are concurrency-safe, so an orchestrator
    // can Promise.all() many delegate() calls; JS runs each synchronously up to
    // its first await, so a check-then-increment that straddles an await lets
    // every parallel call read the same pre-increment count → the cap never
    // fires and the counter lost-updates. Doing read→compare→set with no await
    // in between makes the reservation race-free, and rejecting here (before
    // acquiring any semaphore) means an over-cap call never holds a lane/write
    // slot. The reservation is released exactly once in the outer finally.
    const maxChildren =
      input.maxChildrenOverride ?? this.opts.maxChildrenPerParent ?? DEFAULT_MAX_CHILDREN;
    const current = this.childCounts.get(input.parentSessionId) ?? 0;
    if (current >= maxChildren) {
      throw new Error(
        `subagent cap reached for parent '${input.parentSessionId}' (max=${maxChildren})`,
      );
    }
    this.childCounts.set(input.parentSessionId, current + 1);

    const { providerName, modelName } = this.resolveProviderModel(agent, input.roleOverride);
    // The concurrency lane (local|frontier) the child's provider runs in —
    // distinct from the `lane` attribution object computed inside the try.
    const concurrencyLane = laneFor(providerName);

    // The lane acquire lives INSIDE the outer try so a rejected acquire (e.g. a
    // parent abort while queued) still releases the reservation in the finally.
    let laneRelease: (() => void) | undefined;
    let writeLockRelease: (() => void) | undefined;
    try {
      laneRelease = await this.opts.laneSemaphores.acquire(concurrencyLane, input.parentSignal);
      // 2026-06-15 review fix (C2) — the subscription-executor runs a headless
      // `claude -p --dangerously-skip-permissions` subprocess we CANNOT bound
      // with the write-scope wrap, yet the agent is labelled readOnly:true. It
      // must therefore serialize with ALL other writers (whole-tree lock)
      // regardless of its label or declared scope — otherwise two such tasks
      // (or one plus a native writer) race the same files. A genuinely
      // read-only native child still skips the lock.
      if (useSubprocessExecutor || !agent.readOnly) {
        const lockScope: PathScope = useSubprocessExecutor
          ? { kind: 'all' }
          : (input.writeScope ?? { kind: 'all' });
        writeLockRelease = await this.opts.pathLock.acquire(lockScope, input.parentSignal);
      }

      const tools = buildChildToolPool(input.parentToolPool, agent);

      // Phase 2 T1 — compute the lane attribution hints for the runtime's
      // createChildSession closure. The lane hit is recomputed here (vs.
      // threaded through from resolveProviderModel) because the call shape
      // is purely additive — recomputing keeps the data flow obvious and
      // the resolveLane callback is cheap (a Map lookup over four entries).
      const laneHit =
        agent.role !== undefined && this.opts.resolveLane !== undefined
          ? this.opts.resolveLane(agent.role)
          : undefined;
      const lane =
        laneHit !== undefined && agent.role !== undefined
          ? { name: agent.role, provider: laneHit.provider, model: laneHit.model }
          : null;
      const isDelegator = agent.role === 'delegator';

      const childSessionId = this.opts.createChildSession({
        parentSessionId: input.parentSessionId,
        agentName: agent.name,
        provider: providerName,
        model: modelName,
        systemPrompt: [{ text: agent.systemPrompt, cacheable: true }],
        lane,
        isDelegator,
      });

      // FIX 2 — the per-parent slot was already reserved synchronously at entry
      // (see the atomic check-and-increment above); no second increment here.

      // Phase 2 T4 — fire the delegation lifecycle "started" event.
      // Captured here so the matching "completed" event below can compute
      // durationMs against the same anchor. We fire AFTER createChildSession
      // so the recorder receives a valid childSessionId (createChildSession
      // itself doesn't carry an external start hook; any throw above bubbles
      // through both outer finally blocks normally without firing the
      // lifecycle pair).
      const delegationStartedAt = Date.now();
      input.delegationLifecycleRecorder?.({
        kind: 'delegation_started',
        childSessionId,
        parentSessionId: input.parentSessionId,
        agentName: agent.name,
        laneName: lane !== null ? lane.name : null,
        // 2026-05-24 patch — surface the resolved provider/model on
        // the lifecycle event so the synthesizer can include them in
        // the delegator_atom_started wire event. Debug-mode renderer
        // surfaces "<lane> · <provider>/<model>" so users see exactly
        // which model handled which atom.
        laneProvider: lane !== null ? lane.provider : null,
        laneModel: lane !== null ? lane.model : null,
        promptPreview: input.prompt,
      });

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

        // Phase 2 T3 — three-step precedence: per-call override (lane
        // timeout from AgentTool) > scheduler construction-time default >
        // agent.maxTurns-derived fallback. The override is purely additive:
        // callers that never set `perChildTimeoutMsOverride` see the
        // identical fallback chain that shipped pre-T3.
        const timeoutMs =
          input.perChildTimeoutMsOverride ??
          this.opts.perChildTimeoutMs ??
          agent.maxTurns * DEFAULT_PER_TURN_TIMEOUT_MS;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const composed: AbortSignal =
          input.parentSignal !== undefined
            ? AbortSignal.any([input.parentSignal, timeoutSignal])
            : timeoutSignal;

        // Phase 1 T8 — stamp the child's ToolContext with the name of the
        // agent running in that child session. AgentTool reads this when the
        // child itself tries to delegate, and enforces the child's
        // `allowedSubagents` policy as a recursion guard. Top-level harness
        // calls leave parentAgentName undefined (no scheduler hop).
        const childToolContext: ToolContext = {
          ...input.parentToolContext,
          sessionId: childSessionId,
          parentAgentName: agent.name,
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

        // Executor selection (`useSubprocessExecutor`) was hoisted to delegate()
        // entry so the write-lock decision could account for it; reused here.
        //
        // Task 1.5 — the subscription-executor is an INJECTED port now: the open
        // scheduler no longer value-imports the proprietary `runSubprocessExecutor`,
        // and there is NO implicit default. Resolve the port HERE, BEFORE the
        // dispatch try, so a misconfiguration (subprocess branch reached without a
        // port injected) fails LOUD as a thrown error — resolving inside the try
        // would let the dispatch `catch` swallow it into an "interrupted" child.
        const run = useSubprocessExecutor ? this.opts.runSubprocessExecutor : undefined;
        if (useSubprocessExecutor && run === undefined) {
          throw new Error(
            'subscriptionExecutor.enabled but no runSubprocessExecutor port was injected into the scheduler',
          );
        }

        const startedAt = Date.now();
        let result: SubprocessExecutorResult;
        try {
          if (useSubprocessExecutor) {
            // The subprocess executor returns an error terminal IN-BAND (never
            // throws), so it flows through the success tail below; a non-success
            // terminal simply skips the memory/review hooks (same as a normal
            // child that errored). cwd is constrained to the parent's tool
            // context cwd — the subprocess never roams outside the runtime root.
            //
            // Learning replay (2026-06-08) — hand the subprocess the SAME
            // learning observer + trace sink a NATIVE delegation would use, so a
            // delegated headless-Claude-Code turn's per-tool use lands in the
            // child session's corpus identically to a native child:
            //   - learningObserver: childToolContext.learningObserver — the
            //     observer the native AgentRunner reads off `toolContext`
            //     (inherited from the parent context, sessionId-bound). The same
            //     destination, by construction.
            //   - traceRecorder: wrappedTraceRecorder — the closure that tags
            //     each event with the child sessionId and forks to BOTH the
            //     parent recorder and the child's per-session TraceWriter,
            //     exactly as the native path passes it to AgentRunner.
            // Both are optional: when learning is disabled / no trace sink
            // exists, the replay is a clean no-op (the spike's tests still pass).
            // biome-ignore lint/style/noNonNullAssertion: guarded above — useSubprocessExecutor ⇒ run is defined
            result = await run!({
              prompt: input.prompt,
              cwd: input.parentToolContext.cwd,
              // biome-ignore lint/style/noNonNullAssertion: guarded by useSubprocessExecutor (enabled === true ⇒ config present)
              config: this.opts.subscriptionExecutor!,
              signal: composed,
              ...(childToolContext.learningObserver !== undefined
                ? { learningObserver: childToolContext.learningObserver }
                : {}),
              ...(wrappedTraceRecorder !== undefined
                ? { traceRecorder: wrappedTraceRecorder }
                : {}),
            });
          } else {
            // 2026-06-15 workflows — when the child declares a narrow write
            // scope, ENFORCE it: deny writes (FileWrite/FileEdit + write-capable
            // Bash) outside the declared globs, so a disjoint-scope parallel
            // fan-out can't clash even if the author under-declared. A no-scope
            // / `{kind:'all'}` child is unaffected.
            const childCanUseTool =
              input.writeScope?.kind === 'globs'
                ? wrapCanUseToolWithWriteScope(input.canUseTool, input.writeScope.globs)
                : input.canUseTool;
            // The NATIVE child turn runs through the open SDK's
            // `createAgent().run()`. PURE PARITY — every native turn-loop opt
            // maps 1:1 onto AgentConfig/PerTurn with the SAME value, and NOTHING
            // is added:
            //   • NO `microcompactConfig` — the cron/channel parity-fix was ratified
            //     ONLY for those surfaces; a sub-agent must keep the prior native
            //     loop's EXACT request, which threaded no config → query()'s built-in
            //     DEFAULT_MICROCOMPACT_CONFIG applies in BOTH paths (byte-identical).
            //   • NO `sessionStore`/`transcripts` — the scheduler owns child
            //     persistence + trajectory OUT-OF-BAND (the tail below); passing a
            //     store to createAgent would DOUBLE-write.
            // `parentSessionId` was a result-echo field only (it never reached
            // query() and the scheduler never read it back from the result), so it
            // has no createAgent counterpart — dropping it is behavior-preserving.
            // The child ToolContext (carrying its inherited learningObserver) and the
            // write-scope-wrapped canUseTool are handed through VERBATIM via `perTurn`,
            // so the child keeps EXACTLY its tool + permission wiring. effort / recall
            // / hookRunner / cwd / cacheEnabled stay UNSET (the prior native loop set
            // none → the query() defaults hold identically).
            const childAgent = createAgent({
              provider: resolved.transport as unknown as LLMProvider,
              model: resolved.model,
              systemPrompt,
              maxTokens: this.opts.maxTokens,
              tools,
              maxTurns: agent.maxTurns,
              ...(input.memoryManager !== undefined ? { memoryManager: input.memoryManager } : {}),
              ...(wrappedTraceRecorder !== undefined
                ? { traceRecorder: wrappedTraceRecorder }
                : {}),
            });
            const gen = childAgent.run(input.prompt, {
              sessionId: childSessionId,
              toolContext: childToolContext,
              signal: composed,
              ...(childCanUseTool !== undefined ? { canUseTool: childCanUseTool } : {}),
            });
            result = await drainRunner(gen);
          }
        } catch (err) {
          // Timeout aborts manifest as a thrown error from query.next();
          // surface as an interrupted terminal.
          const message = err instanceof Error ? err.message : String(err);
          // Phase 2 T4 — fire the matching delegation_completed lifecycle
          // event before returning. The synthesis closure routes this onto
          // `delegator_atom_complete` (or `delegator_complete` for the
          // delegator session itself) with success=false.
          input.delegationLifecycleRecorder?.({
            kind: 'delegation_completed',
            childSessionId,
            parentSessionId: input.parentSessionId,
            agentName: agent.name,
            laneName: lane !== null ? lane.name : null,
            laneProvider: lane !== null ? lane.provider : null,
            laneModel: lane !== null ? lane.model : null,
            success: false,
            durationMs: Date.now() - delegationStartedAt,
          });
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
        // ToolContext (set by the runtime at session boot).
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
        // Phase 2 T4 — fire the matching delegation_completed lifecycle
        // event. `completed` and `max_turns` count as success (matching
        // the on_delegation memory-hook semantics above); everything else
        // is a failure path. The synthesis closure routes this onto
        // `delegator_atom_complete` (for an atom) or `delegator_complete`
        // (for the delegator session itself).
        input.delegationLifecycleRecorder?.({
          kind: 'delegation_completed',
          childSessionId,
          parentSessionId: input.parentSessionId,
          agentName: agent.name,
          laneName: lane !== null ? lane.name : null,
          laneProvider: lane !== null ? lane.provider : null,
          laneModel: lane !== null ? lane.model : null,
          success: result.terminal.reason === 'completed' || result.terminal.reason === 'max_turns',
          durationMs: Date.now() - delegationStartedAt,
        });
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
        // Backlog Item 8 — drain the per-child trace writer so every queued
        // append lands on disk before delegate() returns. Best-effort: the
        // writer swallows fs errors internally so this never throws.
        await childTraceWriter?.close();
      }
    } finally {
      // FIX 2 — release the per-parent reservation exactly once, here in the
      // OUTER finally so it covers EVERY post-reservation path: a rejected
      // lane/write acquire, a throw inside the body, or normal completion.
      // Re-read the current count (never a captured stale value, since siblings
      // mutate it concurrently) and clamp at 0; delete the entry only when it
      // reaches 0 so a long-running sibling's slot is never dropped early.
      const after = this.childCounts.get(input.parentSessionId) ?? 1;
      const next = Math.max(0, after - 1);
      if (next === 0) this.childCounts.delete(input.parentSessionId);
      else this.childCounts.set(input.parentSessionId, next);
      writeLockRelease?.();
      laneRelease?.();
    }
  }

  private resolveProviderModel(
    agent: AgentDefinition,
    roleOverride?: string,
  ): {
    providerName: string;
    modelName: string;
  } {
    // 2026-06-15 workflows — a task's `lane` override routes through the named
    // lane regardless of the agent's own role/model, when the lane resolves.
    if (roleOverride !== undefined && this.opts.resolveLane !== undefined) {
      const lane = this.opts.resolveLane(roleOverride);
      if (lane !== undefined) {
        return { providerName: lane.provider, modelName: lane.model };
      }
    }
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
      // Phase 1 T7 — consult the lane-aware resolver first. The runtime
      // wires this to the assembled lane registry so configured roles
      // (`cheap-task`, `moderate-task`, `frontier-task`, `delegator`)
      // route through operator-pinned (provider, model) pairs instead of
      // the capability table. Unknown roles return `undefined` and fall
      // through to the existing capability profile path — keeping this
      // change purely additive.
      if (this.opts.resolveLane !== undefined) {
        const lane = this.opts.resolveLane(agent.role);
        if (lane !== undefined) {
          return { providerName: lane.provider, modelName: lane.model };
        }
      }
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

/** Phase 1 T7 — build the tool pool a child sub-agent will see.
 *
 *  Two modes, selected by `agent.inheritParentTools`:
 *
 *    - `false` (default, Phase 13.5 strict-allowlist semantics): keep parent
 *      tools whose canonical name appears in `agent.allowedTools` (extracting
 *      the prefix before any `(...)` pattern), minus the per-child exclusion
 *      set. Pattern enforcement inside matched tool calls (e.g.
 *      `Bash(git log *)`) is left to the parent's canUseTool — see the file
 *      header.
 *
 *    - `true` (Phase 1 cost-lane sub-agents): hand the child the entire
 *      parent pool, minus the per-child exclusion set. `AgentTool` stays
 *      excluded unless `allowedSubagents` is non-empty (see
 *      `buildSubagentExclusions`).
 *
 *  The function is purely additive over the prior `filterToolsForChild`: any
 *  agent with `inheritParentTools: false` (the registry default) takes the
 *  exact same branch as before. */
function buildChildToolPool(
  parentPool: readonly Tool<unknown, unknown>[],
  agent: Pick<AgentDefinition, 'inheritParentTools' | 'allowedSubagents' | 'allowedTools'>,
): Tool<unknown, unknown>[] {
  const exclusions = buildSubagentExclusions(agent);
  if (agent.inheritParentTools) {
    return parentPool.filter((tool) => !exclusions.has(tool.name));
  }
  const allowed = new Set<string>();
  for (const entry of agent.allowedTools) {
    const parenIdx = entry.indexOf('(');
    const name = parenIdx > 0 ? entry.slice(0, parenIdx) : entry;
    allowed.add(name.trim());
  }
  // Match an allowedTools entry against the tool's canonical NAME or any of its
  // ALIASES — mirrors ruleMatchesTool in src/config/rules.ts. Shipped strict-
  // allowlist agents (explore, plan, verify, review-*, instinct-synthesizer,
  // scheduled-mission) declare the alias spelling (Read/Edit/Write), while the
  // real tools are named FileRead/FileEdit/FileWrite; a name-only match would
  // silently strip every file tool from those children. The exclusion check
  // stays on the canonical name (SUBAGENT_EXCLUDED_TOOLS lists canonical names).
  return parentPool.filter((tool) => {
    const matchesAllow =
      allowed.has(tool.name) || (tool.aliases ?? []).some((alias) => allowed.has(alias));
    return matchesAllow && !exclusions.has(tool.name);
  });
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
