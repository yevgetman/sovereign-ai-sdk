// Terminal REPL. Readline-based prompt loop that streams model output as
// text deltas arrive. In-memory multi-turn history; the model sees every
// prior user/assistant message so follow-up questions ("what did I just
// ask?") resolve coherently.
//
// Ctrl-C semantics:
//   - during streaming: abort the in-flight request, drop back to prompt
//   - at the prompt: close the REPL
//
// Exit commands: `/quit`, `/exit`, `/q`, Ctrl-D.
//
// Phase 1 scope: Anthropic only, no tools, no persistence. Phase 14 swaps
// readline for Ink-based rich UI.

import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { loadBundle } from '../bundle/loader.js';
import { query } from '../core/query.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { AssistantMessage, Message, Terminal } from '../core/types.js';
import { AnthropicProvider } from '../providers/anthropic.js';

export type ReplOpts = {
  bundlePath: string;
  model: string;
  maxTokens: number;
  apiKey: string;
};

const EXIT_COMMANDS = new Set(['/quit', '/exit', '/q']);

export async function runRepl(opts: ReplOpts): Promise<void> {
  const bundle = await loadBundle(opts.bundlePath);
  const provider = new AnthropicProvider({ apiKey: opts.apiKey });
  const systemPrompt = buildSystemSegments(bundle);
  const history: Message[] = [];

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

  // Intercept SIGINT — without this, readline auto-closes on first Ctrl-C.
  // During streaming, Ctrl-C aborts the request. At the prompt, it closes.
  rl.on('SIGINT', () => {
    if (streamController) {
      streamController.abort();
      return;
    }
    rl.close();
  });

  writeBanner(opts, bundle.state.context !== null);

  while (!closed) {
    const input = await rl.question(chalk.cyan('\nyou> ')).catch(() => null);
    if (input === null) break;
    const trimmed = input.trim();
    if (trimmed === '') continue;
    if (EXIT_COMMANDS.has(trimmed)) break;

    history.push({ role: 'user', content: [{ type: 'text', text: trimmed }] });

    process.stdout.write(chalk.gray('\nharness> '));

    streamController = new AbortController();
    let assistantMessage: AssistantMessage | undefined;
    let terminal: Terminal | undefined;

    try {
      const gen = query({
        provider,
        model: opts.model,
        messages: history,
        systemPrompt,
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
        if (ev && typeof ev === 'object' && 'type' in ev) {
          if (ev.type === 'text_delta') {
            process.stdout.write(ev.text);
          } else if (ev.type === 'assistant_message') {
            assistantMessage = ev.message;
          }
        }
      }
    } finally {
      streamController = null;
    }

    process.stdout.write('\n');

    if (assistantMessage) {
      history.push(assistantMessage);
    }

    if (terminal?.reason === 'error') {
      const msg = terminal.error?.message ?? 'unknown error';
      process.stderr.write(chalk.red(`\n[error] ${msg}\n`));
      // Drop the user message whose turn failed — keeps history coherent
      // for the next turn.
      if (!assistantMessage) history.pop();
    } else if (terminal?.reason === 'interrupted') {
      process.stderr.write(chalk.yellow('\n[interrupted]\n'));
    } else if (terminal?.reason === 'max_turns') {
      process.stderr.write(chalk.yellow('\n[max turns reached]\n'));
    }
  }

  rl.close();
  process.stdout.write(chalk.gray('\ngoodbye.\n'));
}

function writeBanner(opts: ReplOpts, haveContext: boolean): void {
  const lines = [
    chalk.bold('sovereign-ai-harness'),
    chalk.gray(`  bundle: ${opts.bundlePath}`),
    chalk.gray(`  model:  ${opts.model}`),
    chalk.gray(`  context.md: ${haveContext ? 'loaded' : 'not found (prompt will be minimal)'}`),
    chalk.gray('  exit:   /quit, /exit, /q, or Ctrl-D'),
    chalk.gray('  Ctrl-C during streaming interrupts the response'),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
