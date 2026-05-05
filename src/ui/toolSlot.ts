// Compact tool block — header + (truncated) inline output + summary footer.
//
// Each tool call renders as:
//
//   ToolName(args)
//     <output line 1, dim>
//     <output line 2, dim>
//     ...
//     <marker> <per-tool footer>
//   <blank line>                              ← breathing room before the next block
//
// Rendering is DEFERRED — `begin()` just stashes the metadata for the
// pending tool; the full block writes when `end()` fires. This is the
// only correct behavior under the orchestrator's batched tool dispatch:
// the model can emit N tool_use blocks in a single assistant message,
// firing N begin()s back-to-back before any end() arrives. With
// in-place overwrite, the second begin would clobber the first
// header, producing visual misalignment when the end()s eventually
// land. With deferred rendering, each end() writes its own complete
// block at the bottom of scrollback, in completion order.
//
// Trade-off: no "tool starting" visual feedback for slow tools. The
// thinking indicator at the top of the turn fills that role for now;
// a future enhancement could surface "running 3 tools" in the spinner.
//
// Verbose mode bypasses this entirely — see terminalRepl's
// renderToolResultPreview path.
//
// The tool name is colored via the active theme's `accent` token
// (cyan in dark, blue in light), matching the bullet/inline-code
// color so all "structural emphasis" reads as one class. Output
// lines are dim. The footer is muted (or red on error).

import { theme } from './theme.js';
import { summarizeToolResult } from './toolFooter.js';

const DEFAULT_INLINE_LINES = 10;
const MAX_INLINE_LINE_WIDTH = 200;
const MAX_ARGS_DISPLAY = 120;

interface WritableLike {
  write(chunk: string): boolean;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export interface ToolSlotOptions {
  /** Max lines of output to render inline below each tool call. When
   *  the result has more, the surplus is summarized in the footer
   *  ("· +N more lines"). Set to 0 to revert to header + footer only,
   *  with no inline content at all. Default: 10. */
  inlineLines?: number;
  /** Cap on completed blocks retained for /expand. Default: 50. The
   *  ring buffer drops the oldest entry when full. */
  retain?: number;
}

interface PendingTool {
  name: string;
  args: string;
}

/** Snapshot of a completed tool call kept in the ring buffer. The
 *  /expand slash command reads from here to re-render a block's full
 *  content (no truncation) when the user wants to see what the slot
 *  hid behind "+N more lines". */
export interface CompletedToolBlock {
  toolUseId: string;
  name: string;
  args: string;
  content: string;
  isError: boolean;
  totalLines: number;
}

const DEFAULT_RETAIN = 50;

export class CompactToolSlot {
  private readonly out: WritableLike;
  private readonly inlineLines: number;
  /** Cap on the FIFO of completed blocks retained for /expand. Older
   *  blocks beyond this cap drop off (the user almost never wants to
   *  re-expand a block from many turns ago, and unbounded retention
   *  would hold tool output forever). */
  private readonly retain: number;
  /** Tools whose begin() has fired but whose end() hasn't. Keyed by
   *  toolUseId so out-of-order end() calls (parallel tools completing
   *  in different orders than they were issued) still find their meta
   *  cleanly. */
  private pending = new Map<string, PendingTool>();
  /** Completed blocks, oldest first. /expand indexes from the end
   *  (1 = most recent). */
  private history: CompletedToolBlock[] = [];

  constructor(out: WritableLike = process.stdout, opts: ToolSlotOptions = {}) {
    this.out = out;
    this.inlineLines = opts.inlineLines ?? DEFAULT_INLINE_LINES;
    this.retain = opts.retain ?? DEFAULT_RETAIN;
  }

  /** Look up the Nth-most-recent completed tool block (1-indexed: 1
   *  is the most recent, 2 the one before, etc.). Returns null when
   *  N is out of range or no blocks have completed yet. Used by the
   *  /expand slash command to surface full output for blocks the
   *  inline renderer truncated. */
  getCompletedTool(n: number): CompletedToolBlock | null {
    if (n < 1) return null;
    const idx = this.history.length - n;
    if (idx < 0) return null;
    return this.history[idx] ?? null;
  }

  /** Total count of retained completed blocks (capped at `retain`).
   *  Used by /expand to error helpfully ("only 3 blocks in history;
   *  /expand 5 is out of range"). */
  completedCount(): number {
    return this.history.length;
  }

  /** Stash the tool's metadata. Renders nothing — the full block
   *  appears when the matching end() fires. */
  begin(toolUseId: string, name: string, args: string): void {
    this.pending.set(toolUseId, { name, args });
  }

  /** Render the complete tool block: header (cyan tool name + paren'd
   *  args), inline output (truncated to inlineLines, dim), per-tool
   *  footer summary, blank line for breathing room. Pushes the full
   *  block onto the retention ring buffer so /expand can resurrect it. */
  end(toolUseId: string, content: string, isError: boolean): void {
    const meta = this.pending.get(toolUseId);
    if (!meta) return;
    this.pending.delete(toolUseId);

    const trimmed = content.trim();
    const allLines = trimmed.length === 0 ? [] : trimmed.split('\n');
    const totalLines = allLines.length;

    this.renderBlock({
      name: meta.name,
      args: meta.args,
      lines: allLines,
      maxInlineLines: this.inlineLines,
      isError,
      totalLines,
      expandedNote: null,
    });

    // Retain for /expand. Ring-buffer eviction keeps memory bounded.
    this.history.push({
      toolUseId,
      name: meta.name,
      args: meta.args,
      content: trimmed,
      isError,
      totalLines,
    });
    if (this.history.length > this.retain) this.history.shift();
  }

  /** Re-render a previously-completed block with no truncation. Used
   *  by /expand. The block is fetched from the retention ring buffer
   *  and written to stdout in the same visual shape as the original
   *  end() output, but with all lines visible and an `(expanded)`
   *  marker on the footer so the user knows this is a re-render and
   *  not a fresh tool call. Returns true on success, false when the
   *  index is out of range. */
  expand(n: number): boolean {
    const block = this.getCompletedTool(n);
    if (!block) return false;
    const lines = block.content.length === 0 ? [] : block.content.split('\n');
    this.renderBlock({
      name: block.name,
      args: block.args,
      lines,
      // Pass +Infinity so the renderer shows everything.
      maxInlineLines: Number.POSITIVE_INFINITY,
      isError: block.isError,
      totalLines: block.totalLines,
      expandedNote: `expanded · block ${n} of ${this.history.length}`,
    });
    return true;
  }

  private renderBlock(opts: {
    name: string;
    args: string;
    lines: string[];
    maxInlineLines: number;
    isError: boolean;
    totalLines: number;
    expandedNote: string | null;
  }): void {
    const t = theme.tokens;
    const argsPart = opts.args ? `(${truncate(opts.args, MAX_ARGS_DISPLAY)})` : '';
    this.out.write(`${t.accent(opts.name)}${argsPart}\n`);

    let outputRowsRendered = 0;
    if (opts.maxInlineLines > 0 && opts.lines.length > 0) {
      const shown =
        opts.maxInlineLines === Number.POSITIVE_INFINITY
          ? opts.lines
          : opts.lines.slice(0, opts.maxInlineLines);
      for (const line of shown) {
        const safe = truncate(line, MAX_INLINE_LINE_WIDTH);
        this.out.write(`  ${t.textDim(safe)}\n`);
        outputRowsRendered++;
      }
    }

    const truncatedCount = Math.max(0, opts.totalLines - outputRowsRendered);
    const summary = summarizeToolResult({
      toolName: opts.name,
      content: opts.lines.join('\n'),
      isError: opts.isError,
      totalLines: opts.totalLines,
    });
    const footerParts = [summary.primary];
    if (truncatedCount > 0 && opts.maxInlineLines !== Number.POSITIVE_INFINITY) {
      footerParts.push(`+${truncatedCount} more line${truncatedCount === 1 ? '' : 's'}`);
    }
    if (opts.expandedNote !== null) footerParts.push(opts.expandedNote);
    const footerText = footerParts.join(' · ');
    const marker = opts.isError ? `${t.statusError('✗')} ` : '  ';
    const styledFooter = opts.isError ? t.statusError(footerText) : t.textMuted(footerText);
    this.out.write(`${marker}${styledFooter}\n`);
    this.out.write('\n');
  }

  /** No-op kept for back-compat with the prior overwrite-based slot.
   *  Blocks now commit themselves on end(); there's no in-place state
   *  to lock or release. */
  commit(): void {
    // Intentionally empty. Past callers used this to push the prior
    // block into scrollback before non-tool output rendered; with the
    // new deferred model, blocks are already in scrollback the moment
    // end() fires, so commit() has nothing to do. Kept as a member so
    // existing call sites compile without churn.
  }
}
