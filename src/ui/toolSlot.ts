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
}

interface PendingTool {
  name: string;
  args: string;
}

export class CompactToolSlot {
  private readonly out: WritableLike;
  private readonly inlineLines: number;
  /** Tools whose begin() has fired but whose end() hasn't. Keyed by
   *  toolUseId so out-of-order end() calls (parallel tools completing
   *  in different orders than they were issued) still find their meta
   *  cleanly. */
  private pending = new Map<string, PendingTool>();

  constructor(out: WritableLike = process.stdout, opts: ToolSlotOptions = {}) {
    this.out = out;
    this.inlineLines = opts.inlineLines ?? DEFAULT_INLINE_LINES;
  }

  /** Stash the tool's metadata. Renders nothing — the full block
   *  appears when the matching end() fires. */
  begin(toolUseId: string, name: string, args: string): void {
    this.pending.set(toolUseId, { name, args });
  }

  /** Render the complete tool block: header (cyan tool name + paren'd
   *  args), inline output (truncated to inlineLines, dim), per-tool
   *  footer summary, blank line for breathing room. */
  end(toolUseId: string, content: string, isError: boolean): void {
    const meta = this.pending.get(toolUseId);
    if (!meta) return;
    this.pending.delete(toolUseId);

    const t = theme.tokens;
    const argsPart = meta.args ? `(${truncate(meta.args, MAX_ARGS_DISPLAY)})` : '';
    this.out.write(`${t.accent(meta.name)}${argsPart}\n`);

    const trimmed = content.trim();
    const allLines = trimmed.length === 0 ? [] : trimmed.split('\n');
    const totalLines = allLines.length;

    let outputRowsRendered = 0;
    if (this.inlineLines > 0 && allLines.length > 0) {
      const shown = allLines.slice(0, this.inlineLines);
      for (const line of shown) {
        // Truncate very long lines so they don't soft-wrap into multiple
        // visible rows; visual rhythm depends on one logical line per row.
        const safe = truncate(line, MAX_INLINE_LINE_WIDTH);
        this.out.write(`  ${t.textDim(safe)}\n`);
        outputRowsRendered++;
      }
    }

    const truncatedCount = Math.max(0, totalLines - outputRowsRendered);
    const summary = summarizeToolResult({
      toolName: meta.name,
      content: trimmed,
      isError,
      totalLines,
    });
    const footerParts = [summary.primary];
    if (truncatedCount > 0 && this.inlineLines > 0) {
      footerParts.push(`+${truncatedCount} more line${truncatedCount === 1 ? '' : 's'}`);
    }
    const footerText = footerParts.join(' · ');
    const marker = isError ? `${t.statusError('✗')} ` : '  ';
    const styledFooter = isError ? t.statusError(footerText) : t.textMuted(footerText);
    this.out.write(`${marker}${styledFooter}\n`);
    // Blank line for visual breathing room before the next block.
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
