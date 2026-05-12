// Phase 16.0c SD1 — headless slash-command driver. Boots the shared
// harness context (see src/commands/dispatchHost.ts), prints a ready
// marker, then reads slash commands from stdin one line at a time.
// Each command's output is flushed to stdout followed by a deterministic
// turn separator so the semantic test driver can split per-turn output.
//
// Exits cleanly on stdin EOF or when a command (e.g. /quit) calls
// requestExit. Boot failures and unhandled errors exit non-zero — slash
// commands themselves (including unknown commands) NEVER exit non-zero;
// their `result.output` is always printed verbatim.

import { createInterface } from 'node:readline';
import { buildHarnessContext } from '../commands/dispatchHost.js';
import { dispatchSlashCommand } from '../commands/registry.js';

const SESSION_ID_PREFIX = 'dispatch';
export const READY_MARKER = '--- ready ---';
export const TURN_SEPARATOR = '--- end-of-turn ---';

export type RunDispatchOpts = {
  readonly bundlePath?: string;
  /** Override stdin/stdout for tests. Defaults to process.stdin/stdout. */
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
};

/**
 * Run the headless dispatch loop. Resolves to a process exit code:
 *   0 — clean EOF or /quit
 *   1 — boot error or unhandled exception inside dispatch
 */
export async function runDispatch(opts: RunDispatchOpts = {}): Promise<number> {
  const stdout: NodeJS.WritableStream = opts.stdout ?? process.stdout;
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;

  let exitRequested = false;
  let harness: Awaited<ReturnType<typeof buildHarnessContext>> | undefined;

  try {
    harness = await buildHarnessContext({
      ...(opts.bundlePath !== undefined ? { bundlePath: opts.bundlePath } : {}),
      sessionIdPrefix: SESSION_ID_PREFIX,
      // Headless mode: no live UI cost tracking; /cost reports zeros.
      getLatestCost: () => undefined,
      onExitRequest: () => {
        exitRequested = true;
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dispatch: boot failed: ${msg}\n`);
    return 1;
  }

  // Boot complete — the test driver waits for this marker.
  stdout.write(`${READY_MARKER}\n`);

  try {
    const rl = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const rawLine of rl) {
      if (exitRequested) break;
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const result = await dispatchSlashCommand(line, harness.commandContext);
      if (result.output.length > 0) {
        stdout.write(result.output);
        if (!result.output.endsWith('\n')) stdout.write('\n');
      }
      stdout.write(`${TURN_SEPARATOR}\n`);
      if (exitRequested) break;
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dispatch: ${msg}\n`);
    return 1;
  } finally {
    await harness.cleanup();
  }
}
