// Terminal REPL. Readline-based prompt loop that streams model output as
// text deltas arrive. In-memory multi-turn history; the model sees every
// prior user/assistant message so follow-up questions ("what did I just
// ask?") resolve coherently.
//
// Phase 2: tools are assembled from the registry and wired into query().
// Tool invocations render as a dim inline hint so the user sees what's
// happening; pretty rendering lands Phase 16.7.
//
// Ctrl-C semantics:
//   - during streaming: abort the in-flight request, drop back to prompt
//   - at the prompt: close the REPL
//
// Exit commands: `/quit`, `/exit`, `/q`, Ctrl-D.

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { loadBundle } from '../bundle/loader.js';
import { query } from '../core/query.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { AssistantMessage, Message, Terminal } from '../core/types.js';
import { buildCanUseTool } from '../permissions/canUseTool.js';
import { buildReadlineAsker } from '../permissions/prompt.js';
import type { PermissionMode } from '../permissions/types.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { assembleToolPool } from '../tool/registry.js';
import type { ToolContext } from '../tool/types.js';

export type ReplOpts = {
  bundlePath: string;
  model: string;
  maxTokens: number;
  permissionMode: PermissionMode;
  apiKey: string;
};

const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);

export async function runRepl(opts: ReplOpts): Promise<void> {
  const bundle = await loadBundle(opts.bundlePath);
  const provider = new AnthropicProvider({ apiKey: opts.apiKey });
  const systemPrompt = buildSystemSegments(bundle);
  const history: Message[] = [];
  const sessionId = randomUUID();
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    bundleRoot: bundle.root,
    sessionId,
  };
  const toolPool = assembleToolPool(toolContext);

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
    mode: opts.permissionMode,
    ask,
    alwaysAllow,
  });

  writeBanner(
    opts,
    bundle.state.context !== null,
    toolPool.map((t) => t.name),
  );

  while (!closed) {
    const input = await rl.question(chalk.cyan('\nyou> ')).catch(() => null);
    if (input === null) break;
    const trimmed = input.trim();
    if (trimmed === '') continue;
    if (EXIT_COMMANDS.has(trimmed)) break;

    history.push({ role: 'user', content: [{ type: 'text', text: trimmed }] });

    process.stdout.write(chalk.gray('\nharness> '));

    streamController = new AbortController();
    let latestAssistant: AssistantMessage | undefined;
    let terminal: Terminal | undefined;

    try {
      const gen = query({
        provider,
        model: opts.model,
        messages: history,
        systemPrompt,
        ...(toolPool.length > 0 ? { tools: toolPool, toolContext, canUseTool } : {}),
        maxTokens: opts.maxTokens,
        signal: streamController.signal,
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
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              const preview = previewToolInput(block.input);
              process.stdout.write(
                chalk.gray(`\n[tool: ${block.name}${preview ? ` ${preview}` : ''}]`),
              );
            }
          }
        }
        // message_start, thinking_delta, tool_use_delta, message_stop: silent.
      }
    } finally {
      streamController = null;
    }

    process.stdout.write('\n');

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
  process.stdout.write(chalk.gray('\ngoodbye.\n'));
}

function writeBanner(opts: ReplOpts, haveContext: boolean, toolNames: string[]): void {
  const modeNote =
    opts.permissionMode === 'bypass' ? chalk.red(' (every tool runs WITHOUT prompting)') : '';
  const lines = [
    chalk.bold('sovereign-ai-harness'),
    chalk.gray(`  bundle: ${opts.bundlePath}`),
    chalk.gray(`  model:  ${opts.model}`),
    chalk.gray(`  context.md: ${haveContext ? 'loaded' : 'not found (prompt will be minimal)'}`),
    chalk.gray(`  tools:  ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`),
    chalk.gray(`  perms:  ${opts.permissionMode}${modeNote}`),
    chalk.gray('  exit:   /quit, /exit, /q, or Ctrl-D'),
    chalk.gray('  Ctrl-C during streaming interrupts the response'),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
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
