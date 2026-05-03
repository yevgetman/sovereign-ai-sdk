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

import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { SessionDb } from '../agent/sessionDb.js';
import { createClearedChildSession } from '../agent/sessionRecovery.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { COMMANDS, buildCommandRegistry, dispatchSlashCommand } from '../commands/registry.js';
import { buildToolScope } from '../commands/toolScope.js';
import type { CommandContext, PromptCommand } from '../commands/types.js';
import { compactSession, shouldCompactProactively } from '../compact/compactor.js';
import { resolveHarnessHome } from '../config/paths.js';
import { parsePermissionRules } from '../config/rules.js';
import { appendProjectLocalPermissionRule, loadPermissionSettings } from '../config/settings.js';
import { readConfig } from '../config/store.js';
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
import { createDefaultMemoryManager } from '../memory/provider.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { buildReadlineAsker } from '../permissions/prompt.js';
import type { PermissionMode } from '../permissions/types.js';
import { isContextOverflowError } from '../providers/errors.js';
import { preflightProvider, preflightToolCalling } from '../providers/preflight.js';
import { estimateCostUsd } from '../providers/pricing.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import { buildSkillCommands } from '../skills/commands.js';
import { loadSkills } from '../skills/loader.js';
import type { SkillRegistry } from '../skills/types.js';
import { filterSkillRegistry, inferActiveToolsets } from '../skills/visibility.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { resolveToolPath } from '../tools/pathUtils.js';
import {
  BracketedPasteTransform,
  disableBracketedPaste,
  enableBracketedPaste,
  restoreEmbeddedNewlines,
} from './bracketedPaste.js';
import { ContextMeter } from './contextMeter.js';
import { renderToolDiff } from './diff.js';
import { type FooterInfo, printPrePromptFooter } from './footer.js';
import { MarkdownStream } from './markdownStream.js';
import { createQueuedQuestion } from './queuedQuestion.js';
import { type SessionMetrics, renderSessionSummary } from './sessionSummary.js';
import { renderSplash } from './splash.js';
import { formatMaxTokensWarning, formatPartialMutationWarning } from './terminalMessages.js';
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
};

const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);

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

export async function runRepl(opts: ReplOpts): Promise<void> {
  const bundle = await loadBundleIfPresent(opts.bundlePath ?? null);
  const harnessHome = resolveHarnessHome();
  const permissionSettings = loadPermissionSettings({ cwd: process.cwd(), harnessHome });
  const userSettings = readConfig();
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
  const memoryManager = createDefaultMemoryManager(harnessHome);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();
  const subdirectoryHintState = createSubdirectoryHintState();
  const loadedSkills = await loadSkills({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
    warn: (message) => process.stderr.write(chalk.yellow(`[skill] ${message}\n`)),
  });
  const db = SessionDb.open(opts.dbPath !== undefined ? { path: opts.dbPath } : {});
  const resumeSession =
    opts.resumeId !== undefined ? (db.getSession(opts.resumeId) ?? undefined) : undefined;
  const storedProvider = resumeSession
    ? ((resumeSession.metadata as { provider?: string }).provider ?? resumeSession.provider)
    : undefined;
  const resolved = resolveProvider(
    opts.providerName ?? storedProvider,
    opts.model ?? resumeSession?.model,
  );
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
  const finalPreliminaryToolPool = assembleToolPool(finalPreliminaryToolContext);
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
  const opened = openOrResumeSession(db, opts, bundle, resolved, finalPreliminaryToolPool, skills);
  let activeSessionId = opened.sessionId;
  const { systemPrompt, history, resumed } = opened;
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
    activeToolNames,
    activeToolsets,
  };
  const toolPool = assembleToolPool(toolContext);

  // Wrap stdin in a bracketed-paste transform so multi-line pastes don't
  // fragment into one model turn per line. The terminal must opt in too,
  // via `\x1b[?2004h`. Skip both when stdin isn't a TTY (CI, piped input).
  const bpEnabled = process.stdin.isTTY === true;
  const bpTransform = bpEnabled ? new BracketedPasteTransform(process.stdin) : null;
  if (bpTransform) {
    process.stdin.pipe(bpTransform);
    enableBracketedPaste(process.stdout);
  }
  const rl = createInterface({
    input: (bpTransform ?? process.stdin) as NodeJS.ReadStream,
    output: process.stdout,
    terminal: true,
  });
  const question = createQueuedQuestion(rl);

  let streamController: AbortController | null = null;
  let closed = false;

  rl.on('close', () => {
    closed = true;
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
  const canUseTool = buildCanUseTool({
    mode: permissionMode,
    ask,
    alwaysAllow,
    ruleLayers: permissionSettings.layers,
    recordAlwaysAllow: (rule) =>
      appendProjectLocalPermissionRule({ cwd: process.cwd(), rule, behavior: 'allow' }),
  });
  const commandContext = (): CommandContext => ({
    sessionId: activeSessionId,
    cwd: process.cwd(),
    providerName,
    model: activeModel,
    setModel: (model) => {
      activeModel = model;
    },
    clearHistory: clearNow,
    getCost: () => db.getSessionCost(activeSessionId),
    compact: compactNow,
    rollback: rollbackNow,
    tools: toolPool,
    registry: commandRegistry,
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

  while (!closed) {
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
    const frame = openPromptFrame();
    const raw = await question(chalk.cyan('> ')).catch(() => null);
    frame.close();
    if (raw === null) break;
    const input = bpEnabled ? restoreEmbeddedNewlines(raw) : raw;
    transcript?.record({ type: 'user_input', sessionId: activeSessionId, text: input });
    const trimmed = input.trim();
    if (trimmed === '') continue;
    if (EXIT_COMMANDS.has(trimmed)) break;

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
        process.stdout.write(`${result.output}\n`);
        continue;
      }
      transcript?.record({
        type: 'slash_command',
        sessionId: activeSessionId,
        command: trimmed,
        kind: result.kind,
        promptCommand: result.command.name,
      });
      await runModelTurn(result.content, result.command);
      continue;
    }

    const enrichedInput = await expandContextReferences(trimmed, { cwd: process.cwd() });
    await runModelTurn([{ type: 'text', text: enrichedInput }]);
  }

  async function runModelTurn(
    userContent: Message['content'],
    command?: PromptCommand,
    retry: { skipUserSave?: boolean; retriedAfterCompact?: boolean } = {},
  ): Promise<void> {
    if (retry.skipUserSave !== true) {
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
    const toolSlot = new CompactToolSlot(process.stdout);
    // Non-verbose: count newlines in text_delta as they stream so that
    // when the next tool fires we can ANSI-clear the just-streamed
    // inter-tool preamble along with the previous slot line. Text still
    // streams live (good UX); only inter-tool transitions clear it.
    let interToolLines = 0;
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
    // user sees the change inline. Errors skip the diff path.
    const diffInputsByToolUseId = new Map<string, { name: string; input: unknown }>();
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
        signal: streamController.signal,
        cacheEnabled: opts.noCache !== true,
        memoryManager,
      });

      for (;;) {
        const step = await gen.next();
        indicator.stop();
        if (step.done) {
          terminal = step.value;
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
                toolSlot.end(block.content, block.is_error === true);
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
                const diffOut = renderToolDiff(diffEntry.name, diffEntry.input, { verbose });
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
            if (!verbose) interToolLines += 1;
            textRunActive = true;
          }
          mdStream.write(ev.text);
          if (!verbose) {
            // Count newlines actually written to stdout so a future
            // toolSlot.begin can ANSI-clear them along with the prior
            // slot. Trailing partial line is tracked at flush time.
            interToolLines += (ev.text.match(/\n/g) ?? []).length;
          }
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
            const hasToolUse = ev.message.content.some((b) => b.type === 'tool_use');
            if (!hasToolUse) {
              // Final-answer turn: any partial markdown line still
              // sitting in mdStream's buffer needs to render; the
              // streamed text stays visible in scrollback as the answer.
              mdStream.flush();
              toolSlot.commit();
              interToolLines = 0;
            }
            // For tool-bearing messages: leave interToolLines as-is so
            // the upcoming toolSlot.begin can clear it along with the
            // previous slot. mdStream's partial buffer (if any) is
            // discarded so it doesn't render later as a stray line.
            else {
              const flushed = mdStream.flush();
              interToolLines += flushed;
            }
          }
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              metrics.toolCalls++;
              toolStartTimes.set(block.id, Date.now());
              const mutation = mutationEffect(block, toolsForTurn, toolContext.cwd);
              if (mutation) mutatingToolUses.set(block.id, mutation);
              if (diffRenderEnabled && isDiffShapedTool(block.name)) {
                diffInputsByToolUseId.set(block.id, { name: block.name, input: block.input });
              }
              const preview = previewToolInput(block.input);
              if (verbose) {
                writeStatusLine(chalk.gray(`[tool: ${block.name}${preview ? ` ${preview}` : ''}]`));
              } else {
                toolSlot.begin(block.name, preview, interToolLines);
                interToolLines = 0;
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
          toolSlot.commit();
          writeStatusLine(
            chalk.gray(
              `[cleared ${ev.info.cleared} stale tool result${ev.info.cleared === 1 ? '' : 's'}, ~${Math.round(ev.info.estimatedTokensSaved / 1000)}K tokens]`,
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
    return result;
  }

  async function rollbackNow(): Promise<string> {
    const session = db.getSession(activeSessionId);
    if (!session) return `cannot rollback: current session ${activeSessionId} was not found`;
    if (session.parentSessionId === null) {
      return `cannot rollback: session ${activeSessionId} has no parent session`;
    }
    const parent = db.getSession(session.parentSessionId);
    if (!parent) return `cannot rollback: parent session ${session.parentSessionId} was not found`;
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
    const scopedCanUseTool = buildCanUseTool({
      mode: permissionMode,
      ask,
      alwaysAllow,
      ruleLayers: [...permissionSettings.layers, commandAllowLayer],
      recordAlwaysAllow: (rule) =>
        appendProjectLocalPermissionRule({ cwd: process.cwd(), rule, behavior: 'allow' }),
    });
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
  const finalCost = db.getSessionCost(activeSessionId);
  await memoryManager.onSessionEnd(activeSessionId);
  await memoryManager.shutdown();
  db.close();
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
    }),
  );
  const resumeHint =
    opts.bundlePath !== undefined
      ? `sov --resume ${activeSessionId} --bundle ${opts.bundlePath}`
      : `sov --resume ${activeSessionId}`;
  process.stdout.write(chalk.gray(`to resume: ${resumeHint}\n`));
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
  const authLabel =
    providerName === 'ollama' ? chalk.gray('local (no key)') : chalk.gray('API Key');
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
): SessionOpen {
  if (opts.resumeId === undefined) {
    const systemPrompt = buildSystemSegments({
      ...(bundle ? { bundle } : {}),
      tools,
      skills: skills.skills,
      cwd: process.cwd(),
      cacheEnabled: opts.noCache !== true,
    });
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
