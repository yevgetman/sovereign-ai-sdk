// Phase 16.1 M3.3 — server-side runtime construction.
//
// buildRuntime() produces the shared building blocks the server needs:
// session DB, bundle, agent registry, tool pool, system segments, provider.
// It owns the boot sequence end-to-end now that the legacy terminal surface
// has been removed (M13) — this module is the single in-process runtime
// builder behind both the TUI launcher and the dispatch CLI.
//
// Scope: a single in-process runtime owns one provider + one session at a
// time. The session id is created on demand by POST /sessions.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionDb } from '../agent/sessionDb.js';
import { loadAgents } from '../agents/loader.js';
import { type AgentRegistry, filterAgentRegistry } from '../agents/types.js';
import { getDefaultBundlePath, isDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import type { PromptCommand } from '../commands/types.js';
import { type MicrocompactConfig, buildMicrocompactConfig } from '../compact/microcompact.js';
import { resolveHarnessHome } from '../config/paths.js';
import type { Settings } from '../config/schema.js';
import {
  getPermissionSettingsPaths,
  loadHookSettings,
  loadMcpServerSettings,
  loadPermissionSettings,
} from '../config/settings.js';
import { readConfig } from '../config/store.js';
import { auditContextBudget } from '../context/budget.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import type { CronRunner } from '../cron/runner.js';
import { createProductionCronRunner } from '../cron/wiring.js';
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
import { createFsPersist } from '../learning-layer/adapters/harness/persistFs.js';
import { createProviderReason } from '../learning-layer/adapters/harness/reasonProvider.js';
import { createLearningLayer } from '../learning-layer/index.js';
import type { LearningLayer } from '../learning-layer/ports.js';
import { serializeMcpServerConfig } from '../mcp/auth.js';
import { buildMcpClientPool } from '../mcp/client.js';
import { wrapMcpTools } from '../mcp/toolWrapper.js';
import type { McpClientPool } from '../mcp/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../permissions/redactSecretsTransformer.js';
import type { AskResponse, AskUser, CanUseTool, PermissionMode } from '../permissions/types.js';
import { loadPluginRuntime } from '../plugins/runtime.js';
import { buildPluginSnapshots } from '../plugins/snapshot.js';
import type { LoadedPlugin } from '../plugins/types.js';
import type { ReasoningEffort } from '../providers/effort.js';
import { preflightProvider, preflightToolCalling } from '../providers/preflight.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import type { LLMProvider, Transport } from '../providers/types.js';
import { RouterAuditLogger } from '../router/auditLogger.js';
import { type LaneRegistry, buildLaneRegistry } from '../router/laneRegistry.js';
import { TASK_ROUTING_ROLES } from '../router/lanes.js';
import { runLanePreflight } from '../router/preflight.js';
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
import type { HarnessInfoSnapshot } from '../tools/HarnessInfoTool.js';
import { ApprovalQueue } from './approvalQueue.js';
import { type ServerCompactor, buildServerCompactor } from './compactor.js';
import { PreflightError, SessionNotFoundError } from './errors.js';
import {
  DEFAULT_MAX_RING,
  type ServerEventBus,
  abortAllBuses,
  clearAllBuses,
  disposeBus,
  setDefaultRingSize,
} from './eventBus.js';
import {
  type SessionContext,
  buildSessionContext,
  disposeSessionContext,
} from './sessionContext.js';

/**
 * Resolves the effective taskRouting.enabled value from env + settings.
 *
 * Semantics:
 *   SOV_TASK_ROUTING_ENABLED='1' → true (env wins)
 *   SOV_TASK_ROUTING_ENABLED='0' → false (env wins)
 *   Any other value (unset, empty, '2', 'true', etc.) → fall through to settings
 *
 * Exported for testing.
 */
export function resolveTaskRoutingEnabled(
  envValue: string | undefined,
  settingsValue: boolean | undefined,
): boolean {
  if (envValue === '1') return true;
  if (envValue === '0') return false;
  return settingsValue ?? false;
}

/**
 * Load the smart-router system prompt segment (and optional trivial-
 * fast-path clause) for the parent system prompt. Returns undefined
 * when task routing is disabled or no bundle is present — in that case
 * the system prompt is built without the smart-router segment.
 *
 * Extracted from inline buildRuntime code so the hot-reload path
 * (rebuildTaskRouting) can reuse the same prompt-assembly logic
 * without duplicating the file-read / error-handling.
 *
 * Missing prompt files are non-fatal: the runtime logs to stderr and
 * skips the segment.
 *
 * 2026-05-24 — taskRouting hot-reload patch.
 */
async function loadSmartRouterPrompt(opts: {
  enabled: boolean;
  bundle: Bundle | null;
  trivialFastPath: boolean;
}): Promise<string | undefined> {
  if (!opts.enabled || opts.bundle === null) return undefined;
  let smartRouterPrompt: string | undefined;
  const promptPath = join(opts.bundle.root, 'prompts', 'smart-router.md');
  try {
    smartRouterPrompt = await readFile(promptPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(
        `[taskRouting] smart-router prompt not found at ${promptPath}; segment skipped\n`,
      );
    } else {
      throw err;
    }
  }
  if (smartRouterPrompt !== undefined && opts.trivialFastPath) {
    const fastPathPath = join(opts.bundle.root, 'prompts', 'smart-router-trivial-fast-path.md');
    try {
      const fastPath = await readFile(fastPathPath, 'utf8');
      smartRouterPrompt = `${smartRouterPrompt.trimEnd()}\n\n${fastPath}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(
          `[taskRouting] trivial-fast-path prompt not found at ${fastPathPath}; flag is set but clause is absent — falling back to strict-always-dispatch\n`,
        );
      } else {
        throw err;
      }
    }
  }
  return smartRouterPrompt;
}

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
   *  buildRuntime falls back to the layered cascade:
   *  layered permission settings → user `config.json` → `'default'`. */
  permissionMode?: PermissionMode;
  /** Explicit session DB path override. When omitted, opens at
   *  <harnessHome>/sessions.db. */
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
   *  Surfaces the Phase 10.5 part 2 --capture-fixture flag. */
  captureFixturePath?: string;
  /** Drive the runtime from a recorded fixture file. Skips live
   *  provider/tool calls — `ReplayProvider` replays captured StreamEvents
   *  and `wrapToolsForReplay` re-serves captured tool results. Mutually
   *  exclusive with captureFixturePath. Surfaces the Phase 10.5 part 2
   *  --replay-fixture flag. */
  replayFixturePath?: string;
  /** Phase 17 — when true (default), buildRuntime constructs a
   *  `CronRunner` and arms its 60s tick interval. Production callers
   *  (tuiLauncher, driveCommand) inherit the default; tests that don't
   *  exercise cron should pass `cronEnabled: false` to skip the runner
   *  entirely. The interval timer uses `unref()` so a hung test won't
   *  block process exit, but explicit opt-out is still safer for tests
   *  that drive their own clock or wait on side effects. */
  cronEnabled?: boolean;
};

export type Runtime = {
  sessionDb: SessionDb;
  toolPool: Tool<unknown, unknown>[];
  systemSegments: SystemSegment[];
  provider: LLMProvider;
  /** Concrete model the provider resolved to — useful for SessionDb rows
   *  and provider/model metadata in events. */
  model: string;
  /** Reasoning-depth ("effort") BOOT DEFAULT. Initialized from `thinking.effort`
   *  config (default 'off') and NOT mutated by `/effort` (backlog #57 — that now
   *  writes the per-session `SessionContext.effort`, seeded from this value at
   *  build time). This field is read by the cron + channel pipelines (which have
   *  no interactive session and should always use the configured default) and
   *  seeds every fresh session's effort. Leaving it unmutated is what keeps one
   *  principal's `/effort` from leaking to other principals / cron / channels.
   *  (`model` above is still global — that sibling gap is tracked separately.) */
  effort: ReasoningEffort;
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
   *  without prompting (the server doesn't own a TTY). The allowlist
   *  must be pre-populated out of band (e.g., by editing the JSON
   *  directly or by a future consent-management subcommand). The runner
   *  is always present; when no hooks are configured it returns
   *  `{ block: false }` immediately. */
  hookRunner: HookRunner;
  /** Permission-request approval queue. The serverAsk callback and the
   *  approvals route both reach into this — the queue is the rendezvous
   *  point between SSE-emitted permission_request events and the TUI's
   *  POST /approvals response. */
  approvalQueue: ApprovalQueue;
  /** Per-lane concurrency caps used by both the router (single-session
   *  escalations) and the sub-agent scheduler (parent dispatching N
   *  children). One instance shared across both consumers. M5.1 wires
   *  caps from `userSettings.router.maxConcurrent{Local,Frontier}`.
   *  Undefined values leave the affected lane unbounded. */
  laneSemaphores: LaneSemaphores;
  /** Phase 1 — assembled task-routing lane registry. Always present,
   *  regardless of `taskRouting.enabled`: the registry powers role-based
   *  sub-agent dispatch (B-via-D bridge baseline) even when the
   *  delegator-first turn flow is off. The scheduler consults
   *  `laneRegistry.lookup(role)` before falling through to the Phase 13.2
   *  capability table. When `taskRouting.enabled === true` the runtime
   *  additionally runs `runLanePreflight` at boot and threads the
   *  `prompts/smart-router.md` body into the parent system prompt.
   *
   *  2026-05-24 — hot-reloadable. `rebuildTaskRouting()` swaps this
   *  field's value when the user mutates `taskRouting.*` via /config.
   *  Internally the scheduler reads via a holder so the new value
   *  flows to subsequent atom dispatches automatically. */
  laneRegistry: LaneRegistry;
  /** 2026-05-24 — task-routing hot-reload. Re-reads userSettings,
   *  rebuilds the lane registry, and reassembles the smart-router
   *  system prompt segment (or removes it when newly disabled).
   *  Subsequent turns + atom dispatches use the new state. Prompt-
   *  cache invalidation is the cost of the rebuild — accepted as a
   *  trade-off the user opts into by editing taskRouting at runtime. */
  rebuildTaskRouting: () => Promise<void>;
  /** 2026-05-24 — bundle root, exposed so rebuildTaskRouting can
   *  re-read prompt files. Internal use; consumers should treat it
   *  as opaque. */
  cacheEnabled: boolean;
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
   *  toolContext. */
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
  /** Plugin System v1 (T8) — every DISCOVERED plugin under
   *  `<harnessHome>/plugins/*` with its load verdict (active / needs-consent /
   *  tampered / disabled). The disclosure surface (HarnessInfo, `/plugins`)
   *  lists ALL of these; only the active ones contribute. Empty when no
   *  plugins are installed (or the dir is absent). */
  plugins: LoadedPlugin[];
  /** Plugin System v1 (T8) — slash commands contributed by the ACTIVE plugins'
   *  `commands/` dirs (built via the skill machinery, never added to
   *  `runtime.skills`). The command seams (server `buildServerCommandContext`,
   *  CLI dispatch) spread these AFTER the built-in COMMANDS (built-ins always
   *  win) and BEFORE skill-derived commands. Empty when no active plugin
   *  contributes a command. Plugin SKILLS are NOT here — they enter the skill
   *  registry via `loadSkills` extraRoots. */
  pluginCommands: PromptCommand[];
  /** Learning-loop spike Phase 1 — the learning layer (Recall + Observe
   *  ports) constructed once at boot over a filesystem Persist adapter
   *  ($HARNESS_HOME) and a provider-backed Reason adapter. The turns route
   *  builds a per-session recall thunk (in buildSessionContext) bound to
   *  the session's project that calls `learningLayer.recall(...)`; query()
   *  splices the recalled lessons in front of the latest user turn. Always
   *  present — recall is gated by `learning.recall.enabled` at the
   *  session-thunk layer, not by the layer's existence. Observe ports are
   *  Phase 1 no-ops (existing capture hooks stay authoritative). */
  learningLayer: LearningLayer;
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
  /** Phase 17 — armed when `opts.cronEnabled !== false`. The 60s tick
   *  interval scans `<harnessHome>/cron/jobs.json` for due jobs and
   *  dispatches each via a fresh-session AgentRunner. Disposed at the
   *  front of `dispose()` so an in-flight tick can't write to a closed
   *  session DB. */
  cronRunner?: CronRunner;
  /** 2026-05-24 — Config UX rebuild. When true, the runtime was minted
   *  by `runConfigOnlyMode` (sov config standalone). The commands route
   *  forwards this flag to `buildServerCommandContext` so `/config`'s
   *  toast collapses to plain "saved" instead of "applied to current
   *  session" — there is no active session to apply to. */
  configStandalone?: boolean;
  dispose: () => Promise<void>;
};

/** M5.1 (backlog #25) — derive the `availableProviders` list passed to
 *  `SubagentScheduler`. Without this, the scheduler's capability-profile
 *  resolver defaults to all four registered providers and picks the
 *  cheapest match (typically `ollama/llama3.1:70b` at costTier 0) even
 *  when the user has no ollama running. The right v0 default is to mirror
 *  what the parent session actually has wired up: in single-provider mode
 *  that's just the resolved provider name; in router mode it's both
 *  configured lanes from the resolved metadata. */
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
 *  Client bundles own their state (write inside the bundle tree); the
 *  stock default bundle routes to harnessHome so `sov upgrade` doesn't
 *  wipe them and each profile gets its own state. The trajectory writer
 *  joins `/trajectories` to whichever root this returns. */
export function resolveSubagentArtifactsRoot(harnessHome: string, bundle: Bundle | null): string {
  return bundle && !isDefaultBundlePath(bundle.root)
    ? join(bundle.root, 'state', 'artifacts')
    : harnessHome;
}

/** SPIKE — the role gated behind `subscriptionExecutor.enabled`. Hidden from
 *  the model's AgentTool enum unless the operator opts in, so an off-by-default
 *  install never exposes the headless-subprocess delegation surface. */
const SUBSCRIPTION_EXECUTOR_ROLE = 'subscription-executor';

/** Compute the model-visible agent registry by excluding roles the current
 *  config does not enable. Always excludes the task-routing roles unless
 *  taskRouting is on (the existing B-via-D behavior); additionally excludes the
 *  subscription-executor role unless its config is enabled. The FULL registry
 *  stays on the runtime for /agent dispatch; only the AgentTool enum narrows. */
export function computeToolVisibleAgents(
  agents: AgentRegistry,
  flags: { taskRoutingEnabled: boolean; subscriptionExecutorEnabled: boolean },
): AgentRegistry {
  const excludeRoles = new Set<string>();
  if (!flags.taskRoutingEnabled) for (const r of TASK_ROUTING_ROLES) excludeRoles.add(r);
  if (!flags.subscriptionExecutorEnabled) excludeRoles.add(SUBSCRIPTION_EXECUTOR_ROLE);
  return excludeRoles.size === 0 ? agents : filterAgentRegistry(agents, excludeRoles);
}

/** M5.1 (backlog #27) — derive per-lane semaphore caps from settings.
 *  Without this, `LaneSemaphores({})` leaves both lanes unbounded, so
 *  server-mode runs cannot configure concurrency caps via `settings.json`
 *  for rate-limit / cost control. Undefined values are omitted so the
 *  caller's `new LaneSemaphores(...)` interprets them as "unbounded for
 *  that lane only" (per laneSemaphores.ts:29-32). */
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

  // Plugin System v1 (T8) — discover + gate plugins, then compose their
  // contributions, BEFORE loadSkills so plugin skillRoots can splice into the
  // skill registry. The shared helper (loadPluginRuntime) is the SAME path the
  // CLI dispatch surface uses so the two can't drift. Fail-soft: a bad plugin
  // is skipped with a warn (loader contract) and an absent plugins/ dir yields
  // empty plugins + empty contributions — buildRuntime never throws on it.
  // Backlog #55 — the plugins config is read from the runtime's resolved
  // harnessHome (not the process-global home), matching every other config
  // read in this function. H4 — only skills + commands are consumed here;
  // disclosed hooks/mcp are surfaced (HarnessInfo) but NEVER wired.
  const { plugins, contributions: pluginContributions } = await loadPluginRuntime({
    harnessHome,
    config: readConfig({ harnessHome }).plugins ?? {},
    warn: (msg) => process.stderr.write(`[plugins] ${msg}\n`),
  });

  // M8 T4 — load the skill registry once at boot. Roots scanned (in order)
  // are project-local .harness/skills/, the user's $HARNESS_HOME/skills/,
  // plugin skill roots (T8 — after user, before bundle, so a plugin skill can
  // override a bundle skill but never shadow a user/project one), and (when a
  // bundle is loaded) the bundle's three skill trees. The result is stored
  // UNFILTERED on Runtime; per-call filtering via `inferActiveToolsets` +
  // `filterSkillRegistry` happens at the call site (buildSessionToolContext
  // for turns, the /skills route for TUI discovery) so visibility narrows with
  // the active toolset without re-walking disk on every turn. Server sessions
  // are independent requests rather than a single stable tool surface, so the
  // registry stays unfiltered up here and the filter step lives at the
  // consumers. Warnings (parse failures, duplicate names) route to stderr —
  // identical policy to the agents loader above.
  const skills = await loadSkills({
    cwd: opts.cwd,
    harnessHome,
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    extraRoots: pluginContributions.skillRoots,
    warn: (msg) => process.stderr.write(`[skills] ${msg}\n`),
  });

  // M7 T1 — load MCP server settings + build pool when configured.
  // Pool tools land in the toolPool via assembleToolPool's `mcpTools` arg
  // below, so the orchestrator sees mcp__<server>__<tool> entries on the
  // very first turn. The pool is shut down before sessionDb.close()
  // inside dispose() (M7-08 order).
  const mcpSettings = loadMcpServerSettings({ cwd: opts.cwd, harnessHome });
  const mcpClientPool: McpClientPool | undefined =
    opts.mcpClientPool ??
    (Object.keys(mcpSettings.servers).length > 0
      ? await buildMcpClientPool({
          servers: mcpSettings.servers,
          log: (msg) => process.stderr.write(`${msg}\n`),
          // Inject the process env at the boundary so the auth resolver stays
          // pure (env-first SOV_MCP_* secret resolution lives in auth.ts).
          env: process.env,
        })
      : undefined);
  const mcpTools = mcpClientPool
    ? wrapMcpTools(mcpClientPool.tools(), mcpClientPool, (msg) => process.stderr.write(`${msg}\n`))
    : [];

  // Pre-read taskRouting.enabled so we can filter routing agents from the
  // tool pool's AgentTool enum. The full registry stays on the runtime for
  // /agent slash-command dispatch; only the model-visible enum is narrowed.
  // Backlog #55 — read config from the runtime's resolved harnessHome (not
  // the process-global home) so a runtime built with an explicit harnessHome
  // (while $HARNESS_HOME is unset) reads ITS config, not ~/.harness/config.json.
  const earlySettings = readConfig({ harnessHome });
  const taskRoutingEnabledAtBoot = resolveTaskRoutingEnabled(
    process.env.SOV_TASK_ROUTING_ENABLED,
    earlySettings.taskRouting?.enabled,
  );
  const toolVisibleAgents = computeToolVisibleAgents(agents, {
    taskRoutingEnabled: taskRoutingEnabledAtBoot,
    subscriptionExecutorEnabled: earlySettings.subscriptionExecutor?.enabled === true,
  });

  // Bare tool context — no memory/skills/scheduler/task manager/learning
  // observer. M3 is the "bare turn" milestone (spec §10). Those subsystems
  // land in M4+ per docs/backlog/phase-16-rebuild-prereqs.md.
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    sessionId: 'pending',
    harnessHome,
    agents: toolVisibleAgents,
  };

  // M10 audit fix — wire HarnessInfoTool into the server-mode tool pool.
  // The snapshot getter is lazy (called by the model at HarnessInfo
  // tool-call time), so it can reference variables that get assigned
  // later in this function via the `*Ref` closure-capture pattern. Slash
  // commands intentionally return empty — the server has no client-side
  // slash registry by design (separate M10 audit gap tracked for future
  // remediation).
  let finalToolPoolRef: Tool<unknown, unknown>[] = [];
  let systemSegmentsRef: SystemSegment[] = [];
  const harnessInfoSnapshot = (): HarnessInfoSnapshot => {
    const ps = loadPermissionSettings({ cwd: opts.cwd, harnessHome });
    const settingsPaths = getPermissionSettingsPaths({ cwd: opts.cwd, harnessHome });
    const presentSources = new Set(ps.sources);
    const liveByServer = new Map<string, string[]>();
    if (mcpClientPool !== undefined) {
      for (const handle of mcpClientPool.servers()) {
        liveByServer.set(
          handle.name,
          handle.tools.map((t) => t.toolName),
        );
      }
    }
    return {
      permissionMode: ps.mode,
      settingsLayers: settingsPaths.map((p) => ({
        name: p.name,
        path: p.path,
        present: presentSources.has(p.path),
      })),
      mcpServers: Object.entries(mcpSettings.servers).map(([name, cfg]) => {
        const liveTools = liveByServer.get(name);
        const status: 'connected' | 'failed' | 'not-attempted' = mcpClientPool
          ? liveTools !== undefined
            ? 'connected'
            : 'failed'
          : 'not-attempted';
        // Transport-aware projection: remote servers expose only
        // { transport, url } (redacted to origin — never headers); stdio
        // exposes { transport, command, args }.
        return {
          name,
          ...serializeMcpServerConfig(cfg),
          status,
          toolCount: liveTools?.length ?? 0,
          tools: liveTools ?? [],
        };
      }),
      tools: {
        native: finalToolPoolRef.filter((t) => t.isMcp !== true).map((t) => t.name),
        mcp: finalToolPoolRef.filter((t) => t.isMcp === true).map((t) => t.name),
      },
      // Server-mode does not surface a client-side slash registry — the
      // TUI implements `/compact`, `/skills`, `/theme` as direct route
      // calls. Returning an empty list (rather than synthesizing one) is
      // honest: the model would otherwise advertise commands the user
      // cannot type from within the TUI.
      slashCommands: [],
      agents: agents.agents.map((a) => ({
        name: a.name,
        description: a.description,
        ...(a.whenToUse !== undefined ? { whenToUse: a.whenToUse } : {}),
        ...(a.role !== undefined ? { role: a.role } : {}),
        ...(a.model !== undefined ? { model: a.model } : {}),
        readOnly: a.readOnly,
        maxTurns: a.maxTurns,
        allowedTools: a.allowedTools,
        source: a.source,
        trustTier: a.trustTier,
      })),
      budget: auditContextBudget({
        systemSegments: systemSegmentsRef,
        tools: finalToolPoolRef,
        skills: skills.skills,
        ...(bundle ? { bundle } : {}),
      }),
      // Plugin System v1 (T8) — list EVERY discovered plugin (active AND inert)
      // with its verdict + disclosed/ignored components, so the model can
      // answer "what plugins are installed / why isn't X active". Empty array
      // when none are installed (honest: the runtime has plugin state).
      plugins: buildPluginSnapshots(plugins),
    };
  };

  let toolPool = assembleToolPool(toolCtx, { mcpTools, harnessInfoSnapshot });
  finalToolPoolRef = toolPool;

  // Determine provider mode BEFORE permission cascade reads userSettings —
  // the router branch needs the same userSettings, so load it now and reuse
  // below. M8 T1: when the user configures provider:router (either via
  // opts.provider or settings.defaultProvider), resolveProvider can't be the
  // single source of truth — the router wraps TWO providers. Construct it
  // explicitly here.
  // Phase 1 — pulled BEFORE the buildSystemSegments call so the
  // smart-router prompt body can flow into the parent system prompt when
  // `userSettings.taskRouting?.enabled === true`.
  // Backlog #55 — scoped to the runtime's harnessHome (see earlySettings above).
  const userSettings = readConfig({ harnessHome });

  // Phase B T2 — set the per-session SSE replay-ring default from
  // gateway.eventBufferSize so every bus minted at runtime (turns / events /
  // cancel / OpenAI routes all call getOrCreateBus with no explicit size)
  // inherits the configured window. setDefaultRingSize clamps invalid values
  // back to DEFAULT_MAX_RING, so a malformed config can't shrink the ring.
  setDefaultRingSize(userSettings.gateway?.eventBufferSize ?? DEFAULT_MAX_RING);

  // Resolve the effective taskRouting.enabled once, honoring
  // SOV_TASK_ROUTING_ENABLED env override ('1'=force-on, '0'=force-off).
  const taskRoutingEnabled = resolveTaskRoutingEnabled(
    process.env.SOV_TASK_ROUTING_ENABLED,
    userSettings.taskRouting?.enabled,
  );

  // Phase 1 — assemble the lane registry from `userSettings.taskRouting`
  // unconditionally. The registry resolves the four well-known roles
  // (cheap-task, moderate-task, frontier-task, delegator) against the
  // operator's overrides + lane defaults. When `taskRouting.enabled` is
  // false (or omitted), the registry still exists so cost-lane sub-agents
  // remain reachable via /agent — the B-via-D bridge baseline. The
  // scheduler's `resolveLane` callback closes over the holder so a
  // hot-reload (rebuildTaskRouting) flows through without restarting
  // the scheduler.
  const laneRegistryHolder: { current: LaneRegistry } = {
    current: buildLaneRegistry(userSettings.taskRouting),
  };
  // Local alias preserves the rest of buildRuntime's references to
  // `laneRegistry` (the preflight check below). Subsequent reads —
  // including the runtime object's exposed `laneRegistry` getter and
  // the scheduler's resolveLane closure — pull from the holder so a
  // hot-reload swap is visible everywhere.
  const laneRegistry = laneRegistryHolder.current;

  // Phase 1 — smart-router segment. Loaded only when `taskRouting.enabled
  // === true` AND a bundle is present (the prompt ships under
  // `<bundle-root>/prompts/smart-router.md`). When the file is missing
  // (e.g. T11 hasn't shipped yet, or a custom bundle omits it), log to
  // stderr and skip the segment — the runtime still boots cleanly.
  //
  // Phase 2.5 — when `taskRouting.trivialFastPath: true`, append the
  // trivial-fast-path exception clause from
  // `<bundle-root>/prompts/smart-router-trivial-fast-path.md` so the
  // parent can respond directly on clearly trivial conversational
  // turns (greetings, one-liner facts, meta-questions) instead of
  // always dispatching to the delegator. Default false preserves the
  // strict Phase 1 contract.
  const smartRouterPrompt = await loadSmartRouterPrompt({
    enabled: taskRoutingEnabled,
    bundle,
    trivialFastPath: userSettings.taskRouting?.trivialFastPath === true,
  });

  const systemSegments = buildSystemSegments({
    ...(bundle ? { bundle } : {}),
    cwd: opts.cwd,
    homeDir: harnessHome,
    cacheEnabled: opts.cacheEnabled !== false,
    tools: toolPool,
    ...(smartRouterPrompt !== undefined ? { smartRouterPrompt } : {}),
  });
  systemSegmentsRef = systemSegments;
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
      // The 200k cap is conservative — a replay never actually talks to
      // a model, so the value only shapes downstream context-window math.
      // Anthropic's cap is a safe choice.
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
      // Resolved lane models so RouterProvider can recover the concrete model
      // without parsing the synthetic "local | frontier" string — survives
      // /model in router mode (finding #17, G9).
      resolvedLocalModel: localResolved.model,
      resolvedFrontierModel: frontierResolved.model,
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
  // Keep a handle on the UNWRAPPED transport for preflight. The preflight
  // probe is an internal health check, not a conversation turn — capturing it
  // would record it as fixture turn 0 and desync every replay by one turn
  // (audit 2026-06-10). So preflight always runs against the raw transport;
  // only real turns flow through the CapturingProvider.
  const preflightTransport = resolved.transport;
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

  // Learning-loop spike Phase 1 — construct the learning layer once at boot.
  // Persist maps named-blob keys to files under $HARNESS_HOME; Reason wraps
  // the resolved provider transport (Transport extends LLMProvider) + model
  // so any future synthesizer reasoning rides the same provider the turn
  // uses. The layer is constructed unconditionally: recall is gated per
  // session by `learning.recall.enabled` (in buildSessionContext), and the
  // layer's Observe ports are Phase 1 no-ops. Cheap to construct — both
  // adapters defer all I/O to first call.
  const learningLayer = createLearningLayer({
    persist: createFsPersist(harnessHome),
    reason: createProviderReason(resolved.transport, resolved.model),
  });

  // Provider preflight — fail fast on bad credentials / quota / transport
  // before opening the sessionDb or doing other side-effects. Skip when
  // opts.preflight === false or when replay is configured: ReplayProvider
  // re-emits captured events without a network round-trip, so a preflight
  // probe would either be a no-op (consuming an unrelated captured turn)
  // or actively misleading.
  if (opts.preflight !== false && opts.replayFixturePath === undefined) {
    const result = await preflightProvider({
      provider: preflightTransport,
      providerName: resolved.transport.name,
      model: resolved.model,
    });
    if (!result.ok) {
      throw new PreflightError(result.kind, result.message);
    }
    // Ollama needs the tool-calling smoke check too — other providers
    // are tool-call-capable by schema; only Ollama can return a model
    // that silently ignores tools.
    if (preflightTransport.name === 'ollama' && toolPool.length > 0) {
      const toolResult = await preflightToolCalling({
        provider: preflightTransport,
        providerName: resolved.transport.name,
        model: resolved.model,
      });
      if (!toolResult.ok) {
        throw new PreflightError(toolResult.kind, toolResult.message);
      }
    }
  }

  // Phase 1 — lane preflight. Runs ONLY when `taskRouting.enabled === true`
  // AND the caller hasn't opted out of preflight. Iterates every configured
  // cost lane (skipping `delegator` — its model rides the parent's
  // preflight when providers align) and aggregates failures into a single
  // `LanePreflightError` so the user can fix all lanes in one pass.
  // Resolves the lane's provider via the same `resolveProvider` the
  // scheduler uses, and adapts `preflightProvider`'s ok/err result into
  // the throw-on-failure contract `runLanePreflight` expects.
  if (opts.preflight !== false && opts.replayFixturePath === undefined && taskRoutingEnabled) {
    await runLanePreflight({
      registry: laneRegistry,
      harnessHome,
      resolveProvider: async (laneProvider, laneModel, ropts) =>
        resolveProvider(laneProvider, laneModel, { harnessHome: ropts.harnessHome }),
      preflight: async (popts) => {
        const probeResult = await preflightProvider({
          provider: popts.provider as LLMProvider,
          providerName: popts.providerName,
          model: popts.model,
        });
        if (!probeResult.ok) {
          throw new PreflightError(probeResult.kind, probeResult.message);
        }
      },
    });
  }

  // M8 T2 — capture / replay tool-pool wrapping. Done AFTER preflight so
  // the Ollama tool-calling smoke check sees the real tool implementations
  // (otherwise its synthetic call would either record a phantom result
  // into the capture sink or trip the replay queue's "exhausted" guard
  // before the first session turn).
  if (opts.replayFixturePath !== undefined) {
    const fixture = loadReplayFixture(opts.replayFixturePath);
    toolPool = wrapToolsForReplay(toolPool, fixture);
    finalToolPoolRef = toolPool;
  } else if (captureSink !== undefined) {
    toolPool = wrapToolsForCapture(toolPool, captureSink);
    finalToolPoolRef = toolPool;
  }

  // On-disk session DB. Opens at <harnessHome>/sessions.db by default;
  // the --db CLI flag overrides the path. cleanupPhantomReviews sweeps
  // stale review-fork rows from prior session crashes.
  //
  // Backlog #55 — derive the default path from the runtime's resolved
  // `harnessHome`, NOT SessionDb.open's own resolveHarnessHome() fallback.
  // The two diverge when a caller passes `harnessHome` while $HARNESS_HOME is
  // unset (a real dev machine / any embedder), which silently opened the
  // GLOBAL ~/.harness/sessions.db. Threading `harnessHome` here makes the DB
  // land under the home the runtime was actually built with.
  const sessionDb = SessionDb.open({
    path: opts.dbPath ?? join(harnessHome, 'sessions.db'),
  });
  const phantomsCleaned = sessionDb.cleanupPhantomReviews();
  if (phantomsCleaned > 0) {
    process.stderr.write(`[review] cleaned up ${phantomsCleaned} phantom review row(s)\n`);
  }
  const cronSessionsCleaned = sessionDb.cleanupOldCronSessions();
  if (cronSessionsCleaned > 0) {
    process.stderr.write(`[cron] cleaned up ${cronSessionsCleaned} old cron session row(s)\n`);
  }
  // Fix F6 — sweep idle channel sessions on the same boot cadence as the cron
  // sweep. Channel sessions reuse deterministic colon-ids forever and aren't
  // REST-deletable, so without this their rows/messages/trajectories grow
  // unbounded. Ages by last_updated (30-day default) so active chats survive.
  const channelSessionsCleaned = sessionDb.cleanupOldChannelSessions();
  if (channelSessionsCleaned > 0) {
    process.stderr.write(
      `[channels] cleaned up ${channelSessionsCleaned} old channel session row(s)\n`,
    );
  }

  if (opts.resumeId !== undefined) {
    const existing = sessionDb.getSession(opts.resumeId);
    if (existing === null) {
      sessionDb.close();
      throw new SessionNotFoundError(opts.resumeId);
    }
  }

  // Permission cascade — honors the user's `~/.harness/config.json`
  // `permissionMode`. Without this the TUI hangs on any tool-using turn:
  // query() falls through to `'default'`, fires an `ask` callback that
  // the server has no interactive surface for, and the TUI receives a
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
    // This is the runtime-level fallback canUseTool — its `ask` is a
    // deny-always placeholder (line ~769). The `always` answer branch
    // in canUseTool.ts:61 is unreachable from this chain because `ask`
    // never returns 'always', so recordAlwaysAllow is genuinely
    // never called. The per-session canUseTool in src/server/routes/
    // turns.ts is the one users actually hit through the approval
    // queue — that's where backlog #44 wired
    // appendProjectLocalPermissionRule.
    alwaysAllow: new Set<string>(),
    ruleLayers: permissionSettings.layers,
    recordAlwaysAllow: () => {
      /* unreachable: ask placeholder always denies. */
    },
  });
  // Defense-in-depth: secrets redactor wraps the resolved canUseTool.
  // Catches the failure class where an agent reads a secret while
  // exploring and then writes it verbatim into a generated artifact.
  const canUseTool = wrapCanUseToolWithTransformers(baseCanUseTool, [redactSecretsTransformer]);

  // Hook runner — loads the `hooks` block from layered settings and wires
  // the consent checker against the server-mode policy (M5-01). The server
  // doesn't own a TTY, so the checker runs NON-INTERACTIVELY: a hook with no
  // prior on-disk decision returns a transient 'skip' (the runner treats it as
  // inert — not a block — so a misconfigured hook never breaks the turn) and
  // NOTHING is persisted (an environment auto-deny must not masquerade as a
  // user decision — audit 2026-06-10). The runner logs a one-line "awaiting
  // consent" notice as the user-visible signal to pre-populate
  // ~/.harness/shell-hooks-allowlist.json; once a genuine allow is recorded
  // there, the hook fires through that cached decision. Always built — first-
  // call cost with no hooks configured is one map lookup.
  const hookSettings = loadHookSettings({ cwd: opts.cwd, harnessHome });
  const hookConsentStore = buildFileConsentStore(join(harnessHome, 'shell-hooks-allowlist.json'));
  const hookConsent = buildConsentChecker({
    store: hookConsentStore,
    // No interactive flag → non-interactive: unrecorded hooks skip (transient),
    // never persisted. `ask` is only consulted in interactive mode, which the
    // server never enables; kept for the (event, command) signature contract.
    ask: async (): Promise<AskResponse> => 'deny',
  });
  const hookRunner = buildHookRunner({
    hooksByEvent: hookSettings.hooksByEvent,
    consent: hookConsent,
    home: process.env.HOME,
    logStderr: (msg: string) => process.stderr.write(`${msg}\n`),
  });

  // M5 T6 — sub-agent infrastructure. The runtime constructs the trio at
  // boot and exposes them on Runtime; the turns route plumbs them onto
  // toolContext at query() time (T8).
  //
  // M5.1 (backlog items 25/26/27): lane caps, availableProviders, and
  // artifactsRoot now thread from settings + the resolved provider.
  // Without these, the scheduler defaults pick the cheapest
  // capability-profile match (often ollama/llama3.1:70b for a
  // `role: explore` child), skip per-child trajectory capture (starving
  // the offline learning/review pipelines), and leave concurrency
  // unbounded. Derivations live in three pure helpers above so the
  // wiring is unit-testable.
  // Write lock: v0 profile-scoped Semaphore(1) for write-capable children.
  // `agents` is the registry loaded earlier; reuse it as-is. Provider/
  // model defaults track the parent session.
  const laneSemaphores = new LaneSemaphores(resolveLaneSemaphoresOpts(userSettings));
  const writeLock = new Semaphore(1);
  // M8 T1 / backlog #30 — when the runtime is router-mode, sub-agent
  // defaults must specialize to the frontier lane. The literal `'router'`
  // string isn't a real provider entry — resolveProvider would throw if a
  // child tried to use it. The frontier lane is the more capable lane and
  // what the user already configured. The frontier model comes from
  // userSettings.router?.frontierModel (the configured override), falling
  // back to the resolved frontier child's own default model when no
  // override is set.
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
    createChildSession: (input) => {
      // Phase 2 T1 — pick the metadata shape based on the routing attribution
      // hints the scheduler computes for us.
      //
      //   isDelegator   → `{ kind: 'routing-delegator', parentSessionId }`
      //   lane !== null → `{ kind: 'routing-atom', laneName, laneProvider,
      //                       laneModel, parentDelegatorSessionId }`
      //   otherwise     → legacy `{ agentName, kind: 'subagent' }`
      //
      // Downstream consumers (audit logger, /sessions list, trajectory
      // exports) can group on `kind` to triage router-routed work
      // separately from domain sub-agents.
      const metadata: Record<string, unknown> = input.isDelegator
        ? { kind: 'routing-delegator', parentSessionId: input.parentSessionId }
        : input.lane !== null
          ? {
              kind: 'routing-atom',
              laneName: input.lane.name,
              laneProvider: input.lane.provider,
              laneModel: input.lane.model,
              parentDelegatorSessionId: input.parentSessionId,
            }
          : { agentName: input.agentName, kind: 'subagent' };
      // Phase E H1 (defense-in-depth) — stamp the child with the parent
      // session's owner so any future getSessionContext(childId) scopes the
      // child's memory/learning under users/{owner}/… rather than the shared
      // legacy namespace. Harmless when the parent is unowned / unresolvable
      // (owner omitted → child row stays unowned, byte-identical to before).
      const parentOwner = sessionDb.getSession(input.parentSessionId)?.ownerId ?? null;
      return sessionDb.createSession({
        provider: input.provider,
        model: input.model,
        parentSessionId: input.parentSessionId,
        title: `subagent:${input.agentName}`,
        systemPrompt: input.systemPrompt,
        metadata,
        ...(parentOwner != null ? { owner: parentOwner } : {}),
      });
    },
    availableProviders: resolveSubagentAvailableProviders(resolved),
    defaultProvider: subagentDefaultProvider,
    defaultModel: subagentDefaultModel,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    artifactsRoot: resolveSubagentArtifactsRoot(harnessHome, bundle),
    // Per-child trace file: child events land at
    // <harnessHome>/traces/<childSessionId>.jsonl alongside the
    // consolidated parent trace.
    harnessHome,
    // Phase 1 — lane-aware role resolution. Consulted by the scheduler
    // BEFORE the Phase 13.2 capability table so configured roles
    // (cheap-task / moderate-task / frontier-task / delegator) route
    // through operator-pinned (provider, model) pairs. Returns
    // `undefined` for unknown roles → falls through to the existing
    // capability profile path.
    // 2026-05-24 — read via holder so rebuildTaskRouting swaps the
    // registry without restarting the scheduler.
    resolveLane: (role) => laneRegistryHolder.current.lookup(role),
    // SPIKE (off by default) — when `subscriptionExecutor.enabled`, a
    // delegation to the `subscription-executor` role is handed to a headless
    // `claude -p` subprocess instead of the AgentRunner loop. Absent /
    // disabled → the branch is inert and every delegation takes the normal
    // path (the existing scheduler tests prove that path is byte-unchanged).
    ...(userSettings.subscriptionExecutor !== undefined
      ? { subscriptionExecutor: userSettings.subscriptionExecutor }
      : {}),
  });

  // M5 T7 — task manager. Wraps the SubagentScheduler with lifecycle
  // persistence so the model can dispatch background work via task_create
  // and observe it via task_list / task_get / task_output. TaskStore
  // reads against `sessionDb` (no separate DB). The server build always
  // carries a manager, and individual task tools no-op safely when the
  // agent registry is empty.
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
  // ~/.harness/config.json `microcompaction` block.
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
  //
  // Phase B T3 — per-session teardown now also reclaims the session's SSE
  // bus + replay ring via disposeBus. The events route NO LONGER disposes
  // the bus in its `finally` (the ring must survive a reconnect window and
  // across turns), so disposal is consolidated here (single-session teardown:
  // DELETE /sessions, OpenAI per-request finally, cron per-job, the M6
  // compaction-pivot on the parent id) and in `dispose()`'s shutdown walk.
  // disposeBus runs AFTER disposeSessionContext so any `session_summary`
  // publish in the T6 path still reaches a live bus before it closes; it's
  // also unconditional (outside the `ctx` guard) so a session that only ever
  // had a bus (subscribed but never ran a turn) still gets reclaimed.
  const disposeSession = async (
    sessionId: string,
    disposeOpts?: { bus?: ServerEventBus },
  ): Promise<void> => {
    const ctx = sessionContexts.get(sessionId);
    if (ctx) {
      sessionContexts.delete(sessionId);
      await disposeSessionContext(ctx, {
        runtime,
        ...(disposeOpts?.bus !== undefined ? { bus: disposeOpts.bus } : {}),
      });
    }
    disposeBus(sessionId);
  };

  // 2026-05-24 — taskRouting hot-reload closure. Re-reads the latest
  // userSettings + bundle prompts, rebuilds the lane registry (via the
  // holder so the scheduler sees the new mapping), and reassembles the
  // smart-router system segment in-place on systemSegments. Subsequent
  // turns + atom dispatches pick up the new state.
  //
  // Cost: the prompt cache invalidates on the next turn — the segment
  // text changed, so Anthropic's prefix-cache miss costs ~5% extra on
  // the first turn after the edit. Acceptable for an interactive user
  // who chose to hot-toggle.
  const cacheEnabled = opts.cacheEnabled !== false;
  const rebuildTaskRouting = async (): Promise<void> => {
    // Backlog #55 — hot-reload from the runtime's harnessHome, not the global.
    const fresh = readConfig({ harnessHome });
    const freshEnabled = resolveTaskRoutingEnabled(
      process.env.SOV_TASK_ROUTING_ENABLED,
      fresh.taskRouting?.enabled,
    );
    laneRegistryHolder.current = buildLaneRegistry(fresh.taskRouting);
    const freshPrompt = await loadSmartRouterPrompt({
      enabled: freshEnabled,
      bundle,
      trivialFastPath: fresh.taskRouting?.trivialFastPath === true,
    });

    // Rebuild the tool pool's AgentTool enum so routing agents appear /
    // disappear when the user toggles taskRouting.enabled mid-session. The
    // subscription-executor role is gated the same way off its own config flag.
    const freshVisibleAgents = computeToolVisibleAgents(agents, {
      taskRoutingEnabled: freshEnabled,
      subscriptionExecutorEnabled: fresh.subscriptionExecutor?.enabled === true,
    });
    const freshToolCtx: ToolContext = {
      cwd: opts.cwd,
      ...(bundle ? { bundleRoot: bundle.root } : {}),
      sessionId: 'pending',
      harnessHome,
      agents: freshVisibleAgents,
    };
    const freshPool = assembleToolPool(freshToolCtx, { mcpTools, harnessInfoSnapshot });
    runtime.toolPool.length = 0;
    runtime.toolPool.push(...freshPool);
    finalToolPoolRef = runtime.toolPool;

    const newSegments = buildSystemSegments({
      ...(bundle ? { bundle } : {}),
      cwd: opts.cwd,
      homeDir: harnessHome,
      cacheEnabled,
      tools: runtime.toolPool,
      ...(freshPrompt !== undefined ? { smartRouterPrompt: freshPrompt } : {}),
    });
    // Mutate in place so any closure that captured the array reference
    // (e.g., harnessInfoSnapshot at line ~580) sees the new content.
    runtime.systemSegments.length = 0;
    runtime.systemSegments.push(...newSegments);
  };

  const runtime: Runtime = {
    sessionDb,
    toolPool,
    systemSegments,
    provider,
    model: resolved.model,
    // Boot default for reasoning depth. Read defensively (`?.`) because the
    // missing-config early-return hands back a bare `{}` where `thinking` is
    // actually absent at runtime despite the Settings type marking it required
    // (the schema default only materializes on the parse path). 'off' = no
    // extended thinking = byte-identical provider requests.
    effort: userSettings.thinking?.effort ?? 'off',
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
    // 2026-05-24 — getter so consumers always observe the current
    // registry post hot-reload. The scheduler uses laneRegistryHolder
    // directly; this is for external reads (sessionContext, turns,
    // tests).
    get laneRegistry() {
      return laneRegistryHolder.current;
    },
    rebuildTaskRouting,
    cacheEnabled,
    writeLock,
    subagentScheduler,
    taskManager,
    daemonEventBus,
    skills,
    plugins,
    pluginCommands: pluginContributions.commands,
    learningLayer,
    microcompactConfig,
    compact,
    proactiveCompactThreshold,
    mcpClientPool,
    sessionContexts,
    getSessionContext,
    disposeSession,
    dispose: async () => {
      // M7-08 disposal order: cron runner → per-session subsystems →
      // router audit logger → MCP pool → approval queue → sessionDb.
      // Phase 17 — stop the cron tick FIRST so an in-flight tick can't
      // race the sessionDb close below. CronRunner.stop() is synchronous
      // (clears the setInterval handle and releases the file lock) but
      // any tick that already entered runDueJobs runs to completion;
      // that's fine, because each cron job builds its own session id
      // and writes through `runtime.sessionDb` while it's still open.
      // The runner is undefined when buildRuntime was called with
      // `cronEnabled: false` (test path).
      runtime.cronRunner?.stop();
      // Fix 3 — abort every live SSE bus FIRST so any in-flight background
      // turn (its query() rides the bus abortSignal) cooperatively cancels
      // before sessionDb.close() below. Without this, a turn parked in a
      // provider stream / tool loop keeps writing to a closed DB handle
      // until process.exit. The abort is synchronous; the per-session
      // disposal walk + the grace tick before sessionDb.close() give the
      // signal time to unwind the running generators. Idempotent — bus
      // close() no-ops on already-closed buses, so double-dispose is safe.
      abortAllBuses();
      const liveSessionIds = Array.from(sessionContexts.keys());
      for (const liveId of liveSessionIds) {
        await disposeSession(liveId);
      }
      // Phase B transport hardening, Fix 4 — sweep up every remaining bus map
      // entry. The disposeSession walk above only reaches sessions that ran a
      // turn (they have a sessionContext); a session that merely opened an
      // events stream minted a bus with no sessionContext, so abortAllBuses
      // closed it but left the entry in the map. clearAllBuses closes (idempotent)
      // + deletes all remaining entries so they don't accumulate across
      // build/dispose cycles in one process. Per-session disposeBus +
      // abortAllBuses keep their non-shutdown semantics.
      clearAllBuses();
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
      // Fix 3 — yield one microtask tick so the bus aborts fired above
      // have propagated through the running query() generators (their
      // cooperative-cancel unwind happens on the next microtask after the
      // abort event) before the DB handle goes away. Minimal + bounded —
      // a single already-resolved Promise, never a hang.
      await Promise.resolve();
      sessionDb.close();
    },
  };

  // Phase 17 — arm the cron runner AFTER the runtime literal is complete.
  // createProductionCronRunner closes over `runtime` (its `runAgent`
  // callback mints sessions, looks up skills, and dispatches an
  // AgentRunner against `runtime.toolPool`), so the construction must
  // happen after the literal binds. The runner is attached to the
  // runtime so `dispose()` can stop it; tests can read it back to drive
  // ticks manually. Default-on: production callers (tuiLauncher,
  // driveCommand) inherit cron; tests that don't need a live tick should
  // pass `cronEnabled: false`.
  if (opts.cronEnabled !== false) {
    const cronRunner = createProductionCronRunner(runtime, harnessHome);
    cronRunner.start();
    runtime.cronRunner = cronRunner;
  }

  return runtime;
}
