// Launch the Go TUI as a child process against an in-process HTTP+SSE server.
//
// Boot sequence (Phase 16.1 M3.5):
//   1. Resolve the sov-tui binary path (SOV_TUI_BIN override → upward
//      walk for a bin/sov-tui sibling; postinstall is the supported install).
//   2. If unresolved, print fallback warning + return EX_SOFTWARE.
//   3. Build a real runtime (sessionDb, toolPool, systemSegments, provider).
//   4. Start the HTTP server with the runtime; mounts /sessions, /turns,
//      /sessions/:id/events on a free localhost port.
//   5. POST /sessions to get a real session ID rooted in SessionDb.
//   6. Spawn sov-tui --port <p> --session-id <s>, inherit stdio.
//   7. When the child exits, stop the server, dispose the runtime, and
//      return the child's exit code.
//
// The launcher is the only place that owns lifecycle of (runtime, server,
// child). When any of the three fails, the others must be torn down so
// the next sov invocation starts cleanly.

import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreflightError, SessionNotFoundError } from '../server/errors.js';

/**
 * Walk up from `startDir` looking for a bin/sov-tui sibling.
 *
 * Exposed as a separate entrypoint so tests can pass a directory that
 * provably has no bin/sov-tui anywhere on the path (e.g. /tmp) and
 * deterministically observe the null branch. The default no-arg
 * `findTuiBinary()` keeps the production search behavior — walk from
 * this module's own directory.
 */
export function findTuiBinaryFrom(startDir: string): string | null {
  if (process.env.SOV_TUI_BIN && existsSync(process.env.SOV_TUI_BIN)) {
    return process.env.SOV_TUI_BIN;
  }
  try {
    let dir = startDir;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'bin', 'sov-tui');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // realpath failures are rare; fall through.
  }
  // No PATH lookup; postinstall is the supported install path.
  return null;
}

/**
 * Resolve the sov-tui binary. Tried in order:
 *   1. SOV_TUI_BIN env var (test seam + power-user override).
 *   2. Phase 21 — binary install mode: sov-tui as sibling of sov in
 *      <dirname(execPath)>/. Discovered via process.execPath which
 *      resolves to the on-disk executable in both bun (source) and
 *      bun --compile (binary) modes — but the sibling only exists
 *      under ~/.sov/bin/ in binary mode.
 *   3. Source mode: walk up from this module's URL looking for a
 *      bin/sov-tui sibling (the postinstall artifact path).
 *
 * The optional opts arg is a test seam: production passes nothing.
 */
export function findTuiBinary(opts: { execPath?: string } = {}): string | null {
  if (process.env.SOV_TUI_BIN && existsSync(process.env.SOV_TUI_BIN)) {
    return process.env.SOV_TUI_BIN;
  }

  // Binary install mode.
  try {
    const execPath = opts.execPath ?? process.execPath;
    const execDir = dirname(realpathSync(execPath));
    const sibling = join(execDir, 'sov-tui');
    if (existsSync(sibling)) return sibling;
  } catch {
    // fall through
  }

  // Source mode.
  try {
    return findTuiBinaryFrom(dirname(realpathSync(fileURLToPath(import.meta.url))));
  } catch {
    return null;
  }
}

export type TuiLaunchOptions = {
  /** Optional bundle path; falls through to the default bundle when omitted. */
  bundle?: unknown;
  /** Optional provider override (e.g., 'mock' for the offline smoke). */
  provider?: unknown;
  /** Optional model override. */
  model?: unknown;
  /** Permission cascade override. Forwarded verbatim to buildRuntime;
   *  the runtime layered-settings cascade fires when omitted. */
  permissionMode?: unknown;
  /** Max tokens per provider call. Defaults handled in buildRuntime. */
  maxTokens?: unknown;
  /** Explicit sessionDb path override. */
  db?: unknown;
  /** Resume a prior session by UUID. When set, the launcher skips the
   *  POST /sessions step and uses the runtime-validated id directly. */
  resume?: unknown;
  /** CLI --no-cache → opts.cache === false; otherwise omitted/true. */
  cache?: unknown;
  /** CLI --no-preflight → opts.preflight === false; otherwise omitted/true. */
  preflight?: unknown;
  /** Capture-fixture output path. Wires through buildRuntime as
   *  `captureFixturePath`. M8 T2 wired the runtime side; this launcher
   *  field threads the CLI flag the rest of the way. Mutually exclusive
   *  with `replayFixture` — buildRuntime throws when both are present. */
  captureFixture?: unknown;
  /** Replay-fixture input path. Wires through buildRuntime as
   *  `replayFixturePath`. Mutually exclusive with `captureFixture`. */
  replayFixture?: unknown;
  // Deferred subsystems — accepted-and-warned (not wired until later milestones).
  /** Transcript output path. Targeting M7. */
  transcript?: unknown;
  /** Agent name override. Targeting M7. */
  agent?: unknown;
  /** State directory override. Targeting M7. */
  stateDir?: unknown;
  /** Verbose logging flag. Targeting M9. */
  verbose?: unknown;
  /** Catch-all so Commander option bags don't trip the type. */
  [k: string]: unknown;
};

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickPermissionMode(value: unknown): 'default' | 'ask' | 'bypass' | undefined {
  if (value === 'default' || value === 'ask' || value === 'bypass') return value;
  return undefined;
}

export async function runTuiLauncher(opts: TuiLaunchOptions): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    // Defensive guard. Post-M13, main.ts hard-errors before invoking the
    // launcher when the binary is missing — this branch is unreachable
    // from the bare `sov` flow but kept as belt-and-suspenders for direct
    // importers of runTuiLauncher (tests, future callers).
    console.warn(
      'sov: sov-tui binary not found — install Go ≥ 1.24 and run `bun pm -g trust @yevgetman/sov && sov upgrade`.',
    );
    return 70;
  }

  // M8 T3 — capture/replay are mutually exclusive at the runtime layer
  // (buildRuntime throws). Pre-check here for a user-facing stderr
  // message before any side effects (server boot, runtime build).
  const captureFixturePath = pickString(opts.captureFixture);
  const replayFixturePath = pickString(opts.replayFixture);
  if (captureFixturePath !== undefined && replayFixturePath !== undefined) {
    process.stderr.write('sov: --capture-fixture and --replay-fixture are mutually exclusive.\n');
    return 2;
  }

  // Flags whose subsystem lands in a later milestone — warn so users
  // aren't silently surprised by missing behavior. Per Postmortem Rule 3:
  // audit before declaring parity; the gap is explicit here.
  // --capture-fixture / --replay-fixture were deferred-warned through M8 T2
  // close-out; they now flow through buildRuntime below (M8 T3 — captureFixturePath
  // / replayFixturePath threading) and are NOT in this list.
  const deferredFlagWarnings: ReadonlyArray<{
    flag: string;
    opt: keyof TuiLaunchOptions;
    milestone: string;
  }> = [
    { flag: '--transcript', opt: 'transcript', milestone: 'M7' },
    { flag: '--agent', opt: 'agent', milestone: 'M7' },
    { flag: '--state-dir', opt: 'stateDir', milestone: 'M7' },
    // ux-fixes 2026-05-22: --verbose is now wired through as
    // --verbose-raw to sov-tui (orthogonal raw escape hatch alongside
    // ui.toolOutput.mode). Removed from the deferred-warnings list.
    // Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
  ];
  for (const { flag, opt, milestone } of deferredFlagWarnings) {
    const value = opts[opt];
    if (value !== undefined && value !== false) {
      process.stderr.write(
        `sov: ${flag} is not yet supported with --ui tui (targeting milestone ${milestone}); continuing without it.\n`,
      );
    }
  }

  const { buildRuntime } = await import('../server/runtime.js');
  const { startServer } = await import('../server/index.js');

  // Stage every CLI flag whose subsystem is wired through buildRuntime.
  // Each field is added only when present so RuntimeOptions defaults
  // (e.g. permissionMode cascade, maxTokens=12000) fire correctly.
  const buildOpts: Parameters<typeof buildRuntime>[0] = {
    cwd: process.cwd(),
  };
  const bundle = pickString(opts.bundle);
  if (bundle !== undefined) buildOpts.bundleRoot = bundle;
  const provider = pickString(opts.provider);
  if (provider !== undefined) buildOpts.provider = provider;
  const model = pickString(opts.model);
  if (model !== undefined) buildOpts.model = model;
  const permissionMode = pickPermissionMode(opts.permissionMode);
  if (permissionMode !== undefined) buildOpts.permissionMode = permissionMode;
  const maxTokens = pickNumber(opts.maxTokens);
  if (maxTokens !== undefined) buildOpts.maxTokens = maxTokens;
  const db = pickString(opts.db);
  if (db !== undefined) buildOpts.dbPath = db;
  const resume = pickString(opts.resume);
  if (resume !== undefined) buildOpts.resumeId = resume;
  // CLI semantics: --no-cache sets opts.cache === false (Commander
  // convention); any other state → leave cacheEnabled at default-on.
  if (pickBoolean(opts.cache) === false) buildOpts.cacheEnabled = false;
  if (pickBoolean(opts.preflight) === false) buildOpts.preflight = false;
  // M8 T3 — capture/replay fixtures. The mutex pre-check above runs
  // before this so only one is ever non-undefined.
  if (captureFixturePath !== undefined) buildOpts.captureFixturePath = captureFixturePath;
  if (replayFixturePath !== undefined) buildOpts.replayFixturePath = replayFixturePath;

  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  try {
    runtime = await buildRuntime(buildOpts);
  } catch (err) {
    if (err instanceof PreflightError) {
      process.stderr.write(`sov: provider preflight failed (${err.kind}): ${err.message}\n`);
      process.stderr.write(
        '     run with --no-preflight to skip this check, or fix the underlying credential/quota issue.\n',
      );
      return 1;
    }
    if (err instanceof SessionNotFoundError) {
      process.stderr.write(`sov: ${err.message}\n`);
      process.stderr.write(
        '     omit --resume to start a fresh session, or pick a valid session id from `sov`.\n',
      );
      return 1;
    }
    throw err;
  }

  let server: { port: number; stop: () => Promise<void> } | null = null;
  try {
    server = await startServer({ runtime });
  } catch (err) {
    console.error(
      `sov: failed to start server: ${err instanceof Error ? err.message : String(err)}`,
    );
    await runtime.dispose();
    return 1;
  }

  // --resume case: buildRuntime already validated the id against sessionDb
  // and threw SessionNotFoundError above on mismatch. Skip POST /sessions
  // entirely so we don't allocate a parallel session id the TUI ignores.
  let sessionId: string;
  if (runtime.resumeId !== undefined) {
    sessionId = runtime.resumeId;
  } else {
    try {
      const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: 'POST',
      });
      if (!createRes.ok) {
        throw new Error(`POST /sessions returned ${createRes.status}`);
      }
      const body = (await createRes.json()) as { sessionId: string };
      sessionId = body.sessionId;
    } catch (err) {
      console.error(
        `sov: failed to create session: ${err instanceof Error ? err.message : String(err)}`,
      );
      await server.stop();
      await runtime.dispose();
      return 1;
    }
  }

  // ux-fixes 2026-05-22: removed the "sov: tui server listening on
  // 127.0.0.1:PORT session=..." stderr line that printed above the
  // splash. It was useful as a launch diagnostic during early Phase
  // 16.1, but the production user sees it as boot noise. The TUI no
  // longer needs the user to know the port to attach (it boots its
  // own server side-process). If diagnostic debugging is needed, add
  // an opt-in --debug or SOV_DEBUG=1 surface later.
  //
  // ux-fixes round 3: forward model + provider so sov-tui's splash card
  // and status line render the real values from the first frame instead
  // of the "?" placeholder. The TUI has no /sessions/:id pre-fetch yet
  // and the status_update event doesn't carry model/provider — passing
  // them as boot-time CLI args sidesteps both gaps.
  // Phase 21: also forward the harness version (from src/version.ts)
  // so the splash card renders the runtime's actual version instead of
  // a hardcoded literal. The Go TUI can't read package.json or the
  // VERSION export, so the launcher is the sole bridge.
  const { VERSION } = await import('../version.js');

  // ux-fixes 2026-05-22 — forward the tool-output rendering mode +
  // truncation cap from user-settings so sov-tui's tool_result handler
  // picks the right mode at boot. Default 'compact' (one-liner per
  // tool call); 'detailed' opts into the bordered ToolCard with output
  // capped to inlineLines. The -v / --verbose flag is orthogonal —
  // forwarded as --verbose-raw so the Go side can print raw
  // untruncated output below either mode's rendering.
  // Spec: docs/specs/2026-05-22-tui-tool-call-abstraction-design.md.
  const { readConfig } = await import('../config/store.js');
  const userSettings = readConfig();
  const toolOutputMode = userSettings.ui?.toolOutput?.mode ?? 'compact';
  const toolOutputInlineLines = userSettings.ui?.toolOutput?.inlineLines ?? 10;
  const verboseRaw = pickBoolean(opts.verbose) === true;

  // 2026-05-24 patch — surface task-routing status + active preset in
  // the bottom status line so the user knows it's on (and which named
  // preset is in effect, when detectable). detectActivePreset returns
  // undefined when routing is off; the TUI then falls back to the
  // default profile-name display.
  const { detectActivePreset } = await import('../config/presets.js');
  const activePreset = detectActivePreset(userSettings);

  const tuiArgs = [
    '--port',
    String(server.port),
    '--session-id',
    sessionId,
    '--model',
    runtime.model,
    '--provider',
    runtime.resolvedProvider.transport.name,
    '--harness-version',
    VERSION,
    '--tool-output-mode',
    toolOutputMode,
    '--tool-output-inline-lines',
    String(toolOutputInlineLines),
  ];
  if (verboseRaw) {
    tuiArgs.push('--verbose-raw');
  }
  if (activePreset !== undefined) {
    tuiArgs.push('--task-router', activePreset);
  }
  // 2026-05-24 patch — debug mode. When enabled (umbrella switch or
  // any child capability), delegator atom lines surface lane
  // provider/model in brackets so users see exactly which model
  // handled a given atom. Tied to userSettings.debugMode.enabled or
  // the transcript switch (both imply the user wants visibility).
  const debugModeOn =
    userSettings.debugMode?.enabled === true || userSettings.debugMode?.transcript === true;
  if (debugModeOn) {
    tuiArgs.push('--debug-mode');
  }
  const spawnOpts: SpawnOptions = { stdio: 'inherit' };
  const child = spawn(binary, tuiArgs, spawnOpts);

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const settle = async (code: number): Promise<void> => {
      if (resolved) return;
      resolved = true;
      if (server) await server.stop();
      await runtime.dispose();
      resolve(code);
    };
    child.on('error', (err) => {
      console.error(`sov: failed to launch TUI: ${err.message}`);
      void settle(1);
    });
    child.on('exit', (code) => {
      void settle(code ?? 0);
    });
  });
}
