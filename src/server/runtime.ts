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

import { SessionDb } from '../agent/sessionDb.js';
import { loadAgents } from '../agents/loader.js';
import type { AgentRegistry } from '../agents/types.js';
import { getDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { resolveHarnessHome } from '../config/paths.js';
import { loadPermissionSettings } from '../config/settings.js';
import { readConfig } from '../config/store.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../permissions/redactSecretsTransformer.js';
import type { AskResponse, CanUseTool, PermissionMode } from '../permissions/types.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { SessionNotFoundError } from './errors.js';

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
  /** Accepted but currently unused by buildRuntime; T6 reads opts.preflight
   *  and conditionally skips provider.preflight(). Defaults to true. */
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
  dispose: () => Promise<void>;
};

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
    dispose: async () => {
      sessionDb.close();
    },
  };
}
