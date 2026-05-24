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

import { createClearedChildSession } from '../agent/sessionRecovery.js';
import { COMMANDS, buildCommandRegistry } from '../commands/registry.js';
import type { CommandContext, InputOpenConfig, PickerOpenConfig } from '../commands/types.js';
import { loadPermissionSettings } from '../config/settings.js';
import { auditContextBudget } from '../context/budget.js';
import type { Message, SystemSegment } from '../core/types.js';
import { computeRoutingStats } from '../router/stats.js';
import { buildSkillCommands } from '../skills/commands.js';
import { filterSkillRegistry, inferActiveToolsets } from '../skills/visibility.js';
import type { Runtime } from './runtime.js';
import type { SessionContext } from './sessionContext.js';
import { loadHistoryAsMessages } from './sessionId.js';

/** Side-effect collector. The route reads these after dispatch and
 *  surfaces them in the CommandResponse envelope so the TUI can react
 *  (hop sessionId, update model display, signal exit, etc.). Only
 *  fields whose mutations matter to the TUI are tracked here — most
 *  commands produce text output with no side effects. */
export type CommandSideEffects = {
  newSessionId?: string;
  exitRequested?: boolean;
  modelChanged?: string;
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
};

export type BuildServerCommandContextResult = {
  ctx: CommandContext;
  sideEffects: CommandSideEffects;
};

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

  // Build registry: built-in commands + skill-as-slash commands the
  // way REPL does. dispatchSlashCommand reads ctx.registry, so this
  // must reflect skills the session can use.
  const allCommands = [...COMMANDS, ...buildSkillCommands(filteredSkills)];
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
    bundlePath: runtime.bundle?.root ?? null,
    setModel: (model: string): void => {
      runtime.model = model;
      sideEffects.modelChanged = model;
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
      return `rolled back to parent session ${parent.sessionId}`;
    },
    tools: runtime.toolPool,
    registry,
    listSessions: (limit?: number) => runtime.sessionDb.listSessions(limit),
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
      const rows = all
        ? runtime.sessionDb.listRoutingAtomsAll()
        : runtime.sessionDb.listRoutingAtomsByParent(sessionId);
      return computeRoutingStats(rows, all ? 'all' : 'session');
    },
    // resumeCheckin is REPL-specific (paused-turn resumption). Left
    // undefined; /continue surfaces 'no pending checkin' as it does
    // in REPL when nothing is paused.
  };

  return { ctx, sideEffects };
}
