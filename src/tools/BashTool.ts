// BashTool — the first real tool. Spawns bash under `bash -c`, captures
// stdout+stderr, returns combined output. Non-zero exit → is_error on the
// tool_result; tool code itself does not throw for non-zero exits.
//
// Phase 2 scope: no permission checks (fail-closed defaults ask for every
// use — Phase 3 adds interactive prompts). Not marked read-only, not
// concurrency-safe. The orchestrator runs tools sequentially so
// isConcurrencySafe doesn't matter yet.
//
// Fry pattern: optional `expectToken` — if provided, the final stdout line
// must contain the token or the result is marked is_error. Useful when
// shelling out to scripts whose exit codes don't reliably indicate success.
//
// Source of pattern: Claude Code src/tools/BashTool (interface shape) +
// Fry's shell-invocation subprocess (sentinel-line idea) — see
// harness-build-plan.md § 2 and fry-analysis.md § A2.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import type { ToolContext } from '../tool/types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const inputSchema = z.object({
  command: z.string().min(1, 'command is required'),
  /** Soft timeout in ms. Default 120s. */
  timeout_ms: z.number().int().positive().max(600_000).optional(),
  /** If set, stdout's last non-empty line must contain this token. */
  expect_token: z.string().min(1).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  /** Present only when the input's expect_token was set. */
  token_matched?: boolean;
  /** Truncation occurred if combined output exceeded the byte cap. */
  truncated?: boolean;
};

export const BashTool = buildTool<Input, Output>({
  name: 'Bash',
  description: () =>
    'Run a bash command. Returns combined stdout and stderr plus the exit code. Set `expect_token` to require a completion sentinel on stdout.',
  inputSchema,
  async call(input, ctx) {
    return runBash(input, ctx);
  },
});

async function runBash(input: Input, ctx: ToolContext): Promise<{ data: Output }> {
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);

  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutCtl.signal]) : timeoutCtl.signal;

  const proc = Bun.spawn(['bash', '-c', input.command], {
    cwd: ctx.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });

  let timedOut = false;
  try {
    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      readAllCapped(proc.stdout),
      readAllCapped(proc.stderr),
      proc.exited,
    ]);

    if (timeoutCtl.signal.aborted) timedOut = true;

    const stdout = stdoutBuf.text;
    const stderr = stderrBuf.text;
    const truncated = stdoutBuf.truncated || stderrBuf.truncated;

    let tokenMatched: boolean | undefined;
    if (input.expect_token) {
      tokenMatched =
        stdout
          .split('\n')
          .reverse()
          .find((l) => l.trim().length > 0)
          ?.includes(input.expect_token) ?? false;
    }

    return {
      data: {
        stdout,
        stderr,
        exit_code: exitCode,
        timed_out: timedOut,
        ...(tokenMatched !== undefined ? { token_matched: tokenMatched } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

type CappedRead = { text: string; truncated: boolean };

async function readAllCapped(stream: ReadableStream<Uint8Array>): Promise<CappedRead> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let truncated = false;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (truncated) continue;
    total += value.byteLength;
    if (total > MAX_OUTPUT_BYTES) {
      const remainingSpace = MAX_OUTPUT_BYTES - (total - value.byteLength);
      if (remainingSpace > 0) {
        text += decoder.decode(value.subarray(0, remainingSpace), { stream: false });
      }
      truncated = true;
    } else {
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return { text, truncated };
}

/**
 * Format the tool's structured output into the string that flows back to
 * the model as `tool_result.content`. Tool-pipeline-agnostic — the
 * orchestrator decides whether to set `is_error` based on `exit_code`,
 * `timed_out`, or `token_matched`.
 */
export function formatBashOutput(out: Output): string {
  const parts: string[] = [];
  parts.push(`exit_code: ${out.exit_code}`);
  if (out.timed_out) parts.push('timed_out: true');
  if (out.token_matched === false) parts.push('expect_token: not found');
  if (out.truncated) parts.push(`truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes`);
  if (out.stdout.length > 0) {
    parts.push('--- stdout ---', out.stdout.trimEnd());
  }
  if (out.stderr.length > 0) {
    parts.push('--- stderr ---', out.stderr.trimEnd());
  }
  if (out.stdout.length === 0 && out.stderr.length === 0) {
    parts.push('(no output)');
  }
  return parts.join('\n');
}

/**
 * Shared decision: given an Output, should the tool_result carry is_error?
 * Non-zero exit, timeout, or expect_token miss all count.
 */
export function isBashError(out: Output): boolean {
  return out.exit_code !== 0 || out.timed_out === true || out.token_matched === false;
}
