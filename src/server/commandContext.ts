// M10.5 — server-side slash-command CommandContext builder.
//
// The slash-command registry in src/commands/registry.ts is the single
// source of truth for what `/help`, `/cost`, `/tasks`, etc. do. It takes
// a CommandContext (defined in src/commands/types.ts) that's heavy with
// fields the runtime supplies at session boot — sessionId, model, tools,
// registry, listSessions, getCost, compact, rollback, getMetrics,
// taskManager, reviewManager, getBudgetReport, expandToolBlock, etc.
//
// dispatchCommand.ts (headless CLI) builds it for one-shot stdin-driven
// dispatch. M10.5 adds the server-mode equivalent: a per-request factory
// that maps the live Runtime + SessionContext into a CommandContext the
// registry can use, plus a side-effects collector so the calling route
// can surface mutations (modelChanged, exitRequested) back to the TUI.
//
// Fields whose underlying subsystem is unwired in server-mode return
// stable informative error strings. M10 audit MEDIUMs:
//   - clearHistory / rollback → wired 2026-05-19 (backlog #41 closed)
//     via createClearedChildSession; sideEffects.newSessionId tells
//     the TUI to hop sessionID for subsequent POSTs.
//   - Memory manager / project scope → wired 2026-05-19 (backlog #43
//     closed) onto SessionContext + threaded into ToolContext by
//     buildSessionToolContext. Affects MemoryTool routing in server-mode.

import type {
  CommandContext,
  InputOpenConfig,
  PickerOpenConfig,
} from '@yevgetman/sov-sdk/commands/types';
import { buildMicrocompactConfig } from '@yevgetman/sov-sdk/compact/microcompact';
import { loadPermissionSettings } from '@yevgetman/sov-sdk/config/settings';
import { readConfig } from '@yevgetman/sov-sdk/config/store';
import { auditContextBudget } from '@yevgetman/sov-sdk/context/budget';
import type { Message, SystemSegment } from '@yevgetman/sov-sdk/core/types';
import type { ReasoningEffort } from '@yevgetman/sov-sdk/providers/effort';
import { PROVIDER_REGISTRY } from '@yevgetman/sov-sdk/providers/models';
import type { ApiMode } from '@yevgetman/sov-sdk/providers/types';
import { buildSkillCommands } from '@yevgetman/sov-sdk/skills/commands';
import { filterSkillRegistry, inferActiveToolsets } from '@yevgetman/sov-sdk/skills/visibility';
import { createClearedChildSession } from '../agent/sessionRecovery.js';
import { COMMANDS, buildCommandRegistry } from '../commands/registry.js';
import { computeRoutingStats } from '../router/stats.js';
import { runWorkflow } from '../workflows/engine.js';
import { loadWorkflows } from '../workflows/loader.js';
import { buildSessionToolContext } from './routes/turns.js';
import type { Runtime } from './runtime.js';
import { type SessionContext, rebuildSessionRecall } from './sessionContext.js';
import { loadHistoryAsMessages } from './sessionId.js';

/** Loader roots for `/workflow` — scans project (cwd) / user (harnessHome) /
 *  bundle workflows/ dirs, same precedence as the agent loader. */
function workflowLoaderRoots(runtime: Runtime): {
  cwd: string;
  harnessHome: string;
  bundleRoot?: string;
} {
  return {
    cwd: runtime.cwd,
    harnessHome: runtime.harnessHome,
    ...(runtime.bundle?.root !== undefined ? { bundleRoot: runtime.bundle.root } : {}),
  };
}

/** Side-effect collector. The route reads these after dispatch and
 *  surfaces them in the CommandResponse envelope so the TUI can react
 *  (hop sessionId, update model display, signal exit, etc.). Only
 *  fields whose mutations matter to the TUI are tracked here — most
 *  commands produce text output with no side effects. */
export type CommandSideEffects = {
  newSessionId?: string;
  exitRequested?: boolean;
  modelChanged?: string;
  /** `/effort <level>` records the new reasoning-depth level so the TUI can
   *  update its status display (parallels `modelChanged`). The PER-SESSION
   *  mutation (`sessionCtx.effort`, NOT the shared `runtime.effort`) IS the
   *  behavioral effect — the next turn reads sessionCtx.effort; this side-effect
   *  is purely for the chrome. Absent when no `/effort` ran in the dispatch. */
  effortChanged?: ReasoningEffort;
  /** M11.5 — picker-driven commands (`/model`, `/resume`, `/export`)
   *  emit this in server mode so the TUI can render an inline card
   *  instead of the broken raw-mode `pick()` overlay (`ux1.png`). The
   *  card's selection is dispatched as a fresh `/<command> <value>`
   *  call. ADR M11.5-01, ADR M11.5-03. */
  pickerOpen?: PickerOpenConfig;
  /** Backlog #46 — `/theme <name>` records the chosen theme so the
   *  TUI can apply it client-side. The server already persists via
   *  applyAndPersistTheme; this side-effect carries the name to the
   *  Go renderer (which is a separate process from the TS theme
   *  singleton). */
  themeChanged?: string;
  /** 2026-05-24 — Config UX rebuild. `/config edit <dotpath>` emits an
   *  InputCard request for free-text fields (string / number / secret).
   *  The TUI renders the card; on Enter it dispatches
   *  `/<onSubmit.command> <typed>`. */
  inputOpen?: InputOpenConfig;
  /** 2026-05-24 — Config UX rebuild. `/config set verbose <bool>`
   *  records the new value so the TUI flips its toolcard renderer
   *  (compact one-liner vs. full bordered output). */
  verboseChanged?: boolean;
  /** 2026-05-24 patch — `/clear` signals the TUI to wipe the terminal
   *  scrollback so the new (cleared) session starts visually fresh.
   *  Without this, the old transcript stays in the terminal even
   *  though the server has hopped to a child session with no model
   *  context. Bool so absence is the no-op default. */
  clearScrollback?: boolean;
  /** 2026-05-24 patch — explicit close-modal signal. Set by /config
   *  commit and /config discard so the TUI clears m.picker / m.inputCard
   *  regardless of what side-effects the prior dispatch in a
   *  tea.Sequence chain left behind. Without this, the S-as-apply-
   *  then-save flow could leave a stale parent-refresh picker open. */
  closeModal?: boolean;
  /** Carries the new preset id (or '' when routing is disabled) so the
   *  TUI status bar updates live. Empty string clears the indicator. */
  taskRouterChanged?: string;
  /** 2026-06-14 config live-apply (M6) — chrome reflections for live /config
   *  edits, mirroring CommandSideEffectsSchema. permissionModeChanged surfaces
   *  the new mode (loud for 'bypass'); the ui.* fields tell the Go renderer to
   *  apply appearance changes live like verboseChanged/themeChanged. */
  permissionModeChanged?: string;
  toolOutputChanged?: { mode?: string; inlineLines?: number };
  footerChanged?: boolean;
  contextMeterChanged?: { warnAtPercent?: number; dangerAtPercent?: number };
  diffRenderChanged?: boolean;
};

export type BuildServerCommandContextResult = {
  ctx: CommandContext;
  sideEffects: CommandSideEffects;
};

/** #32 — the apiMode the `/effort` reasoning-support report should reason about.
 *
 *  In ROUTER mode the resolved provider is a RouterProvider pseudo-transport
 *  with NO `apiMode` (the cast in runtime.ts leaves `transport.apiMode`
 *  undefined), and `runtime.model` is the synthetic `"local | frontier"`
 *  display string. The frontier lane is the one that actually reasons (e.g.
 *  Claude 4 / o-series / sov), so we resolve the report's apiMode from the
 *  metadata's `frontierProvider` name. `runtime.model` still carries the
 *  frontier model id (after the `" | "`), so `modelSupportsReasoning(model,
 *  frontierApiMode)` then returns the correct boolean — the local lane id
 *  (sov/ollama) never matches a frontier reasoning pattern, so there is no
 *  false positive. Outside router mode the metadata's own apiMode is the real
 *  wire dialect and is returned unchanged.
 *
 *  Returns `undefined` only when neither the metadata nor the transport can
 *  name a dialect (a pathological/misconfigured router); the caller keeps the
 *  transport's apiMode in that case, matching pre-#32 behavior. */
export function resolveEffortApiMode(metadata: Record<string, unknown>): ApiMode | undefined {
  if (metadata.apiMode !== 'router') {
    return typeof metadata.apiMode === 'string' ? (metadata.apiMode as ApiMode) : undefined;
  }
  const frontierProvider = metadata.frontierProvider;
  if (typeof frontierProvider !== 'string') return undefined;
  return PROVIDER_REGISTRY[frontierProvider]?.apiMode;
}

/** Build a per-request CommandContext from the live server Runtime +
 *  SessionContext. The returned `sideEffects` map is mutated in place
 *  by the relevant CommandContext fields (setModel, clearHistory,
 *  requestExit) as the command runs. The caller reads it post-dispatch.
 *
 *  This factory is non-destructive: it does NOT mutate runtime/session
 *  state by itself; the mutations happen inside the command handlers
 *  via the closures it provides.
 *
 *  `opts.configStandalone` lets `sov config` standalone mode signal to
 *  `/config` that there's no active session to live-apply against — the
 *  toast collapses to plain "saved" per spec. Default false. */
export function buildServerCommandContext(
  runtime: Runtime,
  sessionCtx: SessionContext,
  sessionId: string,
  opts: { configStandalone?: boolean } = {},
): BuildServerCommandContextResult {
  const sideEffects: CommandSideEffects = {};
  const systemSegmentsRef: SystemSegment[] = runtime.systemSegments;

  // Phase E — the owning principal for this session, sourced from the
  // SessionContext (which reads it from the session row's ownerId, never caller
  // input). Undefined for the implicit single principal (legacy / open /
  // loopback-no-token). SECURITY-LOAD-BEARING: every cross-session listing must
  // scope to this owner so a principal can't enumerate another principal's
  // sessions / routing stats (mirrors GET /sessions' ownerIdOf scoping), and
  // the /clear child must inherit it so the owner isn't 404'd out of their own
  // conversation.
  const ownerId = sessionCtx.userId;

  // Filter the skill registry per the session's active toolsets — the
  // /help output should mention only skills the user can actually
  // invoke right now. inferActiveToolsets takes the active tool names;
  // we surface the full server-mode tool pool's names because the
  // session has access to all of them (no per-session toolset narrowing
  // in server-mode v1).
  const messages: Message[] = loadHistoryAsMessages(runtime.sessionDb, sessionId);
  const activeToolNames = runtime.toolPool.map((t) => t.name);
  const activeToolsets = inferActiveToolsets(activeToolNames);
  const filteredSkills = filterSkillRegistry(runtime.skills, activeToolsets, activeToolNames);

  // Build registry: built-in commands + plugin commands + skill-as-slash
  // commands the way REPL does. dispatchSlashCommand reads ctx.registry, so
  // this must reflect skills the session can use.
  //
  // Plugin System v1 (T8) — ORDER IS THE CONTRACT. Built-in COMMANDS come
  // FIRST so they ALWAYS win a name collision (buildCommandRegistry is
  // first-wins) — a plugin can never shadow `/help`, `/compact`, etc. Plugin
  // commands come next; skill-derived commands last. (H4: only skills/commands
  // flow into the command seam — no plugin hook/mcp wiring here.)
  const allCommands = [
    ...COMMANDS,
    ...runtime.pluginCommands,
    ...buildSkillCommands(filteredSkills),
  ];
  const registry = buildCommandRegistry(allCommands);

  // Read permission settings ONCE for this request. The cascade is
  // small and re-reading on every command keeps `sov config set` hot-
  // reloads working without a restart, matching REPL semantics.
  const permissionSettings = loadPermissionSettings({
    cwd: runtime.cwd,
    harnessHome: runtime.harnessHome,
  });

  const ctx: CommandContext = {
    sessionId,
    cwd: runtime.cwd,
    providerName: runtime.resolvedProvider.transport.name,
    model: runtime.model,
    // #32 — in router mode the transport is a RouterProvider with no apiMode
    // and runtime.model is the synthetic "local | frontier" string, so a naive
    // `transport.apiMode` makes `/effort status` wrongly report "does not
    // support reasoning depth". Resolve the FRONTIER lane's apiMode (the lane
    // that reasons) from the resolved metadata; outside router mode this is the
    // real wire dialect, unchanged. Fall back to the transport's apiMode for a
    // pathological/misconfigured router (pre-#32 behavior).
    apiMode:
      resolveEffortApiMode(runtime.resolvedProvider.metadata) ??
      runtime.resolvedProvider.transport.apiMode,
    // Backlog #57 — the CURRENT level is read off the per-session context (not
    // the shared runtime boot default), so `/effort status` reports this
    // session's depth and the picker marks the right entry.
    effort: sessionCtx.effort,
    bundlePath: runtime.bundle?.root ?? null,
    setModel: (model: string): void => {
      runtime.model = model;
      sideEffects.modelChanged = model;
    },
    // Backlog #57 — mutate the PER-SESSION effort (on the cached SessionContext
    // this builder was handed, which is the same instance the turns route reads
    // via getSessionContext), NOT the shared runtime.effort. This keeps one
    // principal's `/effort` from changing another principal's depth on a
    // multi-user gateway, and leaves the cron / channel pipelines reading the
    // untouched boot default. The next turn's query() carries the new level
    // because it reads sessionCtx.effort; effortChanged is still recorded for
    // the TUI status display. (Unlike setModel, which remains global — that
    // sibling gap is tracked separately; see backlog.)
    setEffort: (level: ReasoningEffort): void => {
      sessionCtx.effort = level;
      sideEffects.effortChanged = level;
    },
    // 2026-05-24 patch — live-apply hook for `permissionMode`. The
    // turns route reads `runtime.permissionMode` per-request (see
    // src/server/routes/turns.ts:471), so mutating it here flows into
    // the next turn's permission gate without a restart. The mode is
    // not surfaced to the TUI chrome anywhere user-visible, so no
    // side-effect is emitted — the model change IS the effect.
    setPermissionMode: (mode: 'default' | 'ask' | 'bypass'): void => {
      runtime.permissionMode = mode;
    },
    // 2026-05-24 patch — live-apply hook for microcompaction.* and
    // compaction.proactiveThresholdPct. Re-reads the persisted config
    // and rebuilds the cached runtime fields. The turns route reads
    // both per-request (microcompactConfig + proactiveCompactThreshold)
    // so the next turn picks up the new values.
    refreshRuntimeFromConfig: (): void => {
      // #55-class fix (2026-06-14) — read from the runtime's resolved
      // harnessHome, not the process-global home. A bare `readConfig()` falls
      // back to `resolveHarnessHome()`, so a runtime built with an explicit
      // harnessHome (while $HARNESS_HOME is unset — any embedder / a real dev
      // box) silently re-read ~/.harness/config.json and the live-apply was a
      // no-op against the home the runtime actually uses. Mirrors every other
      // config read in buildRuntime / buildSessionContext.
      const fresh = readConfig({ harnessHome: runtime.harnessHome });
      runtime.microcompactConfig = buildMicrocompactConfig(fresh.microcompaction);
      const pct = fresh.compaction?.proactiveThresholdPct;
      runtime.proactiveCompactThreshold = pct === undefined ? 0.75 : pct / 100;
    },
    // 2026-05-24 — taskRouting hot-reload. Forwards to the runtime's
    // own rebuildTaskRouting closure which handles the registry swap +
    // system-segment reassembly. Async because the smart-router prompt
    // is reloaded from disk.
    rebuildTaskRouting: async (): Promise<void> => {
      await runtime.rebuildTaskRouting();
    },
    // 2026-06-14 config live-apply (M1) — re-resolve the active provider stack
    // between turns so a cross-family model / credential / baseUrl / router-lane
    // edit applies to the LIVE conversation from the next turn. Forwards to the
    // runtime closure which atomically swaps the transport + model + compactor
    // model + learning Reason adapter.
    reresolveProvider: async (provider?: string, model?: string): Promise<void> => {
      await runtime.reresolveProvider?.(provider, model);
    },
    // 2026-06-14 config live-apply (M2) — rebuild the HookRunner from fresh
    // config; the turns route reads runtime.hookRunner by reference per turn.
    reloadHooks: async (): Promise<void> => {
      await runtime.reloadHooks?.();
    },
    // 2026-06-14 config live-apply (M2) — reconnect the MCP pool + rebuild the
    // MCP slice of the tool pool so mcpServers edits apply next turn.
    reloadMcpServers: async (): Promise<void> => {
      await runtime.reloadMcpServers?.();
    },
    // 2026-06-14 config live-apply (M4) — rebuild THIS session's recall thunk +
    // learning observer in place from fresh config so learning.recall.* /
    // learning.disabled apply to the live conversation. Operates on the SAME
    // cached SessionContext this builder was handed (the instance the turns
    // route reads via getSessionContext). Re-reads the user's persisted values
    // only; never changes recall/synthesis semantics or founder-reserved
    // defaults (recall ON).
    rebuildRecall: async (): Promise<void> => {
      await rebuildSessionRecall(runtime, sessionCtx);
    },
    // Backlog #41 — wired 2026-05-19. Mints a fresh child session via
    // the existing createClearedChildSession helper, sets
    // sideEffects.newSessionId so the TUI hops sessionID for subsequent
    // POSTs. The output text matches the canonical "history cleared into
    // child session ..." message the dispatch CLI surfaces.
    clearHistory: (): string => {
      const result = createClearedChildSession(runtime.sessionDb, {
        parentSessionId: sessionId,
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        systemPrompt: systemSegmentsRef,
        // Phase E — stamp the cleared child with the owning principal so the
        // owner's next /turns isn't 404'd by loadOwnedSession. Omitted when
        // unowned (single-user / legacy), keeping the child unowned.
        ...(ownerId !== undefined ? { owner: ownerId } : {}),
        metadata: {
          bundleRoot: runtime.bundle?.root ?? null,
        },
      });
      sideEffects.newSessionId = result.newSessionId;
      // 2026-05-24 patch — signal the TUI to wipe terminal scrollback
      // so the new session starts visually fresh. Without this, the
      // user's old transcript stays visible even though the server has
      // hopped to the child session with no model-side context.
      sideEffects.clearScrollback = true;
      return [
        `conversation history cleared into child session ${result.newSessionId}`,
        `parent session preserved: ${result.parentSessionId}`,
        'rollback: /rollback',
      ].join('\n');
    },
    getCost: () => runtime.sessionDb.getSessionCost(sessionId),
    compact: () => {
      // The TUI hits POST /sessions/:id/compact directly for /compact;
      // this fallback exists so /compact via the generic dispatcher
      // still produces a coherent result if it's ever routed here.
      // Pass a fresh AbortSignal — the server-side compactor wants one
      // and we have no upstream abort context for a synchronous-style
      // dispatcher call.
      return runtime.compact(messages, sessionId, new AbortController().signal);
    },
    // Backlog #41 — wired 2026-05-19. Looks up the parent session id
    // from sessionDb; sets sideEffects.newSessionId so the TUI hops. The
    // server doesn't keep an in-memory transcript — the next /turns POST
    // on the parent id loads messages fresh from the DB. A "restored N
    // messages" suffix isn't surfaced because SessionMetricsSnapshot
    // doesn't carry message counts and loading the full history just to
    // count rows is wasteful; the hop itself is the success signal.
    rollback: async (): Promise<string> => {
      const session = runtime.sessionDb.getSession(sessionId);
      if (session === null) {
        return `cannot rollback: current session ${sessionId} was not found`;
      }
      if (session.parentSessionId === null) {
        return `cannot rollback: session ${sessionId} has no parent session`;
      }
      const parent = runtime.sessionDb.getSession(session.parentSessionId);
      if (parent === null) {
        return `cannot rollback: parent session ${session.parentSessionId} was not found`;
      }
      sideEffects.newSessionId = parent.sessionId;
      // 2026-05-24 patch — wipe terminal scrollback so the rolled-back
      // session starts visually clean. Parity with /clear. The model
      // retains the parent session's full context server-side; the
      // visible terminal just doesn't show stale content from the
      // child session that's now gone.
      sideEffects.clearScrollback = true;
      return `rolled back to parent session ${parent.sessionId}`;
    },
    tools: runtime.toolPool,
    registry,
    // Phase E — owner-scope the listing so picker-driven commands (`/resume`)
    // and `/review activity` never surface another principal's sessions. The
    // owner arg is undefined in legacy / single-principal mode →
    // listSessions(limit, undefined) returns the unscoped list (byte-identical
    // to pre-Phase-E behavior). Mirrors GET /sessions' ownerIdOf scoping.
    listSessions: (limit?: number) => runtime.sessionDb.listSessions(limit, ownerId),
    cleanupPhantomReviews: () => runtime.sessionDb.cleanupPhantomReviews(),
    getMetrics: () => {
      // SessionMetricsSnapshot (returned by sessionDb.getSessionMetrics)
      // tracks tokens + tool counts. CommandContext.getMetrics expects
      // Omit<SessionMetrics, 'endedAtMs'> which ADDITIONALLY includes
      // wall-clock durations (startedAtMs, agentActiveMs, apiTimeMs,
      // toolTimeMs). The server runtime does not yet maintain in-memory
      // accumulators for those; for /stats output we surface what we
      // have and zero the unknown durations. Future polish could thread
      // the start time and per-turn timing through SessionContext.
      const snap = runtime.sessionDb.getSessionMetrics(sessionId);
      return {
        sessionId,
        startedAtMs: 0,
        agentActiveMs: 0,
        apiTimeMs: 0,
        toolTimeMs: 0,
        toolCalls: snap.toolCalls,
        toolOk: snap.toolOk,
        toolErr: snap.toolErr,
        tokens: snap.tokens,
      };
    },
    skills: filteredSkills,
    getLastAssistantText: (): string | null => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m === undefined) continue;
        if (m.role !== 'assistant') continue;
        const text = m.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return text.length > 0 ? text : null;
      }
      return null;
    },
    getMessages: () => messages,
    getPermissions: () => ({
      mode: runtime.permissionMode,
      // Session-scoped 'alwaysAllow' rules accumulate in the runtime's
      // canUseTool closure (M5); server-mode doesn't expose them on the
      // SessionContext directly. Surfacing an empty list keeps the
      // /permissions output honest: the persistent layers are what
      // mostly matters for users anyway.
      alwaysAllow: [],
      layers: permissionSettings.layers,
    }),
    requestExit: (): void => {
      sideEffects.exitRequested = true;
    },
    // 2026-05-24 patch — close-modal side-effect. /config commit and
    // /config discard use this to reliably clear any open picker /
    // input card on the TUI.
    requestCloseModal: (): void => {
      sideEffects.closeModal = true;
    },
    requestPicker: (config: PickerOpenConfig): void => {
      // ADR M11.5-01: one picker per command dispatch. Double-emission
      // is a programming error (a picker command shouldn't fire twice
      // in one call); throwing surfaces it loudly rather than silently
      // overwriting and dropping the first picker.
      if (sideEffects.pickerOpen !== undefined) {
        throw new Error('a picker is already open for this command dispatch');
      }
      sideEffects.pickerOpen = config;
    },
    recordThemeChange: (name: string): void => {
      sideEffects.themeChanged = name;
    },
    requestInput: (config: InputOpenConfig): void => {
      // Parallel to requestPicker. /config edit on a string/number/secret
      // field emits exactly one InputCard request per dispatch.
      sideEffects.inputOpen = config;
    },
    recordVerboseChange: (value: boolean): void => {
      sideEffects.verboseChanged = value;
    },
    recordTaskRouterChange: (preset: string): void => {
      sideEffects.taskRouterChanged = preset;
    },
    // 2026-06-14 config live-apply (M6) — chrome-reflection recorders the
    // /config relay calls so live edits surface in the Go TUI.
    recordPermissionModeChange: (mode: string): void => {
      sideEffects.permissionModeChanged = mode;
    },
    recordToolOutputChange: (change: { mode?: string; inlineLines?: number }): void => {
      sideEffects.toolOutputChanged = change;
    },
    recordFooterChange: (value: boolean): void => {
      sideEffects.footerChanged = value;
    },
    recordContextMeterChange: (change: {
      warnAtPercent?: number;
      dangerAtPercent?: number;
    }): void => {
      sideEffects.contextMeterChanged = change;
    },
    recordDiffRenderChange: (value: boolean): void => {
      sideEffects.diffRenderChanged = value;
    },
    ...(opts.configStandalone === true ? { isConfigStandalone: true } : {}),
    taskManager: runtime.taskManager,
    ...(sessionCtx.reviewManager !== undefined ? { reviewManager: sessionCtx.reviewManager } : {}),
    harnessHome: runtime.harnessHome,
    getBudgetReport: () =>
      auditContextBudget({
        systemSegments: systemSegmentsRef,
        tools: runtime.toolPool,
        skills: filteredSkills.skills,
        ...(runtime.bundle ? { bundle: runtime.bundle } : {}),
      }),
    // /expand is a REPL-specific UI affordance (re-render an inline
    // tool block from the in-memory ring buffer). The Go TUI has its
    // own M9.6 expand surface in the transcript component; surfacing
    // ok:false here means /expand via dispatcher reports out-of-range
    // honestly rather than pretending to work.
    expandToolBlock: (_n: number) => ({ ok: false, total: 0 }),
    // Phase 2 T9 — server-mode wiring for `/routing-stats`. Reads atom
    // rows directly from sessionDb (per-session by walking the
    // delegator child of the current session; cross-session via the
    // unconstrained --all query) and aggregates via computeRoutingStats.
    getRoutingStats: (opts) => {
      const all = opts?.all === true;
      // Phase E — `--all` must aggregate only THIS principal's routing atoms,
      // not every principal's. With an owner, use the owner-scoped query; with
      // none (legacy / single-principal) fall back to the unscoped cross-session
      // query (byte-identical to pre-Phase-E behavior). The per-session path is
      // already owner-safe — it walks the current (owner-verified) session's
      // delegator children.
      const rows = all
        ? ownerId !== undefined
          ? runtime.sessionDb.listRoutingAtomsAllByOwner(ownerId)
          : runtime.sessionDb.listRoutingAtomsAll()
        : runtime.sessionDb.listRoutingAtomsByParent(sessionId);
      return computeRoutingStats(rows, all ? 'all' : 'session');
    },
    // 2026-06-15 multi-agent workflows — `/workflow` runs declarative workflows
    // in THIS session via the live runtime (scheduler/lanes/path-lock). loads
    // from project/user/bundle workflows/ on each call (matches /config's
    // hot-read semantics). run() delegates to the engine, which fans out the
    // phase tasks in parallel through the scheduler.
    workflows: {
      list: async () => {
        const { byName } = await loadWorkflows(workflowLoaderRoots(runtime));
        return [...byName.values()].map((w) => ({
          name: w.def.name,
          description: w.def.description,
          source: w.source,
          phaseCount: w.def.phases.length,
        }));
      },
      run: async (name, args, onEvent) => {
        const { byName } = await loadWorkflows(workflowLoaderRoots(runtime));
        const loaded = byName.get(name);
        if (loaded === undefined) {
          throw new Error(`unknown workflow '${name}' (try /workflow list)`);
        }
        return runWorkflow({
          host: {
            cwd: runtime.cwd,
            harnessHome: runtime.harnessHome,
            scheduler: runtime.subagentScheduler,
            buildToolContext: (sid, cut, opts) => buildSessionToolContext(runtime, sid, cut, opts),
          },
          def: loaded.def,
          args,
          parentSessionId: sessionId,
          ...(onEvent !== undefined ? { onEvent } : {}),
        });
      },
    },
    // resumeCheckin is REPL-specific (paused-turn resumption). Left
    // undefined; /continue surfaces 'no pending checkin' as it does
    // in REPL when nothing is paused.
  };

  return { ctx, sideEffects };
}
