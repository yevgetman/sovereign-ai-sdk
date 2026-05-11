// Terminal REPL. Readline-based prompt loop that streams model output as
// text deltas arrive. Multi-turn history is now persisted (Phase 3.5) via
// the session DB; in-memory history mirrors what the DB knows so the model
// sees every prior user/assistant message.
//
// Phase 3.5: every turn is saved to ~/.harness/sessions.db (overridable
// via --db). `--resume <id>` rehydrates history and the frozen system
// prompt from the stored session instead of rebuilding from the bundle.
//
// Ctrl-C semantics:
//   - during streaming: abort the in-flight request, drop back to prompt
//   - at the prompt: close the REPL
//
// Exit commands: `/quit`, `/exit`, `/q`, Ctrl-D.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { SessionDb } from '../agent/sessionDb.js';
import { createClearedChildSession } from '../agent/sessionRecovery.js';
import { loadAgents } from '../agents/loader.js';
import type { AgentDefinition } from '../agents/types.js';
import { isDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { COMMANDS, buildCommandRegistry, dispatchSlashCommand } from '../commands/registry.js';
import { buildToolScope } from '../commands/toolScope.js';
import type { CommandContext, PromptCommand } from '../commands/types.js';
import { compactSession, shouldCompactProactively } from '../compact/compactor.js';
import {
  buildMicrocompactConfig,
  buildToolNameMap,
  microcompact,
  shouldMicrocompact,
} from '../compact/microcompact.js';
import { resolveHarnessHome } from '../config/paths.js';
import { parsePermissionRules } from '../config/rules.js';
import {
  appendProjectLocalPermissionRule,
  getPermissionSettingsPaths,
  loadHookSettings,
  loadMcpServerSettings,
  loadPermissionSettings,
} from '../config/settings.js';
import { readConfig } from '../config/store.js';
import { auditContextBudget } from '../context/budget.js';
import { expandContextReferences } from '../context/references.js';
import { createSubdirectoryHintState } from '../context/subdirectoryHints.js';
import { query } from '../core/query.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import { estimateMessageTokens } from '../core/tokenEstimate.js';
import { repairMissingToolResults } from '../core/transcriptRepair.js';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  SystemSegment,
  Terminal,
  TokenUsage,
} from '../core/types.js';
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
import { LearningObserver } from '../learning/observer.js';
import { instinctsDir } from '../learning/paths.js';
import { getProjectId } from '../learning/project.js';
import { buildMcpClientPool } from '../mcp/client.js';
import { wrapMcpTool } from '../mcp/toolWrapper.js';
import type { McpClientPool } from '../mcp/types.js';
import { createDefaultMemoryManager } from '../memory/provider.js';
import { resolveProjectScope } from '../memory/scope.js';
import { applyTransition, shouldRun } from '../mission/fsm.js';
import { notesMdPath } from '../mission/paths.js';
import { buildMissionSegments } from '../mission/segments.js';
import {
  acquireLock,
  appendWakeLog,
  loadMissionState,
  releaseLock,
  writeMissionState,
} from '../mission/state.js';
import type { MissionFiles } from '../mission/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../permissions/inputTransformer.js';
import { buildReadlineAsker } from '../permissions/prompt.js';
import { redactSecretsTransformer } from '../permissions/redactSecretsTransformer.js';
import type { PermissionMode } from '../permissions/types.js';
import { isContextOverflowError } from '../providers/errors.js';
import { preflightProvider, preflightToolCalling } from '../providers/preflight.js';
import { estimateCostUsd } from '../providers/pricing.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import type { Transport } from '../providers/types.js';
import { ReviewManager } from '../review/manager.js';
import { RouterAuditLogger } from '../router/auditLogger.js';
import { RouterProvider } from '../router/provider.js';
import { LaneSemaphores } from '../runtime/laneSemaphores.js';
import { SubagentScheduler } from '../runtime/scheduler.js';
import { Semaphore } from '../runtime/semaphore.js';
import { buildSkillCommands } from '../skills/commands.js';
import { loadSkills } from '../skills/loader.js';
import type { SkillRegistry } from '../skills/types.js';
import { filterSkillRegistry, inferActiveToolsets } from '../skills/visibility.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskStore } from '../tasks/store.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { HarnessInfoSnapshot } from '../tools/HarnessInfoTool.js';
import { resolveToolPath } from '../tools/pathUtils.js';
import { TraceWriter } from '../trace/writer.js';
import { tryWriteTrajectory } from '../trajectory/writer.js';
import {
  BracketedPasteTransform,
  disableBracketedPaste,
  enableBracketedPaste,
  restoreEmbeddedNewlines,
} from './bracketedPaste.js';
import { ContextMeter } from './contextMeter.js';
import { renderToolDiff } from './diff.js';
import { type FooterInfo, printPrePromptFooter } from './footer.js';
import { isInlineShellInput, runInlineShell } from './inlineShell.js';
import { InputEditor } from './inputEditor.js';
import { InputHistory } from './inputHistory.js';
import { getKeypressDispatcher } from './keypress.js';
import { MarkdownStream } from './markdownStream.js';
import { createQueuedQuestion } from './queuedQuestion.js';
import { type SessionMetrics, renderSessionSummary } from './sessionSummary.js';
import { renderSplash } from './splash.js';
import { formatMaxTokensWarning, formatPartialMutationWarning } from './terminalMessages.js';
import { resolveThemeName, setTheme } from './theme.js';
import { ThinkingIndicator } from './thinking.js';
import { CompactToolSlot } from './toolSlot.js';
import { createTranscriptLogger, resolveDebugTranscriptPath } from './transcript.js';

export type ReplOpts = {
  /** Absolute path to the harness bundle. Omitted in generic-agent mode (no
   *  bundle resolved from --bundle, HARNESS_BUNDLE, or CWD walk-up). */
  bundlePath?: string;
  providerName?: string;
  model?: string;
  maxTokens: number;
  permissionMode: PermissionMode;
  /** Resume an existing session by UUID. Validates the bundle matches what
   *  was stored at session creation; refuses otherwise. */
  resumeId?: string;
  /** Override the default DB path (~/.harness/sessions.db). */
  dbPath?: string;
  /** Disable provider prompt-cache markers for deterministic smoke tests. */
  noCache?: boolean;
  /** Startup provider health check. Defaults to true. */
  preflight?: boolean;
  /** Optional redacted JSONL event transcript path. */
  transcriptPath?: string;
  /** When true, render full tool-result preview blocks. Default false:
   *  REPL prints a one-line summary so tool output doesn't dominate
   *  the conversation view. CLI flag wins over config setting. */
  verbose?: boolean;
  /** When true, use the legacy readline-based input loop instead of
   *  the Wave-4 raw-mode inputEditor. Default false. */
  legacyInput?: boolean;
  /** Phase 10.5 part 2 — write a deterministic-replay fixture to this
   *  path on session end. The provider + tools are wrapped with
   *  capture observers; their outputs are replayed exactly when this
   *  fixture is later loaded via replayFixturePath. */
  captureFixturePath?: string;
  /** Phase 10.5 part 2 — replace the resolved provider + tool pool
   *  with replay primitives that re-emit the captured events from
   *  this fixture. No LLM calls are made; the agent loop runs against
   *  canned events deterministically. */
  replayFixturePath?: string;
  /** Phase 13.5 — name of the agent definition the session should run as.
   *  Resolved through the loaded agent registry (project / user / bundle).
   *  Required when `stateDir` is set. When supplied, the agent's
   *  systemPrompt prefixes the standard system segments and the tool pool
   *  is restricted to its `allowedTools` list. */
  agentName?: string;
  /** Phase 13.5 — path to a mission directory (mission.md / plan.md /
   *  notes.md / state.json / wake_log.jsonl). When set, the REPL runs
   *  in scheduled-mission mode: load the mission state, perform a single
   *  bounded wake against the named agent, persist the sentinel + notes
   *  produced by the agent, then exit. Requires `--agent`. */
  stateDir?: string;
};

/** Write a bracketed status line (e.g. `[tool: ...]`, `[cleared ...]`,
 *  `[debug] ...`) with guaranteed leading and trailing newlines so it
 *  never collides with adjacent assistant text. The caller passes the
 *  already-tinted body; this helper only enforces the line-break
 *  contract. Pass `stream='err'` to route to stderr. */
function writeStatusLine(tinted: string, stream: 'out' | 'err' = 'out'): void {
  const target = stream === 'err' ? process.stderr : process.stdout;
  target.write(`\n${tinted}\n\n`);
}

/** Visual divider width: terminal columns. Spans the full terminal width
 *  so the input frame matches the window. Lower-bounded at 20 to guard
 *  against terminals that report zero columns. */
function promptRuleWidth(): number {
  const cols = process.stdout.columns ?? 60;
  return Math.max(20, cols);
}

/** Render a 3-line frame around the input — top rule, blank input line,
 *  bottom rule — and reposition the cursor onto the blank line so the
 *  prompt that follows types between the rules. The returned `close()`
 *  must be called after readline resolves to advance the cursor past
 *  the bottom rule before any further output. */
function openPromptFrame(): { close: () => void } {
  const rule = chalk.gray('─'.repeat(promptRuleWidth()));
  // Top rule, blank line, bottom rule, then cursor advances to a line
  // below the bottom rule. We then move cursor up 2 rows back onto the
  // blank input line. (TTY only — non-TTY falls back to a single rule
  // before the prompt so transcripts and CI logs still read sensibly.)
  if (process.stdout.isTTY) {
    process.stdout.write(`${rule}\n\n${rule}\n\x1b[2A`);
    return {
      close: () => {
        // After the user hits enter, cursor sits at col 0 of the bottom
        // rule line. Advance one line so subsequent output lands below
        // the rule rather than overwriting it.
        process.stdout.write('\n');
      },
    };
  }
  process.stdout.write(`${rule}\n`);
  return { close: () => process.stdout.write(`${rule}\n`) };
}

/** Phase 10.6 — when the user invokes `--provider router`, build a synthetic
 *  ResolvedProvider whose transport is a RouterProvider wrapping two child
 *  providers (local + frontier) resolved via the normal provider pipeline.
 *  contextLength conservatively takes the smaller of the two children's
 *  caps so the ContextMeter stays accurate on either lane. */
function buildRouterResolvedProvider(
  harnessHome: string,
  setRefs: (logger: RouterAuditLogger, router: RouterProvider) => void,
): ResolvedProvider {
  const settings = readConfig();
  if (!settings.router) {
    throw new Error(
      '--provider router requires a `router` block in config.json (configure with: sov config set router.localProvider <name>, etc.)',
    );
  }
  const localResolved = resolveProvider(settings.router.localProvider, settings.router.localModel);
  const frontierResolved = resolveProvider(
    settings.router.frontierProvider,
    settings.router.frontierModel,
  );
  const auditLogger = new RouterAuditLogger({
    harnessHome,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const routerConfig = {
    localProvider: settings.router.localProvider,
    frontierProvider: settings.router.frontierProvider,
    ...(settings.router.localModel !== undefined ? { localModel: settings.router.localModel } : {}),
    ...(settings.router.frontierModel !== undefined
      ? { frontierModel: settings.router.frontierModel }
      : {}),
    ...(settings.router.defaultLane !== undefined
      ? { defaultLane: settings.router.defaultLane }
      : {}),
    ...(settings.router.escalationMode !== undefined
      ? { escalationMode: settings.router.escalationMode }
      : {}),
    ...(settings.router.maxConcurrentLocal !== undefined
      ? { maxConcurrentLocal: settings.router.maxConcurrentLocal }
      : {}),
    ...(settings.router.maxConcurrentFrontier !== undefined
      ? { maxConcurrentFrontier: settings.router.maxConcurrentFrontier }
      : {}),
  };
  const routerProvider = new RouterProvider({
    config: routerConfig,
    localProvider: localResolved.transport,
    frontierProvider: frontierResolved.transport,
    auditLogger,
    sessionId: 'pending',
    localContextLength: localResolved.contextLength,
  });
  setRefs(auditLogger, routerProvider);
  return {
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
}

/** Phase 10.5 part 2 — when --replay-fixture is supplied, skip
 *  resolveProvider entirely and build a synthetic ResolvedProvider
 *  whose transport is a ReplayProvider. The fixture's `provider`
 *  metadata is surfaced in the splash + audit log so the user knows
 *  this is a replay, not a live run. */
function buildReplayResolvedProvider(fixturePath: string): ResolvedProvider {
  const fixture = loadReplayFixture(fixturePath);
  const replay = new ReplayProvider({ fixture, providerName: fixture.meta.provider });
  return {
    transport: replay as unknown as Transport,
    client: replay,
    baseUrl: 'replay://',
    model: fixture.meta.model,
    contextLength: 200_000,
    authType: 'none',
    metadata: {
      provider: fixture.meta.provider,
      apiMode: 'replay',
      purpose: 'main',
      replayFixture: fixturePath,
    },
  };
}

export async function runRepl(opts: ReplOpts): Promise<void> {
  const bundle = await loadBundleIfPresent(opts.bundlePath ?? null);
  const harnessHome = resolveHarnessHome();
  const permissionSettings = loadPermissionSettings({ cwd: process.cwd(), harnessHome });
  const hookSettings = loadHookSettings({ cwd: process.cwd(), harnessHome });
  const mcpSettings = loadMcpServerSettings({ cwd: process.cwd(), harnessHome });
  const userSettings = readConfig();
  // Initialize theme BEFORE anything renders. NO_COLOR env var is
  // honored at this seam; explicit ui.theme wins over default 'dark'
  // but loses to NO_COLOR. setTheme is a singleton mutation so every
  // subsequent renderer call sees the active token set.
  setTheme(
    resolveThemeName(
      userSettings.ui?.theme !== undefined ? { configured: userSettings.ui.theme } : {},
    ),
  );
  const transcriptPath = resolveDebugTranscriptPath({
    ...(opts.transcriptPath !== undefined ? { cliPath: opts.transcriptPath } : {}),
    ...(userSettings.debugMode !== undefined ? { debugMode: userSettings.debugMode } : {}),
    harnessHome,
  });
  const transcript = createTranscriptLogger(transcriptPath);
  if (transcript && opts.transcriptPath === undefined) {
    writeStatusLine(chalk.gray(`[debug] transcript → ${transcript.path}`));
  }
  const proactiveThreshold =
    userSettings.compaction?.proactiveThresholdPct !== undefined
      ? userSettings.compaction.proactiveThresholdPct / 100
      : undefined;
  const verbose = opts.verbose === true || userSettings.verbose === true;
  const footerEnabled = userSettings.ui?.footer?.enabled !== false;
  const diffRenderEnabled = userSettings.ui?.diffRender?.enabled !== false;
  const meterWarnAt = userSettings.ui?.contextMeter?.warnAtPercent ?? 60;
  const meterDangerAt = userSettings.ui?.contextMeter?.dangerAtPercent ?? 80;
  // Precedence: explicit CLI flag → .harness/settings.json layers →
  // ~/.harness/config.json → built-in 'default'. The settings.json layer
  // owns allow/deny rules so it stays authoritative when present; config.json
  // acts as a single-knob fallback for users who only touch the picker.
  const permissionMode =
    opts.permissionMode !== 'default'
      ? opts.permissionMode
      : permissionSettings.mode !== 'default'
        ? permissionSettings.mode
        : (userSettings.permissionMode ?? 'default');
  // Phase 13.4 follow-up (Item 19) — resolve the session's project identity
  // exactly once at boot. The same instance threads through MemoryManager,
  // ToolContext, and buildSystemSegments so the snapshot, MemoryTool routing,
  // and the system-prompt scope segment all agree.
  const projectScope = resolveProjectScope({
    cwd: process.cwd(),
    bundle: bundle ?? null,
    harnessHome,
  });
  const memoryManager = createDefaultMemoryManager(harnessHome, projectScope);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();
  const subdirectoryHintState = createSubdirectoryHintState();
  const loadedSkills = await loadSkills({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    warn: (message) => process.stderr.write(chalk.yellow(`[skill] ${message}\n`)),
  });
  const loadedAgents = await loadAgents({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    warn: (message) => process.stderr.write(chalk.yellow(`[agent] ${message}\n`)),
  });
  const db = SessionDb.open(opts.dbPath !== undefined ? { path: opts.dbPath } : {});
  // Phase 13.3 follow-up — sweep phantom review-fork rows from prior sessions
  // that ended via /quit while a review was mid-dispatch (B4 abort path).
  // Fix #3 hides them from /review activity; this prevents indefinite DB growth.
  const phantomsCleaned = db.cleanupPhantomReviews();
  if (phantomsCleaned > 0) {
    process.stderr.write(`[review] cleaned up ${phantomsCleaned} phantom review row(s)\n`);
  }
  const resumeSession =
    opts.resumeId !== undefined ? (db.getSession(opts.resumeId) ?? undefined) : undefined;
  const storedProvider = resumeSession
    ? ((resumeSession.metadata as { provider?: string }).provider ?? resumeSession.provider)
    : undefined;
  if (opts.captureFixturePath !== undefined && opts.replayFixturePath !== undefined) {
    throw new Error('--capture-fixture and --replay-fixture are mutually exclusive');
  }
  const requestedProvider = opts.providerName ?? storedProvider;
  let routerAuditLogger: RouterAuditLogger | undefined;
  let routerHandle: RouterProvider | undefined;
  let resolved: ResolvedProvider;
  if (opts.replayFixturePath !== undefined) {
    resolved = buildReplayResolvedProvider(opts.replayFixturePath);
  } else if (requestedProvider === 'router') {
    resolved = buildRouterResolvedProvider(harnessHome, (logger, router) => {
      routerAuditLogger = logger;
      routerHandle = router;
    });
  } else {
    resolved = resolveProvider(requestedProvider, opts.model ?? resumeSession?.model);
  }
  // Phase 10.5 part 2 — capture-mode wrapping. Replace the resolved
  // transport with a CapturingProvider so every StreamEvent flowing
  // through the agent loop gets mirrored into the sink. Tools get
  // wrapped further down once the pool is assembled.
  let captureSink: CaptureSink | undefined;
  if (opts.captureFixturePath !== undefined) {
    captureSink = createCaptureSink({
      sessionId: 'pending', // updated once activeSessionId is known
      provider: String(resolved.metadata.provider),
      model: resolved.model,
    });
    const wrapped = new CapturingProvider(resolved.transport, captureSink);
    resolved = { ...resolved, transport: wrapped as unknown as Transport };
  }
  const providerName = String(resolved.metadata.provider);
  let activeModel = resolved.model;
  const provider = resolved.transport;
  if (opts.preflight !== false) {
    const preflight = await preflightProvider({ provider, providerName, model: activeModel });
    if (!preflight.ok) {
      transcript?.record({
        type: 'provider_error',
        stage: 'provider_preflight',
        providerName,
        model: activeModel,
        message: preflight.message,
      });
      await memoryManager.onSessionEnd('preflight-failed');
      await memoryManager.shutdown();
      db.close();
      throw new Error(preflight.message);
    }
  }
  const preliminaryToolContext: ToolContext = {
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    sessionId: opts.resumeId ?? 'pending',
    harnessHome,
    memoryManager,
    subdirectoryHintState,
    skills: loadedSkills,
    agents: loadedAgents,
    projectScope,
  };
  const preliminaryToolPool = assembleToolPool(preliminaryToolContext);
  const activeToolNames = preliminaryToolPool.map((tool) => tool.name);
  const activeToolsets = inferActiveToolsets(activeToolNames);
  const skills = filterSkillRegistry(loadedSkills, activeToolsets, activeToolNames);
  const commandRegistry = buildCommandRegistry([...COMMANDS, ...buildSkillCommands(skills)]);
  const finalPreliminaryToolContext: ToolContext = {
    ...preliminaryToolContext,
    skills,
    activeToolNames,
    activeToolsets,
  };
  let finalPreliminaryToolPool = assembleToolPool(finalPreliminaryToolContext);
  if (
    opts.preflight !== false &&
    providerName === 'ollama' &&
    finalPreliminaryToolPool.length > 0
  ) {
    const preflight = await preflightToolCalling({ provider, providerName, model: activeModel });
    if (!preflight.ok) {
      transcript?.record({
        type: 'provider_error',
        stage: 'tool_preflight',
        providerName,
        model: activeModel,
        message: preflight.message,
      });
      await memoryManager.onSessionEnd('preflight-failed');
      await memoryManager.shutdown();
      db.close();
      throw new Error(preflight.message);
    }
  }

  // Phase 13.5 — mission mode setup. When --state-dir is set, load the
  // mission directory contract files, gate on FSM terminal-state + overlap
  // lock, and resolve the agent definition. The system prompt picks up
  // the agent's prompt + mission segments below via openOrResumeSession.
  let missionFiles: MissionFiles | undefined;
  const wakeStartedAt = Date.now();
  if (opts.stateDir !== undefined) {
    if (opts.agentName === undefined) {
      await memoryManager.onSessionEnd('mission-config-error');
      await memoryManager.shutdown();
      db.close();
      throw new Error('--state-dir requires --agent');
    }
    missionFiles = loadMissionState(opts.stateDir);
    if (!shouldRun(missionFiles.state.fsmState)) {
      process.stdout.write(
        `[mission] state is "${missionFiles.state.fsmState}" (terminal) — nothing to do\n`,
      );
      await memoryManager.onSessionEnd('mission-terminal');
      await memoryManager.shutdown();
      db.close();
      return;
    }
    if (!acquireLock(opts.stateDir)) {
      process.stdout.write('[mission] another wake is already running (lock held) — skipping\n');
      await memoryManager.onSessionEnd('mission-locked');
      await memoryManager.shutdown();
      db.close();
      return;
    }
  }

  // Phase 13.5 — resolve agent definition when --agent is given.
  const agentDef =
    opts.agentName !== undefined ? loadedAgents.byName.get(opts.agentName) : undefined;
  if (opts.agentName !== undefined && agentDef === undefined) {
    if (opts.stateDir !== undefined) releaseLock(opts.stateDir);
    await memoryManager.onSessionEnd('agent-not-found');
    await memoryManager.shutdown();
    db.close();
    throw new Error(`agent "${opts.agentName}" not found`);
  }
  if (opts.stateDir !== undefined && agentDef !== undefined && !agentDef.supportsMissionState) {
    releaseLock(opts.stateDir);
    await memoryManager.onSessionEnd('agent-mission-unsupported');
    await memoryManager.shutdown();
    db.close();
    throw new Error(`agent "${opts.agentName}" does not declare supportsMissionState: true`);
  }

  try {
    // Phase 13.5 — restrict the preliminary tool pool to the agent's
    // allowedTools so the system-prompt's tool listing reflects the actual
    // pool the agent will see. The fully-assembled `toolPool` is restricted
    // again further down once canUseTool is built. Pre-canUseTool here we
    // only need the filtered tool list; a no-op canUseTool satisfies the
    // signature and is discarded.
    if (agentDef !== undefined && agentDef.allowedTools.length > 0) {
      const scoped = buildToolScope({
        allowedTools: agentDef.allowedTools,
        tools: finalPreliminaryToolPool,
        canUseTool: async () => ({ behavior: 'allow' }),
      });
      finalPreliminaryToolPool = scoped.tools;
    }

    const opened = openOrResumeSession(
      db,
      opts,
      bundle,
      resolved,
      finalPreliminaryToolPool,
      skills,
      projectScope,
      agentDef,
      missionFiles,
    );
    let activeSessionId = opened.sessionId;
    // Phase 10.6 — once the session id resolves, propagate it into the
    // RouterProvider so subsequent audit-log entries record the actual id.
    if (routerHandle) routerHandle.setSessionId(activeSessionId);
    const { systemPrompt, history, resumed } = opened;
    // Phase 10.5 — operational trace writer. One file per REPL invocation,
    // keyed on the initial session id. Failures route to stderr but never
    // block the session (Invariant #10). `/compact` and `/rollback` swap
    // activeSessionId but reuse this writer so the full operational stream
    // for one REPL run lives in one file.
    const traceWriter = new TraceWriter({
      sessionId: activeSessionId,
      harnessHome,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    traceWriter.record({
      type: 'session_start',
      sessionId: activeSessionId,
      provider: providerName,
      model: activeModel,
      cwd: process.cwd(),
      ...(bundle ? { bundlePath: bundle.root } : {}),
      iso: new Date().toISOString(),
    });
    const contextMeter = new ContextMeter({
      contextLength: resolved.contextLength,
      warnAtPercent: meterWarnAt,
      dangerAtPercent: meterDangerAt,
    });
    const metrics: Omit<SessionMetrics, 'endedAtMs'> = {
      sessionId: activeSessionId,
      startedAtMs: Date.now(),
      agentActiveMs: 0,
      apiTimeMs: 0,
      toolTimeMs: 0,
      toolCalls: 0,
      toolOk: 0,
      toolErr: 0,
    };
    const toolStartTimes = new Map<string, number>();
    transcript?.record({
      type: 'session_start',
      sessionId: activeSessionId,
      resumed,
      cwd: process.cwd(),
      bundlePath: opts.bundlePath ?? null,
      providerName,
      model: activeModel,
      permissionMode,
    });

    const toolContext: ToolContext = {
      cwd: process.cwd(),
      ...(bundle ? { bundleRoot: bundle.root } : {}),
      sessionId: activeSessionId,
      harnessHome,
      memoryManager,
      subdirectoryHintState,
      skills,
      agents: loadedAgents,
      activeToolNames,
      activeToolsets,
      projectScope,
    };
    // Phase 12: connect to configured MCP servers and wrap each discovered
    // tool. Connection failures log + continue (one bad server doesn't take
    // down the session). The pool is shut down at session end.
    const mcpPool: McpClientPool | undefined =
      Object.keys(mcpSettings.servers).length > 0
        ? await buildMcpClientPool({
            servers: mcpSettings.servers,
            log: (msg) => process.stdout.write(`${msg}\n`),
          })
        : undefined;
    const mcpTools: Tool<unknown, unknown>[] = mcpPool
      ? mcpPool.tools().map((meta) => wrapMcpTool(meta, mcpPool))
      : [];
    // HarnessInfo's snapshot reads live state at tool-call time. The tool
    // pool reference is captured *after* assembly via `finalToolPoolRef`
    // (it's circular: HarnessInfo is in the pool it reports on). Skipping
    // skill-derived commands intentionally — they're listed via /skills.
    let finalToolPoolRef: Tool<unknown, unknown>[] = [];
    const settingsPaths = getPermissionSettingsPaths({ cwd: process.cwd(), harnessHome });
    const presentSources = new Set(permissionSettings.sources);
    const harnessInfoSnapshot = (): HarnessInfoSnapshot => {
      const liveByServer = new Map<string, string[]>();
      for (const handle of mcpPool?.servers() ?? []) {
        liveByServer.set(
          handle.name,
          handle.tools.map((t) => t.toolName),
        );
      }
      return {
        permissionMode: permissionSettings.mode,
        settingsLayers: settingsPaths.map((p) => ({
          name: p.name,
          path: p.path,
          present: presentSources.has(p.path),
        })),
        mcpServers: Object.entries(mcpSettings.servers).map(([name, cfg]) => {
          const liveTools = liveByServer.get(name);
          const status: 'connected' | 'failed' | 'not-attempted' = mcpPool
            ? liveTools !== undefined
              ? 'connected'
              : 'failed'
            : 'not-attempted';
          return {
            name,
            command: cfg.command,
            args: cfg.args ?? [],
            status,
            toolCount: liveTools?.length ?? 0,
            tools: liveTools ?? [],
          };
        }),
        tools: {
          native: finalToolPoolRef.filter((t) => t.isMcp !== true).map((t) => t.name),
          mcp: finalToolPoolRef.filter((t) => t.isMcp === true).map((t) => t.name),
        },
        slashCommands: Array.from(new Set(commandRegistry.values())).map((c) => ({
          name: c.name,
          description: c.description,
        })),
        agents: loadedAgents.agents.map((a) => ({
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
          systemSegments: opened.systemPrompt,
          tools: finalToolPoolRef,
          skills: skills.skills,
          ...(bundle ? { bundle } : {}),
          ...(activeToolNames ? { activeToolNames } : {}),
        }),
      };
    };
    let toolPool = assembleToolPool(toolContext, { mcpTools, harnessInfoSnapshot });
    // Phase 10.5 part 2 — wrap the assembled pool when in capture or
    // replay mode. The wrappers preserve every other property of the
    // tool (schema, permissions, render hooks) and only override
    // `call()`. Permission gates, hooks, and orchestrator partitioning
    // run on the wrapped tool just like the live one.
    if (captureSink !== undefined) {
      toolPool = wrapToolsForCapture(toolPool, captureSink);
    }
    if (opts.replayFixturePath !== undefined) {
      const fixture = loadReplayFixture(opts.replayFixturePath);
      toolPool = wrapToolsForReplay(toolPool, fixture);
    }
    finalToolPoolRef = toolPool;

    // Two input paths share the same `question(prompt) => Promise<string>`
    // shape:
    //   - legacy: readline + bracketed-paste transform + queuedQuestion
    //     (Phase 3.5 baseline; the proven path for piped stdin and CI).
    //   - inputEditor: Wave-4 raw-mode editor with multi-line, history,
    //     autocomplete (TTY-only path).
    // Selection: --legacy-input flag forces legacy; otherwise inputEditor
    // when stdin is a TTY, legacy when stdin is piped (so CI / scripted
    // sessions keep working without the editor's terminal assumptions).
    const useEditor = opts.legacyInput !== true && process.stdin.isTTY === true;
    const bpEnabled = !useEditor && process.stdin.isTTY === true;
    const bpTransform = bpEnabled ? new BracketedPasteTransform(process.stdin) : null;
    if (bpTransform) {
      process.stdin.pipe(bpTransform);
      enableBracketedPaste(process.stdout);
    }
    const rl = createInterface({
      input: (bpTransform ?? process.stdin) as NodeJS.ReadStream,
      output: process.stdout,
      terminal: !useEditor,
    });
    const legacyQuestion = createQueuedQuestion(rl);
    const editor = useEditor
      ? new InputEditor({
          keypress: getKeypressDispatcher(),
          history: (() => {
            const h = new InputHistory({ path: join(harnessHome, 'input-history') });
            h.load();
            return h;
          })(),
          commandNames: () =>
            commandRegistry ? Array.from(new Set(commandRegistry.values())).map((c) => c.name) : [],
          cwd: () => process.cwd(),
        })
      : null;
    const question: typeof legacyQuestion = editor
      ? Object.assign(
          async (prompt: string, options?: { signal?: AbortSignal }) => {
            return editor.ask(prompt, options ?? {});
          },
          { pending: () => 0 },
        )
      : legacyQuestion;

    let streamController: AbortController | null = null;
    let closed = false;

    rl.on('close', () => {
      // Don't set `closed = true` here — under piped stdin the close
      // event fires after the lines have been buffered into the queue
      // but before the REPL has dispatched them. The `while` loop now
      // checks `question.pending()` so any queued lines drain before
      // the loop exits via the question() throw / null catch path.
    });

    rl.on('SIGINT', () => {
      if (streamController) {
        streamController.abort();
        return;
      }
      rl.close();
    });

    const alwaysAllow = new Set<string>();
    const ask = buildReadlineAsker(question, {
      onPrompt: (event) =>
        transcript?.record({
          type: 'permission_prompt',
          sessionId: activeSessionId,
          ...event,
        }),
      onAnswer: (event) =>
        transcript?.record({
          type: 'permission_answer',
          sessionId: activeSessionId,
          ...event,
        }),
    });
    const baseCanUseTool = buildCanUseTool({
      mode: permissionMode,
      ask,
      alwaysAllow,
      ruleLayers: permissionSettings.layers,
      recordAlwaysAllow: (rule) =>
        appendProjectLocalPermissionRule({ cwd: process.cwd(), rule, behavior: 'allow' }),
    });
    // Defense-in-depth: redact well-known secret patterns from Write/Edit/
    // NotebookEdit inputs before the orchestrator dispatches the tool.
    // Catches the failure class where an agent reads a secret while
    // exploring and then accidentally reproduces it verbatim into a
    // generated artifact (e.g. a security audit report). Set
    // HARNESS_REDACTION=off to disable globally.
    let canUseTool = wrapCanUseToolWithTransformers(baseCanUseTool, [redactSecretsTransformer]);

    // Phase 13.5 — restrict the assembled tool pool to the agent's allowed
    // tools (when --agent is set). Mirrors the prompt-command tool-scope
    // pattern: rules filter the visible pool AND wrap canUseTool so any
    // out-of-scope dispatch is denied at the permission gate. The earlier
    // preliminary-pool restriction shaped the system-prompt tool listing;
    // this restriction governs runtime dispatch.
    if (agentDef !== undefined && agentDef.allowedTools.length > 0) {
      const scoped = buildToolScope({
        allowedTools: agentDef.allowedTools,
        tools: toolPool,
        canUseTool,
      });
      toolPool = scoped.tools;
      canUseTool = scoped.canUseTool;
      finalToolPoolRef = toolPool;
    }

    // Phase 13.5 — wire the sub-agent scheduler. AgentTool reads
    // ctx.subagentScheduler at call time; the scheduler owns concurrency,
    // lineage, and cancellation. Mutating toolContext (rather than
    // rebuilding) is safe here because no consumer has captured the field
    // set yet (the first query() call comes later).
    let taskManager: TaskManager | undefined;
    let reviewManager: ReviewManager | undefined;
    // Phase 13.3 (B4) — session-scoped controller for in-flight review forks.
    // Aborted in the session-end path so reviews don't survive past /quit.
    let reviewAbortController: AbortController | undefined;
    // Phase 13.4 — internal observation writer. Mounts on the tool context so
    // the orchestrator can call ctx.learningObserver?.observe(...) after each
    // tool call. Drained at session-end before trajectory write so this
    // session's observations land on disk first. Defaults: bufferSize=200,
    // enabled=true. settings.learning.* overrides applied here.
    const learningObserver = new LearningObserver({
      harnessHome,
      cwd: process.cwd(),
      sessionId: activeSessionId,
      bufferSize: userSettings.learning?.observationBufferSize ?? 200,
      enabled: !(userSettings.learning?.disabled === true),
    });
    type WritableToolContext = { -readonly [K in keyof ToolContext]: ToolContext[K] };
    (toolContext as WritableToolContext).learningObserver = learningObserver;
    if (loadedAgents.agents.length > 0) {
      const laneSemaphores = new LaneSemaphores({
        ...(userSettings.router?.maxConcurrentLocal !== undefined
          ? { local: userSettings.router.maxConcurrentLocal }
          : {}),
        ...(userSettings.router?.maxConcurrentFrontier !== undefined
          ? { frontier: userSettings.router.maxConcurrentFrontier }
          : {}),
      });
      // Phase 13.5 — `availableProviders` controls capability-profile
      // resolution for `role: <kind>` agent definitions. Without this, the
      // scheduler defaults to all four registered providers and the
      // cheapest match (typically an ollama model — costTier 0) wins even
      // when the user has no ollama running. The right v0 default is to
      // mirror what the parent session actually has wired up: in single-
      // provider mode that's just `providerName`; in router mode it's both
      // configured lanes from the resolved metadata.
      const meta = resolved.metadata as {
        localProvider?: string;
        frontierProvider?: string;
      };
      const agentAvailableProviders =
        providerName === 'router' && meta.localProvider && meta.frontierProvider
          ? ([meta.localProvider, meta.frontierProvider] as const)
          : ([providerName] as const);
      // Default provider/model when an agent declares neither `model` nor
      // `role` (or `role` doesn't match anything in the available
      // capability-profile rows). In router mode `providerName === 'router'`
      // isn't a real provider entry, so fall back to the frontier lane —
      // it's the more capable lane and what the user already configured.
      const subagentDefaultProvider =
        providerName === 'router' && meta.frontierProvider ? meta.frontierProvider : providerName;
      const subagentDefaultModel =
        providerName === 'router'
          ? // Parent's `activeModel` is the synthetic combined string
            // `"<localModel> | <frontierModel>"`; the frontier model is
            // the part after " | " (per buildRouterResolvedProvider line
            // ~256: `${localResolved.model} | ${frontierResolved.model}`).
            (activeModel.split(' | ')[1]?.trim() ?? activeModel)
          : activeModel;
      const subagentWriteLock = new Semaphore(1);
      // Phase 13.1 — child trajectory capture. Same artifactsRoot the
      // REPL uses for its own (parent) trajectory write at session end:
      // <bundle>/state/artifacts when a client bundle is loaded, else
      // <harnessHome>. Write semantics + bucket split are uniform across
      // parent and child sessions.
      // Phase 13.3 (B2) — stock default bundle is system content; route its
      // trajectories to <harnessHome>/ so sov upgrade doesn't wipe them and
      // each profile gets its own state. Client bundles still own their state.
      const subagentArtifactsRoot =
        bundle && !isDefaultBundlePath(bundle.root)
          ? join(bundle.root, 'state', 'artifacts')
          : harnessHome;
      const subagentScheduler = new SubagentScheduler({
        agents: loadedAgents,
        laneSemaphores,
        writeLock: subagentWriteLock,
        resolveProvider: (name, model) => resolveProvider(name, model),
        createChildSession: (input) =>
          db.createSession({
            provider: input.provider,
            model: input.model,
            parentSessionId: input.parentSessionId,
            title: `subagent:${input.agentName}`,
            systemPrompt: input.systemPrompt,
            metadata: { agentName: input.agentName, kind: 'subagent' },
          }),
        availableProviders: agentAvailableProviders,
        defaultProvider: subagentDefaultProvider,
        defaultModel: subagentDefaultModel,
        maxTokens: opts.maxTokens,
        artifactsRoot: subagentArtifactsRoot,
        // Backlog Item 8 — also write a per-child trace file at
        // <harnessHome>/traces/<childSessionId>.jsonl so `sov trace show
        // <childId>` has a fast path that doesn't filter the parent
        // timeline. Parent recorder still receives every tagged event.
        harnessHome,
      });
      type WritableToolContext = { -readonly [K in keyof ToolContext]: ToolContext[K] };
      const writableCtx = toolContext as WritableToolContext;
      writableCtx.subagentScheduler = subagentScheduler;
      writableCtx.parentToolPool = toolPool;
      writableCtx.canUseTool = canUseTool;
      writableCtx.traceRecorder = (e) => traceWriter.record(e);
      // Phase 13.2 — task manager. Wraps the SubagentScheduler with
      // lifecycle persistence so the model can dispatch background work
      // via task_create and observe it via task_list / task_get /
      // task_output. Gated on loadedAgents.agents.length > 0 (same
      // guard as the scheduler) — task delegation only makes sense when
      // there are actually agents to delegate to.
      const taskStore = new TaskStore(db);
      taskManager = new TaskManager({
        store: taskStore,
        scheduler: subagentScheduler,
      });
      writableCtx.taskManager = taskManager;
      // Phase 13.3 T11 — auto-promote opt-ins from settings.review.
      if (userSettings.review?.autoPromoteMemory === true) {
        writableCtx.reviewAutoPromoteMemory = true;
      }
      if (userSettings.review?.autoPromoteSkills === true) {
        writableCtx.reviewAutoPromoteSkills = true;
      }
      // Phase 13.3 — review manager. Wired once the scheduler is live so
      // dispatch can delegate review forks through the same infrastructure.
      // pathsResolver is lazy so it captures the runtime-computed paths
      // (trajectory goes to samples.jsonl within the artifacts root;
      // trace path is the same writer used by the session). Both are
      // informational; empty-string fallbacks are safe.
      // Phase 13.3 (B2) — stock default bundle is system content; route its
      // trajectories to <harnessHome>/ so sov upgrade doesn't wipe them.
      const artifactsRootForReview =
        bundle && !isDefaultBundlePath(bundle.root)
          ? join(bundle.root, 'state', 'artifacts')
          : harnessHome;
      reviewAbortController = new AbortController();
      reviewManager = new ReviewManager({
        scheduler: subagentScheduler,
        sessionId: activeSessionId,
        signal: reviewAbortController.signal,
        thresholds: {
          ...(userSettings.review?.userTurnsForMemoryReview !== undefined
            ? { userTurnsForMemoryReview: userSettings.review.userTurnsForMemoryReview }
            : {}),
          ...(userSettings.review?.toolIterationsForSkillReview !== undefined
            ? { toolIterationsForSkillReview: userSettings.review.toolIterationsForSkillReview }
            : {}),
          ...(userSettings.review?.childReviewEveryN !== undefined
            ? { childReviewEveryN: userSettings.review.childReviewEveryN }
            : {}),
          ...(userSettings.review?.minIntervalMs !== undefined
            ? { minIntervalMs: userSettings.review.minIntervalMs }
            : {}),
          ...(userSettings.learning?.synthesizerEveryN !== undefined
            ? { synthesizerEveryN: userSettings.learning.synthesizerEveryN }
            : {}),
          ...(userSettings.learning?.synthesizerEveryNToolIterations !== undefined
            ? {
                synthesizerEveryNToolIterations:
                  userSettings.learning.synthesizerEveryNToolIterations,
              }
            : {}),
        },
        pathsResolver: () => {
          const project = getProjectId(process.cwd());
          return {
            trajectoryPath: join(artifactsRootForReview, 'trajectories', 'samples.jsonl'),
            tracePath: traceWriter.path,
            instinctsDir: instinctsDir(harnessHome, project.id),
          };
        },
        parentToolPool: toolPool,
        parentToolContext: writableCtx as ToolContext,
        enabled: !(userSettings.review?.disabled === true),
        projectIdentity: () => getProjectId(process.cwd()),
        harnessHome,
      });
      writableCtx.reviewManager = reviewManager;
    }
    // Phase 10.6 part 2b — install the interactive escalation asker on
    // the router (only meaningful when --provider router and the
    // configured `escalationMode` is 'ask'). The asker is built around
    // the same `question` source used by the permission prompt; we
    // present the user with a yes/no, route to frontier on yes, stay on
    // default lane on no. Without a TTY the question source still works
    // (returns empty string) and we treat that as "no" — matches the
    // ask-falls-through-to-never posture for piped sessions.
    if (routerHandle) {
      routerHandle.setEscalationAsker(async (promptText: string) => {
        const answer = await question(`${promptText} [y/N] `);
        const trimmed = answer.trim().toLowerCase();
        return trimmed === 'y' || trimmed === 'yes';
      });
    }
    // Hook subsystem (Phase 11). Built once per session; the consent allowlist
    // is read lazily on first prompt and cached for the session lifetime. When
    // no hooks are configured, we still build the runner — its first call cost
    // is one map lookup, and the alternative (conditional plumbing) costs more
    // than it saves.
    const hookConsentStore = buildFileConsentStore(join(harnessHome, 'shell-hooks-allowlist.json'));
    const hookConsent = buildConsentChecker({ store: hookConsentStore, ask });
    const hookRunner = buildHookRunner({
      hooksByEvent: hookSettings.hooksByEvent,
      consent: hookConsent,
      home: process.env.HOME,
      logStderr: (msg) => process.stderr.write(`${msg}\n`),
    });
    // Tool slot lives at session scope (not per-turn) so /expand can
    // surface tool blocks from earlier turns. The retention ring buffer
    // (default 50) bounds memory; older blocks drop off as new ones
    // complete. inlineLines comes from ui.toolOutput.inlineLines (default
    // 10) and gates how much of each block lands inline at render time;
    // /expand is the escape hatch for the truncated surplus.
    const inlineLines = userSettings.ui?.toolOutput?.inlineLines ?? 10;
    const toolSlot = new CompactToolSlot(process.stdout, { inlineLines });
    const commandContext = (): CommandContext => ({
      sessionId: activeSessionId,
      cwd: process.cwd(),
      providerName,
      model: activeModel,
      bundlePath: opts.bundlePath ?? null,
      setModel: (model) => {
        activeModel = model;
        // Persist so /model picks survive --resume.
        db.updateSessionModel(activeSessionId, model);
      },
      clearHistory: clearNow,
      getCost: () => db.getSessionCost(activeSessionId),
      compact: compactNow,
      rollback: rollbackNow,
      tools: toolPool,
      registry: commandRegistry,
      listSessions: (limit) => db.listSessions(limit),
      cleanupPhantomReviews: () => db.cleanupPhantomReviews(),
      getMetrics: () => ({ ...metrics, sessionId: activeSessionId }),
      skills,
      ...(taskManager !== undefined ? { taskManager } : {}),
      ...(reviewManager !== undefined ? { reviewManager } : {}),
      harnessHome,
      getLastAssistantText: () => extractLastAssistantText(history),
      getMessages: () => [...history],
      getPermissions: () => ({
        mode: permissionMode,
        alwaysAllow: [...alwaysAllow],
        layers: permissionSettings.layers,
      }),
      requestExit: () => {
        closed = true;
        rl.close();
      },
      getBudgetReport: () =>
        harnessInfoSnapshot().budget ?? { components: [], totals: { estimated: 0 } },
      expandToolBlock: (n) => {
        // The /expand command writes the re-rendered block straight to
        // stdout via the slot's expand path; we return ok/total so the
        // command can produce a helpful error when the index is out of
        // range without duplicating the slot's bookkeeping here.
        const ok = toolSlot.expand(n);
        return { ok, total: toolSlot.completedCount() };
      },
      // Backlog item 24 — only expose resumeCheckin when a turn is paused
      // at the tool-call checkin limit. /continue checks this and returns
      // "no pending checkin" when undefined. Spread-conditional keeps the
      // key absent (vs. undefined) so exactOptionalPropertyTypes is happy.
      ...(checkinPending
        ? {
            resumeCheckin: async () => {
              checkinPending = false;
              reviewManager?.onUserTurn(activeSessionId);
              await runModelTurn([], undefined, { isContinuation: true });
            },
          }
        : {}),
    });

    writeBanner(
      opts,
      permissionMode,
      permissionSettings.sources,
      resolved,
      bundle?.state.context != null,
      toolPool.map((t) => t.name),
      activeSessionId,
      resumed,
      countLayerAllowRules(permissionSettings.layers),
    );

    // Phase 13.1 — track the most recent Terminal across all turns so the
    // session-close trajectory writer knows whether the session ended
    // cleanly. Empty sessions (user opens sov and quits without prompting)
    // leave this undefined; the writer treats `undefined` as "completed."
    let lastTerminal: Terminal | undefined;

    // Backlog item 24 — set true when query() returns terminal.reason ===
    // 'checkin'. The next turn's commandContext exposes a resumeCheckin
    // closure (which /continue invokes) so the model resumes its work
    // without the user having to type a continuation message.
    let checkinPending = false;

    // Phase 13.5 — scheduled-mission auto-wake. When --state-dir is set,
    // we run a single bounded wake (no interactive prompt) instead of the
    // normal readline loop. The model receives a "continue your mission"
    // instruction; we parse the MISSION_TRANSITION sentinel and the
    // <mission-notes-update> block from its last assistant text, persist
    // the new FSM state + notes, append a wake-log entry, release the
    // lock, and return so the session shuts down cleanly through the
    // teardown path below.
    if (opts.stateDir !== undefined && missionFiles !== undefined) {
      const wakeNumber = missionFiles.state.wakeCount + 1;
      const wakeMessage = `Wake #${wakeNumber}: please continue working on your mission. Read your mission goal, plan, and notes from the system prompt, then do one bounded piece of work.`;
      process.stdout.write(
        `[mission] starting wake #${wakeNumber} (${missionFiles.state.fsmState})\n`,
      );
      try {
        await runModelTurn([{ type: 'text', text: wakeMessage }]);
        const lastMsg = history.at(-1);
        const lastAssistantText =
          lastMsg?.role === 'assistant'
            ? lastMsg.content
                .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
            : '';
        const sentinelMatch = lastAssistantText.match(/MISSION_TRANSITION=(\w+)/);
        const sentinelValue = sentinelMatch?.[1];
        const notesMatch = lastAssistantText.match(
          /<mission-notes-update>([\s\S]*?)<\/mission-notes-update>/,
        );
        if (notesMatch?.[1] !== undefined) {
          writeFileSync(notesMdPath(opts.stateDir), notesMatch[1].trim(), 'utf8');
        }
        const stateBefore = missionFiles.state.fsmState;
        const stateAfter = applyTransition(stateBefore, sentinelValue);
        writeMissionState(opts.stateDir, {
          fsmState: stateAfter,
          wakeCount: wakeNumber,
          updatedAt: new Date().toISOString(),
        });
        appendWakeLog(opts.stateDir, {
          wakeNumber,
          timestamp: new Date().toISOString(),
          fsmStateBefore: stateBefore,
          fsmStateAfter: stateAfter,
          ...(sentinelValue !== undefined ? { sentinel: sentinelValue } : {}),
          durationMs: Date.now() - wakeStartedAt,
        });
        process.stdout.write(`[mission] wake #${wakeNumber} complete — state: ${stateAfter}\n`);
      } finally {
        releaseLock(opts.stateDir);
      }
      closed = true;
    }

    while (!closed || question.pending() > 0) {
      if (footerEnabled) {
        const cost = db.getSessionCost(activeSessionId);
        const totalCost = cost.estimatedCostUsd + cost.estimatedCompactionCostUsd;
        const bundleLabel = opts.bundlePath ? deriveBundleLabel(opts.bundlePath) : null;
        const footerInfo: FooterInfo = {
          providerName,
          model: activeModel,
          bundleLabel,
          permissionMode,
          toolCount: toolPool.length,
          costUsd: totalCost,
          meter: contextMeter,
        };
        printPrePromptFooter(process.stdout, footerInfo, { enabled: true });
      }
      // The Wave-4 editor renders its own multi-line prompt area, so we
      // skip the rule-frame when it's active. Legacy path keeps the
      // top/bottom rules as before so piped-stdin transcripts still
      // read sensibly.
      const frame = useEditor ? null : openPromptFrame();
      const raw = await question(chalk.cyan('> ')).catch(() => null);
      frame?.close();
      if (raw === null) break;
      const input = bpEnabled ? restoreEmbeddedNewlines(raw) : raw;
      transcript?.record({ type: 'user_input', sessionId: activeSessionId, text: input });
      const trimmed = input.trim();
      if (trimmed === '') continue;

      // Inline shell: `! <cmd>` runs the rest of the line in bash with the
      // harness's TTY inherited. The escape hatch for sudo / TouchID / pagers
      // / interactive prompts that BashTool can't service. By design the
      // command's output is not captured into the conversation — it's a
      // user-side affordance, not a tool call.
      if (isInlineShellInput(trimmed)) {
        const result = await runInlineShell(trimmed, { cwd: process.cwd() });
        if (result.empty) {
          process.stdout.write(chalk.gray('usage: ! <command>\n'));
        } else {
          process.stdout.write(chalk.gray(`[exit ${result.exitCode}]\n`));
        }
        transcript?.record({
          type: 'inline_shell',
          sessionId: activeSessionId,
          command: trimmed,
          exitCode: result.exitCode,
          empty: result.empty,
        });
        continue;
      }

      if (trimmed.startsWith('/')) {
        const result = await dispatchSlashCommand(trimmed, commandContext());
        if (result.kind === 'local' || result.kind === 'unknown') {
          transcript?.record({
            type: 'slash_command',
            sessionId: activeSessionId,
            command: trimmed,
            kind: result.kind,
            output: result.output,
          });
          process.stdout.write('\n');
          if (result.output) process.stdout.write(`${result.output}\n`);
          continue;
        }
        transcript?.record({
          type: 'slash_command',
          sessionId: activeSessionId,
          command: trimmed,
          kind: result.kind,
          promptCommand: result.command.name,
        });
        reviewManager?.onUserTurn(activeSessionId);
        await runModelTurn(result.content, result.command);
        continue;
      }

      const enrichedInput = await expandContextReferences(trimmed, { cwd: process.cwd() });
      // Phase 13.3 — fire once per user prompt, before the model turn.
      reviewManager?.onUserTurn(activeSessionId);
      await runModelTurn([{ type: 'text', text: enrichedInput }]);
    }

    async function runModelTurn(
      userContent: Message['content'],
      command?: PromptCommand,
      retry: {
        skipUserSave?: boolean;
        retriedAfterCompact?: boolean;
        isContinuation?: boolean;
      } = {},
    ): Promise<void> {
      if (retry.skipUserSave !== true && retry.isContinuation !== true) {
        const userMessage: Message = { role: 'user', content: userContent };
        history.push(userMessage);
        db.saveMessage(activeSessionId, {
          role: 'user',
          content: userMessage.content,
          tokenCount: estimateMessageTokens(userMessage),
        });
      }

      // Pre-compaction warning. Threshold is the configured proactive
      // threshold (or the meter's danger threshold if proactive is unset)
      // — fires once when the meter crosses 5% below it, so the user sees
      // a heads-up before compaction kicks in on the next turn rather
      // than after-the-fact when history has already been rewritten.
      {
        const thresholdPct =
          proactiveThreshold !== undefined
            ? proactiveThreshold * 100
            : contextMeter.getThresholds().danger;
        if (contextMeter.shouldWarnApproachingCompaction(thresholdPct)) {
          writeStatusLine(
            chalk.yellow(
              `[compact] approaching threshold (ctx ${contextMeter.getPercent()}% / trigger ${Math.round(thresholdPct)}%) — compaction may fire on the next turn`,
            ),
            'err',
          );
        }
      }
      if (
        shouldCompactProactively({
          messages: history,
          systemPrompt,
          contextLength: resolved.contextLength,
          ...(proactiveThreshold !== undefined ? { threshold: proactiveThreshold } : {}),
        })
      ) {
        writeStatusLine(chalk.yellow('[compact] context threshold exceeded; compacting'), 'err');
        const result = await compactNow();
        process.stderr.write(
          chalk.yellow(
            `[compact] ${result.parentSessionId} -> ${result.newSessionId}; estimated tokens ${result.estimatedBeforeTokens} -> ${result.estimatedAfterTokens}\n`,
          ),
        );
        contextMeter.reset();
      }

      process.stdout.write('\n');

      streamController = new AbortController();
      const mdStream = new MarkdownStream(process.stdout);
      const indicator = new ThinkingIndicator(process.stdout);
      // toolSlot is hoisted to session scope (defined above the
      // commandContext factory) so /expand can reach tool blocks from
      // earlier turns. The slot's retention ring buffer holds them.
      /** tool_use_id → tool name. Populated when a tool_use block fires;
       *  consumed (and removed) when the matching tool_result block fires
       *  so the slot can pass the tool name to summarizeToolResult for a
       *  per-tool footer (e.g. "read 250 lines", "found 47 files"). */
      const toolUseNames = new Map<string, string>();
      // (interToolLines bookkeeping removed when CompactToolSlot moved
      // to deferred rendering — the slot no longer needs to ANSI-up past
      // text the agent emitted between tools because each tool block
      // now writes its own complete chunk on end(), no overwrite. Text
      // between tools naturally stays in scrollback.)
      // Tracks whether we're currently in a continuous text-streaming
      // run. Used to prepend a single blank line before the first
      // text_delta of each agent response so the answer always has
      // breathing room above it. Reset when any non-text event fires.
      let textRunActive = false;
      indicator.start();
      const turnStartedAt = Date.now();
      const turnToolTimeBaseline = metrics.toolTimeMs;
      let latestAssistant: AssistantMessage | undefined;
      let terminal: Terminal | undefined;
      let latestUsage: TokenUsage | undefined;
      const turnMessages: Message[] = [];
      const mutatingToolUses = new Map<string, { name: string; paths: string[] }>();
      const completedMutationPaths = new Set<string>();
      // Captured at tool_use time, consumed at tool_result time. Lets the
      // diff renderer fire after a successful FileEdit / FileWrite so the
      // user sees the change inline. For FileEdit we also snapshot the
      // pre-edit file contents (synchronously, before the orchestrator
      // dispatches the tool) so the renderer can show full-line context
      // around old_string instead of just the substring. Errors skip the
      // diff path.
      const diffInputsByToolUseId = new Map<
        string,
        { name: string; input: unknown; preContent?: string }
      >();
      let toolsForTurn = toolPool;

      try {
        const scoped = command ? scopedToolsForCommand(command) : undefined;
        toolsForTurn = scoped?.tools ?? toolPool;
        const gen = query({
          provider,
          model: activeModel,
          messages: history,
          systemPrompt,
          ...((scoped?.tools ?? toolPool).length > 0
            ? {
                tools: scoped?.tools ?? toolPool,
                toolContext,
                canUseTool: scoped?.canUseTool ?? canUseTool,
              }
            : {}),
          maxTokens: opts.maxTokens,
          ...(userSettings.maxTurns !== undefined ? { maxTurns: userSettings.maxTurns } : {}),
          ...(userSettings.behavior?.maxToolCallsBeforeCheckin !== undefined
            ? { maxToolCallsBeforeCheckin: userSettings.behavior.maxToolCallsBeforeCheckin }
            : {}),
          microcompactConfig: buildMicrocompactConfig(userSettings.microcompaction),
          signal: streamController.signal,
          cacheEnabled: opts.noCache !== true,
          memoryManager,
          hookRunner,
          sessionId: activeSessionId,
          cwd: process.cwd(),
          traceRecorder: (e) => traceWriter.record(e),
        });

        for (;;) {
          const step = await gen.next();
          indicator.stop();
          if (step.done) {
            terminal = step.value;
            lastTerminal = terminal;
            break;
          }
          const ev = step.value;
          if (!ev || typeof ev !== 'object') {
            indicator.start();
            continue;
          }

          // Message branch — ev is a tool_result carrier yielded between turns.
          if ('role' in ev) {
            if (ev.role === 'user') {
              for (const block of ev.content) {
                if (block.type !== 'tool_result') continue;
                const startedAt = toolStartTimes.get(block.tool_use_id);
                const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
                if (startedAt !== undefined) {
                  metrics.toolTimeMs += durationMs ?? 0;
                  toolStartTimes.delete(block.tool_use_id);
                }
                transcript?.record({
                  type: 'tool_result',
                  sessionId: activeSessionId,
                  toolUseId: block.tool_use_id,
                  isError: block.is_error === true,
                  content: block.content,
                  ...(durationMs !== undefined ? { durationMs } : {}),
                });
                if (verbose) {
                  renderToolResultPreview(block.content, block.is_error === true, true);
                } else {
                  toolUseNames.delete(block.tool_use_id);
                  // Spinner reverts to "Thinking …" once all running
                  // tools complete (Gap 1).
                  indicator.removeRunningTool(block.tool_use_id);
                  toolSlot.end(block.tool_use_id, block.content, block.is_error === true);
                }
                if (block.is_error === true) {
                  metrics.toolErr++;
                  diffInputsByToolUseId.delete(block.tool_use_id);
                  continue;
                }
                // Successful diff-shaped tool: emit the inline diff block
                // below the slot summary so the user sees what changed.
                const diffEntry = diffInputsByToolUseId.get(block.tool_use_id);
                if (diffEntry) {
                  diffInputsByToolUseId.delete(block.tool_use_id);
                  const diffOut = renderToolDiff(diffEntry.name, diffEntry.input, {
                    verbose,
                    ...(diffEntry.preContent !== undefined
                      ? { preContent: diffEntry.preContent }
                      : {}),
                  });
                  if (diffOut) {
                    // toolSlot.commit() so the diff lands as fresh
                    // scrollback below the slot rather than overwriting it.
                    toolSlot.commit();
                    process.stdout.write(diffOut);
                  }
                }
                metrics.toolOk++;
                const mutation = mutatingToolUses.get(block.tool_use_id);
                if (!mutation) continue;
                for (const path of mutation.paths) completedMutationPaths.add(path);
              }
              turnMessages.push(ev);
              db.saveMessage(activeSessionId, {
                role: 'user',
                content: ev.content,
                tokenCount: estimateMessageTokens(ev),
              });
              const errs = ev.content.filter(
                (b) => b.type === 'tool_result' && b.is_error === true,
              ).length;
              if (errs > 0) {
                toolSlot.commit();
                writeStatusLine(chalk.gray(`[${errs} tool error${errs === 1 ? '' : 's'}]`));
              }
            }
            indicator.start();
            continue;
          }

          // StreamEvent branch.
          if (!('type' in ev)) continue;
          if (ev.type === 'text_delta') {
            if (!textRunActive) {
              process.stdout.write('\n');
              textRunActive = true;
            }
            mdStream.write(ev.text);
            indicator.noteStreamedChars(ev.text.length);
            indicator.start();
            continue;
          }
          if (ev.type === 'assistant_message') {
            latestAssistant = ev.message;
            turnMessages.push(ev.message);
            db.saveMessage(activeSessionId, {
              role: 'assistant',
              content: ev.message.content,
              tokenCount: estimateMessageTokens(ev.message),
            });
            transcript?.record({
              type: 'assistant_message',
              sessionId: activeSessionId,
              content: snapshotContentForTranscript(ev.message.content),
            });
            if (!verbose) {
              // Flush any partial markdown line still in mdStream's
              // buffer so it renders before the next tool block / final
              // answer. The deferred toolSlot doesn't need any line-
              // counting bookkeeping — each tool block writes its own
              // complete chunk on end().
              mdStream.flush();
              toolSlot.commit();
            }
            for (const block of ev.message.content) {
              if (block.type === 'tool_use') {
                metrics.toolCalls++;
                toolStartTimes.set(block.id, Date.now());
                const mutation = mutationEffect(block, toolsForTurn, toolContext.cwd);
                if (mutation) mutatingToolUses.set(block.id, mutation);
                if (diffRenderEnabled && isDiffShapedTool(block.name)) {
                  const preContent = readPreEditContent(block.name, block.input, toolContext.cwd);
                  diffInputsByToolUseId.set(block.id, {
                    name: block.name,
                    input: block.input,
                    ...(preContent !== undefined ? { preContent } : {}),
                  });
                }
                const tool = toolPool.find((t) => t.name === block.name);
                const preview = formatToolInputForDisplay(tool, block.input);
                toolUseNames.set(block.id, block.name);
                if (verbose) {
                  writeStatusLine(
                    chalk.gray(`[tool: ${block.name}${preview ? ` ${preview}` : ''}]`),
                  );
                } else {
                  toolSlot.begin(block.id, block.name, preview);
                  // Tell the spinner what's running so the user sees
                  // "Running Bash(find /) · 12s" instead of an opaque
                  // "Thinking 12s" during the deferred-render window
                  // (Gap 1).
                  indicator.addRunningTool(block.id, block.name, preview);
                }
                textRunActive = false;
                transcript?.record({
                  type: 'tool_call',
                  sessionId: activeSessionId,
                  toolUseId: block.id,
                  name: block.name,
                  input: block.input,
                });
              }
            }
          }
          if (ev.type === 'message_stop') {
            transcript?.record({
              type: 'message_stop',
              sessionId: activeSessionId,
              stopReason: ev.stop_reason,
            });
          }
          if (ev.type === 'usage_delta') {
            latestUsage = ev.usage;
            indicator.setUsage(ev.usage.inputTokens, ev.usage.outputTokens);
            contextMeter.update(ev.usage);
          }
          if (ev.type === 'microcompact') {
            // Microcompact is internal optimization — the orchestrator
            // clears stale tool_result content to keep context bounded.
            // Inlining a status line per fire used to spam the screen on
            // long sessions ("Cleared 2 stale tool results, ~80 tokens"
            // repeated dozens of times — see the harness.png screenshot
            // comparison vs. Claude Code). The trace stream still records
            // every microcompact event for `sov trace show`, so forensic
            // detail is preserved; the visible REPL just stays quiet.
            // Verbose mode is for full *tool result* rendering, not for
            // operational status events — it stays quiet too.
          }
          if (ev.type === 'route_decision') {
            // Phase 10.6 part 2 — surface the lane the router picked so the
            // user is never surprised that data left the box. The audit log
            // at <harness-home>/router/audit.jsonl has the full record;
            // this is the just-in-time UX signal.
            toolSlot.commit();
            const arrow = ev.info.lane === 'frontier' ? '↗' : '·';
            writeStatusLine(
              chalk.gray(
                `[router ${arrow} ${ev.info.lane} (${ev.info.delegatedProvider}/${ev.info.delegatedModel}) — ${ev.info.reason}]`,
              ),
            );
            textRunActive = false;
          }
          // message_start, thinking_delta, tool_use_delta, message_stop: silent.
          indicator.start();
        }
      } finally {
        streamController = null;
        indicator.stop();
        toolSlot.commit();
        mdStream.flush();
        const turnElapsed = Date.now() - turnStartedAt;
        const turnToolTime = metrics.toolTimeMs - turnToolTimeBaseline;
        metrics.agentActiveMs += turnElapsed;
        metrics.apiTimeMs += Math.max(0, turnElapsed - turnToolTime);
      }

      process.stdout.write('\n');
      if (latestUsage) {
        const cost = estimateCostUsd(providerName, activeModel, latestUsage);
        db.recordTokenUsage(activeSessionId, latestUsage, cost);
        const debugOn =
          userSettings.debugMode?.enabled === true || userSettings.debugMode?.transcript === true;
        if (debugOn) {
          process.stdout.write(chalk.gray(`${formatUsage(latestUsage)}\n`));
        }
      }

      // Sync REPL history with what query() actually processed. query() works
      // on a copy internally; the pushes we did before the generator started
      // (just the user message) are the only ones already in our `history`.
      history.push(...turnMessages);

      if (terminal?.reason === 'error') {
        const msg = terminal.error?.message ?? 'unknown error';
        if (
          terminal.error &&
          isContextOverflowError(terminal.error) &&
          retry.retriedAfterCompact !== true
        ) {
          process.stderr.write(
            chalk.yellow('\n[compact] context overflow; compacting and retrying once\n'),
          );
          const result = await compactNow();
          process.stderr.write(
            chalk.yellow(
              `[compact] ${result.parentSessionId} -> ${result.newSessionId}; estimated tokens ${result.estimatedBeforeTokens} -> ${result.estimatedAfterTokens}\n`,
            ),
          );
          await runModelTurn(userContent, command, {
            skipUserSave: true,
            retriedAfterCompact: true,
          });
          return;
        }
        writeStatusLine(chalk.red(`[error] ${msg}`), 'err');
        transcript?.record({
          type: 'provider_error',
          stage: 'turn',
          sessionId: activeSessionId,
          providerName,
          model: activeModel,
          message: msg,
          mutationPaths: [...completedMutationPaths],
        });
        if (completedMutationPaths.size > 0) {
          process.stderr.write(
            chalk.yellow(
              `\n${formatPartialMutationWarning({ paths: [...completedMutationPaths] })}\n`,
            ),
          );
        }
        if (!latestAssistant) history.pop();
      } else if (terminal?.reason === 'interrupted') {
        writeStatusLine(chalk.yellow('[interrupted]'), 'err');
      } else if (terminal?.reason === 'max_tokens') {
        process.stderr.write(
          chalk.yellow(
            `\n${formatMaxTokensWarning({
              maxTokens: opts.maxTokens,
              sessionId: activeSessionId,
              bundlePath: opts.bundlePath ?? null,
            })}\n`,
          ),
        );
      } else if (terminal?.reason === 'max_turns') {
        writeStatusLine(chalk.yellow('[max turns reached]'), 'err');
      } else if (terminal?.reason === 'checkin') {
        const count = terminal.toolCallCount ?? 0;
        process.stderr.write(
          chalk.yellow(
            `\n[checkin] ${count} tool call${count === 1 ? '' : 's'} — type /continue to keep going, or send a new message.\n`,
          ),
        );
        checkinPending = true;
      }
    }

    async function compactNow() {
      const result = await compactSession({
        db,
        sessionId: activeSessionId,
        model: activeModel,
        providerName,
        systemPrompt,
        history,
        warn: (message) => process.stderr.write(chalk.yellow(`[compact] ${message}\n`)),
      });
      activeSessionId = result.newSessionId;
      toolContext.sessionId = activeSessionId;
      history.length = 0;
      history.push(
        { role: 'assistant', content: [{ type: 'text', text: result.summary }] },
        ...result.tail,
      );
      // Post-compaction guard: clear stale tool results from the tail so the
      // child session doesn't start bloated with results the summary already covers.
      const mcCfg = buildMicrocompactConfig(userSettings.microcompaction);
      if (mcCfg.enabled) {
        const toolNameMap = buildToolNameMap(history);
        if (shouldMicrocompact(history, mcCfg, toolNameMap)) {
          const { messages: mcHistory, result: mcResult } = microcompact(
            history,
            toolNameMap,
            mcCfg,
          );
          if (mcResult.cleared > 0) {
            history.length = 0;
            history.push(...mcHistory);
          }
        }
      }
      return result;
    }

    async function rollbackNow(): Promise<string> {
      const session = db.getSession(activeSessionId);
      if (!session) return `cannot rollback: current session ${activeSessionId} was not found`;
      if (session.parentSessionId === null) {
        return `cannot rollback: session ${activeSessionId} has no parent session`;
      }
      const parent = db.getSession(session.parentSessionId);
      if (!parent)
        return `cannot rollback: parent session ${session.parentSessionId} was not found`;
      activeSessionId = parent.sessionId;
      activeModel = parent.model;
      toolContext.sessionId = activeSessionId;
      const rawRestored = db.loadMessages(activeSessionId).map((message) => ({
        role: message.role,
        content: message.content,
      })) as Message[];
      const { messages: restored, insertedToolResults } = repairMissingToolResults(rawRestored);
      if (insertedToolResults > 0) {
        process.stderr.write(
          chalk.yellow(
            `[repair] synthesized ${insertedToolResults} missing tool_result block(s) while rolling back to ${activeSessionId}\n`,
          ),
        );
      }
      history.length = 0;
      history.push(...restored);
      return `rolled back to parent session ${activeSessionId}; restored ${restored.length} messages`;
    }

    function clearNow(): string {
      const result = createClearedChildSession(db, {
        parentSessionId: activeSessionId,
        model: activeModel,
        provider: providerName,
        systemPrompt,
        metadata: {
          bundleRoot: bundle?.root ?? null,
          provider: providerName,
          baseUrl: resolved.baseUrl,
          contextLength: resolved.contextLength,
        },
      });
      activeSessionId = result.newSessionId;
      toolContext.sessionId = activeSessionId;
      history.length = 0;
      return [
        `conversation history cleared into child session ${result.newSessionId}`,
        `parent session preserved: ${result.parentSessionId}`,
        'rollback: /rollback',
      ].join('\n');
    }

    function scopedToolsForCommand(command: PromptCommand): {
      tools: typeof toolPool;
      canUseTool: typeof canUseTool;
    } {
      if (!command.allowedTools || command.allowedTools.length === 0) {
        return { tools: toolPool, canUseTool };
      }
      const commandAllowLayer = {
        source: `command:/${command.name}`,
        rules: parsePermissionRules('allow', command.allowedTools),
      };
      // Same defense-in-depth wrapping as the default canUseTool path
      // (see comment near `wrapCanUseToolWithTransformers` above). Without
      // this wrapping, prompt-commands with allowedTools — like the
      // /security-audit skill — would route through a redactor-free
      // canUseTool, so an agent's Write calls during a slash-command
      // turn could land plaintext secrets on disk even though the
      // default chat path is protected.
      const scopedCanUseTool = wrapCanUseToolWithTransformers(
        buildCanUseTool({
          mode: permissionMode,
          ask,
          alwaysAllow,
          ruleLayers: [...permissionSettings.layers, commandAllowLayer],
          recordAlwaysAllow: (rule) =>
            appendProjectLocalPermissionRule({ cwd: process.cwd(), rule, behavior: 'allow' }),
        }),
        [redactSecretsTransformer],
      );
      const scoped = buildToolScope({
        allowedTools: command.allowedTools,
        tools: toolPool,
        canUseTool: scopedCanUseTool,
      });
      return { tools: scoped.tools, canUseTool: scoped.canUseTool };
    }

    rl.close();
    if (bpTransform) {
      process.stdin.unpipe(bpTransform);
      bpTransform.end();
      disableBracketedPaste(process.stdout);
    }
    transcript?.record({ type: 'session_end', sessionId: activeSessionId });
    // Phase 13.3 (B4) — cancel any in-flight review forks. The signal
    // propagates through scheduler.delegate → AgentRunner; cooperative
    // cancellation usually surfaces as a 'interrupted' terminal in the
    // child trajectory. Failures are best-effort: abort never throws.
    reviewAbortController?.abort();
    // Phase 13.4 — flush in-flight observations before any further teardown.
    // Drain after abort (so cancelled reviews don't block) and before the
    // trajectory write (so this session's observations are durably on disk
    // first). Best-effort: drain never throws.
    await learningObserver.drain();
    const finalCost = db.getSessionCost(activeSessionId);
    // Phase 13.1 — write a ShareGPT-shaped trajectory record before
    // shutting down dependencies. Skipped for empty sessions (no
    // user/assistant turns at all). Failures are swallowed via
    // tryWriteTrajectory — Invariant #10 (additive, non-blocking).
    if (history.length > 0) {
      // Phase 13.3 (B2) — stock default bundle is system content; route its
      // trajectories to <harnessHome>/ so sov upgrade doesn't wipe them and
      // each profile gets its own state. Client bundles still own their state.
      const artifactsRoot =
        bundle && !isDefaultBundlePath(bundle.root)
          ? join(bundle.root, 'state', 'artifacts')
          : harnessHome;
      await tryWriteTrajectory(
        {
          messages: history,
          terminal: lastTerminal ?? { reason: 'completed' },
          metadata: {
            sessionId: activeSessionId,
            provider: providerName,
            model: activeModel,
            toolCallCount: metrics.toolCalls,
            iterationsUsed: metrics.toolOk + metrics.toolErr,
            estimatedCostUsd: finalCost.estimatedCostUsd + finalCost.estimatedCompactionCostUsd,
          },
          artifactsRoot,
        },
        (msg) => process.stderr.write(`${msg}\n`),
      );
    }
    await memoryManager.onSessionEnd(activeSessionId);
    await memoryManager.shutdown();
    if (mcpPool) await mcpPool.shutdown();
    traceWriter.record({
      type: 'session_end',
      reason: lastTerminal?.reason ?? 'completed',
      iso: new Date().toISOString(),
    });
    await traceWriter.close();
    if (routerAuditLogger) await routerAuditLogger.close();
    // Phase 10.5 part 2 — flush the capture sink to disk. The fixture
    // is written atomically (temp + rename) so a crash mid-write can't
    // leave a corrupt fixture.
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
    db.close();
    const reviewSummary = reviewManager?.getDispatchSummary();
    process.stdout.write(
      renderSessionSummary({
        ...metrics,
        sessionId: activeSessionId,
        endedAtMs: Date.now(),
        tokens: {
          input: finalCost.inputTokens + finalCost.compactionInputTokens,
          output: finalCost.outputTokens + finalCost.compactionOutputTokens,
          cacheRead: finalCost.cacheReadInputTokens,
          cacheWrite: finalCost.cacheCreationInputTokens,
          estimatedCostUsd: finalCost.estimatedCostUsd + finalCost.estimatedCompactionCostUsd,
        },
        ...(reviewSummary !== undefined && reviewSummary.totalDispatched > 0
          ? { reviews: reviewSummary }
          : {}),
      }),
    );
    const resumeHint =
      opts.bundlePath !== undefined
        ? `sov --resume ${activeSessionId} --bundle ${opts.bundlePath}`
        : `sov --resume ${activeSessionId}`;
    process.stdout.write(chalk.gray(`to resume: ${resumeHint}\n`));
  } finally {
    if (opts.stateDir !== undefined) {
      releaseLock(opts.stateDir);
    }
  }
}

function writeBanner(
  opts: ReplOpts,
  permissionMode: PermissionMode,
  _permissionSources: string[],
  resolved: ResolvedProvider,
  _haveContext: boolean,
  toolNames: string[],
  sessionId: string,
  resumed: boolean,
  layerAllowRuleCount: number,
): void {
  const providerName = String(resolved.metadata.provider);
  const authLabel = (() => {
    if (providerName === 'ollama') return chalk.gray('local (no key)');
    if (providerName === 'router') return chalk.gray('router-managed');
    return chalk.gray('API Key');
  })();
  const modeNote =
    permissionMode === 'bypass' ? chalk.red(' (fallthrough runs WITHOUT prompting)') : '';
  const sessionLabel = resumed
    ? `resumed ${sessionId.slice(0, 8)}`
    : `new ${sessionId.slice(0, 8)}`;
  const configuredMode =
    permissionMode === opts.permissionMode ? permissionMode : `${permissionMode} (from settings)`;
  const rulesNote =
    layerAllowRuleCount > 0
      ? ` (${layerAllowRuleCount} allow rule${layerAllowRuleCount === 1 ? '' : 's'} loaded)`
      : '';
  const splash = renderSplash({
    providerLabel: providerName,
    authLabel,
    model: resolved.model,
    bundlePath: opts.bundlePath ?? null,
    permissionMode: `${configuredMode}${rulesNote}`,
    permissionModeNote: modeNote,
    toolCount: toolNames.length,
    cacheOn: opts.noCache !== true,
    sessionLabel,
    exitHint: '/quit or Ctrl-D to exit',
  });
  process.stdout.write(`${splash}\n`);
}

/** Count `allow`-behavior rules across every loaded permission layer.
 *  The splash uses this to advertise that the user has persistent
 *  auto-allow rules in effect, separate from session-scoped `always`
 *  answers (which start empty and accumulate during a session). */
function countLayerAllowRules(layers: import('../config/rules.js').PermissionRuleLayer[]): number {
  let n = 0;
  for (const layer of layers) {
    for (const rule of layer.rules) {
      if (rule.behavior === 'allow') n++;
    }
  }
  return n;
}

type SessionOpen = {
  sessionId: string;
  systemPrompt: SystemSegment[];
  history: Message[];
  resumed: boolean;
};

function openOrResumeSession(
  db: SessionDb,
  opts: ReplOpts,
  bundle: Bundle | null,
  resolved: ResolvedProvider,
  tools: import('../tool/types.js').Tool<unknown, unknown>[],
  skills: SkillRegistry,
  projectScope: import('../memory/scope.js').ProjectScope,
  agentDef?: AgentDefinition,
  missionFiles?: MissionFiles,
): SessionOpen {
  if (opts.resumeId === undefined) {
    const cacheEnabled = opts.noCache !== true;
    const baseSegments = buildSystemSegments({
      ...(bundle ? { bundle } : {}),
      tools,
      skills: skills.skills,
      cwd: process.cwd(),
      cacheEnabled,
      projectScope,
    });
    const systemPrompt: SystemSegment[] =
      agentDef !== undefined
        ? [
            { text: agentDef.systemPrompt, cacheable: cacheEnabled },
            ...(missionFiles !== undefined
              ? buildMissionSegments(missionFiles, { cacheEnabled })
              : []),
            ...baseSegments,
          ]
        : baseSegments;
    const sessionId = db.createSession({
      model: resolved.model,
      provider: String(resolved.metadata.provider),
      platform: 'cli',
      systemPrompt,
      metadata: {
        bundleRoot: bundle?.root ?? null,
        provider: resolved.metadata.provider,
        baseUrl: resolved.baseUrl,
        contextLength: resolved.contextLength,
      },
    });
    return { sessionId, systemPrompt, history: [], resumed: false };
  }

  const session = db.getSession(opts.resumeId);
  if (!session) {
    throw new Error(`no session with id ${opts.resumeId}`);
  }
  const storedBundleRootRaw = (session.metadata as { bundleRoot?: string | null }).bundleRoot;
  const storedBundleRoot =
    typeof storedBundleRootRaw === 'string' ? storedBundleRootRaw : undefined;
  if (storedBundleRoot !== undefined && storedBundleRoot !== bundle?.root) {
    throw new Error(
      `session ${opts.resumeId} was created against bundle ${storedBundleRoot}; ` +
        `current --bundle is ${bundle?.root ?? '(none)'}. Pass --bundle ${storedBundleRoot} to resume.`,
    );
  }
  if (session.systemPrompt === null) {
    throw new Error(`session ${opts.resumeId} has no stored system prompt — cannot resume`);
  }
  const storedMessages = db.loadMessages(opts.resumeId);
  const rawHistory: Message[] = storedMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const { messages: history, insertedToolResults } = repairMissingToolResults(rawHistory);
  if (insertedToolResults > 0) {
    process.stderr.write(
      chalk.yellow(
        `[repair] synthesized ${insertedToolResults} missing tool_result block(s) while loading session ${opts.resumeId}\n`,
      ),
    );
  }
  return {
    sessionId: opts.resumeId,
    systemPrompt: session.systemPrompt,
    history,
    resumed: true,
  };
}

/** Width of the inline tool-result preview block in characters. Tool
 *  results are visible to the model but normally invisible to the user;
 *  this preview surfaces them to stdout so the user can see what the
 *  agent saw, with a generous cap to keep the terminal readable. */
const TOOL_RESULT_PREVIEW_CHARS = 4000;
const TOOL_RESULT_PREVIEW_LINES = 40;

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K chars`;
  return `${(n / 1_000_000).toFixed(2)}M chars`;
}

function renderToolResultPreview(content: string, isError: boolean, verbose: boolean): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) return;
  const tint = isError ? chalk.red : chalk.gray;
  const allLines = trimmed.split('\n');
  if (!verbose) {
    // One-line summary mode (default). Show "ok · N lines, M chars" or
    // first 80 chars of the error so the user knows what happened
    // without the full content dominating the view.
    if (isError) {
      const firstLine = allLines[0] ?? '';
      const snippet = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
      process.stdout.write(chalk.red(`  └─ error · ${snippet}\n`));
    } else {
      process.stdout.write(
        chalk.gray(
          `  └─ ok · ${allLines.length} line${allLines.length === 1 ? '' : 's'}, ${formatChars(trimmed.length)}\n`,
        ),
      );
    }
    return;
  }
  let preview = allLines.slice(0, TOOL_RESULT_PREVIEW_LINES).join('\n');
  let truncated = allLines.length > TOOL_RESULT_PREVIEW_LINES;
  if (preview.length > TOOL_RESULT_PREVIEW_CHARS) {
    preview = preview.slice(0, TOOL_RESULT_PREVIEW_CHARS);
    truncated = true;
  }
  const indented = preview
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  process.stdout.write(`\n${tint(indented)}\n`);
  if (truncated) {
    const totalLines = allLines.length;
    const totalChars = trimmed.length;
    process.stdout.write(
      chalk.gray(`  … (${totalLines} lines, ${totalChars} chars total — preview truncated)\n`),
    );
  }
}

function previewToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return truncatePreview(input);
  if (typeof input !== 'object') return truncatePreview(String(input));
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return truncatePreview(obj.command);
  try {
    return truncatePreview(JSON.stringify(obj));
  } catch {
    return '';
  }
}

/** Format a tool's input for the compact REPL slot. Prefers the tool's
 *  own `displayInput` (which can shape per-tool — e.g. `src/foo.ts:50-70`
 *  for FileRead). Falls back to the generic `previewToolInput` when the
 *  tool doesn't supply one, preserving prior behavior for any tool that
 *  hasn't opted in.
 *
 *  Returns the raw arg string. The slot wraps it in `Tool(args)` form
 *  to match Claude Code's display style. */
function formatToolInputForDisplay(
  tool: Tool<unknown, unknown> | undefined,
  input: unknown,
): string {
  if (tool?.displayInput) {
    try {
      const display = tool.displayInput(input);
      if (display !== '') return truncatePreview(display);
    } catch {
      // Fall through to generic preview.
    }
  }
  return previewToolInput(input);
}

function mutationEffect(
  block: Extract<ContentBlock, { type: 'tool_use' }>,
  tools: Tool<unknown, unknown>[],
  cwd: string,
): { name: string; paths: string[] } | null {
  const tool = tools.find((candidate) => candidate.name === block.name);
  if (!tool) return null;
  if (tool.isReadOnly(block.input)) return null;
  const rawPaths = tool.affectedPaths?.(block.input) ?? [];
  const paths = rawPaths.map((path) => resolveToolPath(path, cwd));
  if (paths.length === 0) return null;
  return { name: block.name, paths };
}

function truncatePreview(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

/** Names recognised by the inline diff renderer. Aliases (Edit / Write)
 *  are kept in sync with the buildTool aliases on FileEditTool /
 *  FileWriteTool so a model that emits either form gets the same UX. */
function isDiffShapedTool(name: string): boolean {
  return name === 'FileEdit' || name === 'Edit' || name === 'FileWrite' || name === 'Write';
}

/** Pull the latest assistant message's text content. Concatenates
 *  consecutive text blocks; returns null when the latest assistant
 *  message is tool-only or no assistant message exists yet. Used by
 *  the /copy slash command. */
function extractLastAssistantText(history: Message[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== 'assistant') continue;
    const text = msg.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** For FileEdit only: read the file synchronously at the moment we see
 *  the tool_use block, before the orchestrator dispatches the tool.
 *  The diff renderer uses this snapshot to expand the diff to full-line
 *  context. Returns undefined on any failure so the renderer falls back
 *  to substring rendering rather than crashing the turn. FileWrite is
 *  intentionally skipped — its diff is additive, no pre-content needed. */
function readPreEditContent(toolName: string, rawInput: unknown, cwd: string): string | undefined {
  if (toolName !== 'FileEdit' && toolName !== 'Edit') return undefined;
  if (rawInput === null || typeof rawInput !== 'object') return undefined;
  const path = (rawInput as Record<string, unknown>).path;
  if (typeof path !== 'string') return undefined;
  try {
    const abs = resolveToolPath(path, cwd);
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Short, scannable label for the footer's bundle segment. Strips
 *  trailing slashes and shows just the basename — full path stays
 *  visible in the splash banner. */
function deriveBundleLabel(bundlePath: string): string {
  const trimmed = bundlePath.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** Strip image base64 payloads before serializing assistant content into
 *  the transcript. Everything else passes through verbatim so the JSONL
 *  captures full text, thinking, and tool_use blocks. */
function snapshotContentForTranscript(content: ContentBlock[]): unknown[] {
  return content.map((block) => {
    if (block.type === 'image') {
      return {
        type: 'image',
        media_type: block.source.media_type,
        omitted: 'base64-data',
      };
    }
    return block;
  });
}

function formatUsage(usage: TokenUsage): string {
  const parts = [
    ['input', usage.inputTokens],
    ['output', usage.outputTokens],
    ['cache_write', usage.cacheCreationInputTokens],
    ['cache_read', usage.cacheReadInputTokens],
  ]
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([label, value]) => `${label}=${value}`);
  return parts.length > 0 ? `[usage: ${parts.join(', ')}]` : '[usage: unavailable]';
}
