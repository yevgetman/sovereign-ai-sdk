#!/usr/bin/env bun
// CLI entry. Commander parses flags; dispatches to terminalRepl.
//
// Phase 1 scope: `chat` command launches a streaming REPL against Anthropic.
// Accepts --bundle (or HARNESS_BUNDLE env), --model, --max-tokens. Reads
// ANTHROPIC_API_KEY from env. No tools, no persistence — Phase 2+ adds those.

import { Command, InvalidArgumentError } from '@commander-js/extra-typings';

const VERSION = '0.0.1';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;

function resolveBundlePath(cliArg: string | undefined): string {
  if (cliArg) return cliArg;
  const env = process.env.HARNESS_BUNDLE;
  if (env) return env;
  throw new Error('No bundle path provided. Pass --bundle <path> or set HARNESS_BUNDLE env var.');
}

function resolveApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY env var is required for the Anthropic provider.');
  }
  return key;
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return n;
}

async function main(argv: string[]): Promise<void> {
  const program = new Command()
    .name('harness')
    .description('Sovereign AI agent runtime')
    .version(VERSION);

  program
    .command('chat', { isDefault: true })
    .description('Start an interactive chat session against a harness bundle')
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .option('-m, --model <name>', 'model name', DEFAULT_MODEL)
    .option('--max-tokens <n>', 'max tokens per turn', parsePositiveInt, DEFAULT_MAX_TOKENS)
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const apiKey = resolveApiKey();
      const { runRepl } = await import('./ui/terminalRepl.js');
      await runRepl({
        bundlePath,
        model: opts.model,
        maxTokens: opts.maxTokens,
        apiKey,
      });
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(1);
});
