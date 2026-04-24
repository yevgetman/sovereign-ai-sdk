#!/usr/bin/env bun
// CLI entry. Commander parses flags; dispatches to terminalRepl.
//
// Phase 3 scope: `chat` subcommand (the default) launches a streaming REPL
// against Anthropic with tools and permission gating. Accepts --bundle (or
// HARNESS_BUNDLE env), --model, --max-tokens, --permission-mode. Reads
// ANTHROPIC_API_KEY from env.

import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import type { PermissionMode } from './permissions/types.js';

const VERSION = '0.0.1';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

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

function parsePermissionMode(raw: string): PermissionMode {
  if (raw === 'ask' || raw === 'bypass') return raw;
  throw new InvalidArgumentError("must be 'ask' or 'bypass'");
}

async function main(argv: string[]): Promise<void> {
  const program = new Command()
    .name('sovereign')
    .description('Sovereign AI agent runtime')
    .version(VERSION);

  program
    .command('chat', { isDefault: true })
    .description('Start an interactive chat session against a harness bundle')
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .option('-m, --model <name>', 'model name', DEFAULT_MODEL)
    .option('--max-tokens <n>', 'max tokens per turn', parsePositiveInt, DEFAULT_MAX_TOKENS)
    .option(
      '--permission-mode <mode>',
      "tool permissions: 'ask' prompts before each tool call, 'bypass' runs every tool without asking",
      parsePermissionMode,
      DEFAULT_PERMISSION_MODE,
    )
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const apiKey = resolveApiKey();
      const { runRepl } = await import('./ui/terminalRepl.js');
      await runRepl({
        bundlePath,
        model: opts.model,
        maxTokens: opts.maxTokens,
        permissionMode: opts.permissionMode,
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
