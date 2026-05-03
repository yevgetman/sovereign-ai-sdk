// Compact in-place tool display. During a sequence of tool calls, each
// new call overwrites the previous one's line in the terminal so the
// scrollback stays clean — a long "thinking run" with 20 tool calls
// consumes one slot of vertical space, not 40 lines. When non-tool
// output (text, status lines) is about to write, the slot is "committed"
// (its last state stays in scrollback, and the next tool starts a fresh
// slot below it).
//
// Verbose mode bypasses this entirely — it keeps the additive multi-line
// preview block from `renderToolResultPreview`.

import chalk from 'chalk';

const ESC = '\x1b';

interface WritableLike {
  write(chunk: string): boolean;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function summarizeContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'no output';
  const lines = trimmed.split('\n').length;
  const chars =
    trimmed.length < 1000
      ? `${trimmed.length} chars`
      : trimmed.length < 1_000_000
        ? `${(trimmed.length / 1000).toFixed(trimmed.length < 10_000 ? 1 : 0)}K chars`
        : `${(trimmed.length / 1_000_000).toFixed(2)}M chars`;
  return `${lines} line${lines === 1 ? '' : 's'}, ${chars}`;
}

function summarizeError(content: string): string {
  const lines = content.trim().split('\n');
  const first = lines[0] ?? '';
  const head = truncate(first, 160);
  if (lines.length <= 1) return head;
  // Multi-line errors: hint that the full body has more lines so the
  // user knows the truncation is hiding context. The full content is
  // still visible in `--verbose` mode and the JSONL transcript.
  const more = lines.length - 1;
  return `${head}  · +${more} more line${more === 1 ? '' : 's'}`;
}

export class CompactToolSlot {
  private out: WritableLike;
  private active = false;

  constructor(out: WritableLike = process.stdout) {
    this.out = out;
  }

  /** A new tool is starting. If `interToolLines` > 0, ANSI-clear that
   *  many lines of inter-tool content (text the agent emitted between
   *  this tool and the previous one) along with the previous slot line.
   *  This keeps the tool slot's overwrite continuity intact even when
   *  the agent streams preamble text between tool calls. */
  begin(name: string, input: string, interToolLines = 0): void {
    if (this.active) {
      const linesToClear = interToolLines + 1;
      this.out.write(`${ESC}[${linesToClear}A${ESC}[J`);
    } else if (interToolLines > 0) {
      this.out.write(`${ESC}[${interToolLines}A${ESC}[J`);
    }
    const label = input ? `${name} ${truncate(input, 80)}` : name;
    this.out.write(`${chalk.cyan('→')} ${chalk.gray(label)}\n`);
    this.active = true;
  }

  /** The most recent tool finished — overwrite its "running" line with
   *  the result summary. */
  end(content: string, isError: boolean): void {
    if (!this.active) return;
    this.clearLine();
    if (isError) {
      this.out.write(`${chalk.red('✗')} ${chalk.red(summarizeError(content))}\n`);
    } else {
      this.out.write(`${chalk.green('✓')} ${chalk.gray(summarizeContent(content))}\n`);
    }
    // Stay active so the next begin() can overwrite this line.
  }

  /** Non-tool output (text, status, divider) is about to render. The
   *  current slot stays in scrollback as-is; the next begin() will start
   *  a fresh line below it instead of overwriting. */
  commit(): void {
    this.active = false;
  }

  private clearLine(): void {
    this.out.write(`${ESC}[1A${ESC}[2K`);
  }
}
