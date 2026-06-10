// BashTool — the first real tool. Spawns bash under `bash -c`, captures
// stdout+stderr, returns combined output. Non-zero exit → is_error on the
// tool_result; tool code itself does not throw for non-zero exits.
//
// Phase 3 started with `checkPermissions: ask` for every invocation. Phase 10.5
// allows commands that the same input-aware classifier already treats as
// read-only/concurrency-safe; mutating or opaque commands still ask.
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
import {
  type VirtualOperation,
  analyzeShellCommand,
  splitShellSegments,
} from '../permissions/shellSemantics.js';
import { buildTool } from '../tool/buildTool.js';
import type { ToolContext, ToolObservation } from '../tool/types.js';

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
  'true',
  'false',
  'whoami',
  'hostname',
  'uname',
  'id',
  'tree',
  'rg',
]);

/** Command launchers that run an arbitrary FOLLOWING command. They must never
 *  classify read-only on their own — the real command after them decides. The
 *  classifier skips past the launcher (and its flags / env-assignments) to that
 *  command. A launcher with no following command (bare `env`) fails closed.
 *  (Audit C3: `env bash -c '…'` previously auto-allowed.) */
const COMMAND_LAUNCHERS = new Set<string>([
  'env',
  'command',
  'exec',
  'builtin',
  'nice',
  'nohup',
  'time',
  'timeout',
  'stdbuf',
  'xargs',
]);

/** `find` primaries that execute commands or mutate the filesystem — they make
 *  an otherwise read-only `find` unsafe (audit C3). */
const FIND_DESTRUCTIVE_RE =
  /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fprint0|fls)(?:\s|$)/;

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
  displayInput: (input) => input.command,
  checkPermissions: async (input) =>
    isReadOnlyBashCommand(input.command)
      ? { behavior: 'allow', reason: 'read-only bash allowlist' }
      : { behavior: 'ask' },
  virtualToolName: (input) => bashVirtualToolName(input.command),
  isReadOnly: (input) => isReadOnlyBashCommand(input.command),
  isConcurrencySafe: (input) => isReadOnlyBashCommand(input.command),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesBashPermissionPattern(input.command, pattern),
  renderResult: (out) => ({
    content: formatBashOutput(out),
    isError: isBashError(out),
  }),
  renderHint: { kind: 'text' },
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

  // Output redirection turns a read command into a write: `cat x > out`,
  // `echo y >> f`, `grep z 2> err`. Fd-duplications (`2>&1`, `>&2`) target no
  // file and stay read-only. Fail-closed: a literal '>' even inside quotes is
  // treated as a redirect (asks rather than silently auto-allowing a write).
  if (/(?:\d*|&)>>?\s*[^&\s]/.test(command)) return false;

  // Quote-aware split on every control operator incl. newline and a control
  // `&` — a regex split previously missed those, so a writer smuggled after a
  // read classified read-only (audit C2).
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (!isReadOnlySegment(seg)) return false;
  }
  return true;
}

/** Resolve a single shell segment's effective leading command, skipping leading
 *  env-var assignments and any command launchers (env/nice/timeout/…), then
 *  decide whether that command is read-only. Fail-closed on anything opaque. */
function isReadOnlySegment(segment: string): boolean {
  const seg = segment.trim();
  if (seg.length === 0) return false;
  const tokens = seg.split(/\s+/).filter(Boolean);
  let cursor = 0;
  // Skip leading `VAR=val` assignments.
  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
    cursor++;
  }
  // Skip command launchers and their own flags/assignments to reach the real
  // command they would run.
  while (cursor < tokens.length && COMMAND_LAUNCHERS.has(tokens[cursor] ?? '')) {
    cursor++;
    while (cursor < tokens.length) {
      const t = tokens[cursor] ?? '';
      if (t.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        cursor++;
        continue;
      }
      break;
    }
  }
  const cmd = tokens[cursor];
  if (!cmd) return false; // launcher with no real command (e.g. bare `env`)
  if (cmd.startsWith('-') || cmd.includes('/')) return false;
  if (!BASH_READ_COMMANDS.has(cmd)) return false;
  // `find` is read-only only without a destructive/exec primary.
  if (cmd === 'find' && FIND_DESTRUCTIVE_RE.test(seg)) return false;
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
  // Split on control operators incl. newline + control `&` (a smuggled command
  // after those must also match the pattern — audit C2), but keep a single `|`
  // inside its segment (historical Bash(pattern) behavior).
  const segments = splitShellSegments(command, { splitPipes: false });
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

/**
 * Privilege-escalation commands that need a TTY for the password / TouchID
 * prompt. The harness spawns bash with stdin piped, so these will always
 * hang waiting for credentials. We detect and refuse before spawning.
 *
 * Detection scans every pipeline / `&&` / `||` / `;` segment, skips leading
 * env-var assignments, and checks the first command word. We keep the set
 * small and conservative — false positives mean a refusal the agent has to
 * route around, but false negatives mean the actual hang we're trying to
 * prevent.
 */
const PRIV_ESCALATION_COMMANDS = new Set<string>(['sudo', 'pkexec', 'doas', 'su']);

export function detectPrivilegeEscalation(command: string): string | null {
  // Quote-aware split on every control operator incl. newline + control `&`
  // (a regex split missed those, so `cat a\nsudo …` evaded the guard — C2).
  const segments = splitShellSegments(command);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    let cursor = 0;
    while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
      cursor++;
    }
    // Skip command launchers (env/nice/…) so `env sudo …` is still caught.
    while (cursor < tokens.length && COMMAND_LAUNCHERS.has(tokens[cursor] ?? '')) {
      cursor++;
      while (cursor < tokens.length) {
        const t = tokens[cursor] ?? '';
        if (t.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          cursor++;
          continue;
        }
        break;
      }
    }
    const cmd = tokens[cursor];
    if (!cmd) continue;
    // Strip a leading absolute path so `/usr/bin/sudo` is caught.
    const basename = cmd.includes('/') ? (cmd.split('/').pop() ?? cmd) : cmd;
    if (PRIV_ESCALATION_COMMANDS.has(basename)) return basename;
  }
  return null;
}

/** Render a structured refusal Output for a privilege-escalation attempt.
 *  Uses exit_code 126 (the conventional "command found but not executable"
 *  shell convention — the closest match for "we found this command but
 *  refuse to run it") so the model sees is_error and adapts. */
function refusedPrivilegeEscalationOutput(command: string, escalator: string): Output {
  const stderr = `Refused: this command uses \`${escalator}\` which the harness cannot run.\nReason: the harness spawns bash with no TTY, so password / TouchID prompts hang indefinitely.\nAction: run the command yourself in your terminal and paste the output back. On macOS, prefer \`launchctl list\` over \`sudo grep /etc/cron*\` for service queries.\nOriginal command: ${command}`;
  return {
    stdout: '',
    stderr,
    exit_code: 126,
    timed_out: false,
  };
}

async function runBash(
  input: Input,
  ctx: ToolContext,
): Promise<{ data: Output; observation: ToolObservation }> {
  // Privilege-escalation guardrail. These commands need a TTY for password /
  // TouchID prompts which a piped subprocess can't supply — the spawn would
  // hang until BashTool's timeout fires, leaving the agent stuck for two
  // minutes. Refuse upfront with a structured error so the agent adapts.
  const escalator = detectPrivilegeEscalation(input.command);
  if (escalator) {
    const data = refusedPrivilegeEscalationOutput(input.command, escalator);
    return {
      data,
      observation: {
        status: 'error',
        summary: `refused: command uses ${escalator}, which needs a TTY`,
        next_actions: [
          'run the command yourself in your terminal and paste the output back',
          `for service queries on macOS, prefer \`launchctl list\` over \`${escalator} grep /etc/cron*\``,
        ],
      },
    };
  }

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

    const data: Output = {
      stdout,
      stderr,
      exit_code: exitCode,
      timed_out: timedOut,
      ...(tokenMatched !== undefined ? { token_matched: tokenMatched } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
    return { data, observation: bashObservation(data) };
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

/**
 * Build the Phase 12.5 observation envelope from a Bash Output. Status maps
 * via `isBashError`; summary picks the first non-empty stderr line on error
 * paths, otherwise the first non-empty stdout line. `next_actions` are
 * supplied for a few common error classes; for run-of-the-mill non-zero
 * exits we deliberately surface no next_actions because the right move is
 * usually call-site-specific.
 */
export function bashObservation(out: Output): ToolObservation {
  if (out.timed_out) {
    return {
      status: 'error',
      summary: 'command timed out',
      next_actions: [
        'increase the timeout_ms input or break the command into smaller steps',
        'check whether the command is waiting for stdin (the harness pipes /dev/null)',
      ],
    };
  }
  if (out.token_matched === false) {
    return {
      status: 'error',
      summary: 'expect_token not found on the last stdout line',
      next_actions: [
        'review the actual stdout below to see what the command produced',
        'adjust expect_token to match a stable sentinel, or drop it for this call',
      ],
    };
  }
  const error = out.exit_code !== 0;
  const summary = (() => {
    if (error) {
      const stderrLine = firstNonEmptyLine(out.stderr);
      if (stderrLine) return `exit ${out.exit_code}: ${truncateLine(stderrLine)}`;
      return `exit ${out.exit_code} (no stderr)`;
    }
    const stdoutLine = firstNonEmptyLine(out.stdout);
    if (stdoutLine) return truncateLine(stdoutLine);
    return 'command succeeded silently';
  })();
  const next_actions: string[] = [];
  if (error) {
    if (/command not found/i.test(out.stderr)) {
      next_actions.push('install the missing binary or check PATH');
    } else if (/permission denied/i.test(out.stderr)) {
      next_actions.push('check file/directory ownership or run with appropriate user');
    } else if (/no such file or directory/i.test(out.stderr)) {
      next_actions.push('verify the path with Glob or `ls`; confirm the working directory');
    }
  }
  if (out.truncated) {
    next_actions.push('output was truncated — narrow the command scope or pipe through head/grep');
  }
  return {
    status: error ? 'error' : 'success',
    summary,
    ...(next_actions.length > 0 ? { next_actions } : {}),
  };
}

function firstNonEmptyLine(s: string): string | undefined {
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return undefined;
}

function truncateLine(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Map a bash command to a virtual tool name (Read, Write, or null) via
 * shell AST analysis. Used by the permission system to resolve bash
 * commands against Read/Write permission rules.
 */
export function bashVirtualToolName(command: string): string | null {
  const ops = analyzeShellCommand(command);
  if (ops.length === 0) return null;
  if (ops.every((op): op is VirtualOperation & { kind: 'read' } => op.kind === 'read')) {
    return 'Read';
  }
  if (
    ops.some((op) => op.kind === 'write') &&
    !ops.some((op) => op.kind === 'edit' || op.kind === 'unsafe')
  ) {
    return 'Write';
  }
  return null;
}
