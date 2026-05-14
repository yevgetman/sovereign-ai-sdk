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

export function findTuiBinary(): string | null {
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

// TODO M4+: integration test that mocks child_process.spawn + startServer
// and exercises this function end-to-end (build runtime → start server →
// POST /sessions → spawn child → settle on child exit). Currently only
// findTuiBinary[From]() has coverage; the orchestration here is verified by
// the manual smoke alone.
export async function runTuiLauncher(opts: TuiLaunchOptions): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    // Earlier text claimed "falling back to --ui repl" but main.ts exits
    // immediately on the returned 70 — there is no fallback wired today.
    // The warning now reflects the actual remediation path.
    console.warn(
      'sov: TUI binary not found — install Go ≥ 1.24 and run `sov upgrade` (with `bun pm -g trust @yevgetman/sov`).',
    );
    console.warn('     For the readline REPL, omit `--ui tui` (or pass `--ui repl`).');
    // Caller (main.ts) propagates this exit code; no foreground fallback.
    return 70;
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

  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  try {
    runtime = await buildRuntime(buildOpts);
  } catch (err) {
    const { PreflightError, SessionNotFoundError } = await import('../server/errors.js');
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
        '     list sessions with `sov --ui repl` then /sessions, or omit --resume to start a fresh one.\n',
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

  // One-line log so the manual smoke can curl the server while it's
  // running. The TUI also has access via app's ENTER handler in M3.7.
  // Use process.stderr.write directly — this isn't an error, just an
  // informational line we want kept off stdout (TUI may follow shortly
  // on the same fd if `stdio: 'inherit'` mixes them).
  process.stderr.write(
    `sov: tui server listening on 127.0.0.1:${server.port} session=${sessionId}\n`,
  );

  const spawnOpts: SpawnOptions = { stdio: 'inherit' };
  const child = spawn(
    binary,
    ['--port', String(server.port), '--session-id', sessionId],
    spawnOpts,
  );

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
