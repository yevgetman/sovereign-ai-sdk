// GrepTool — shell out to ripgrep. Supports content / files-with-matches /
// count output modes plus glob filtering and case-insensitive matching.
// Read-only and concurrency-safe; doesn't participate in path-overlap
// serialization (no affectedPaths), so two greps can always run in
// parallel with anything else.
//
// Requires ripgrep on PATH (`brew install ripgrep` on macOS,
// `apt install ripgrep` on Debian/Ubuntu). When missing, the tool surfaces
// the error verbatim so the model can suggest the install command.

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import type { ToolContext, ToolObservation } from '../tool/types.js';
import { resolveToolPath } from './pathUtils.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const MAX_OUTPUT_BYTES = 256 * 1024;

// Self-timeout so a runaway ripgrep (e.g. a pathological regex over a huge tree)
// is bounded on headless surfaces where there's no human to Ctrl-C. Mirrors
// BashTool's DEFAULT_TIMEOUT_MS. Composed with ctx.signal so an upstream cancel
// (turn abort) still wins immediately.
const DEFAULT_TIMEOUT_MS = 120_000;

const inputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for (ripgrep syntax).'),
  path: z
    .string()
    .optional()
    .describe('Directory or file to search; accepts absolute, ~/, or cwd-relative paths.'),
  glob: z
    .string()
    .optional()
    .describe('Restrict to files matching this glob, e.g. "*.ts" or "**/*.md".'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output format: "content" (matching lines, default), "files_with_matches" (paths only), "count" (per-file count).',
    ),
  case_insensitive: z.boolean().optional().describe('Match case-insensitively. Default false.'),
  show_line_numbers: z
    .boolean()
    .optional()
    .describe('Prefix matches with line numbers (content mode only). Default false.'),
  head_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of result lines to return. Default: no cap.'),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  matches: string[];
  truncated: boolean;
};

export const GrepTool = buildTool<Input, Output>({
  name: 'Grep',
  description: () =>
    'Search files for a regex pattern using ripgrep. Returns matching lines (default), or a list of files with matches, or a per-file count.',
  inputSchema,
  displayInput: (input) => {
    const where = input.path !== undefined ? ` in ${input.path}` : '';
    const filter = input.glob !== undefined ? ` (${input.glob})` : '';
    return `"${input.pattern}"${where}${filter}`;
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(input.path ?? '.', pattern) ||
    matchesPathPermissionPattern(input.glob ?? input.pattern, pattern),
  renderResult: (out) => ({
    content:
      out.matches.length === 0
        ? '(no matches)'
        : out.truncated
          ? `${out.matches.join('\n')}\n[truncated]`
          : out.matches.join('\n'),
  }),
  renderHint: { kind: 'tree' },
  async call(input, ctx) {
    return runGrep(input, ctx);
  },
});

async function runGrep(
  input: Input,
  ctx: ToolContext,
): Promise<{ data: Output; observation: ToolObservation }> {
  const args: string[] = ['--no-heading', '--color=never'];
  const mode = input.output_mode ?? 'content';
  if (mode === 'files_with_matches') args.push('--files-with-matches');
  else if (mode === 'count') args.push('--count');
  if (input.case_insensitive) args.push('--ignore-case');
  if (input.show_line_numbers && mode === 'content') args.push('--line-number');
  if (input.glob) args.push('--glob', input.glob);
  args.push('--', input.pattern);
  if (input.path) args.push(resolveToolPath(input.path, ctx.cwd));

  // Self-timeout composed with the upstream cancel signal (BashTool pattern).
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), DEFAULT_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutCtl.signal]) : timeoutCtl.signal;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['rg', ...args], {
      cwd: ctx.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to spawn ripgrep: ${msg}. Install with: brew install ripgrep (macOS) or apt install ripgrep (Debian/Ubuntu).`,
    );
  }

  // `stdout: 'pipe'` and `stderr: 'pipe'` guarantee these are ReadableStreams,
  // but Bun's spawn return type widens to `number | ReadableStream | undefined`
  // because the same overload covers FD-redirect modes. Narrow at the call site.
  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
  let stdout: { text: string; truncated: boolean };
  let stderr: { text: string; truncated: boolean };
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readStream(stdoutStream),
      readStream(stderrStream),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  // Surface a self-timeout as a clear error so the model can narrow the query
  // rather than puzzling over a generic non-zero exit.
  if (timeoutCtl.signal.aborted) {
    throw new Error(
      `ripgrep timed out after ${DEFAULT_TIMEOUT_MS}ms — narrow the regex or scope (path/glob).`,
    );
  }

  // ripgrep exits 1 when there are no matches — that's not an error.
  if (exitCode !== 0 && exitCode !== 1) {
    const msg = stderr.text.trim() || `ripgrep exited with code ${exitCode}`;
    throw new Error(msg);
  }

  let lines = stdout.text.split('\n').filter((l) => l.length > 0);
  // The byte cap (readStream, >256 KiB) is one truncation source; head_limit is
  // the other. OR them so a byte-capped result is honestly reported as
  // truncated instead of silently cut with truncated:false.
  let truncated = stdout.truncated;
  if (input.head_limit !== undefined && lines.length > input.head_limit) {
    lines = lines.slice(0, input.head_limit);
    truncated = true;
  }
  const observation: ToolObservation = (() => {
    if (lines.length === 0) {
      return {
        status: 'warning',
        summary: `no matches for /${input.pattern}/${input.case_insensitive ? 'i' : ''}`,
        next_actions: [
          'broaden the regex (drop word boundaries; use case_insensitive: true)',
          'widen the search root via the `path` arg, or check the glob filter',
        ],
      };
    }
    return {
      status: 'success',
      summary: `${lines.length} match${lines.length === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`,
      ...(truncated
        ? {
            next_actions: ['raise head_limit, or narrow the regex / scope to reduce result count'],
          }
        : {}),
    };
  })();
  return { data: { matches: lines, truncated }, observation };
}

/** Drain a ripgrep stream, capping at MAX_OUTPUT_BYTES. Returns the kept text
 *  plus whether the byte cap fired. When capped, the text is trimmed back to
 *  the last complete newline so the final line isn't split mid-way (a half a
 *  match line would otherwise survive `split('\n')` as a bogus result). */
async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ text: string; truncated: boolean }> {
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
      const room = MAX_OUTPUT_BYTES - (total - value.byteLength);
      if (room > 0) text += decoder.decode(value.subarray(0, room), { stream: false });
      truncated = true;
    } else {
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  if (truncated) {
    // Trim the dangling partial line left by the byte cap. Keep everything up
    // to and including the last newline; if there's no newline at all, keep the
    // single (truncated) line as-is rather than dropping all output.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline !== -1) text = text.slice(0, lastNewline + 1);
  }
  return { text, truncated };
}
