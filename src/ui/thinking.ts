// Inline thinking indicator. Shows a subtle braille spinner with elapsed
// time and live token counts (↑ in / ↓ out) while the runtime is waiting
// on the provider — prompt processing, tool execution, etc. Visible
// updates suppress it; reactivates on subsequent quiet periods.
//
// Implementation note: writes use \r and the ANSI clear-line code so the
// indicator never advances scrollback. A 500ms grace period keeps the
// indicator from flashing during normal fast streaming.

import chalk from 'chalk';
import { isModalActive } from './modal.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SHOW_AFTER_MS = 500;
const TICK_MS = 80;
const ESC = '\x1b';

interface WritableLike {
  write(chunk: string): boolean;
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
    const line = `${chalk.cyan(f)} ${chalk.gray(`Thinking ${elapsed}s${tokenStr}`)}`;
    this.out.write(`\r${ESC}[2K${line}`);
  }

  private clearLine(): void {
    this.out.write(`\r${ESC}[2K`);
  }
}
