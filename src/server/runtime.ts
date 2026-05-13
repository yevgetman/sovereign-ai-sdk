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
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';

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
  dispose: () => Promise<void>;
};

export async function buildRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  const bundleRoot = opts.bundleRoot ?? getDefaultBundlePath() ?? undefined;
  const bundle = await loadBundleIfPresent(bundleRoot ?? null);
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

  // M3 keeps the session DB in-process and ephemeral. A real on-disk DB
  // under harnessHome lands when the server gets multi-session support
  // and persistent resume; until then the in-memory store mirrors the
  // SQLite shape so SessionDb.createSession() / saveMessage() work.
  const sessionDb = SessionDb.open({ path: ':memory:' });

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
    dispose: async () => {
      sessionDb.close();
    },
  };
}
