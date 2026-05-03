// Process driver — spawns the binary under test, pipes a single prompt
// followed by /quit, captures stdout/stderr, and returns an ANSI-stripped
// transcript. Never imports anything from src/. The only thing it knows
// about the harness is that it's a stdin-driven REPL.

import type { Sandbox } from './sandbox.js';
import type { DriverOutcome } from './types.js';

const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-6';

const ESC = String.fromCharCode(27);
// Strip CSI sequences (color, cursor, mode) and OSC title sequences. The
// non-TTY code path in `sov` does not emit raw-mode picker escapes since
// stdin is piped, so a broad CSI strip is sufficient for transcripts.
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
   *  In piped-stdin mode, sov reads line-by-line — each newline-terminated
   *  prompt drives one turn, then the next is consumed when the previous
   *  turn completes. */
  prompt: string | string[];
  /** Hard timeout in ms. The process is SIGKILLed on timeout. */
  timeoutMs: number;
}

export async function runHarnessSession(opts: DriverOptions): Promise<DriverOutcome> {
  const extraArgs = opts.extraArgs ?? [];
  const hasExplicitModel = extraArgs.includes('--model');
  const hasExplicitPermMode = extraArgs.includes('--permission-mode');
  const args = [
    'chat',
    '--no-preflight',
    '--no-cache',
    // Default the agent to bypass mode for happy-path tests. Permission tests
    // override via binaryArgs (e.g., ['--permission-mode', 'default']) so the
    // deny/allow rules from a sandbox `.harness/settings.local.json` apply.
    ...(hasExplicitPermMode ? [] : ['--permission-mode', 'bypass']),
    '--db',
    opts.sandbox.dbPath,
    // Pin the agent model unless the test specifies one via binaryArgs.
    ...(hasExplicitModel ? [] : ['--model', DEFAULT_AGENT_MODEL]),
    ...extraArgs,
  ];
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

  // Drive each prompt as one turn, then /quit. sov in piped-stdin mode
  // consumes each newline-terminated line as a separate prompt and waits
  // for the prior turn to finish before reading the next.
  const prompts = Array.isArray(opts.prompt) ? opts.prompt : [opts.prompt];
  const stdinContent = `${prompts.map((p) => `${p}\n`).join('')}/quit\n`;
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
