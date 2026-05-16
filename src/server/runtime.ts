// Phase 16.1 M3.3 — server-side runtime construction.
//
// buildRuntime() produces the shared building blocks the M3 server needs:
// session DB, bundle, agent registry, tool pool, system segments, provider.
// It mirrors terminalRepl's boot sequence in a *parallel, additive* form —
// terminalRepl stays untouched per Postmortem Rule 1 (coexistence). The
// server lives next to terminalRepl, not on top of it.
//
// Scope for M3: a single in-process runtime owns one provider + one session
// at a time. The session id is created on demand by POST /sessions; tool
// runtime extras (memory, skills, mission, learning) intentionally land in
// later milestones — this milestone wires a bare turn end-to-end.

import { join } from 'node:path';
import { SessionDb } from '../agent/sessionDb.js';
import { loadAgents } from '../agents/loader.js';
import type { AgentRegistry } from '../agents/types.js';
import { getDefaultBundlePath, isDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { type MicrocompactConfig, buildMicrocompactConfig } from '../compact/microcompact.js';
import { resolveHarnessHome } from '../config/paths.js';
import type { Settings } from '../config/schema.js';
import {
  loadHookSettings,
  loadMcpServerSettings,
  loadPermissionSettings,
} from '../config/settings.js';
import { readConfig } from '../config/store.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import { DaemonEventBus } from '../daemon/eventBus.js';
import {
  type CaptureSink,
  CapturingProvider,
  createCaptureSink,
  wrapToolsForCapture,
} from '../eval/replay/capture.js';
import { loadReplayFixture, writeReplayFixture } from '../eval/replay/loader.js';
import { ReplayProvider } from '../eval/replay/provider.js';
import { wrapToolsForReplay } from '../eval/replay/toolPool.js';
import { buildConsentChecker, buildFileConsentStore } from '../hooks/consent.js';
import { buildHookRunner } from '../hooks/runner.js';
import type { HookRunner } from '../hooks/types.js';
import { buildMcpClientPool } from '../mcp/client.js';
import { wrapMcpTool } from '../mcp/toolWrapper.js';
import type { McpClientPool } from '../mcp/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../permissions/redactSecretsTransformer.js';
import type { AskResponse, AskUser, CanUseTool, PermissionMode } from '../permissions/types.js';
import { preflightProvider, preflightToolCalling } from '../providers/preflight.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import type { LLMProvider, Transport } from '../providers/types.js';
import { RouterAuditLogger } from '../router/auditLogger.js';
import { RouterProvider } from '../router/provider.js';
import { LaneSemaphores, type LaneSemaphoresOpts } from '../runtime/laneSemaphores.js';
import { SubagentScheduler } from '../runtime/scheduler.js';
import { Semaphore } from '../runtime/semaphore.js';
import { loadSkills } from '../skills/loader.js';
import type { SkillRegistry } from '../skills/types.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskStore } from '../tasks/store.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { ApprovalQueue } from './approvalQueue.js';
import { type ServerCompactor, buildServerCompactor } from './compactor.js';
import { PreflightError, SessionNotFoundError } from './errors.js';
import type { ServerEventBus } from './eventBus.js';
import {
  type SessionContext,
  buildSessionContext,
  disposeSessionContext,
} from './sessionContext.js';

/** Default timeout for a pending permission request (M5-02). 60 seconds —
 *  long enough for a user to read the prompt and decide, short enough that
 *  a forgotten approval doesn't park a turn indefinitely. */
const PERMISSION_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Build a session-scoped AskUser that bridges the canUseTool `ask` callback
 * to the SSE event bus + ApprovalQueue. Each invocation mints a fresh
 * requestId, emits a `permission_request` event onto the bus, and awaits
 * the matching POST /sessions/:id/approvals/:requestId. Times out at 60s
 * with a denied result (M5-02).
 *
 * Three response paths:
 *   - approved + always=true → `'always'` (canUseTool adds a session rule)
 *   - approved + !always     → `'allow'`  (one-shot grant)
 *   - !approved              → `'deny'`   (includes the 60s timeout case)
 *
 * The runtime-level `runtime.canUseTool` keeps the M3 deny placeholder so
 * out-of-band callers (no bus context) still fail closed. The turns route
 * builds a session-scoped canUseTool around this factory before each
 * `query()` call.
 */
export function createServerAsk(
  approvalQueue: ApprovalQueue,
  bus: ServerEventBus,
  sessionId: string,
): AskUser {
  return async (opts) => {
    const requestId = crypto.randomUUID();
    const pending = approvalQueue.createPending(requestId, PERMISSION_REQUEST_TIMEOUT_MS);
    bus.publish({
      type: 'permission_request',
      seq: bus.nextSeq(),
      sessionId,
      requestId,
      tool: opts.toolName,
      input: opts.preview,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
    const response = await pending;
    if (!response.approved) return 'deny';
    return response.always === true ? 'always' : 'allow';
  };
}

/** Matches the CLI default in src/main.ts (`--max-tokens <n>` default). */
const DEFAULT_MAX_TOKENS = 12000;

export type RuntimeOptions = {
  /** Harness state root override (test isolation). Defaults to
   *  resolveHarnessHome() which respects $HARNESS_HOME / profile. */
  harnessHome?: string;
  /** Explicit bundle path. When omitted, the default bundle is loaded. */
  bundleRoot?: string;
  /** Process cwd for the turn (system prompt context, tool calls). */
  cwd: string;
  /** Provider name override; mock for tests, otherwise resolveProvider's
   *  precedence applies (settings → env). */
  provider?: string;
  /** Model name override. */
  model?: string;
  /** Cache markers default-on; pass false in tests that exercise the
   *  no-cache path. */
  cacheEnabled?: boolean;
  /** Explicit permission-mode override. When omitted (or `'default'`),
   *  buildRuntime falls back to the same cascade terminalRepl uses:
   *  layered permission settings → user `config.json` → `'default'`. */
  permissionMode?: PermissionMode;
  /** Explicit session DB path override. When omitted, opens at
   *  <harnessHome>/sessions.db — the same default terminalRepl uses. */
  dbPath?: string;
  /** Resume a prior session by UUID. buildRuntime validates the row
   *  exists in sessionDb and throws SessionNotFoundError if not. */
  resumeId?: string;
  /** Max tokens per provider call. Defaults to 12000 to match the
   *  src/main.ts CLI default; users override via --max-tokens. */
  maxTokens?: number;
  /** When `false`, skips the provider preflight smoke-call at boot.
   *  Defaults to true: buildRuntime fires preflightProvider after the
   *  provider resolves so credential / quota / transport failures
   *  throw `PreflightError` before the session DB opens. Ollama gets
   *  an additional preflightToolCalling check when toolPool is non-empty
   *  to catch the silent-tool-ignore failure class. */
  preflight?: boolean;
  /** Per-part tool-result clearing config used inside the query() turn
   *  loop. When omitted, buildRuntime sources from
   *  userSettings.microcompaction via buildMicrocompactConfig. */
  microcompactConfig?: MicrocompactConfig;
  /** Override the proactive-compaction threshold (fraction of context
   *  length, e.g. 0.75). Test hook; production reads from
   *  userSettings.compaction.proactiveThresholdPct (which is stored as a
   *  percentage 1..99 and divided by 100 here). */
  proactiveCompactThreshold?: number;
  /** Pre-built MCP client pool injection seam (test override). When
   *  omitted, buildRuntime loads from settings via loadMcpServerSettings
   *  and constructs a fresh pool when at least one server is configured. */
  mcpClientPool?: McpClientPool;
  /** Pre-built DaemonEventBus injection seam (test override). When
   *  omitted, buildRuntime constructs a fresh in-memory bus. */
  daemonEventBus?: DaemonEventBus;
  /** Per-session context factory override (test injection seam). When
   *  omitted, buildRuntime uses the default buildSessionContext() which
   *  opens a TraceWriter at <harnessHome>/traces/<sessionId>.jsonl. */
  sessionContextFactory?: (sessionId: string) => SessionContext;
  /** Capture every provider call + tool call to a fixture file. On
   *  runtime.dispose() the fixture is finalized and written atomically.
   *  Mutually exclusive with replayFixturePath — supplying both throws.
   *  Mirrors terminalRepl's --capture-fixture (Phase 10.5 part 2). */
  captureFixturePath?: string;
  /** Drive the runtime from a recorded fixture file. Skips live
   *  provider/tool calls — `ReplayProvider` replays captured StreamEvents
   *  and `wrapToolsForReplay` re-serves captured tool results. Mutually
   *  exclusive with captureFixturePath. Mirrors terminalRepl's
   *  --replay-fixture (Phase 10.5 part 2). */
  replayFixturePath?: string;
};

export type Runtime = {
  sessionDb: SessionDb;
  toolPool: Tool<unknown, unknown>[];
  systemSegments: SystemSegment[];
  provider: LLMProvider;
  /** Concrete model the provider resolved to — useful for SessionDb rows
   *  and provider/model metadata in events. */
  model: string;
  agents: AgentRegistry;
  bundle: Bundle | null;
  cwd: string;
  bundleRoot: string | undefined;
  harnessHome: string;
  /** Resolved-provider record kept so the server can re-introspect (model,
   *  context length, auth type) without rebuilding. */
  resolvedProvider: ResolvedProvider;
  /** Orchestrator-facing permission gate. Wraps the layered rule-chain
   *  + tool self-checks + (in M3) a deny-by-default ask placeholder, then
   *  composes the redactSecretsTransformer for defense-in-depth. */
  canUseTool: CanUseTool;
  /** Resolved permission mode after the cascade (option → layered
   *  settings → user config.json → `'default'`). Echoed so tests +
   *  future observability surfaces can introspect what the runtime is
   *  actually enforcing. */
  permissionMode: PermissionMode;
  /** Echoed resumeId from RuntimeOptions, validated against sessionDb
   *  at boot. Undefined when no resume requested. Downstream consumers
   *  (events route, /messages route) use this to decide whether to
   *  hydrate prior message history. */
  resumeId: string | undefined;
  /** Resolved max tokens per provider call. Always populated — either
   *  the caller-supplied value or DEFAULT_MAX_TOKENS (12000). The turns
   *  route reads this instead of its own local const so --max-tokens
   *  flows end-to-end. */
  maxTokens: number;
  /** PreToolUse / PostToolUse / UserPromptSubmit / Stop hook runner.
   *  Server-mode: consent gate is non-interactive (M5-01) — commands
   *  not already in `~/.harness/shell-hooks-allowlist.json` are denied
   *  without prompting (the server doesn't own a TTY). Users pre-consent
   *  via `sov --ui repl` once. The runner is always present; when no
   *  hooks are configured it returns `{ block: false }` immediately. */
  hookRunner: HookRunner;
  /** Permission-request approval queue. The serverAsk callback and the
   *  approvals route both reach into this — the queue is the rendezvous
   *  point between SSE-emitted permission_request events and the TUI's
   *  POST /approvals response. */
  approvalQueue: ApprovalQueue;
  /** Per-lane concurrency caps used by both the router (single-session
   *  escalations) and the sub-agent scheduler (parent dispatching N
   *  children). One instance shared across both consumers. M5.1 wires
   *  caps from `userSettings.router.maxConcurrent{Local,Frontier}` so
   *  server-mode behaves like terminalRepl. Undefined values leave the
   *  affected lane unbounded. */
  laneSemaphores: LaneSemaphores;
  /** Single-writer lock for write-capable children. Prevents two child
   *  agents from racing on the same path. v0 is a single in-memory
   *  Semaphore(1); finer-grained per-path locking lands later. */
  writeLock: Semaphore;
  /** Sub-agent scheduler. The turns route plumbs this onto toolContext
   *  at query() time so AgentTool can call `scheduler.delegate(...)`
   *  for any agent dispatch the model issues. */
  subagentScheduler: SubagentScheduler;
  /** Lifecycle-aware fire-and-forget delegation on top of subagentScheduler.
   *  The TaskStore reads/writes against `sessionDb` (no separate database).
   *  The task_create / task_list / task_get / task_output tools (and the
   *  /tasks slash command) call into this manager once T8 threads it onto
   *  toolContext. Mirrors terminalRepl.ts:962-972. */
  taskManager: TaskManager;
  /** Per-part tool-result clearing config. Always populated — either the
   *  caller-supplied value or buildMicrocompactConfig(userSettings.microcompaction).
   *  The turns route reads this and passes it to query() so stale tool
   *  results clear inside the turn loop before they cause full compaction. */
  microcompactConfig: MicrocompactConfig;
  /** Server-side compaction primitive (M6 T2). Wraps compactSession() with
   *  the runtime's provider/model/systemPrompt + a same-provider summarize
   *  callback. Consumers: T3 (proactive check in turns route), T4 (overflow
   *  recovery in turns route), T5 (POST /sessions/:id/compact route).
   *  Lineage is recorded inside compactSession itself. */
  compact: ServerCompactor;
  /** Resolved fraction of provider context length above which
   *  shouldCompactProactively returns true. Always populated; production
   *  derives from userSettings.compaction.proactiveThresholdPct (stored
   *  as a percentage; divided by 100 here). Default 0.75 mirrors
   *  shouldCompactProactively's built-in default. */
  proactiveCompactThreshold: number;
  /** Connected MCP client pool. Undefined when no MCP servers are
   *  configured. The pool's wrapped tools are already merged into
   *  `toolPool` at boot. runtime.dispose() shuts the pool down before
   *  sessionDb.close() (M7-08 order). */
  mcpClientPool: McpClientPool | undefined;
  /** Cross-cutting event bus that TaskManager publishes lifecycle events
   *  onto (`task_update` at queued + terminal transitions). M7 has no
   *  in-process subscriber — this is plumbing for future cross-process
   *  consumers (daemon-mode TUI, external observers) per M7-06. Tests
   *  may inject their own bus via `RuntimeOptions.daemonEventBus`.
   *  Closes backlog #28. */
  daemonEventBus: DaemonEventBus;
  /** Loaded skill registry (M8 T4). Populated once at buildRuntime boot
   *  from project (.harness/skills/), user ($HARNESS_HOME/skills/), and
   *  bundle (bundle-default/skills/, harness/skills-trusted/,
   *  skills-community/) roots. This is the UNFILTERED superset — per-call
   *  filtering via `inferActiveToolsets` + `filterSkillRegistry` happens
   *  inside `buildSessionToolContext` (turns.ts) and the GET
   *  /sessions/:id/skills route so the active toolset can narrow
   *  visibility per turn / per request without re-walking disk. The T5
   *  /skillname dispatch reads `byName` directly off this unfiltered
   *  registry; visibility filtering is rendering-only.
   *  Closes phase-16 prereq row 20. */
  skills: SkillRegistry;
  /** Per-session subsystem registry (M7-01). Holds the trace writer
   *  (T3) and — in follow-up tasks — learning observer (T5), review
   *  manager (T6), and trajectory metadata (T4) for each active session
   *  id. Built lazily on the first `getSessionContext` call; evicted by
   *  `disposeSession` and walked by `dispose()` at shutdown. Externally
   *  read-only — callers must go through `getSessionContext` /
   *  `disposeSession` so disposal ordering is preserved. */
  sessionContexts: Map<string, SessionContext>;
  /** Lazy-build or return the cached SessionContext for `sessionId`. Safe
   *  to call repeatedly; idempotent within a runtime. After
   *  `disposeSession`, the next call rebuilds a fresh context (the entry
   *  is evicted before disposal awaits, so a concurrent get during
   *  shutdown sees the missing entry and rebuilds rather than handing
   *  back a half-closed writer). */
  getSessionContext: (sessionId: string) => SessionContext;
  /** Tear down the per-session subsystems for `sessionId` and evict from
   *  the registry. Idempotent — no-op when the id is not registered. The
   *  M6 compaction pivot calls this on the parent id (and lazy-builds the
   *  child's context on the next `getSessionContext` lookup).
   *
   *  When `opts.bus` is supplied (single-session explicit disposal — e.g.
   *  the M7 T6 review test, or a future DELETE /sessions/:id route), the
   *  per-session SSE bus is threaded into `disposeSessionContext` so the
   *  ReviewManager's getDispatchSummary lands as a `session_summary` event
   *  for the TUI. runtime.dispose()'s shutdown walk omits the bus — no
   *  SSE consumer remains at process teardown, so the summary is logged
   *  to stderr instead. */
  disposeSession: (sessionId: string, opts?: { bus?: ServerEventBus }) => Promise<void>;
  dispose: () => Promise<void>;
};

/** M5.1 (backlog #25) — derive the `availableProviders` list passed to
 *  `SubagentScheduler`. Without this, the scheduler's capability-profile
 *  resolver defaults to all four registered providers and picks the
 *  cheapest match (typically `ollama/llama3.1:70b` at costTier 0) even
 *  when the user has no ollama running. The right v0 default is to mirror
 *  what the parent session actually has wired up: in single-provider mode
 *  that's just the resolved provider name; in router mode it's both
 *  configured lanes from the resolved metadata.
 *
 *  Mirrors terminalRepl.ts:887-902. Router mode is currently a TS-only
 *  surface (terminalRepl) but the metadata read is kept symmetrical so
 *  the helper still does the right thing if server-mode router lands
 *  later. */
export function resolveSubagentAvailableProviders(resolved: ResolvedProvider): readonly string[] {
  const providerName = String(resolved.metadata.provider);
  const meta = resolved.metadata as {
    localProvider?: string;
    frontierProvider?: string;
  };
  if (providerName === 'router' && meta.localProvider && meta.frontierProvider) {
    return [meta.localProvider, meta.frontierProvider];
  }
  return [providerName];
}

/** M5.1 (backlog #26) — derive the `artifactsRoot` passed to
 *  `SubagentScheduler` for per-child trajectory capture (Phase 13.1).
 *  Without this, server-mode sessions silently skip per-child trajectory
 *  writes, starving Phase 13.3's review daemon and Phase 13.4's instinct
 *  corpus pipelines.
 *
 *  Mirrors terminalRepl.ts:927-930. Client bundles own their state (write
 *  inside the bundle tree); the stock default bundle routes to harnessHome
 *  so `sov upgrade` doesn't wipe them and each profile gets its own state.
 *  The trajectory writer joins `/trajectories` to whichever root this
 *  returns (`src/trajectory/writer.ts:95`). */
export function resolveSubagentArtifactsRoot(harnessHome: string, bundle: Bundle | null): string {
  return bundle && !isDefaultBundlePath(bundle.root)
    ? join(bundle.root, 'state', 'artifacts')
    : harnessHome;
}

/** M5.1 (backlog #27) — derive per-lane semaphore caps from settings.
 *  Without this, `LaneSemaphores({})` leaves both lanes unbounded, so
 *  server-mode runs cannot configure concurrency caps via `settings.json`
 *  for rate-limit / cost control. Undefined values are omitted so the
 *  caller's `new LaneSemaphores(...)` interprets them as "unbounded for
 *  that lane only" (per laneSemaphores.ts:29-32).
 *
 *  Mirrors terminalRepl.ts:879-886. */
export function resolveLaneSemaphoresOpts(userSettings: Settings): LaneSemaphoresOpts {
  return {
    ...(userSettings.router?.maxConcurrentLocal !== undefined
      ? { local: userSettings.router.maxConcurrentLocal }
      : {}),
    ...(userSettings.router?.maxConcurrentFrontier !== undefined
      ? { frontier: userSettings.router.maxConcurrentFrontier }
      : {}),
  };
}

export async function buildRuntime(opts: RuntimeOptions): Promise<Runtime> {
  // M8 T2 — capture and replay are mutually exclusive; they target the
  // same provider/tool wrapping seam and combining them would silently
  // produce a capture of a replay (i.e. the recorded fixture). Validate
  // before any side effects (bundle load, mcp pool, etc.) so a
  // misconfiguration fails fast.
  if (opts.captureFixturePath !== undefined && opts.replayFixturePath !== undefined) {
    throw new Error('captureFixturePath and replayFixturePath are mutually exclusive');
  }
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  const requestedBundleRoot = opts.bundleRoot ?? getDefaultBundlePath() ?? undefined;
  const bundle = await loadBundleIfPresent(requestedBundleRoot ?? null);
  // bundleRoot must track the bundle that actually loaded — keeping the
  // user-passed path even when loadBundleIfPresent returned null left
  // downstream code (session metadata, /sessions echo, eventual resume)
  // pointing at a directory the runtime never opened.
  const bundleRoot = bundle?.root ?? undefined;
  const agents = await loadAgents({
    harnessHome,
    cwd: opts.cwd,
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });

  // M8 T4 — load the skill registry once at boot. Roots scanned (in order)
  // are project-local .harness/skills/, the user's $HARNESS_HOME/skills/,
  // and (when a bundle is loaded) the bundle's three skill trees. The
  // result is stored UNFILTERED on Runtime; per-call filtering via
  // `inferActiveToolsets` + `filterSkillRegistry` happens at the call site
  // (buildSessionToolContext for turns, the /skills route for TUI
  // discovery) so visibility narrows with the active toolset without
  // re-walking disk on every turn. Mirrors terminalRepl.ts:468-470 except
  // the filter step lives at the consumers rather than at boot — server
  // sessions are independent requests, not a single REPL with a stable
  // tool surface, so the registry stays unfiltered up here. Warnings (parse
  // failures, duplicate names) route to stderr — identical policy to the
  // agents loader above.
  const skills = await loadSkills({
    cwd: opts.cwd,
    harnessHome,
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    warn: (msg) => process.stderr.write(`[skills] ${msg}\n`),
  });

  // M7 T1 — load MCP server settings + build pool when configured.
  // Mirrors terminalRepl.ts:336,651-659. Pool tools land in the toolPool
  // via assembleToolPool's `mcpTools` arg below, so the orchestrator sees
  // mcp__<server>__<tool> entries on the very first turn. The pool is
  // shut down before sessionDb.close() inside dispose() (M7-08 order).
  const mcpSettings = loadMcpServerSettings({ cwd: opts.cwd, harnessHome });
  const mcpClientPool: McpClientPool | undefined =
    opts.mcpClientPool ??
    (Object.keys(mcpSettings.servers).length > 0
      ? await buildMcpClientPool({
          servers: mcpSettings.servers,
          log: (msg) => process.stderr.write(`${msg}\n`),
        })
      : undefined);
  const mcpTools = mcpClientPool
    ? mcpClientPool.tools().map((meta) => wrapMcpTool(meta, mcpClientPool))
    : [];

  // Bare tool context — no memory/skills/scheduler/task manager/learning
  // observer. M3 is the "bare turn" milestone (spec §10). Those subsystems
  // land in M4+ per docs/backlog/phase-16-rebuild-prereqs.md.
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    sessionId: 'pending',
    harnessHome,
    agents,
  };
  let toolPool = assembleToolPool(toolCtx, { mcpTools });

  const systemSegments = buildSystemSegments({
    ...(bundle ? { bundle } : {}),
    cwd: opts.cwd,
    homeDir: harnessHome,
    cacheEnabled: opts.cacheEnabled !== false,
    tools: toolPool,
  });

  // Determine provider mode BEFORE permission cascade reads userSettings —
  // the router branch needs the same userSettings, so load it now and reuse
  // below. M8 T1: when the user configures provider:router (either via
  // opts.provider or settings.defaultProvider), resolveProvider can't be the
  // single source of truth — the router wraps TWO providers. Construct it
  // explicitly here, mirroring terminalRepl.ts:238-292.
  const userSettings = readConfig();
  const useRouter =
    opts.provider === 'router' ||
    (opts.provider === undefined && userSettings.defaultProvider === 'router');
  let resolved: ResolvedProvider;
  let routerAuditLogger: RouterAuditLogger | undefined;
  // M8 T2 — capture sink, populated when opts.captureFixturePath is set
  // *and* we're not in replay mode. The sink also wraps the tool pool
  // further down, and runtime.dispose() finalizes it before MCP shutdown.
  let captureSink: CaptureSink | undefined;
  if (opts.replayFixturePath !== undefined) {
    // Replay short-circuits everything: ReplayProvider re-emits captured
    // StreamEvents in order, so credential / quota / preflight checks
    // would be no-ops at best. Skip the entire provider-resolution path.
    const fixture = loadReplayFixture(opts.replayFixturePath);
    const replayProvider = new ReplayProvider({
      fixture,
      providerName: fixture.meta.provider,
    });
    resolved = {
      transport: replayProvider as unknown as Transport,
      client: replayProvider,
      baseUrl: 'replay://',
      model: fixture.meta.model,
      // The 200k cap mirrors terminalRepl.buildReplayResolvedProvider — a
      // replay never actually talks to a model, so the value only shapes
      // downstream context-window math. Anthropic's cap is a safe choice.
      contextLength: 200_000,
      authType: 'none',
      metadata: {
        provider: fixture.meta.provider,
        apiMode: 'replay',
        purpose: 'main',
        replayFixture: opts.replayFixturePath,
        replay: true,
      },
    };
  } else if (useRouter) {
    const routerCfg = userSettings.router;
    if (!routerCfg) {
      throw new Error(
        'provider: router requires a `router` block in config.json (configure with: sov config set router.localProvider <name>, etc.)',
      );
    }
    const localResolved = resolveProvider(routerCfg.localProvider, routerCfg.localModel, {
      harnessHome,
    });
    const frontierResolved = resolveProvider(routerCfg.frontierProvider, routerCfg.frontierModel, {
      harnessHome,
    });
    routerAuditLogger = new RouterAuditLogger({
      harnessHome,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    const routerConfig = {
      localProvider: routerCfg.localProvider,
      frontierProvider: routerCfg.frontierProvider,
      ...(routerCfg.localModel !== undefined ? { localModel: routerCfg.localModel } : {}),
      ...(routerCfg.frontierModel !== undefined ? { frontierModel: routerCfg.frontierModel } : {}),
      ...(routerCfg.defaultLane !== undefined ? { defaultLane: routerCfg.defaultLane } : {}),
      ...(routerCfg.escalationMode !== undefined
        ? { escalationMode: routerCfg.escalationMode }
        : {}),
      ...(routerCfg.maxConcurrentLocal !== undefined
        ? { maxConcurrentLocal: routerCfg.maxConcurrentLocal }
        : {}),
      ...(routerCfg.maxConcurrentFrontier !== undefined
        ? { maxConcurrentFrontier: routerCfg.maxConcurrentFrontier }
        : {}),
    };
    const routerProvider = new RouterProvider({
      config: routerConfig,
      localProvider: localResolved.transport,
      frontierProvider: frontierResolved.transport,
      auditLogger: routerAuditLogger,
      sessionId: 'pending',
      localContextLength: localResolved.contextLength,
    });
    resolved = {
      transport: routerProvider as unknown as Transport,
      client: routerProvider,
      baseUrl: 'router://',
      model: `${localResolved.model} | ${frontierResolved.model}`,
      contextLength: Math.min(localResolved.contextLength, frontierResolved.contextLength),
      authType: 'none',
      metadata: {
        provider: 'router',
        apiMode: 'router',
        purpose: 'main',
        localProvider: localResolved.metadata.provider,
        frontierProvider: frontierResolved.metadata.provider,
      },
    };
  } else {
    resolved = resolveProvider(opts.provider, opts.model, {
      harnessHome,
    });
  }
  // M8 T2 — capture wrapping for the non-replay paths. Replay already
  // owns the provider transport, so capturing a replay would be a
  // tautology (and the mutex guard above forbids the combination). The
  // sink's sessionId is set to `'pending'` at construction because
  // buildRuntime doesn't know the session id yet — sessions are minted
  // on demand via POST /sessions. The fixture's `meta.sessionId` is
  // informational only (replay creates fresh ids), so leaving it as
  // `'pending'` is acceptable; future M9 work can plumb a real id in
  // when capture is gated to a single session.
  if (opts.captureFixturePath !== undefined) {
    captureSink = createCaptureSink({
      sessionId: 'pending',
      provider: resolved.transport.name,
      model: resolved.model,
    });
    const wrapped = new CapturingProvider(resolved.transport, captureSink);
    resolved = { ...resolved, transport: wrapped as unknown as Transport };
  }
  const provider = resolved.transport;

  // Provider preflight — fail fast on bad credentials / quota / transport
  // before opening the sessionDb or doing other side-effects. Mirrors
  // terminalRepl.ts:447-504. Skip when opts.preflight === false or when
  // replay is configured: ReplayProvider re-emits captured events without
  // a network round-trip, so a preflight probe would either be a no-op
  // (consuming an unrelated captured turn) or actively misleading.
  if (opts.preflight !== false && opts.replayFixturePath === undefined) {
    const result = await preflightProvider({
      provider,
      providerName: resolved.transport.name,
      model: resolved.model,
    });
    if (!result.ok) {
      throw new PreflightError(result.kind, result.message);
    }
    // Ollama needs the tool-calling smoke check too — see
    // terminalRepl.ts:486-504. Other providers are tool-call-capable by
    // schema; only Ollama can return a model that silently ignores tools.
    if (provider.name === 'ollama' && toolPool.length > 0) {
      const toolResult = await preflightToolCalling({
        provider,
        providerName: resolved.transport.name,
        model: resolved.model,
      });
      if (!toolResult.ok) {
        throw new PreflightError(toolResult.kind, toolResult.message);
      }
    }
  }

  // M8 T2 — capture / replay tool-pool wrapping. Done AFTER preflight so
  // the Ollama tool-calling smoke check sees the real tool implementations
  // (otherwise its synthetic call would either record a phantom result
  // into the capture sink or trip the replay queue's "exhausted" guard
  // before the first session turn). Mirrors terminalRepl.ts:728-740.
  if (opts.replayFixturePath !== undefined) {
    const fixture = loadReplayFixture(opts.replayFixturePath);
    toolPool = wrapToolsForReplay(toolPool, fixture);
  } else if (captureSink !== undefined) {
    toolPool = wrapToolsForCapture(toolPool, captureSink);
  }

  // On-disk session DB. terminalRepl opens the same DB at
  // <harnessHome>/sessions.db by default; the --db CLI flag overrides
  // both surfaces identically (Postmortem Rule 1: parity, not parallel
  // semantics). cleanupPhantomReviews sweeps stale review-fork rows
  // from prior session crashes; mirrors terminalRepl.ts:402-405.
  const sessionDb =
    opts.dbPath !== undefined ? SessionDb.open({ path: opts.dbPath }) : SessionDb.open({});
  const phantomsCleaned = sessionDb.cleanupPhantomReviews();
  if (phantomsCleaned > 0) {
    process.stderr.write(`[review] cleaned up ${phantomsCleaned} phantom review row(s)\n`);
  }

  if (opts.resumeId !== undefined) {
    const existing = sessionDb.getSession(opts.resumeId);
    if (existing === null) {
      sessionDb.close();
      throw new SessionNotFoundError(opts.resumeId);
    }
  }

  // Permission cascade — mirrors terminalRepl so the user's
  // `~/.harness/config.json` `permissionMode` is honored by the server
  // runtime. Without this the TUI hangs on any tool-using turn: query()
  // falls through to `'default'`, fires an `ask` callback that the
  // server has no interactive surface for, and the TUI receives a
  // `permission_request` event it can't approve. See M3 batch notes.
  // (userSettings was loaded earlier for the router branch — reuse it.)
  const permissionSettings = loadPermissionSettings({
    cwd: opts.cwd,
    harnessHome,
  });
  const permissionMode: PermissionMode =
    opts.permissionMode !== undefined && opts.permissionMode !== 'default'
      ? opts.permissionMode
      : permissionSettings.mode !== 'default'
        ? permissionSettings.mode
        : (userSettings.permissionMode ?? 'default');

  // M3 server has no interactive permission prompt. ask() denies with
  // actionable guidance so a user who lands here (i.e. permissionMode
  // resolves to `'default'` / `'ask'` AND a tool falls through to ask)
  // gets a clear remediation message instead of a silent hang. The M5
  // milestone replaces this placeholder with an SSE `permission_request`
  // round-trip + POST /approvals/:requestId endpoint.
  const ask = async (): Promise<AskResponse> => 'deny';

  const baseCanUseTool = buildCanUseTool({
    mode: permissionMode,
    ask,
    // M3 server has no project-local always-allow persistence; the set
    // remains empty and recordAlwaysAllow is a no-op. M5 wires both
    // through the approval queue.
    alwaysAllow: new Set<string>(),
    ruleLayers: permissionSettings.layers,
    recordAlwaysAllow: () => {
      /* no-op: M3 server doesn't persist session-scoped allow rules. */
    },
  });
  // Defense-in-depth: secrets redactor wraps the resolved canUseTool
  // (matches the terminalRepl chain). Catches the failure class where
  // an agent reads a secret while exploring and then writes it
  // verbatim into a generated artifact.
  const canUseTool = wrapCanUseToolWithTransformers(baseCanUseTool, [redactSecretsTransformer]);

  // Hook runner — loads the `hooks` block from layered settings and wires
  // the consent checker against the server-mode policy (M5-01). The server
  // doesn't own a TTY, so the consent gate's `ask` callback returns 'deny'
  // immediately for any (event, command) pair not already in the on-disk
  // allowlist. Users pre-consent once via `sov --ui repl` to populate
  // ~/.harness/shell-hooks-allowlist.json; from then on the hook fires
  // through the cached decision. Mirrors terminalRepl.ts:1057-1064 except
  // for the non-interactive ask. The runner is always built — its first-
  // call cost when no hooks are configured is one map lookup.
  const hookSettings = loadHookSettings({ cwd: opts.cwd, harnessHome });
  const hookConsentStore = buildFileConsentStore(join(harnessHome, 'shell-hooks-allowlist.json'));
  const hookConsent = buildConsentChecker({
    store: hookConsentStore,
    // Non-interactive: deny by default. The runner treats a denied hook
    // as inert (not a block), so misconfigured hooks won't break the
    // turn; the stderr log line is the user-visible signal that they
    // need to pre-consent.
    ask: async (): Promise<AskResponse> => 'deny',
  });
  const hookRunner = buildHookRunner({
    hooksByEvent: hookSettings.hooksByEvent,
    consent: hookConsent,
    home: process.env.HOME,
    logStderr: (msg: string) => process.stderr.write(`${msg}\n`),
  });

  // M5 T6 — sub-agent infrastructure. Mirrors terminalRepl.ts:879-955.
  // The server constructs the trio at boot and exposes them on Runtime;
  // the turns route plumbs them onto toolContext at query() time (T8).
  //
  // M5.1 (backlog items 25/26/27): lane caps, availableProviders, and
  // artifactsRoot now thread from settings + the resolved provider so the
  // server build matches terminalRepl's parity. Without these, the
  // scheduler defaults pick the cheapest capability-profile match (often
  // ollama/llama3.1:70b for a `role: explore` child), skip per-child
  // trajectory capture (starving the offline learning/review pipelines),
  // and leave concurrency unbounded. Derivations live in three pure
  // helpers above so the wiring is unit-testable.
  // Write lock: v0 profile-scoped Semaphore(1) for write-capable children.
  // `agents` is the registry loaded earlier; reuse it as-is. Provider/
  // model defaults track the parent session.
  const laneSemaphores = new LaneSemaphores(resolveLaneSemaphoresOpts(userSettings));
  const writeLock = new Semaphore(1);
  // M8 T1 / backlog #30 — when the runtime is router-mode, sub-agent
  // defaults must specialize to the frontier lane. The literal `'router'`
  // string isn't a real provider entry — resolveProvider would throw if a
  // child tried to use it. Mirrors terminalRepl.ts:908-917: the frontier
  // lane is the more capable lane and what the user already configured.
  // The frontier model comes from userSettings.router?.frontierModel (the
  // configured override), falling back to the resolved frontier child's
  // own default model when no override is set.
  const isRouterMode = resolved.transport.name === 'router';
  const routerMeta = resolved.metadata as { frontierProvider?: string };
  const subagentDefaultProvider =
    isRouterMode && routerMeta.frontierProvider !== undefined
      ? routerMeta.frontierProvider
      : resolved.transport.name;
  // When the parent is router-mode, resolved.model is the synthetic
  // `"<localModel> | <frontierModel>"` string — split it to recover the
  // frontier model rather than depending on settings (the settings field
  // can be undefined when the user accepts the provider's default model).
  const subagentDefaultModel = isRouterMode
    ? (resolved.model.split(' | ')[1]?.trim() ?? resolved.model)
    : resolved.model;
  const subagentScheduler = new SubagentScheduler({
    agents,
    laneSemaphores,
    writeLock,
    resolveProvider: (name, model) => resolveProvider(name, model, { harnessHome }),
    createChildSession: (input) =>
      sessionDb.createSession({
        provider: input.provider,
        model: input.model,
        parentSessionId: input.parentSessionId,
        title: `subagent:${input.agentName}`,
        systemPrompt: input.systemPrompt,
        metadata: { agentName: input.agentName, kind: 'subagent' },
      }),
    availableProviders: resolveSubagentAvailableProviders(resolved),
    defaultProvider: subagentDefaultProvider,
    defaultModel: subagentDefaultModel,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    artifactsRoot: resolveSubagentArtifactsRoot(harnessHome, bundle),
    // Per-child trace file path mirrors terminalRepl:954: child events
    // also land at <harnessHome>/traces/<childSessionId>.jsonl alongside
    // the consolidated parent trace.
    harnessHome,
  });

  // M5 T7 — task manager. Wraps the SubagentScheduler with lifecycle
  // persistence so the model can dispatch background work via task_create
  // and observe it via task_list / task_get / task_output. TaskStore reads
  // against `sessionDb` (no separate DB). Mirrors terminalRepl.ts:962-972
  // except for the agents-empty guard — the server build always carries a
  // manager, and individual task tools no-op safely when the agent
  // registry is empty.
  // M7 T2 — DaemonEventBus plumbing (closes backlog #28). Constructed once
  // per runtime; threaded into TaskManager so lifecycle events fire onto it
  // for future subscribers. No in-process subscriber in M7 — purely plumbing
  // per M7-06. Tests may inject their own bus via opts.daemonEventBus.
  const daemonEventBus = opts.daemonEventBus ?? new DaemonEventBus();
  const taskStore = new TaskStore(sessionDb);
  const taskManager = new TaskManager({
    store: taskStore,
    scheduler: subagentScheduler,
    bus: daemonEventBus,
  });

  // M5 — permission-request approval queue. One queue per Runtime; the
  // server route and the (future) serverAsk callback share it as the
  // in-memory rendezvous between SSE-emitted permission_request events
  // and the TUI's POST /approvals response.
  const approvalQueue = new ApprovalQueue();

  // M6 T1 — microcompaction config. Sourced from userSettings.microcompaction
  // when no caller override is supplied so server-mode honors the user's
  // ~/.harness/config.json `microcompaction` block (parity with terminalRepl,
  // which calls buildMicrocompactConfig at REPL boot).
  const microcompactConfig =
    opts.microcompactConfig ?? buildMicrocompactConfig(userSettings.microcompaction);

  // M6 T2 — server-side compactor primitive. Built from the locals already
  // in scope (sessionDb, resolved, model, systemSegments) so the closure
  // doesn't need a Runtime forward-reference.
  const compact = buildServerCompactor({
    sessionDb,
    resolvedProvider: resolved,
    model: resolved.model,
    systemSegments,
  });

  // M6 T3 — proactive-compaction threshold. Settings store as a percentage
  // (1..99) for human-friendly editing; the compactor expects a fraction.
  // Mirrors terminalRepl.ts:356-359.
  const proactiveCompactThreshold =
    opts.proactiveCompactThreshold ??
    (userSettings.compaction?.proactiveThresholdPct !== undefined
      ? userSettings.compaction.proactiveThresholdPct / 100
      : 0.75);

  // M7 T3 — per-session subsystem registry. `factory` defaults to
  // `buildSessionContext({ runtime, sessionId })`, capturing the `runtime`
  // const declared below. The closure is safe because JavaScript closures
  // hold a reference, not a snapshot: by the time `factory(sessionId)`
  // actually fires (always after `buildRuntime` returns), `runtime` has
  // been initialized to the Runtime literal.
  const sessionContexts = new Map<string, SessionContext>();
  const sessionContextFactory: (sessionId: string) => SessionContext =
    opts.sessionContextFactory ?? ((sessionId) => buildSessionContext({ runtime, sessionId }));
  const getSessionContext = (sessionId: string): SessionContext => {
    let ctx = sessionContexts.get(sessionId);
    if (!ctx) {
      ctx = sessionContextFactory(sessionId);
      sessionContexts.set(sessionId, ctx);
    }
    return ctx;
  };
  // Evict from the map BEFORE awaiting disposal so a concurrent get during
  // shutdown rebuilds rather than handing back a half-closed writer.
  // `opts.bus` (T6) is only forwarded on single-session disposal: when
  // present, disposeSessionContext emits a `session_summary` SSE event
  // with the ReviewManager's dispatch summary. The shutdown walk inside
  // `dispose()` below does NOT supply a bus — the summary is logged.
  const disposeSession = async (
    sessionId: string,
    disposeOpts?: { bus?: ServerEventBus },
  ): Promise<void> => {
    const ctx = sessionContexts.get(sessionId);
    if (!ctx) return;
    sessionContexts.delete(sessionId);
    await disposeSessionContext(ctx, {
      runtime,
      ...(disposeOpts?.bus !== undefined ? { bus: disposeOpts.bus } : {}),
    });
  };

  const runtime: Runtime = {
    sessionDb,
    toolPool,
    systemSegments,
    provider,
    model: resolved.model,
    agents,
    bundle,
    cwd: opts.cwd,
    bundleRoot,
    harnessHome,
    resolvedProvider: resolved,
    canUseTool,
    permissionMode,
    resumeId: opts.resumeId,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    hookRunner,
    approvalQueue,
    laneSemaphores,
    writeLock,
    subagentScheduler,
    taskManager,
    daemonEventBus,
    skills,
    microcompactConfig,
    compact,
    proactiveCompactThreshold,
    mcpClientPool,
    sessionContexts,
    getSessionContext,
    disposeSession,
    dispose: async () => {
      // M7-08 disposal order: per-session subsystems → router audit logger
      // → MCP pool → approval queue → sessionDb. The per-session walk
      // closes each trace writer first so the JSONL files are flushed
      // before the surrounding state (DB connection, MCP transports) goes
      // away. T1 handled MCP + approval + sessionDb only; T3 hooked the
      // per-session sweep at the front; M8 T1 inserts the router audit
      // logger's close() before MCP shutdown so its sequential write
      // chain drains while everything else is still up.
      const liveSessionIds = Array.from(sessionContexts.keys());
      for (const liveId of liveSessionIds) {
        await disposeSession(liveId);
      }
      if (routerAuditLogger) await routerAuditLogger.close();
      // M8 T2 — flush the capture sink BEFORE MCP shutdown so the
      // fixture write succeeds even if MCP teardown later throws. The
      // write is atomic (temp + rename inside writeReplayFixture), so a
      // crash mid-write can't leave a corrupt fixture on disk. Errors
      // are logged but not re-thrown — capture is a side-channel and
      // shouldn't mask a session's primary disposal outcome.
      if (captureSink !== undefined && opts.captureFixturePath !== undefined) {
        try {
          writeReplayFixture(opts.captureFixturePath, captureSink.finish());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[capture] failed to write fixture at ${opts.captureFixturePath}: ${msg}\n`,
          );
        }
      }
      if (mcpClientPool) await mcpClientPool.shutdown();
      // Cancel any in-flight approval promises before closing the DB so
      // a clean shutdown doesn't leave Promises that never resolve.
      approvalQueue.disposeAll();
      sessionDb.close();
    },
  };
  return runtime;
}
