// BashTool — the first real tool. Spawns bash under `bash -c`, captures
// stdout+stderr, returns combined output. Non-zero exit → is_error on the
// tool_result; tool code itself does not throw for non-zero exits.
//
// Phase 3 scope: `checkPermissions` returns 'ask' for every invocation so
// the orchestrator prompts the human. Phase 7 replaces this with input-aware
// rule-based logic (e.g. safe-listing read-only commands via a regex, plus
// the full rule engine from Claude Code).
//
// Phase 4: `isConcurrencySafe(input)` inspects the command and returns true
// only when every shell segment's leading command is in BASH_READ_COMMANDS
// and there's no command/process substitution to hide unsafe sub-commands.
// `renderResult` formats the bash output into the string the model sees.
//
// Fry pattern: optional `expectToken` — if provided, the final stdout line
// must contain the token or the result is marked is_error. Useful when
// shelling out to scripts whose exit codes don't reliably indicate success.
//
// Source of pattern: Claude Code src/tools/BashTool (interface shape) +
// Fry's shell-invocation subprocess (sentinel-line idea) — see
// harness-build-plan.md § 2 and fry-analysis.md § A2.

import { z } from 'zod';
import { wildcardMatches } from '../config/rules.js';
import { buildTool } from '../tool/buildTool.js';
import type { ToolContext } from '../tool/types.js';

/** Bash commands deemed read-only and safe to run in parallel with other
 *  read-only operations. Anything not on this list is treated as a writer
 *  (the fail-closed default). Phase 7 may extend the recognition surface
 *  via the full rule engine. */
const BASH_READ_COMMANDS = new Set<string>([
  'ls',
  'cat',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'echo',
  'pwd',
  'which',
  'date',
  'env',
  'true',
  'false',
  'whoami',
  'hostname',
  'uname',
  'id',
  'tree',
  'rg',
]);

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
  // Bash is arbitrary-code execution. Ask for every invocation until Phase 7
  // lands input-aware rules.
  checkPermissions: async () => ({ behavior: 'ask' }),
  isReadOnly: (input) => isReadOnlyBashCommand(input.command),
  isConcurrencySafe: (input) => isReadOnlyBashCommand(input.command),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesBashPermissionPattern(input.command, pattern),
  renderResult: (out) => ({
    content: formatBashOutput(out),
    isError: isBashError(out),
  }),
  async call(input, ctx) {
    return runBash(input, ctx);
  },
});

/**
 * Return true when every shell segment in `command` starts with a token
 * that's in `BASH_READ_COMMANDS`. Conservative: any command/process
 * substitution (`$(...)`, backticks, `<(...)`, `>(...)`) returns false
 * because the inner command isn't being inspected. Leading env-var
 * assignments (`LC_ALL=C grep ...`) are skipped before resolving the real
 * command word. Path-prefixed binaries (`/usr/bin/cat`) return false —
 * Phase 7 may relax this once the rule engine can resolve PATH lookups.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(command)) return false;

  const segments = command.split(/\|\||&&|;|\|/);
  for (const raw of segments) {
    const seg = raw.trim();
    if (seg.length === 0) return false;
    const tokens = seg.split(/\s+/);
    let cursor = 0;
    while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
      cursor++;
    }
    const cmd = tokens[cursor];
    if (!cmd) return false;
    if (cmd.startsWith('-') || cmd.includes('/')) return false;
    if (!BASH_READ_COMMANDS.has(cmd)) return false;
  }
  return true;
}

/**
 * Permission-rule matcher for Bash(command-pattern). Each shell segment
 * split by `&&`, `||`, or `;` must match the pattern. Wildcards are
 * token-bounded (`*` does not cross whitespace), so `git *` matches
 * `git status` but not `git push --force`.
 */
export function matchesBashPermissionPattern(command: string, pattern: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(command)) return false;
  const segments = command.split(/\|\||&&|;/);
  if (segments.length === 0) return false;
  for (const raw of segments) {
    const segment = normalizeShellSegment(raw);
    if (segment.length === 0) return false;
    if (!wildcardMatches(pattern, segment, { flavor: 'shell' })) return false;
  }
  return true;
}

function normalizeShellSegment(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let cursor = 0;
  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
    cursor++;
  }
  return tokens.slice(cursor).join(' ');
}

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
