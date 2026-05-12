// Process driver — spawns the binary's headless `dispatch` subcommand,
// pipes each prompt line into stdin, captures stdout/stderr, and returns
// an ANSI-stripped transcript. Never imports anything from src/; the only
// thing it knows about the harness is that `dispatch` is a stdin-driven
// REPL that emits a `READY_MARKER` after boot and a `TURN_SEPARATOR`
// after every command's output.
//
// Phase 16.0c SD2 rewire: `sov chat` no longer exists; the driver now
// targets the slash-command-only headless surface. Tests that need to
// drive real agent turns (i.e. non-slash prompts) cannot use this driver
// until an agent-headless surface is reintroduced.

import { READY_MARKER, TURN_SEPARATOR } from '../../../src/cli/dispatchCommand.js';
import type { Sandbox } from './sandbox.js';
import type { DriverOutcome } from './types.js';

const ESC = String.fromCharCode(27);
// Strip CSI sequences (color, cursor, mode) and OSC title sequences.
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');
const OSC_RE = new RegExp(`${ESC}\\][^\\x07]*\\x07`, 'g');

export function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '').replace(OSC_RE, '');
}

export interface DriverOptions {
  binary: string;
  /** Args appended after the sandbox-default args. */
  extraArgs?: string[];
  sandbox: Sandbox;
  /** Single prompt (one turn) or array of prompts (one turn per element).
   *  Each line is fed into the dispatch loop's stdin; one TURN_SEPARATOR
   *  follows each command's output. */
  prompt: string | string[];
  /** Hard timeout in ms. The process is SIGKILLed on timeout. */
  timeoutMs: number;
}

export { READY_MARKER, TURN_SEPARATOR };

export async function runHarnessSession(opts: DriverOptions): Promise<DriverOutcome> {
  const extraArgs = opts.extraArgs ?? [];
  const args = ['dispatch', ...extraArgs];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.sandbox.envAdditions,
    // Force non-TTY-friendly output even if the runner is itself a TTY.
    NO_COLOR: '1',
    CI: '1',
  };

  const startedAt = performance.now();
  const proc = Bun.spawn([opts.binary, ...args], {
    cwd: opts.sandbox.cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Feed each prompt as one line; dispatch terminates on EOF, so we don't
  // need to send /quit explicitly. The /quit command is still valid as
  // a user-driven prompt and tests may include it.
  const prompts = Array.isArray(opts.prompt) ? opts.prompt : [opts.prompt];
  const stdinContent = prompts.map((p) => `${p}\n`).join('');
  proc.stdin.write(stdinContent);
  await proc.stdin.end();

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, opts.timeoutMs);

  const [rawStdout, rawStderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(killer);

  const durationMs = performance.now() - startedAt;
  const stdout = stripAnsi(rawStdout);
  const stderr = stripAnsi(rawStderr);

  return {
    stdout,
    stderr,
    transcript: buildTranscript(stdout, stderr),
    exitCode: proc.exitCode,
    signal: (proc.signalCode ?? null) as NodeJS.Signals | null,
    timedOut,
    durationMs,
  };
}

function buildTranscript(stdout: string, stderr: string): string {
  if (!stderr.trim()) return stdout;
  return `${stdout}\n--- STDERR ---\n${stderr}`;
}
