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
import { loadBundle } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { resolveHarnessHome } from '../config/paths.js';
import { appendProjectLocalPermissionRule, loadPermissionSettings } from '../config/settings.js';
import { expandContextReferences } from '../context/references.js';
import { createSubdirectoryHintState } from '../context/subdirectoryHints.js';
import { query } from '../core/query.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type {
  AssistantMessage,
  Message,
  SystemSegment,
  Terminal,
  TokenUsage,
} from '../core/types.js';
import { createDefaultMemoryManager } from '../memory/provider.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { buildReadlineAsker } from '../permissions/prompt.js';
import type { PermissionMode } from '../permissions/types.js';
import { type ResolvedProvider, resolveProvider } from '../providers/resolver.js';
import { assembleToolPool } from '../tool/registry.js';
import type { ToolContext } from '../tool/types.js';

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
};

const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);

export async function runRepl(opts: ReplOpts): Promise<void> {
  const bundle = await loadBundle(opts.bundlePath);
  const harnessHome = resolveHarnessHome();
  const permissionSettings = loadPermissionSettings({ cwd: process.cwd(), harnessHome });
  const permissionMode =
    opts.permissionMode === 'default' && permissionSettings.mode !== 'default'
      ? permissionSettings.mode
      : opts.permissionMode;
  const memoryManager = createDefaultMemoryManager(harnessHome);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();
  const subdirectoryHintState = createSubdirectoryHintState();
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
  const provider = resolved.transport;
  const preliminaryToolContext: ToolContext = {
    cwd: process.cwd(),
    bundleRoot: bundle.root,
    sessionId: opts.resumeId ?? 'pending',
    harnessHome,
    memoryManager,
    subdirectoryHintState,
  };
  const preliminaryToolPool = assembleToolPool(preliminaryToolContext);
  const { sessionId, systemPrompt, history, resumed } = openOrResumeSession(
    db,
    opts,
    bundle,
    resolved,
    preliminaryToolPool,
  );

  const toolContext: ToolContext = {
    cwd: process.cwd(),
    bundleRoot: bundle.root,
    sessionId,
    harnessHome,
    memoryManager,
    subdirectoryHintState,
  };
  const toolPool = preliminaryToolPool;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

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
  const ask = buildReadlineAsker(rl);
  const canUseTool = buildCanUseTool({
    mode: permissionMode,
    ask,
    alwaysAllow,
    ruleLayers: permissionSettings.layers,
    recordAlwaysAllow: (rule) =>
      appendProjectLocalPermissionRule({ cwd: process.cwd(), rule, behavior: 'allow' }),
  });

  writeBanner(
    opts,
    permissionMode,
    permissionSettings.sources,
    resolved,
    bundle.state.context !== null,
    toolPool.map((t) => t.name),
    sessionId,
    resumed,
  );

  while (!closed) {
    const input = await rl.question(chalk.cyan('\nyou> ')).catch(() => null);
    if (input === null) break;
    const trimmed = input.trim();
    if (trimmed === '') continue;
    if (EXIT_COMMANDS.has(trimmed)) break;

    const enrichedInput = await expandContextReferences(trimmed, { cwd: process.cwd() });
    const userMessage: Message = { role: 'user', content: [{ type: 'text', text: enrichedInput }] };
    history.push(userMessage);
    db.saveMessage(sessionId, { role: 'user', content: userMessage.content });

    process.stdout.write(chalk.gray('\nharness> '));

    streamController = new AbortController();
    let latestAssistant: AssistantMessage | undefined;
    let terminal: Terminal | undefined;
    let latestUsage: TokenUsage | undefined;

    try {
      const gen = query({
        provider,
        model: resolved.model,
        messages: history,
        systemPrompt,
        ...(toolPool.length > 0 ? { tools: toolPool, toolContext, canUseTool } : {}),
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
            db.saveMessage(sessionId, { role: 'user', content: ev.content });
            const errs = ev.content.filter(
              (b) => b.type === 'tool_result' && b.is_error === true,
            ).length;
            if (errs > 0) {
              process.stdout.write(chalk.gray(`\n[${errs} tool error${errs === 1 ? '' : 's'}]`));
            }
            process.stdout.write(chalk.gray('\nharness> '));
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
          db.saveMessage(sessionId, { role: 'assistant', content: ev.message.content });
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
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
        // message_start, thinking_delta, tool_use_delta, message_stop: silent.
      }
    } finally {
      streamController = null;
    }

    process.stdout.write('\n');
    if (latestUsage) {
      process.stdout.write(chalk.gray(`${formatUsage(latestUsage)}\n`));
    }

    // Sync REPL history with what query() actually processed. query() works
    // on a copy internally; the pushes we did before the generator started
    // (just the user message) are the only ones already in our `history`.
    if (latestAssistant) history.push(latestAssistant);

    if (terminal?.reason === 'error') {
      const msg = terminal.error?.message ?? 'unknown error';
      process.stderr.write(chalk.red(`\n[error] ${msg}\n`));
      if (!latestAssistant) history.pop();
    } else if (terminal?.reason === 'interrupted') {
      process.stderr.write(chalk.yellow('\n[interrupted]\n'));
    } else if (terminal?.reason === 'max_turns') {
      process.stderr.write(chalk.yellow('\n[max turns reached]\n'));
    }
  }

  rl.close();
  await memoryManager.onSessionEnd(sessionId);
  await memoryManager.shutdown();
  db.close();
  process.stdout.write(chalk.gray('\ngoodbye.\n'));
  process.stdout.write(
    chalk.gray(`to resume: sovereign chat --resume ${sessionId} --bundle ${opts.bundlePath}\n`),
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
): SessionOpen {
  if (opts.resumeId === undefined) {
    const systemPrompt = buildSystemSegments({
      bundle,
      tools,
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
  const history: Message[] = storedMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
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
