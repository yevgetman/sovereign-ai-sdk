#!/usr/bin/env bun
// CLI entry. Commander parses flags; bare `sov` boots the Go Bubble Tea TUI
// via `runTuiLauncher`. Also defines the `dispatch`, `upgrade`, and other
// subcommands.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import { getDefaultBundlePath } from './bundle/defaultBundle.js';
import { parseProfileFlag } from './cli/profileFlag.js';
import { DEFAULT_PROFILE_NAME, getActiveProfile, getBaseHome } from './config/paths.js';
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
import { VERSION } from './version.js';

/**
 * Fill `process.env` from the `.env` at the repo root. Bun auto-loads `.env`
 * from the CWD, but when `sov` runs as a globally-linked binary the
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

/**
 * Apply the top-level profile flag (or the persisted active profile when no
 * flag is given) by setting `process.env.HARNESS_HOME`. Per Invariant #11
 * this runs before any module that captures HARNESS_HOME at load time, so
 * every downstream `getHarnessHome()` call site lands under the right root.
 */
function resolveAndApplyProfile(argv: string[]): string[] {
  const { flagValue, rest } = parseProfileFlag(argv);
  const resolved = flagValue ?? getActiveProfile();
  if (resolved !== DEFAULT_PROFILE_NAME) {
    process.env.HARNESS_HOME = join(getBaseHome(), 'profiles', resolved);
  }
  return rest;
}

const PARSED_ARGV = resolveAndApplyProfile(process.argv);

const DEFAULT_MAX_TOKENS = 12000;
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';
// Must match DEFAULT_PER_WAKE_TURN_BUDGET exported from src/cli/missionInit.ts.
// Defined here as a literal because missionInit.ts is imported lazily (inside
// the action handler) and Commander's .option() default must be a value, not
// a promise.
const DEFAULT_PER_WAKE_TURN_BUDGET = 10;

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
 * Resolve where to find the harness bundle. Four-step fallthrough (per
 * Phase 10.8):
 *
 *   1. Explicit `--bundle <path>` flag.
 *   2. `HARNESS_BUNDLE` env var.
 *   3. Upward `index.yaml` walk from CWD.
 *   4. Default bundle — `<harness-home>/default-bundle/` (user override)
 *      or shipped `<runtime-repo>/bundle-default/` (fallback).
 *
 * Returns null only when even the default bundle is unreachable, which
 * should be impossible in a healthy install. The REPL handles that
 * case by running as a fully bundleless generic agent.
 */
function resolveBundlePath(cliArg: string | undefined): string | null {
  if (cliArg) return cliArg;
  const env = process.env.HARNESS_BUNDLE;
  if (env) return env;
  const upward = findBundleUpwards(process.cwd());
  if (upward !== null) return upward;
  return getDefaultBundlePath();
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return n;
}

/** Commander helper for repeatable string flags like `--filter`. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePermissionMode(raw: string): PermissionMode {
  if (raw === 'default' || raw === 'ask' || raw === 'bypass') return raw;
  throw new InvalidArgumentError("must be 'default', 'ask', or 'bypass'");
}

async function main(argv: string[]): Promise<void> {
  const program = new Command()
    .name('sov')
    .description('Sovereign AI agent runtime')
    .version(VERSION)
    .option(
      '-p, --profile <name>',
      "scope the run to a named profile under <harness-home>/profiles/<name>/ (use 'default' for the unscoped root)",
    );

  program
    .command('chat', { isDefault: true })
    .description(
      "[deprecated keyword — use bare 'sov'] Start an interactive chat session against a harness bundle (use --agent + --state-dir for scheduled-mission mode)",
    )
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .option('--provider <name>', 'provider name: anthropic, openai, ollama, or openrouter')
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
    .option(
      '--capture-fixture <path>',
      'wrap the provider + tools to record a deterministic-replay fixture at this path on session end',
    )
    .option(
      '--replay-fixture <path>',
      'replay a previously-captured fixture instead of resolving a real provider (no LLM calls)',
    )
    .option(
      '--agent <name>',
      "run as a named agent (uses the agent definition's system prompt and allowed tools)",
    )
    .option(
      '--state-dir <path>',
      'scheduled-mission mode: path to a mission directory (requires --agent with supportsMissionState:true)',
    )
    .action(async (opts) => {
      // Deprecation notice — fired only when 'chat' is explicitly typed, not
      // when the bare `sov` invocation triggers Commander's default action.
      if (process.argv[2] === 'chat') {
        process.stderr.write(
          "[deprecated] 'sov chat' is going away — use bare 'sov' for the interactive TUI, or 'sov dispatch' for headless slash-command testing.\n",
        );
      }

      const { findTuiBinary, runTuiLauncher } = await import('./cli/tuiLauncher.js');
      if (findTuiBinary() === null) {
        process.stderr.write('sov: sov-tui binary not found. Install with:\n');
        process.stderr.write('     bun pm -g trust @yevgetman/sov && sov upgrade\n');
        process.exit(1);
      }

      const code = await runTuiLauncher(opts);
      process.exit(code);
    });

  program
    .command('dispatch')
    .description(
      'Headless slash-command dispatch — boots a minimum context, reads slash commands from stdin (one per line), prints output to stdout, exits on EOF or /quit. Used for mechanical testing of read-only commands; commands that need the session DB, compactor, task manager, or review manager error informatively.',
    )
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const { runDispatch } = await import('./cli/dispatchCommand.js');
      const exitCode = await runDispatch({
        ...(bundlePath !== null ? { bundlePath } : {}),
      });
      process.exit(exitCode);
    });

  program
    .command('drive')
    .description(
      'Headless line-driven LLM conversation — boots the same Hono server as the TUI but emits plain-text events to stdout instead of rendering Bubble Tea. Reads one prompt per stdin line (slash commands routed through /sessions/:id/commands, free text through /sessions/:id/turns). Exits on EOF or /quit. Used by the semantic test suite and any other automation that needs to drive sov non-interactively.',
    )
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .option('--provider <name>', 'provider name: anthropic, openai, ollama, or openrouter')
    .option('-m, --model <name>', 'model name (overrides provider/config default)')
    .option('--max-tokens <n>', 'max tokens per turn', parsePositiveInt, DEFAULT_MAX_TOKENS)
    .option(
      '--permission-mode <mode>',
      "tool permissions: 'default' honors rules/tool checks, 'ask' (auto-denied in drive mode), 'bypass' allows on fallthrough",
      parsePermissionMode,
      DEFAULT_PERMISSION_MODE,
    )
    .option('--resume <id>', 'resume a prior session by its UUID')
    .option('--db <path>', 'session database path (default: ~/.harness/sessions.db)')
    .option('--no-cache', 'disable provider prompt-cache markers for this session')
    .option('--no-preflight', 'skip the startup provider health check')
    .option(
      '--verbose-raw',
      'append raw untruncated tool output below each tool_result line (orthogonal to mode)',
    )
    .action(async (opts) => {
      const { runDriveCommand } = await import('./cli/driveCommand.js');
      const exitCode = await runDriveCommand(opts);
      process.exit(exitCode);
    });

  program
    .command('serve-dev')
    .description('boot the Phase 16.1 HTTP+SSE server on 127.0.0.1 (M1 dev harness)')
    .option('--port <n>', 'explicit port (default: random free port)', parsePositiveInt)
    .action(async (opts) => {
      const { startServer } = await import('./server/index.js');
      const startOpts: { port?: number } = {};
      if (typeof opts.port === 'number') startOpts.port = opts.port;
      const server = await startServer(startOpts);
      process.stdout.write(`sov serve-dev: listening on http://127.0.0.1:${server.port}\n`);
      process.stdout.write('  GET /health\n');
      process.stdout.write('  GET /sessions/<id>/events  (SSE)\n');
      process.stdout.write('Press Ctrl-C to stop.\n');
      process.on('SIGINT', async () => {
        await server.stop();
        process.exit(0);
      });
      process.on('SIGTERM', async () => {
        await server.stop();
        process.exit(0);
      });
    });

  program
    .command('serve')
    .description(
      'Run the OpenAI-compatible HTTP API server (Phase 18). Long-lived; SIGINT/SIGTERM trigger graceful shutdown.',
    )
    .option('--port <n>', 'port (default 8765, env SOV_OPENAI_PORT)', parsePositiveInt)
    .option('--host <addr>', 'host (default 127.0.0.1, env SOV_OPENAI_HOST)')
    .option('--provider <name>', 'provider name: anthropic, openai, ollama, openrouter, or router')
    .option('-m, --model <name>', 'model name (overrides provider/config default)')
    .option('--max-tokens <n>', 'max tokens per provider call', parsePositiveInt)
    .option(
      '--permission-mode <mode>',
      "tool permissions: 'default', 'ask', or 'bypass'",
      parsePermissionMode,
    )
    .option('--no-cron', 'disable the cron tick loop')
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .option('--no-preflight', 'skip the startup provider health check')
    .action(async (opts) => {
      const { readConfig } = await import('./config/store.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const { buildRuntime } = await import('./server/runtime.js');
      const { createOpenAIServer } = await import('./openai/server.js');

      const harnessHome = resolveHarnessHome();
      const config = readConfig();
      const apiKey = process.env.SOV_OPENAI_API_KEY ?? config.openaiServer?.apiKey ?? undefined;
      if (apiKey === undefined || apiKey.length === 0) {
        process.stderr.write(
          'sov serve: API key required.\n' +
            'Set SOV_OPENAI_API_KEY=<key> or run: sov config set openaiServer.apiKey <key>\n',
        );
        process.exit(1);
      }

      const envPortRaw = process.env.SOV_OPENAI_PORT;
      const envPort =
        envPortRaw !== undefined && envPortRaw.length > 0
          ? Number.parseInt(envPortRaw, 10)
          : undefined;
      const port =
        opts.port ??
        (envPort !== undefined && Number.isFinite(envPort) ? envPort : undefined) ??
        config.openaiServer?.port ??
        8765;
      const host =
        opts.host ?? process.env.SOV_OPENAI_HOST ?? config.openaiServer?.host ?? '127.0.0.1';

      const runtime = await buildRuntime({
        cwd: process.cwd(),
        cronEnabled: opts.cron !== false,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.bundle !== undefined ? { bundleRoot: opts.bundle } : {}),
        ...(opts.preflight === false ? { preflight: false } : {}),
      });

      const server = createOpenAIServer({ runtime, apiKey, port, host });

      process.stdout.write(`sov serve: listening on http://${server.host}:${server.port}\n`);
      process.stdout.write(
        `  provider=${runtime.resolvedProvider.transport.name}  model=${runtime.model}\n`,
      );
      process.stdout.write(
        `  cron=${opts.cron !== false ? 'on' : 'off'}  harnessHome=${harnessHome}\n`,
      );

      let shuttingDown = false;
      const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stdout.write(`sov serve: ${signal} received, shutting down...\n`);
        try {
          await server.stop();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`server.stop() failed: ${msg}\n`);
        }
        try {
          await runtime.dispose();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`runtime.dispose() failed: ${msg}\n`);
        }
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));

      // Park forever — the SIGINT/SIGTERM handlers above are the only
      // legal exit paths.
      await new Promise<never>(() => {});
    });

  const configCmd = program
    .command('config')
    .description('Open the interactive config picker (no args) or read/write via subcommands')
    .action(async () => {
      // 2026-05-24 config UX rebuild — the legacy raw-mode picker
      // (`src/ui/configMenu.ts`) was removed; `sov config` now boots a
      // lightweight Hono server + the sov-tui Bubble Tea client in
      // config-only mode (no providers, no preflight, no bundle). The
      // TUI launches straight into the `/config` slash command.
      const { runConfigOnlyMode } = await import('./cli/configMode.js');
      const code = await runConfigOnlyMode();
      process.exit(code);
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

  const profileCmd = program
    .command('profile')
    .description('Manage profile-scoped state roots under <harness-home>/profiles/');

  profileCmd
    .command('list')
    .description("List all profiles (the active one marked with '*')")
    .action(async () => {
      const { listProfiles, formatProfileList } = await import('./cli/profileCommands.js');
      process.stdout.write(formatProfileList(listProfiles()));
    });

  profileCmd
    .command('show')
    .description('Print the active profile name')
    .action(async () => {
      const { getActiveProfile: getActive } = await import('./config/paths.js');
      process.stdout.write(`${getActive()}\n`);
    });

  profileCmd
    .command('create <name>')
    .description('Create a new profile directory under <harness-home>/profiles/<name>/')
    .action(async (name: string) => {
      const { createProfile } = await import('./cli/profileCommands.js');
      const result = createProfile(name);
      const verb = result.alreadyExisted ? 'already exists' : 'created';
      process.stdout.write(`profile '${result.name}' ${verb} at ${result.path}\n`);
    });

  profileCmd
    .command('use <name>')
    .description("Set the persisted active profile (use 'default' to clear)")
    .action(async (name: string) => {
      const { useProfile } = await import('./cli/profileCommands.js');
      const result = useProfile(name);
      process.stdout.write(`active profile is now '${result.name}' (${result.path})\n`);
    });

  profileCmd
    .command('import-default <name>')
    .description('Copy the unscoped default-root config + credentials into a profile')
    .action(async (name: string) => {
      const { importDefaultIntoProfile, formatImportResult } = await import(
        './cli/profileCommands.js'
      );
      const result = importDefaultIntoProfile(name);
      process.stdout.write(formatImportResult(result, name));
    });

  program
    .command('init')
    .description('Bootstrap the current directory into a real harness bundle')
    .option('--force', 'overwrite an existing index.yaml')
    .action(async (opts) => {
      const { runInit, formatInitResult } = await import('./cli/init.js');
      const result = runInit({
        ...(opts.force === true ? { force: true } : {}),
      });
      const out = formatInitResult(result);
      if (result.ok) {
        process.stdout.write(out);
        process.exit(0);
      } else {
        process.stderr.write(out);
        process.exit(1);
      }
    });

  const evalCmd = program
    .command('eval')
    .description('Run golden-task evaluations against a live `sov chat` subprocess');

  evalCmd
    .command('run')
    .description('Run all goldens (or filter via --filter) and report pass/fail + budget verdict')
    .option('--goldens <dir>', 'directory holding *.golden.ts modules', 'evals/goldens')
    .option('--budget <path>', 'budget JSON path', 'evals/budget.json')
    .option('--filter <substr>', 'filter goldens by id/name/category (repeatable)', collect, [])
    .option('--binary <path>', "binary to spawn (default: 'sov')")
    .option('--timeout <ms>', 'per-golden timeout override in milliseconds', parsePositiveInt)
    .option('--include-slow', 'include goldens marked slow:true')
    .option('--keep-sandbox', 'leave each sandbox tempdir on disk for debugging')
    .option(
      '--compare <providers>',
      'comma-separated list of provider names to compare (e.g. anthropic,ollama)',
    )
    .option(
      '--capture <dir>',
      'capture mode — write a deterministic-replay fixture per golden under this directory (one <id>.fixture.json file per golden)',
    )
    .option(
      '--replay <dir>',
      'replay mode — replay each golden against its matching <id>.fixture.json under this directory; no LLM calls',
    )
    .action(async (opts) => {
      const { runEvalCli } = await import('./cli/evalRun.js');
      const compareProviders =
        typeof opts.compare === 'string' && opts.compare.length > 0
          ? opts.compare
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
      const result = await runEvalCli({
        goldensDir: opts.goldens,
        budgetPath: opts.budget,
        ...(Array.isArray(opts.filter) && opts.filter.length > 0 ? { filters: opts.filter } : {}),
        ...(opts.binary !== undefined ? { binary: opts.binary } : {}),
        ...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
        ...(opts.includeSlow === true ? { includeSlow: true } : {}),
        ...(opts.keepSandbox === true ? { keepSandbox: true } : {}),
        ...(compareProviders !== undefined ? { compareProviders } : {}),
        ...(opts.capture !== undefined ? { captureDir: opts.capture } : {}),
        ...(opts.replay !== undefined ? { replayDir: opts.replay } : {}),
      });
      process.exit(result.exitCode);
    });

  const traceCmd = program
    .command('trace')
    .description('Inspect operational traces written under <harness-home>/traces/');

  traceCmd
    .command('show <session-id>')
    .description('Render a session trace as a high-signal summary')
    .action(async (sessionId: string) => {
      const { showTrace } = await import('./cli/traceShow.js');
      const result = showTrace({ sessionId });
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        process.exit(1);
      }
      process.stdout.write(result.output);
      if (!result.output.endsWith('\n')) process.stdout.write('\n');
    });

  const learningCmd = program
    .command('learning')
    .description('Inspect and maintain the per-project instinct corpus (Phase 13.4)');

  learningCmd
    .command('status')
    .description('Per-project instinct counts + confidence histogram')
    .option('--project <id>', 'limit to a single project id (default: all projects)')
    .action(async (opts) => {
      const { getLearningStatus, formatLearningStatus } = await import('./cli/learningStatus.js');
      const statuses = getLearningStatus({
        ...(opts.project !== undefined ? { project: opts.project } : {}),
      });
      process.stdout.write(formatLearningStatus(statuses));
    });

  learningCmd
    .command('prune')
    .description('Drop sub-threshold instincts past their aging window')
    .option('--project <id>', 'limit to a single project id (default: all projects)')
    .option('--dry-run', 'list candidates without removing them')
    .action(async (opts) => {
      const { runLearningPrune, formatPruneResult } = await import('./cli/learningPrune.js');
      const result = runLearningPrune({
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.dryRun === true ? { dryRun: true } : {}),
      });
      process.stdout.write(formatPruneResult(result));
    });

  learningCmd
    .command('export <project-id>')
    .description('Emit each instinct as a .md file (--output <dir>) or summary count (no --output)')
    .option('--output <dir>', 'directory to write per-instinct .md files into')
    .action(async (projectId: string, opts) => {
      const { runLearningExport, formatExportResult } = await import('./cli/learningExport.js');
      const result = runLearningExport({
        projectId,
        ...(opts.output !== undefined ? { output: opts.output } : {}),
      });
      process.stdout.write(formatExportResult(result));
    });

  program
    .command('upgrade')
    .description('Pull the latest sov from the private repo and re-link the global binary')
    .option('--ref <ref>', 'branch, tag, or commit to install (default: the remote default branch)')
    .option('--dry-run', 'print the bun commands without running them')
    .option(
      '--skip-uninstall',
      "skip the pre-uninstall step (faster, but Bun's git-cache may serve a stale SHA)",
    )
    .option(
      '--purge-cache',
      'wipe ~/.bun/install/cache before install [now the default — preserved for back-compat; use --keep-cache to opt out]',
    )
    .option(
      '--keep-cache',
      'preserve ~/.bun/install/cache (other Bun packages keep their cached manifests; risk: bun may re-install the same stale SHA)',
    )
    .action(async (opts) => {
      const { runUpgrade } = await import('./cli/upgrade.js');
      const result = runUpgrade({
        ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        ...(opts.skipUninstall === true ? { skipUninstall: true } : {}),
        ...(opts.purgeCache === true ? { purgeCache: true } : {}),
        ...(opts.keepCache === true ? { keepCache: true } : {}),
      });
      process.exit(result.exitCode);
    });

  const missionCmd = program.command('mission').description('Manage scheduled autonomous missions');

  missionCmd
    .command('init <dir>')
    .description('Scaffold a new mission directory with mission.md, plan.md, notes.md, state.json')
    .option('--goal <text>', 'mission goal statement (required)')
    .option(
      '--per-wake-turns <n>',
      'tool-call budget per wake',
      parsePositiveInt,
      DEFAULT_PER_WAKE_TURN_BUDGET,
    )
    .option('--force', 'overwrite an existing state.json')
    .action(async (dir: string, opts) => {
      if (opts.goal === undefined) {
        process.stderr.write('sov mission init: --goal <text> is required\n');
        process.exit(1);
      }
      const { runMissionInit, formatMissionInitResult } = await import('./cli/missionInit.js');
      const result = runMissionInit({
        dir,
        goal: opts.goal,
        ...(opts.perWakeTurns !== undefined ? { perWakeTurnBudget: opts.perWakeTurns } : {}),
        ...(opts.force === true ? { force: true } : {}),
      });
      const out = formatMissionInitResult(result);
      if (result.ok) {
        process.stdout.write(out);
        process.exit(0);
      } else {
        process.stderr.write(out);
        process.exit(1);
      }
    });

  const cronCmd = program.command('cron').description('Manage scheduled jobs (Phase 17)');

  cronCmd
    .command('add')
    .description('Add a new cron job')
    .requiredOption(
      '--schedule <spec>',
      'schedule (relative "5m", interval "every 10m", cron "*/15 * * * *", or ISO "2026-05-23T10:00:00Z")',
    )
    .requiredOption('--prompt <text>', 'operator prompt to send when the job fires')
    .option('--deliver <target>', 'delivery target', 'local')
    .option('--skills <names...>', 'skills to chain in order (space-separated)')
    .option('--script <path>', 'pre-agent script (relative to <harness-home>/cron/scripts/)')
    .action(async (opts) => {
      const { runCronAdd, formatJobLine } = await import('./cli/cronCommand.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const job = runCronAdd(resolveHarnessHome(), {
        schedule: opts.schedule,
        prompt: opts.prompt,
        deliver: opts.deliver,
        skills: Array.isArray(opts.skills) ? opts.skills : [],
        ...(opts.script !== undefined ? { script: opts.script } : {}),
      });
      process.stdout.write(`added job ${job.id}\n`);
      process.stdout.write(`${formatJobLine(job)}\n`);
    });

  cronCmd
    .command('list')
    .description('List all cron jobs')
    .action(async () => {
      const { runCronList, formatJobLine } = await import('./cli/cronCommand.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const jobs = runCronList(resolveHarnessHome());
      if (jobs.length === 0) {
        process.stdout.write('no cron jobs\n');
        return;
      }
      for (const job of jobs) process.stdout.write(`${formatJobLine(job)}\n`);
    });

  cronCmd
    .command('show <id>')
    .description('Show full detail for a cron job')
    .action(async (id: string) => {
      const { runCronShow } = await import('./cli/cronCommand.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const job = runCronShow(resolveHarnessHome(), id);
      if (!job) {
        process.stderr.write(`no job with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
    });

  cronCmd
    .command('pause <id>')
    .description('Pause a cron job (job stays in the registry; tick skips it)')
    .action(async (id: string) => {
      const { runCronPause } = await import('./cli/cronCommand.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const job = runCronPause(resolveHarnessHome(), id);
      if (!job) {
        process.stderr.write(`no job ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`paused ${job.id}\n`);
    });

  cronCmd
    .command('resume <id>')
    .description('Resume a paused cron job')
    .action(async (id: string) => {
      const { runCronResume } = await import('./cli/cronCommand.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const job = runCronResume(resolveHarnessHome(), id);
      if (!job) {
        process.stderr.write(`no job ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`resumed ${job.id}\n`);
    });

  cronCmd
    .command('delete <id>')
    .description('Delete a cron job')
    .action(async (id: string) => {
      const { runCronDelete } = await import('./cli/cronCommand.js');
      const { resolveHarnessHome } = await import('./config/paths.js');
      const ok = runCronDelete(resolveHarnessHome(), id);
      if (!ok) {
        process.stderr.write(`no job ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`deleted ${id}\n`);
    });

  cronCmd
    .command('run <id>')
    .description('Manually fire this specific cron job once (bypasses schedule + enabled checks)')
    .action(async (id: string) => {
      // Strict single-fire: forceRunJob runs ONLY the named job, regardless
      // of its nextRunAt or enabled flag. The id arg is validated by
      // forceRunJob itself (returns ok:false on missing id).
      const { resolveHarnessHome } = await import('./config/paths.js');
      const home = resolveHarnessHome();
      const { buildRuntime } = await import('./server/runtime.js');
      const { createProductionCronRunner } = await import('./cron/wiring.js');
      const runtime = await buildRuntime({ cwd: process.cwd(), cronEnabled: false });
      try {
        const runner = createProductionCronRunner(runtime, home);
        const result = await runner.forceRunJob(id);
        if (!result.ok) {
          process.stderr.write(`run failed: ${result.error ?? 'unknown error'}\n`);
          process.exit(1);
        }
        process.stdout.write(
          `fired job ${id.slice(0, 8)}; check 'sov cron show ${id.slice(0, 8)}' for the result\n`,
        );
      } finally {
        await runtime.dispose();
      }
    });

  cronCmd
    .command('tick')
    .description('Manually run one tick cycle against every due job (debugging)')
    .action(async () => {
      const { resolveHarnessHome } = await import('./config/paths.js');
      const { buildRuntime } = await import('./server/runtime.js');
      const { createProductionCronRunner } = await import('./cron/wiring.js');
      const runtime = await buildRuntime({ cwd: process.cwd(), cronEnabled: false });
      try {
        const runner = createProductionCronRunner(runtime, resolveHarnessHome());
        await runner.runDueJobs();
        process.stdout.write('tick complete\n');
      } finally {
        await runtime.dispose();
      }
    });

  program
    .command('daemon')
    .description('Start the harness daemon for the active profile.')
    .action(async () => {
      const { startDaemon } = await import('./daemon/runner.js');
      let handle: ReturnType<typeof startDaemon> | null = null;
      try {
        handle = startDaemon();
        process.stderr.write(`[daemon] started (PID ${process.pid})\n`);
        const stop = (): void => {
          handle?.shutdown();
          process.exit(0);
        };
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
        await new Promise<never>(() => {});
      } catch (err) {
        process.stderr.write(`[daemon] ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  await program.parseAsync(argv);
}

main(PARSED_ARGV).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`sov: ${msg}\n`);
  process.exit(1);
});
