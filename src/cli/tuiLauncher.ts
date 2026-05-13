// Launch the Go TUI as a child process against an in-process HTTP+SSE server.
//
// Boot sequence:
//   1. Resolve the sov-tui binary path (env override → repo-root bin/ → PATH).
//   2. If unresolved, print fallback warning + run terminalRepl.
//   3. Start the HTTP server on a free localhost port.
//   4. Create a session (M2: synthetic ID since /sessions POST lands in M3).
//   5. Spawn sov-tui --port <p> --session-id <s>, inherit stdio.
//   6. When the child exits, stop the server and return its exit code.

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
  // No PATH lookup in M2; postinstall is the supported install path.
  return null;
}

export type TuiLaunchOptions = Record<string, unknown>;

export async function runTuiLauncher(_opts: TuiLaunchOptions): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    console.warn('sov: TUI binary not found; falling back to --ui repl.');
    console.warn('     Run `sov upgrade` (requires Go ≥ 1.24 on PATH) to install it.');
    // M2 leaves the fallback to the caller. The chat .action() should
    // detect this exit code and re-dispatch to terminalRepl; for now we
    // return 70 (EX_SOFTWARE) so the caller can branch.
    return 70;
  }

  const { startServer } = await import('../server/index.js');
  const server = await startServer();
  const sessionID = `s_m2_${Date.now()}`;
  const spawnOpts: SpawnOptions = { stdio: 'inherit' };
  const child = spawn(
    binary,
    ['--port', String(server.port), '--session-id', sessionID],
    spawnOpts,
  );

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const settle = async (code: number): Promise<void> => {
      if (resolved) return;
      resolved = true;
      await server.stop();
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
