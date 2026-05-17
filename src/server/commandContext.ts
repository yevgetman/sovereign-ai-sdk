// M10.5 — server-side slash-command CommandContext builder.
//
// The slash-command registry in src/commands/registry.ts is the single
// source of truth for what `/help`, `/cost`, `/tasks`, etc. do. It takes
// a CommandContext (defined in src/commands/types.ts) that's heavy with
// fields the REPL builds during boot — sessionId, model, tools, registry,
// listSessions, getCost, compact, rollback, getMetrics, taskManager,
// reviewManager, getBudgetReport, expandToolBlock, etc.
//
// terminalRepl.ts builds it inline alongside its own session loop.
// dispatchCommand.ts (headless CLI) builds it for one-shot stdin-driven
// dispatch. M10.5 adds the server-mode equivalent: a per-request factory
// that maps the live Runtime + SessionContext into a CommandContext the
// registry can use, plus a side-effects collector so the calling route
// can surface mutations (modelChanged, exitRequested) back to the TUI.
//
// Fields whose underlying subsystem is unwired in server-mode return
// stable informative error strings. M10 audit MEDIUMs not yet wired:
//   - clearHistory / rollback → require createClearedChildSession
//     (backlog #41); return an error referencing it
//   - The /memory slash command depends on a memory manager that the
//     server runtime doesn't construct (backlog #43); /memory's own
//     handler will surface the limitation when invoked

import { COMMANDS, buildCommandRegistry } from '../commands/registry.js';
import type { CommandContext } from '../commands/types.js';
import { loadPermissionSettings } from '../config/settings.js';
import { auditContextBudget } from '../context/budget.js';
import type { Message, SystemSegment } from '../core/types.js';
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
 *  via the closures it provides. */
export function buildServerCommandContext(
  runtime: Runtime,
  sessionCtx: SessionContext,
  sessionId: string,
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

  // M10.5 — informative error strings for unwired commands. Returned
  // as the command output (string), not thrown — so the TUI renders
  // them as normal transcript content. References the backlog item
  // tracking the wire-up so users see exactly what's coming.
  const UNWIRED_CLEAR_MSG =
    '/clear is not yet available in --ui tui (M10.5 scope-out; tracked as backlog item #41 — createClearedChildSession server wiring). Use `sov chat --ui repl` for now, or compact instead (/compact).';
  const UNWIRED_ROLLBACK_MSG =
    '/rollback is not yet available in --ui tui (M10.5 scope-out; tracked as backlog item #41). Use `sov chat --ui repl` for now.';

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
    clearHistory: (): string => UNWIRED_CLEAR_MSG,
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
    rollback: async () => UNWIRED_ROLLBACK_MSG,
    tools: runtime.toolPool,
    registry,
    listSessions: (limit?: number) => runtime.sessionDb.listSessions(limit),
    cleanupPhantomReviews: () => runtime.sessionDb.cleanupPhantomReviews(),
    getMetrics: () => {
      // SessionMetricsSnapshot (returned by sessionDb.getSessionMetrics)
      // tracks tokens + tool counts. CommandContext.getMetrics expects
      // Omit<SessionMetrics, 'endedAtMs'> which ADDITIONALLY includes
      // wall-clock durations (startedAtMs, agentActiveMs, apiTimeMs,
      // toolTimeMs) that terminalRepl tracks via in-memory accumulators
      // mid-session. Server-mode does not yet maintain those accumulators
      // (M9.x note); for /stats output we surface what we have and zero
      // the unknown durations. Future polish (M11+) could thread the
      // start time and per-turn timing through SessionContext.
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
    // resumeCheckin is REPL-specific (paused-turn resumption). Left
    // undefined; /continue surfaces 'no pending checkin' as it does
    // in REPL when nothing is paused.
  };

  return { ctx, sideEffects };
}
