#!/usr/bin/env bun
// CLI entry. Commander parses flags; dispatches to terminalRepl.
//
// Phase 5 scope: `chat` subcommand (the default) launches a streaming REPL
// against a resolved provider. Accepts --provider, --bundle (or
// HARNESS_BUNDLE env), --model, --max-tokens, and --permission-mode.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import type { PermissionMode } from './permissions/types.js';

/**
 * Fill `process.env` from the `.env` at the repo root. Bun auto-loads `.env`
 * from the CWD, but when `sovereign` runs as a globally-linked binary the
 * CWD is usually the caller's project, not this repo. Shell-exported values
 * and CWD-based `.env` still win (this loader only fills unset keys).
 *
 * `realpathSync` resolves the bun-link symlink chain so we find the .env in
 * the actual checkout, not somewhere under ~/.bun/install/.
 */
function loadPackageEnv(): void {
  try {
    const realMain = realpathSync(fileURLToPath(import.meta.url));
    const envPath = join(dirname(dirname(realMain)), '.env');
    if (!existsSync(envPath)) return;
    for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // realpath or read failures: silently skip. resolveApiKey() will throw
    // with a clear message if ANTHROPIC_API_KEY is still unset.
  }
}

loadPackageEnv();

const VERSION = '0.0.1';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

function resolveBundlePath(cliArg: string | undefined): string {
  if (cliArg) return cliArg;
  const env = process.env.HARNESS_BUNDLE;
  if (env) return env;
  throw new Error('No bundle path provided. Pass --bundle <path> or set HARNESS_BUNDLE env var.');
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
    .option('-p, --provider <name>', 'provider name: anthropic, openai, ollama, or openrouter')
    .option('-m, --model <name>', 'model name (overrides provider/config default)')
    .option('--max-tokens <n>', 'max tokens per turn', parsePositiveInt, DEFAULT_MAX_TOKENS)
    .option(
      '--permission-mode <mode>',
      "tool permissions: 'ask' prompts before each tool call, 'bypass' runs every tool without asking",
      parsePermissionMode,
      DEFAULT_PERMISSION_MODE,
    )
    .option('--resume <id>', 'resume a prior session by its UUID')
    .option('--db <path>', 'session database path (default: ~/.harness/sessions.db)')
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const { runRepl } = await import('./ui/terminalRepl.js');
      await runRepl({
        bundlePath,
        ...(opts.provider !== undefined ? { providerName: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        maxTokens: opts.maxTokens,
        permissionMode: opts.permissionMode,
        ...(opts.resume !== undefined ? { resumeId: opts.resume } : {}),
        ...(opts.db !== undefined ? { dbPath: opts.db } : {}),
      });
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(1);
});
