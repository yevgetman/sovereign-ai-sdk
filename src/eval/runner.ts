// Phase 10.5 part 2 — eval runner. Spawn `sov drive` in a sandbox, pipe
// the golden's prompt(s) into stdin, capture stdout/stderr, parse the
// session-summary footer for cost + tool-call totals, evaluate
// assertions, return a GoldenResult. Sequential execution; one
// subprocess per golden.
//
// FIX 3 (2026-06): the runner used to spawn `sov chat`, but since M13
// (2026-05-20) `chat` boots the Go TUI, which exits 1 on non-TTY (piped)
// stdin — so every golden / --compare / --capture / --replay run failed. The
// headless surface is `sov drive` (the same one the semantic suite migrated
// to): one prompt per stdin line, slash commands routed through the session
// commands route. drive's `/quit` does NOT print the session-summary card the
// cost/tool-call parsers read, so we inject `/stats` (which renders that card)
// immediately before `/quit`.

import { spawn } from 'node:child_process';
import { evaluateAll } from './assertions.js';
import { type EvalSandbox, createEvalSandbox } from './sandbox.js';
import type { GoldenResult, GoldenSpec } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BINARY = 'sov';

const ESC = String.fromCharCode(27);
// Strip CSI sequences (color, cursor, mode) and OSC title sequences. The
// non-TTY code path in `sov` does not emit raw-mode picker escapes since
// stdin is piped, so a broad CSI strip is sufficient for transcripts.
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');
const OSC_RE = new RegExp(`${ESC}\\][^\\x07]*\\x07`, 'g');

export function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '').replace(OSC_RE, '');
}

export type RunGoldenOpts = {
  /** Path or name of the binary. Defaults to 'sov' (PATH lookup). */
  binary?: string;
  /** Per-run timeout override. Falls back to the golden's spec or 60s. */
  timeoutMs?: number;
  /** Extra arguments passed in addition to the golden's `extraArgs`. */
  extraArgs?: string[];
  /** When true, keep the sandbox tempdir on disk. Useful for debugging
   *  a failed golden ("here's what the cwd looked like at exit"). */
  keepSandbox?: boolean;
};

/** Spawn `sov drive` against one golden, pipe the prompt(s), wait for
 *  exit, run the assertions, return the GoldenResult. The sandbox is
 *  always cleaned up unless `keepSandbox: true`. */
export async function runGolden(
  golden: GoldenSpec,
  opts: RunGoldenOpts = {},
): Promise<GoldenResult> {
  const binary = opts.binary ?? DEFAULT_BINARY;
  const timeoutMs = opts.timeoutMs ?? golden.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sandbox = createEvalSandbox(golden.seed);
  try {
    const outcome = await spawnAgent({
      binary,
      sandbox,
      prompt: golden.prompt,
      timeoutMs,
      extraArgs: [...(golden.extraArgs ?? []), ...(opts.extraArgs ?? [])],
    });

    const transcript = stripAnsi(outcome.stdout);
    const stderr = stripAnsi(outcome.stderr);
    const toolCalls = parseToolCalls(transcript);
    const estCostUsd = parseEstCost(transcript);

    const assertionResults = evaluateAll(golden.assertions, {
      sandboxCwd: sandbox.cwd,
      transcript,
      exitCode: outcome.exitCode,
      ...(toolCalls ? { toolCalls } : {}),
    });

    const provider = providerFromExtraArgs(opts.extraArgs);
    const baseResult: GoldenResult = {
      id: golden.id,
      name: golden.name,
      ...(provider !== undefined ? { provider } : {}),
      pass: outcome.abortReason === undefined && assertionResults.every((r) => r.pass),
      durationMs: outcome.durationMs,
      ...(estCostUsd !== undefined ? { estCostUsd } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      exitCode: outcome.exitCode,
      assertionResults,
      transcript,
      stderr,
      ...(outcome.abortReason !== undefined ? { abortReason: outcome.abortReason } : {}),
    };
    return baseResult;
  } finally {
    if (!opts.keepSandbox) sandbox.cleanup();
  }
}

type SpawnOpts = {
  binary: string;
  sandbox: EvalSandbox;
  prompt: string | string[];
  timeoutMs: number;
  extraArgs: string[];
};

type SpawnOutcome = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  abortReason?: string;
};

/** Build the `sov drive` argv for a golden run: the `drive` subcommand, the
 *  per-sandbox session DB, `--no-preflight` (the sandbox has no credentials to
 *  preflight), then the golden's extra args. FIX 3 — was `chat` (the dead TUI
 *  surface on non-TTY stdin). Pure + exported so the args contract is unit-
 *  tested without spawning a subprocess. */
export function buildDriveArgs(dbPath: string, extraArgs: string[]): string[] {
  return ['drive', '--db', dbPath, '--no-preflight', ...extraArgs];
}

/** Build the stdin payload piped into `sov drive`: one prompt per line (drive
 *  drives one turn per non-slash line), then `/stats` to emit the session-
 *  summary card (drive's `/quit` does NOT print it — only `/stats`/`/cost`
 *  do), then `/quit` to exit cleanly. FIX 3. Pure + exported for unit tests. */
export function buildDriveStdin(prompt: string | string[]): string {
  const prompts = Array.isArray(prompt) ? prompt : [prompt];
  return `${prompts.join('\n')}\n/stats\n/quit\n`;
}

async function spawnAgent(opts: SpawnOpts): Promise<SpawnOutcome> {
  const stdinPayload = buildDriveStdin(opts.prompt);
  const args = buildDriveArgs(opts.sandbox.dbPath, opts.extraArgs);

  const startedAt = Date.now();
  return await new Promise<SpawnOutcome>((resolve) => {
    const child = spawn(opts.binary, args, {
      cwd: opts.sandbox.cwd,
      env: { ...process.env, ...opts.sandbox.envAdditions },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let aborted: string | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      aborted = `timed out after ${opts.timeoutMs}ms`;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.on('error', (err) => {
      aborted = `spawn error: ${err.message}`;
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const result: SpawnOutcome = {
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs,
        ...(aborted !== undefined ? { abortReason: aborted } : {}),
      };
      resolve(result);
    });

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

/** Parse `Tool Calls:    N ( ✓ ok · ✗ err )` from the session summary. */
export function parseToolCalls(transcript: string): { ok: number; err: number } | undefined {
  const re = /Tool Calls:\s+\d+\s*\(\s*[^0-9]*([0-9]+)\s*[^0-9]*([0-9]+)\s*\)/m;
  const m = transcript.match(re);
  if (!m) return undefined;
  const ok = Number.parseInt(m[1] ?? '', 10);
  const err = Number.parseInt(m[2] ?? '', 10);
  if (!Number.isFinite(ok) || !Number.isFinite(err)) return undefined;
  return { ok, err };
}

/** Parse `Est. Cost:     $0.0011` from the session summary. */
export function parseEstCost(transcript: string): number | undefined {
  const re = /Est\. Cost:\s+\$([0-9]+(?:\.[0-9]+)?)/m;
  const m = transcript.match(re);
  if (!m) return undefined;
  const v = Number.parseFloat(m[1] ?? '');
  return Number.isFinite(v) ? v : undefined;
}

/** Recover the `--provider <name>` value from an extraArgs array, when
 *  present. Used by `runGolden` to tag the GoldenResult so reports can
 *  show which provider produced each outcome. */
function providerFromExtraArgs(extraArgs: string[] | undefined): string | undefined {
  if (!extraArgs) return undefined;
  for (let i = 0; i < extraArgs.length - 1; i++) {
    if (extraArgs[i] === '--provider') return extraArgs[i + 1];
  }
  return undefined;
}
