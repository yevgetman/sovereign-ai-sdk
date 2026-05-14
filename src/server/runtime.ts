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
import { resolveHarnessHome } from '../config/paths.js';
import type { Settings } from '../config/schema.js';
import { loadHookSettings, loadPermissionSettings } from '../config/settings.js';
import { readConfig } from '../config/store.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import { buildConsentChecker, buildFileConsentStore } from '../hooks/consent.js';
import { buildHookRunner } from '../hooks/runner.js';
import type { HookRunner } from '../hooks/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../permissions/redactSecretsTransformer.js';
import type { AskResponse, AskUser, CanUseTool, PermissionMode } from '../permissions/types.js';
import { preflightProvider, preflightToolCalling } from '../providers/preflight.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import { LaneSemaphores, type LaneSemaphoresOpts } from '../runtime/laneSemaphores.js';
import { SubagentScheduler } from '../runtime/scheduler.js';
import { Semaphore } from '../runtime/semaphore.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskStore } from '../tasks/store.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { ApprovalQueue } from './approvalQueue.js';
import { PreflightError, SessionNotFoundError } from './errors.js';
import type { ServerEventBus } from './eventBus.js';

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
  const toolPool = assembleToolPool(toolCtx);

  const systemSegments = buildSystemSegments({
    ...(bundle ? { bundle } : {}),
    cwd: opts.cwd,
    homeDir: harnessHome,
    cacheEnabled: opts.cacheEnabled !== false,
    tools: toolPool,
  });

  const resolved = resolveProvider(opts.provider, opts.model, {
    harnessHome,
  });
  const provider = resolved.transport;

  // Provider preflight — fail fast on bad credentials / quota / transport
  // before opening the sessionDb or doing other side-effects. Mirrors
  // terminalRepl.ts:447-504. Skip when opts.preflight === false.
  if (opts.preflight !== false) {
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
  const userSettings = readConfig();
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
    defaultProvider: resolved.transport.name,
    defaultModel: resolved.model,
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
  const taskStore = new TaskStore(sessionDb);
  const taskManager = new TaskManager({
    store: taskStore,
    scheduler: subagentScheduler,
  });

  // M5 — permission-request approval queue. One queue per Runtime; the
  // server route and the (future) serverAsk callback share it as the
  // in-memory rendezvous between SSE-emitted permission_request events
  // and the TUI's POST /approvals response.
  const approvalQueue = new ApprovalQueue();

  return {
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
    dispose: async () => {
      // Cancel any in-flight approval promises before closing the DB so
      // a clean shutdown doesn't leave Promises that never resolve.
      approvalQueue.disposeAll();
      sessionDb.close();
    },
  };
}
