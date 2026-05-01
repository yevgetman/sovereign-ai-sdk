#!/usr/bin/env bun
// CLI entry. Commander parses flags; dispatches to terminalRepl.
//
// Phase 5 scope: `chat` subcommand (the default) launches a streaming REPL
// against a resolved provider. Accepts --provider, --bundle (or
// HARNESS_BUNDLE env), --model, --max-tokens, --permission-mode, and
// --no-cache.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import {
  formatValue,
  getAt,
  parseValueLiteral,
  readConfig,
  redactSecrets,
  resolveConfigPath,
  setAt,
  unsetAt,
  writeConfig,
} from './config/store.js';
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
const DEFAULT_MAX_TOKENS = 12000;
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/**
 * Walk up from `start` looking for a directory that contains `index.yaml`
 * (the bundle manifest marker — see src/bundle/loader.ts). Returns the first
 * match, or null if we hit the filesystem root without finding one.
 */
function findBundleUpwards(start: string): string | null {
  let dir = start;
  const { root } = parsePath(dir);
  while (true) {
    if (existsSync(join(dir, 'index.yaml'))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve where to find the harness bundle. Returns null when no bundle is
 * provided via flag/env and none is found by walking up from CWD; the REPL
 * then runs as a generic agent with no bundle context attached.
 */
function resolveBundlePath(cliArg: string | undefined): string | null {
  if (cliArg) return cliArg;
  const env = process.env.HARNESS_BUNDLE;
  if (env) return env;
  return findBundleUpwards(process.cwd());
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return n;
}

function parsePermissionMode(raw: string): PermissionMode {
  if (raw === 'default' || raw === 'ask' || raw === 'bypass') return raw;
  throw new InvalidArgumentError("must be 'default', 'ask', or 'bypass'");
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
      "tool permissions: 'default' honors rules/tool checks, 'ask' prompts on fallthrough, 'bypass' allows on fallthrough",
      parsePermissionMode,
      DEFAULT_PERMISSION_MODE,
    )
    .option('--resume <id>', 'resume a prior session by its UUID')
    .option('--db <path>', 'session database path (default: ~/.harness/sessions.db)')
    .option('--no-cache', 'disable provider prompt-cache markers for this session')
    .option('--no-preflight', 'skip the startup provider health check')
    .option('--transcript <path>', 'write a redacted JSONL terminal/event transcript')
    .option('-v, --verbose', 'show full tool-result previews instead of one-line summaries')
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const { runRepl } = await import('./ui/terminalRepl.js');
      await runRepl({
        ...(bundlePath !== null ? { bundlePath } : {}),
        ...(opts.provider !== undefined ? { providerName: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        maxTokens: opts.maxTokens,
        permissionMode: opts.permissionMode,
        ...(opts.resume !== undefined ? { resumeId: opts.resume } : {}),
        ...(opts.db !== undefined ? { dbPath: opts.db } : {}),
        ...(opts.cache === false ? { noCache: true } : {}),
        preflight: opts.preflight !== false,
        ...(opts.transcript !== undefined ? { transcriptPath: opts.transcript } : {}),
        ...(opts.verbose === true ? { verbose: true } : {}),
      });
    });

  const configCmd = program
    .command('config')
    .description('Read or write user-level config (no args opens an interactive picker)')
    .action(async () => {
      const { runConfigMenu } = await import('./ui/configMenu.js');
      await runConfigMenu();
    });

  configCmd
    .command('show')
    .description('Print the current config (secrets redacted)')
    .action(() => {
      const settings = readConfig();
      process.stdout.write(`${JSON.stringify(redactSecrets(settings), null, 2)}\n`);
    });

  configCmd
    .command('path')
    .description('Print the resolved config file path')
    .action(() => {
      process.stdout.write(`${resolveConfigPath()}\n`);
    });

  configCmd
    .command('get <dotpath>')
    .description('Print the value at the given dot-path (secrets redacted)')
    .action((dotpath: string) => {
      const settings = readConfig();
      const value = getAt(redactSecrets(settings), dotpath);
      process.stdout.write(`${formatValue(value)}\n`);
    });

  configCmd
    .command('set <dotpath> <value>')
    .description('Set a value at the given dot-path; literals are auto-parsed')
    .action((dotpath: string, raw: string) => {
      const current = readConfig();
      const next = setAt(current, dotpath, parseValueLiteral(raw));
      writeConfig(next);
      process.stdout.write(`set ${dotpath}\n`);
    });

  configCmd
    .command('unset <dotpath>')
    .description('Remove the value at the given dot-path')
    .action((dotpath: string) => {
      const current = readConfig();
      const next = unsetAt(current, dotpath);
      writeConfig(next);
      process.stdout.write(`unset ${dotpath}\n`);
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(1);
});
