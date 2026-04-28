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
import { loadBundle } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { COMMANDS, buildCommandRegistry, dispatchSlashCommand } from '../commands/registry.js';
import { buildToolScope } from '../commands/toolScope.js';
import type { CommandContext, PromptCommand } from '../commands/types.js';
import { compactSession, shouldCompactProactively } from '../compact/compactor.js';
import { resolveHarnessHome } from '../config/paths.js';
import { parsePermissionRules } from '../config/rules.js';
import { appendProjectLocalPermissionRule, loadPermissionSettings } from '../config/settings.js';
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
import { createQueuedQuestion } from './queuedQuestion.js';
import { formatMaxTokensWarning, formatPartialMutationWarning } from './terminalMessages.js';
import { createTranscriptLogger } from './transcript.js';

export type ReplOpts = {
  bundlePath: string;
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
};

const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);

export async function runRepl(opts: ReplOpts): Promise<void> {
  const bundle = await loadBundle(opts.bundlePath);
  const harnessHome = resolveHarnessHome();
  const transcript = createTranscriptLogger(opts.transcriptPath);
  const permissionSettings = loadPermissionSettings({ cwd: process.cwd(), harnessHome });
  const permissionMode =
    opts.permissionMode === 'default' && permissionSettings.mode !== 'default'
      ? permissionSettings.mode
      : opts.permissionMode;
  const memoryManager = createDefaultMemoryManager(harnessHome);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();
  const subdirectoryHintState = createSubdirectoryHintState();
  const loadedSkills = await loadSkills({
    harnessHome,
    cwd: process.cwd(),
    bundleRoot: bundle.root,
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
    bundleRoot: bundle.root,
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
  transcript?.record({
    type: 'session_start',
    sessionId: activeSessionId,
    resumed,
    cwd: process.cwd(),
    bundlePath: opts.bundlePath,
    providerName,
    model: activeModel,
    permissionMode,
  });

  const toolContext: ToolContext = {
    cwd: process.cwd(),
    bundleRoot: bundle.root,
    sessionId: activeSessionId,
    harnessHome,
    memoryManager,
    subdirectoryHintState,
    skills,
    activeToolNames,
    activeToolsets,
  };
  const toolPool = assembleToolPool(toolContext);

  const rl = createInterface({
    input: process.stdin,
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
    bundle.state.context !== null,
    toolPool.map((t) => t.name),
    activeSessionId,
    resumed,
  );

  while (!closed) {
    const input = await question(chalk.cyan('\n> ')).catch(() => null);
    if (input === null) break;
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

    if (
      shouldCompactProactively({
        messages: history,
        systemPrompt,
        contextLength: resolved.contextLength,
      })
    ) {
      process.stderr.write(chalk.yellow('\n[compact] context threshold exceeded; compacting\n'));
      const result = await compactNow();
      process.stderr.write(
        chalk.yellow(
          `[compact] ${result.parentSessionId} -> ${result.newSessionId}; estimated tokens ${result.estimatedBeforeTokens} -> ${result.estimatedAfterTokens}\n`,
        ),
      );
    }

    process.stdout.write('\n');

    streamController = new AbortController();
    let latestAssistant: AssistantMessage | undefined;
    let terminal: Terminal | undefined;
    let latestUsage: TokenUsage | undefined;
    const turnMessages: Message[] = [];
    const mutatingToolUses = new Map<string, { name: string; paths: string[] }>();
    const completedMutationPaths = new Set<string>();
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
        signal: streamController.signal,
        cacheEnabled: opts.noCache !== true,
        memoryManager,
      });

      for (;;) {
        const step = await gen.next();
        if (step.done) {
          terminal = step.value;
          break;
        }
        const ev = step.value;
        if (!ev || typeof ev !== 'object') continue;

        // Message branch — ev is a tool_result carrier yielded between turns.
        if ('role' in ev) {
          if (ev.role === 'user') {
            for (const block of ev.content) {
              if (block.type !== 'tool_result' || block.is_error === true) continue;
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
              process.stdout.write(chalk.gray(`\n[${errs} tool error${errs === 1 ? '' : 's'}]`));
            }
            process.stdout.write('\n');
          }
          continue;
        }

        // StreamEvent branch.
        if (!('type' in ev)) continue;
        if (ev.type === 'text_delta') {
          process.stdout.write(ev.text);
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
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              const mutation = mutationEffect(block, toolsForTurn, toolContext.cwd);
              if (mutation) mutatingToolUses.set(block.id, mutation);
              const preview = previewToolInput(block.input);
              process.stdout.write(
                chalk.gray(`\n[tool: ${block.name}${preview ? ` ${preview}` : ''}]`),
              );
            }
          }
        }
        if (ev.type === 'usage_delta') {
          latestUsage = ev.usage;
        }
        if (ev.type === 'microcompact') {
          process.stdout.write(
            chalk.gray(
              `\n[cleared ${ev.info.cleared} stale tool result${ev.info.cleared === 1 ? '' : 's'}, ~${Math.round(ev.info.estimatedTokensSaved / 1000)}K tokens]`,
            ),
          );
        }
        // message_start, thinking_delta, tool_use_delta, message_stop: silent.
      }
    } finally {
      streamController = null;
    }

    process.stdout.write('\n');
    if (latestUsage) {
      const cost = estimateCostUsd(providerName, activeModel, latestUsage);
      db.recordTokenUsage(activeSessionId, latestUsage, cost);
      process.stdout.write(chalk.gray(`${formatUsage(latestUsage)}\n`));
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
      process.stderr.write(chalk.red(`\n[error] ${msg}\n`));
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
      process.stderr.write(chalk.yellow('\n[interrupted]\n'));
    } else if (terminal?.reason === 'max_tokens') {
      process.stderr.write(
        chalk.yellow(
          `\n${formatMaxTokensWarning({
            maxTokens: opts.maxTokens,
            sessionId: activeSessionId,
            bundlePath: opts.bundlePath,
          })}\n`,
        ),
      );
    } else if (terminal?.reason === 'max_turns') {
      process.stderr.write(chalk.yellow('\n[max turns reached]\n'));
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
        bundleRoot: bundle.root,
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
  transcript?.record({ type: 'session_end', sessionId: activeSessionId });
  await memoryManager.onSessionEnd(activeSessionId);
  await memoryManager.shutdown();
  db.close();
  process.stdout.write(chalk.gray('\ngoodbye.\n'));
  process.stdout.write(
    chalk.gray(
      `to resume: sovereign chat --resume ${activeSessionId} --bundle ${opts.bundlePath}\n`,
    ),
  );
}

function writeBanner(
  opts: ReplOpts,
  permissionMode: PermissionMode,
  permissionSources: string[],
  resolved: ResolvedProvider,
  haveContext: boolean,
  toolNames: string[],
  sessionId: string,
  resumed: boolean,
): void {
  const modeNote =
    permissionMode === 'bypass' ? chalk.red(' (fallthrough runs WITHOUT prompting)') : '';
  const sessionLabel = resumed ? `resumed ${sessionId}` : `new ${sessionId}`;
  const configuredMode =
    permissionMode === opts.permissionMode ? permissionMode : `${permissionMode} (from settings)`;
  const lines = [
    chalk.bold('sovereign-ai-harness'),
    chalk.gray(`  bundle: ${opts.bundlePath}`),
    chalk.gray(`  provider: ${String(resolved.metadata.provider)} (${resolved.baseUrl})`),
    chalk.gray(`  model:  ${resolved.model}`),
    chalk.gray(`  context.md: ${haveContext ? 'loaded' : 'not found (prompt will be minimal)'}`),
    chalk.gray(`  tools:  ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`),
    chalk.gray(`  cache:  ${opts.noCache === true ? 'off' : 'on'}`),
    chalk.gray(`  perms:  ${configuredMode}${modeNote}`),
    chalk.gray(
      `  rules:  ${permissionSources.length > 0 ? `${permissionSources.length} settings file(s)` : 'none'}`,
    ),
    chalk.gray(`  session: ${sessionLabel}`),
    chalk.gray('  exit:   /quit, /exit, /q, or Ctrl-D'),
    chalk.gray('  Ctrl-C during streaming interrupts the response'),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
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
  bundle: Bundle,
  resolved: ResolvedProvider,
  tools: import('../tool/types.js').Tool<unknown, unknown>[],
  skills: SkillRegistry,
): SessionOpen {
  if (opts.resumeId === undefined) {
    const systemPrompt = buildSystemSegments({
      bundle,
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
        bundleRoot: bundle.root,
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
  const storedBundleRoot = (session.metadata as { bundleRoot?: string }).bundleRoot;
  if (storedBundleRoot !== undefined && storedBundleRoot !== bundle.root) {
    throw new Error(
      `session ${opts.resumeId} was created against bundle ${storedBundleRoot}; ` +
        `current --bundle is ${bundle.root}. Pass --bundle ${storedBundleRoot} to resume.`,
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
