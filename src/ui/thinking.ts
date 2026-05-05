// Inline thinking indicator. Shows a subtle braille spinner with elapsed
// time and live token counts (↑ in / ↓ out) while the runtime is waiting
// on the provider — prompt processing, tool execution, etc. Visible
// updates suppress it; reactivates on subsequent quiet periods.
//
// Implementation note: writes use \r and the ANSI clear-line code so the
// indicator never advances scrollback. A 500ms grace period keeps the
// indicator from flashing during normal fast streaming.

import { isModalActive } from './modal.js';
import { theme } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SHOW_AFTER_MS = 500;
const TICK_MS = 80;
const ESC = '\x1b';

interface WritableLike {
  write(chunk: string): boolean;
}

/** A tool that begin() fired but end() hasn't yet. The spinner shows
 *  these by name so the user knows what's running during the deferred
 *  rendering window (the slot doesn't write anything until end()). */
interface RunningTool {
  name: string;
  /** Truncated arg preview (already shaped by formatToolInputForDisplay
   *  in terminalRepl); displayed as `Name(args)` when only one tool is
   *  running. Multiple-tool case shows just names to keep the line
   *  from blowing past terminal width. */
  args: string;
}

export class ThinkingIndicator {
  private out: WritableLike;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private rendered = false;
  private startedAt = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private streamedChars = 0;
  private frame = 0;
  /** Tools currently mid-flight (begin without matching end). Insertion
   *  order is preserved by Map semantics so the spinner shows them in
   *  call order. */
  private runningTools = new Map<string, RunningTool>();

  constructor(out: WritableLike = process.stdout) {
    this.out = out;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.streamedChars = 0;
    this.frame = 0;
    this.rendered = false;
    this.startTimer = setTimeout(() => this.beginRender(), SHOW_AFTER_MS);
  }

  /** Briefly stop the indicator while the caller emits its own visible
   *  output, but stay armed so the next quiet period restarts the
   *  animation without the caller managing it. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.rendered) this.clearLine();
    this.rendered = false;
  }

  setUsage(input?: number, output?: number): void {
    if (typeof input === 'number') this.inputTokens = input;
    if (typeof output === 'number') this.outputTokens = output;
  }

  /** Track streamed assistant text so output token estimate ticks up
   *  during a stream even before usage_delta lands. */
  noteStreamedChars(chars: number): void {
    this.streamedChars += chars;
  }

  /** Register a tool as running. The spinner's text changes from
   *  "Thinking …" to "Running <Tool>(args) · …" (single tool) or
   *  "Running N tools · A, B, C · …" (multiple), so the user always
   *  knows what's in flight during the deferred-render window. */
  addRunningTool(toolUseId: string, name: string, args: string): void {
    this.runningTools.set(toolUseId, { name, args });
  }

  /** Tool finished — remove from the running list. The spinner reverts
   *  to "Thinking" once all tools have completed. */
  removeRunningTool(toolUseId: string): void {
    this.runningTools.delete(toolUseId);
  }

  private beginRender(): void {
    if (!this.active) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private tick(): void {
    if (!this.active) return;
    // Suppress the spinner while a modal is up so the spinner's
    // \r-clear-line trick doesn't clobber the permission prompt.
    if (isModalActive()) return;
    this.rendered = true;
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const f = FRAMES[this.frame % FRAMES.length] ?? '⠋';
    this.frame++;
    const out = Math.max(this.outputTokens, Math.round(this.streamedChars / 4));
    const tokenStr = this.inputTokens > 0 || out > 0 ? ` ↑ ${this.inputTokens} ↓ ${out}` : '';
    const t = theme.tokens;
    // Pick the message body based on what's currently running:
    //   no tools  → "Thinking …" (waiting on the model)
    //   1 tool    → "Running <Tool>(args) · …"
    //   N tools   → "Running N tools · A, B, C · …"
    // Tool names are intentionally surfaced (not just count) for the
    // multi-tool case — the user wants to know which slow tool is
    // holding up the turn.
    const body = this.runningToolsLabel(elapsed, tokenStr);
    const line = `${t.accent(f)} ${t.textMuted(body)}`;
    this.out.write(`\r${ESC}[2K${line}`);
  }

  private runningToolsLabel(elapsedSec: number, tokenStr: string): string {
    const count = this.runningTools.size;
    if (count === 0) {
      return `Thinking ${elapsedSec}s${tokenStr}`;
    }
    if (count === 1) {
      const only = this.runningTools.values().next().value as RunningTool;
      const argsPart = only.args ? `(${only.args})` : '';
      return `Running ${only.name}${argsPart} · ${elapsedSec}s`;
    }
    const names = Array.from(this.runningTools.values(), (t) => t.name);
    return `Running ${count} tools · ${names.join(', ')} · ${elapsedSec}s`;
  }

  private clearLine(): void {
    this.out.write(`\r${ESC}[2K`);
  }
}
