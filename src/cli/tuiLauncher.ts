// Launch the Go TUI as a child process against an in-process HTTP+SSE server.
//
// Boot sequence (Phase 16.1 M3.5):
//   1. Resolve the sov-tui binary path (env override → repo-root bin/ → PATH).
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

export function findTuiBinary(): string | null {
  if (process.env.SOV_TUI_BIN && existsSync(process.env.SOV_TUI_BIN)) {
    return process.env.SOV_TUI_BIN;
  }
  // Walk up from this module until we find a directory containing bin/sov-tui.
  try {
    let dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
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

export type TuiLaunchOptions = {
  /** Optional bundle path; falls through to the default bundle when omitted. */
  bundle?: unknown;
  /** Optional provider override (e.g., 'mock' for the offline smoke). */
  provider?: unknown;
  /** Optional model override. */
  model?: unknown;
  /** Catch-all so Commander option bags don't trip the type. */
  [k: string]: unknown;
};

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function runTuiLauncher(opts: TuiLaunchOptions): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    console.warn('sov: TUI binary not found; falling back to --ui repl.');
    console.warn('     Run `sov upgrade` (requires Go ≥ 1.24 on PATH) to install it.');
    // Caller branches on exit code 70 (EX_SOFTWARE) to re-dispatch to
    // terminalRepl.
    return 70;
  }

  const { buildRuntime } = await import('../server/runtime.js');
  const { startServer } = await import('../server/index.js');

  const runtime = await buildRuntime({
    cwd: process.cwd(),
    ...(pickString(opts.provider) ? { provider: pickString(opts.provider) as string } : {}),
    ...(pickString(opts.model) ? { model: pickString(opts.model) as string } : {}),
    ...(pickString(opts.bundle) ? { bundleRoot: pickString(opts.bundle) as string } : {}),
  });

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

  const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: 'POST',
  });
  if (!createRes.ok) {
    console.error('sov: failed to create session');
    await server.stop();
    await runtime.dispose();
    return 1;
  }
  const { sessionId } = (await createRes.json()) as { sessionId: string };

  // One-line log so the manual smoke can curl the server while it's
  // running. The TUI also has access via app's ENTER handler in M3.7.
  console.error(`sov: tui server listening on 127.0.0.1:${server.port} session=${sessionId}`);

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
