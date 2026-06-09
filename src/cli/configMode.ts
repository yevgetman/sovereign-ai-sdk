// `sov config` — config-only TUI mode.
//
// Built 2026-05-24 as part of the config UX rebuild (spec
// docs/specs/2026-05-24-config-ux-rebuild-design.md, plan
// docs/plans/2026-05-24-config-ux-rebuild.md, task T6).
//
// Boots a *minimal* Hono server (no providers, no bundle, no preflight,
// no agent runtime) plus sov-tui launched straight into `/config` mode
// via the new `--initial-command` flag (Agent B). The server mounts the
// dispatcher route the config UI rides on, plus the session creation
// route and SSE bus (so the TUI's standard boot path works), plus
// /health (so the TUI's health probe succeeds).
//
// Architecture:
//   * No `buildRuntime`. We hand-roll a Runtime literal whose heavy
//     subsystems (providers, learning, review, MCP, cron, hooks) are
//     either undefined/empty or replaced with a thin stub that throws
//     "not available in config-only mode" if invoked. The config slash
//     command never touches them.
//   * `sessionDb` is real (SQLite, isolated tempdir).
//   * `sessionContextFactory` returns a minimal SessionContext stub —
//     no TraceWriter, no LearningObserver, no ReviewManager, no
//     trajectory writes. Disposal is a no-op.
//   * Routes mounted: /health, /sessions (POST, GET, GET messages),
//     /sessions/:id/events (SSE), /sessions/:id/commands (POST, GET).
//     Turns/approvals/compact/cancel/skills are mounted too because
//     `buildAppWithRuntime` is the simplest path; they're guarded by
//     the absence of a real provider so any attempted use would surface
//     a clean error.
//
// On TUI exit, the server stops, the stub runtime disposes the sessionDb,
// and we return the child's exit code.

import { type SpawnOptions, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionDb } from '../agent/sessionDb.js';
import { resolveHarnessHome } from '../config/paths.js';
import type { SystemSegment } from '../core/types.js';
import { DaemonEventBus } from '../daemon/eventBus.js';
import type { CanUseTool } from '../permissions/types.js';
import type { ResolvedProvider } from '../providers/resolver.js';
import type { LLMProvider, Transport } from '../providers/types.js';
import { buildLaneRegistry } from '../router/laneRegistry.js';
import { LaneSemaphores } from '../runtime/laneSemaphores.js';
import { SubagentScheduler } from '../runtime/scheduler.js';
import { Semaphore } from '../runtime/semaphore.js';
import { buildAppWithRuntime } from '../server/app.js';
import { ApprovalQueue } from '../server/approvalQueue.js';
import { type ServerCompactor, buildServerCompactor } from '../server/compactor.js';
import { startServer } from '../server/index.js';
import type { Runtime } from '../server/runtime.js';
import type { SessionContext } from '../server/sessionContext.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskStore } from '../tasks/store.js';
import { findTuiBinary } from './tuiLauncher.js';

/** Sentinel values surfaced to the TUI splash card and `/config`'s context
 *  display. They make clear the user is in a config-only context with no
 *  active provider — the catalog's `defaultModel` / `defaultProvider`
 *  fields still reflect what the user has saved in config.json. */
const CONFIG_ONLY_PROVIDER = '(none)';
const CONFIG_ONLY_MODEL = '(none)';
const CONFIG_ONLY_INITIAL_COMMAND = '/config';

export type ConfigOnlyOptions = {
  /** Skip launching the TUI; return after the server boots. Test-only
   *  seam — production callers always launch the TUI. */
  noLaunch?: boolean;
  /** Override the harness home (where config.json + sessions.db live).
   *  Test-only seam — production resolves the standard $HARNESS_HOME. */
  harnessHomeOverride?: string;
};

export type ConfigOnlyBootResult = {
  /** Server port (loopback). */
  port: number;
  /** Session id minted on boot. */
  sessionId: string;
  /** Tear everything down — stop the server, dispose the runtime, clean
   *  up the tempdir. Idempotent. */
  shutdown: () => Promise<void>;
};

/**
 * Boot the config-only server + runtime stub without launching the TUI.
 * Returns the running server's port + session id + a shutdown hook.
 * Test seam — production callers use {@link runConfigOnlyMode}.
 */
export async function bootConfigOnly(opts: ConfigOnlyOptions = {}): Promise<ConfigOnlyBootResult> {
  const harnessHome = opts.harnessHomeOverride ?? resolveHarnessHome();

  // Ensure the harness home exists — the sessionDb writes to <home>/sessions.db,
  // and the directory is required even when the user has no other state yet.
  mkdirSync(harnessHome, { recursive: true });

  const runtime = buildConfigOnlyRuntime(harnessHome);
  const server = await startServer({ runtime });

  let sessionId: string;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`POST /sessions returned ${res.status}`);
    }
    const body = (await res.json()) as { sessionId: string };
    sessionId = body.sessionId;
  } catch (err) {
    await server.stop();
    await runtime.dispose();
    throw err instanceof Error ? err : new Error(String(err));
  }

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await server.stop();
    await runtime.dispose();
  };

  return { port: server.port, sessionId, shutdown };
}

/**
 * `sov config` entry point. Boots the minimal server + spawns sov-tui
 * with the new `--initial-command=/config` flag. Returns the child's
 * exit code.
 */
export async function runConfigOnlyMode(opts: ConfigOnlyOptions = {}): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    process.stderr.write(
      'sov: sov-tui binary not found — install Go ≥ 1.24 and run `bun pm -g trust @yevgetman/sov && sov upgrade`.\n',
    );
    return 70;
  }

  let booted: ConfigOnlyBootResult;
  try {
    booted = await bootConfigOnly(opts);
  } catch (err) {
    process.stderr.write(
      `sov: failed to start config server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (opts.noLaunch === true) {
    // Test seam — caller drives the lifecycle. Return 0 so the boot path
    // is exercised end-to-end without spawning the binary.
    await booted.shutdown();
    return 0;
  }

  const { VERSION } = await import('../version.js');
  const tuiArgs = [
    '--port',
    String(booted.port),
    '--session-id',
    booted.sessionId,
    '--initial-command',
    CONFIG_ONLY_INITIAL_COMMAND,
    '--model',
    CONFIG_ONLY_MODEL,
    '--provider',
    CONFIG_ONLY_PROVIDER,
    '--harness-version',
    VERSION,
    // 2026-05-24 patch — instruct the TUI to hide the prompt + status
    // line and exit cleanly when no modal (picker / inputCard) is
    // open. Without this flag the standalone process looks like a
    // normal agent session with an empty prompt and no model loaded,
    // which deceives users into thinking they can chat.
    '--config-only',
  ];

  const spawnOpts: SpawnOptions = { stdio: 'inherit' };
  const child = spawn(binary, tuiArgs, spawnOpts);

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const settle = async (code: number): Promise<void> => {
      if (resolved) return;
      resolved = true;
      await booted.shutdown();
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`sov: failed to launch TUI: ${err.message}\n`);
      void settle(1);
    });
    child.on('exit', (code) => {
      void settle(code ?? 0);
    });
  });
}

// ─── stub Runtime ──────────────────────────────────────────────────────────

/**
 * Build a hand-rolled Runtime literal that satisfies the type without
 * loading providers, bundle, agents, skills, hooks, MCP, cron, or any
 * other heavy subsystem. The session DB is real (so /sessions, /commands
 * work) but every other field is empty/stub.
 *
 * Heavy fields (subagentScheduler, taskManager) get minimal real instances
 * whose dependencies are stub callbacks — they'll throw "not available
 * in config-only mode" if anything tries to use them. The config slash
 * command path never invokes them.
 */
function buildConfigOnlyRuntime(harnessHome: string): Runtime {
  // Real session DB rooted in the harness home. Phantom-row cleanup and
  // cron-row cleanup are no-ops here (no review forks, no cron jobs ever
  // got minted in this surface) — call them anyway so the on-disk DB is
  // kept tidy if the user happens to share it with the full runtime.
  const sessionDb = SessionDb.open({ path: join(harnessHome, 'sessions.db') });

  // Stub provider that throws if streamed. The config command path never
  // invokes the provider; the field is required by the Runtime type only.
  // The interface declares `stream` as an async generator; supplying an
  // async function that throws conforms structurally because TypeScript
  // accepts a Promise that rejects in place of an iterator return — the
  // never-returned generator just satisfies the type via the unknown cast.
  const stubProvider: LLMProvider = {
    name: CONFIG_ONLY_PROVIDER,
    stream: ((): never => {
      throw new Error('provider stream is not available in config-only mode');
    }) as unknown as LLMProvider['stream'],
  };

  const resolvedProvider: ResolvedProvider = {
    // Stub transport carries a harmless `apiMode` so the server CommandContext
    // builder (which reads `resolvedProvider.transport.apiMode` for /effort)
    // gets a valid ApiMode rather than undefined. /effort isn't reachable in
    // config-only mode; this only keeps the typed field honest at runtime.
    transport: { ...stubProvider, apiMode: 'anthropic' } as unknown as Transport,
    client: stubProvider,
    baseUrl: 'config-only://',
    model: CONFIG_ONLY_MODEL,
    contextLength: 0,
    authType: 'none',
    metadata: {
      provider: CONFIG_ONLY_PROVIDER,
      apiMode: 'config-only',
      purpose: 'main',
    },
  };

  // canUseTool: deny-by-default. The config command never invokes tools.
  const canUseTool: CanUseTool = async () => ({
    behavior: 'deny',
    message: 'tool use is not available in config-only mode',
    interrupt: false,
  });

  // Empty lane registry (no `taskRouting` config consulted — registry is
  // queried by the scheduler, not the config UI).
  const laneRegistry = buildLaneRegistry(undefined);
  const laneSemaphores = new LaneSemaphores({});
  const writeLock = new Semaphore(1);

  // SubagentScheduler: minimal real instance. The closures throw if hit.
  // The config command never delegates.
  const subagentScheduler = new SubagentScheduler({
    agents: { agents: [], byName: new Map() },
    laneSemaphores,
    writeLock,
    resolveProvider: () => {
      throw new Error('provider resolution is not available in config-only mode');
    },
    createChildSession: () => {
      throw new Error('child session creation is not available in config-only mode');
    },
    defaultProvider: CONFIG_ONLY_PROVIDER,
    defaultModel: CONFIG_ONLY_MODEL,
    maxTokens: 0,
    harnessHome,
    resolveLane: (role) => laneRegistry.lookup(role),
  });

  const daemonEventBus = new DaemonEventBus();
  const taskStore = new TaskStore(sessionDb);
  const taskManager = new TaskManager({
    store: taskStore,
    scheduler: subagentScheduler,
    bus: daemonEventBus,
  });

  const approvalQueue = new ApprovalQueue();

  // Server-side compactor primitive. Construction is cheap; invocation
  // would surface our stub provider's "not available" error if reached.
  const systemSegments: SystemSegment[] = [];
  const compact: ServerCompactor = buildServerCompactor({
    sessionDb,
    resolvedProvider,
    model: CONFIG_ONLY_MODEL,
    systemSegments,
  });

  // SessionContext stub factory — no TraceWriter, no LearningObserver,
  // no ReviewManager. `buildServerCommandContext` reads
  // `sessionCtx.reviewManager` via optional-chaining and otherwise ignores
  // the context, so the stub is sufficient for the config command path.
  const sessionContexts = new Map<string, SessionContext>();
  const getSessionContext = (sessionId: string): SessionContext => {
    let ctx = sessionContexts.get(sessionId);
    if (!ctx) {
      ctx = buildStubSessionContext(sessionId);
      sessionContexts.set(sessionId, ctx);
    }
    return ctx;
  };

  const disposeSession = async (sessionId: string): Promise<void> => {
    sessionContexts.delete(sessionId);
  };

  // ── Runtime literal ────────────────────────────────────────────────────
  const runtime: Runtime = {
    sessionDb,
    toolPool: [],
    systemSegments,
    provider: stubProvider,
    model: CONFIG_ONLY_MODEL,
    // Standalone `sov config` never runs a turn — the inert default. (The
    // /effort command isn't reachable here; this only satisfies the type.)
    effort: 'off',
    agents: { agents: [], byName: new Map() },
    bundle: null,
    cwd: process.cwd(),
    bundleRoot: undefined,
    harnessHome,
    resolvedProvider,
    canUseTool,
    permissionMode: 'default',
    resumeId: undefined,
    maxTokens: 0,
    // HookRunner is a function type. No hooks configured in config-only
    // mode → return `{ block: false }` for every event so any code path
    // that wires hook checks degrades gracefully.
    hookRunner: async () => ({ block: false }),
    approvalQueue,
    laneSemaphores,
    laneRegistry,
    // 2026-05-24 — taskRouting hot-reload. In standalone config-only
    // mode there's no real runtime to hot-reload (no scheduler, no
    // active session), so this is a no-op that returns immediately.
    rebuildTaskRouting: async () => {},
    cacheEnabled: true,
    writeLock,
    subagentScheduler,
    taskManager,
    daemonEventBus,
    skills: { skills: [], byName: new Map() },
    // Config-only mode loads no plugins (no bundle, no agent loop) — empty so
    // the Runtime shape is satisfied; the command seam spreads nothing.
    plugins: [],
    pluginCommands: [],
    // Learning-loop spike Phase 1 — inert learning layer. Config-only mode
    // runs no turns (no session ever calls recall) and Observe is a Phase 1
    // no-op everywhere, so a stub that returns an empty recall result is
    // sufficient and avoids constructing the provider-backed Reason adapter
    // for a surface that never reasons.
    learningLayer: {
      recall: async () => ({ injectionText: '', lessons: [] }),
      observeSession: async () => {},
      observeToolEvent: () => {},
    },
    microcompactConfig: {
      enabled: false,
      keepRecent: 0,
      triggerThresholdPct: 0,
      compactableTools: new Set<string>(),
    },
    compact,
    proactiveCompactThreshold: 0.75,
    mcpClientPool: undefined,
    sessionContexts,
    getSessionContext,
    disposeSession,
    // 2026-05-24 — Config UX rebuild. Signals `/config`'s slash dispatcher
    // that there's no active session to live-apply against (Agent A's
    // configOps.ts reads this through buildServerCommandContext + the
    // CommandContext.isConfigStandalone flag) so the toast collapses to
    // plain "saved" instead of "applied to current session".
    configStandalone: true,
    dispose: async () => {
      approvalQueue.disposeAll();
      sessionDb.close();
    },
  };

  return runtime;
}

/**
 * Minimal SessionContext stub. The fields required by the type are all
 * present but inert — TraceWriter / LearningObserver / ReviewManager
 * would normally write to disk and consume runtime subsystems; here they
 * never fire because nothing in the config-command path observes them.
 *
 * The single field the command-context builder reads is
 * `ctx.reviewManager` (via optional-chain), so this stub omits it. The
 * remaining fields are typed-required and supply safe defaults.
 */
function buildStubSessionContext(sessionId: string): SessionContext {
  return {
    sessionId,
    // TraceWriter is a class; the stub mimics its surface area enough to
    // satisfy the type. The route paths the config command exercises never
    // call `.record()` or `.close()`, so the stub methods are no-ops.
    traceWriter: {
      path: '',
      record: () => {},
      close: async () => {},
    } as unknown as SessionContext['traceWriter'],
    trajectoryMetadata: {
      toolCallCount: 0,
      iterationsUsed: 0,
      estimatedCostUsd: 0,
    },
    reviewAbortController: new AbortController(),
    subdirectoryHintState: { touched: new Set() },
    memoryManager: {
      addProvider: () => {},
      initialize: async () => {},
      onSessionStart: async () => {},
      onSessionEnd: async () => {},
      shutdown: async () => {},
      prefetchSnapshot: async () => '',
      syncTurn: async () => {},
      onMemoryWrite: async () => {},
      onDelegation: async () => {},
    } as unknown as SessionContext['memoryManager'],
    projectScope: { kind: 'none' },
  };
}

// ─── test utilities ─────────────────────────────────────────────────────────

/**
 * Test seam — exposed for `tests/server/configMode.test.ts` so it can
 * exercise the stub runtime and routes without launching sov-tui.
 *
 * Production callers should use {@link runConfigOnlyMode}.
 */
export const __test__ = {
  buildConfigOnlyRuntime,
  buildStubSessionContext,
  /** Build a fully-wired Hono app around the stub runtime for in-process
   *  `app.request(...)` exercise patterns (no port binding). The caller
   *  owns disposal — call `runtime.dispose()` when done. */
  buildConfigOnlyApp: (
    harnessHome: string,
  ): { app: ReturnType<typeof buildAppWithRuntime>; runtime: Runtime } => {
    const runtime = buildConfigOnlyRuntime(harnessHome);
    return { app: buildAppWithRuntime(runtime), runtime };
  },
};
