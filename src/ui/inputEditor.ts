// Drop-in replacement for queuedQuestion's `question(prompt) ⇒ string`.
// Owns a TextBuffer + subscribes to keypress events from the
// dispatcher, dispatches keys through a small keybind table, and
// re-renders the buffer area inline above the cursor.
//
// Keybinds (Wave 4 MVP):
//   Enter         submit (unless line ends with `\` → newline)
//   Shift-Tab     no-op (reserved for autocomplete cycling backward)
//   Tab           autocomplete (slash commands, @file paths)
//   Up / Down     history navigation when cursor is on first/last line;
//                 otherwise cursor motion within the buffer
//   Left / Right  cursor motion (across line boundaries)
//   Home / End    line start / line end
//   Backspace     delete left
//   Delete        delete right
//   Ctrl-A / -E   line start / line end (readline emulation)
//   Ctrl-U        delete to line start
//   Ctrl-K        delete to line end
//   Ctrl-W        delete word left
//   Ctrl-L        clear screen
//   Ctrl-C        clear buffer (first); exit when buffer already empty
//   Ctrl-D        EOF when buffer empty; delete-right otherwise
//
// Multi-line submit: a trailing backslash on the buffer's last line
// is consumed and replaced with a newline so the user can keep
// typing. Plain Enter on a buffer whose last line doesn't end with
// `\` submits the entire buffer.
//
// Modal coexistence: while withModal() is active, the keypress
// dispatcher swallows events (see keypress.ts:isModalActive guard).
// The editor's pending question() call resolves only after the
// modal closes and the next Enter arrives.

import type { CompletionResult } from './autocomplete.js';
import { complete } from './autocomplete.js';
import type { InputHistory } from './inputHistory.js';
import type { Key, KeypressDispatcher } from './keypress.js';
import { TextBuffer } from './textBuffer.js';
import { theme } from './theme.js';

const ESC = '\x1b';

interface WritableLike {
  write(chunk: string): boolean;
}

export type InputEditorOpts = {
  keypress: KeypressDispatcher;
  history: InputHistory;
  out?: WritableLike;
  /** Slash command names for tab completion. */
  commandNames: () => string[];
  /** Working directory for @file completions. */
  cwd: () => string;
  /** Width of the rendering area. Defaults to terminal columns. */
  columns?: () => number;
};

export type AskOpts = {
  signal?: AbortSignal;
};

type ResolveFn = (value: string) => void;
type RejectFn = (err: Error) => void;

export class InputEditor {
  private opts: InputEditorOpts;
  private out: WritableLike;
  private buffer = new TextBuffer();
  private historyIndex = -1; // -1 = not browsing
  private historyDraft = ''; // user-typed buffer when they started browsing
  private prompt = '';
  private resolve: ResolveFn | null = null;
  private reject: RejectFn | null = null;
  private signalListener: (() => void) | null = null;
  private renderedLines = 0; // number of lines we last drew below the prompt
  private unsubscribe: (() => void) | null = null;
  private completionState: {
    suggestions: string[];
    index: number;
    replaceFrom: number;
  } | null = null;

  constructor(opts: InputEditorOpts) {
    this.opts = opts;
    this.out = opts.out ?? process.stdout;
  }

  /** Read one logical input. Resolves with the user's text on
   *  Enter (with trailing `\` continuations folded into newlines).
   *  Rejects with name === 'AbortError' when the AbortSignal fires
   *  or 'EOF' when the user hits Ctrl-D on an empty buffer. */
  ask(prompt: string, opts: AskOpts = {}): Promise<string> {
    if (this.resolve) {
      return Promise.reject(new Error('inputEditor: previous ask() has not resolved'));
    }
    this.prompt = prompt;
    this.buffer.clear();
    this.historyIndex = -1;
    this.historyDraft = '';
    this.completionState = null;

    return new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (opts.signal) {
        if (opts.signal.aborted) {
          this.cleanup();
          reject(abortError());
          return;
        }
        this.signalListener = () => {
          if (this.reject) {
            const err = abortError();
            this.cleanup();
            reject(err);
          }
        };
        opts.signal.addEventListener('abort', this.signalListener, { once: true });
      }
      this.opts.keypress.enable();
      this.unsubscribe = this.opts.keypress.subscribe((key) => this.handleKey(key));
      this.renderInitial();
    });
  }

  /** Editor exposes a pending() of zero — it's not buffering input
   *  the way queuedQuestion did. The REPL loop's drain check uses
   *  this to know when to exit. */
  pending(): number {
    return 0;
  }

  // ──────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────

  private renderInitial(): void {
    this.out.write(this.prompt);
    this.draw();
  }

  /** Re-render the buffer area below the prompt. ANSI cursor is moved
   *  to the cursor's position when done. */
  private draw(): void {
    // Erase any previous render. We've drawn `renderedLines` lines
    // including the buffer's first line (which shares the prompt
    // line). For each, move cursor up + clear to end of line.
    if (this.renderedLines > 0) {
      // First, move to the start of the prompt line (current line if
      // renderedLines === 1; otherwise up renderedLines-1 rows).
      this.out.write('\r');
      if (this.renderedLines > 1) this.out.write(`${ESC}[${this.renderedLines - 1}A`);
      // Now clear from current row to end of screen.
      this.out.write(`${ESC}[J`);
    } else {
      this.out.write('\r');
    }

    const { lines, cursor } = this.buffer.render();
    const promptText = this.prompt;
    const indent = ' '.repeat(visibleWidth(promptText));
    // First buffer line is on the prompt line. Subsequent lines are
    // indented to align with the buffer body.
    const drawn: string[] = [];
    drawn.push(promptText + (lines[0] ?? ''));
    for (let i = 1; i < lines.length; i++) drawn.push(indent + (lines[i] ?? ''));
    this.out.write(drawn.join('\n'));

    // Render completion suggestions, if any.
    let extraLines = 0;
    if (this.completionState && this.completionState.suggestions.length > 1) {
      const sugLine = this.formatSuggestionLine();
      this.out.write(`\n${sugLine}`);
      extraLines = 1;
    }

    // Position cursor: from the last drawn line, move up to the cursor
    // row, then to the cursor col (accounting for prompt indent).
    const targetRow = cursor.row;
    const lastRow = drawn.length - 1 + extraLines;
    const upBy = lastRow - targetRow;
    if (upBy > 0) this.out.write(`${ESC}[${upBy}A`);
    // Move to start of line, then to the target column.
    this.out.write('\r');
    const colOffset = (targetRow === 0 ? promptText.length : indent.length) + cursor.col;
    if (colOffset > 0) this.out.write(`${ESC}[${colOffset}C`);

    this.renderedLines = drawn.length + extraLines;
  }

  private formatSuggestionLine(): string {
    const state = this.completionState;
    if (!state) return '';
    const { suggestions, index } = state;
    const visible = suggestions.slice(0, 6);
    const more = suggestions.length - visible.length;
    const t = theme.tokens;
    const parts = visible.map((s, i) => (i === index ? t.accent(s) : t.textMuted(s)));
    if (more > 0) parts.push(t.textDim(`(+${more} more)`));
    return t.textDim('  ↹ ') + parts.join('  ');
  }

  // ──────────────────────────────────────────────────────────────────
  // Key handling
  // ──────────────────────────────────────────────────────────────────

  private handleKey(key: Key): void {
    if (!this.resolve) return;

    if (key.paste) {
      this.buffer.insert(key.sequence);
      this.completionState = null;
      this.draw();
      return;
    }

    // Reset completion state on most keys so Tab → another Tab cycles,
    // but any other key clears the suggestion list.
    if (key.name !== 'tab') this.completionState = null;

    if (this.dispatchByName(key)) return;
    if (this.dispatchCtrl(key)) return;

    // Plain printable input.
    if (key.sequence.length > 0 && !key.ctrl) {
      this.buffer.insert(key.sequence);
      this.draw();
    }
  }

  /** Dispatch a key by symbolic name. Returns true when handled. */
  private dispatchByName(key: Key): boolean {
    switch (key.name) {
      case 'enter':
        this.onEnter();
        return true;
      case 'tab':
        this.onTab();
        return true;
      case 'backspace':
        this.onChange(() => this.buffer.deleteLeft());
        return true;
      case 'delete':
        this.onChange(() => this.buffer.deleteRight());
        return true;
      case 'left':
        this.onMove(() => this.buffer.moveLeft());
        return true;
      case 'right':
        this.onMove(() => this.buffer.moveRight());
        return true;
      case 'home':
        this.onMove(() => this.buffer.moveLineStart());
        return true;
      case 'end':
        this.onMove(() => this.buffer.moveLineEnd());
        return true;
      case 'up':
        this.onUp();
        return true;
      case 'down':
        this.onDown();
        return true;
      default:
        return false;
    }
  }

  /** Dispatch Ctrl+letter readline-style keybinds. Returns true when
   *  handled, false to let the default printable path consume the key. */
  private dispatchCtrl(key: Key): boolean {
    if (!key.ctrl) return false;
    switch (key.sequence) {
      case 'a':
        this.onMove(() => this.buffer.moveLineStart());
        return true;
      case 'e':
        this.onMove(() => this.buffer.moveLineEnd());
        return true;
      case 'b':
        this.onMove(() => this.buffer.moveLeft());
        return true;
      case 'f':
        this.onMove(() => this.buffer.moveRight());
        return true;
      case 'p':
        this.onUp();
        return true;
      case 'n':
        this.onDown();
        return true;
      case 'u':
        this.onChange(() => this.buffer.deleteToLineStart());
        return true;
      case 'k':
        this.onChange(() => this.buffer.deleteToLineEnd());
        return true;
      case 'w':
        this.onChange(() => this.buffer.deleteWordLeft());
        return true;
      case 'l':
        this.onClearScreen();
        return true;
      case 'c':
        this.onCtrlC();
        return true;
      case 'd':
        this.onCtrlD();
        return true;
      default:
        return false;
    }
  }

  private onChange(mutate: () => void): void {
    mutate();
    this.draw();
  }

  private onMove(mutate: () => void): void {
    mutate();
    this.draw();
  }

  private onEnter(): void {
    // Consume a trailing `\` as a line-continuation hint: drop it,
    // insert a newline, keep editing.
    const last = this.buffer.charAtBufferEnd();
    if (last === '\\') {
      this.buffer.moveBufferEnd();
      this.buffer.deleteLeft();
      this.buffer.insertNewline();
      this.draw();
      return;
    }
    const value = this.buffer.toString();
    if (value.length > 0) this.opts.history.add(value);
    // Move cursor below the rendered buffer so subsequent output
    // lands on a fresh line.
    const lines = this.buffer.render().lines.length;
    const cursorRow = this.buffer.getCursor().row;
    const downBy = (this.completionState ? 1 : 0) + (lines - 1 - cursorRow);
    if (downBy > 0) this.out.write(`${ESC}[${downBy}B`);
    this.out.write('\n');
    this.finalize(value);
  }

  private onTab(): void {
    // First Tab: compute suggestions and replace prefix with the first.
    // Subsequent Tabs cycle.
    if (this.completionState && this.completionState.suggestions.length > 0) {
      const state = this.completionState;
      state.index = (state.index + 1) % state.suggestions.length;
      this.applySuggestion();
      this.draw();
      return;
    }
    const result = this.computeCompletion();
    if (result.suggestions.length === 0) return;
    this.completionState = {
      suggestions: result.suggestions,
      index: 0,
      replaceFrom: result.replaceFrom,
    };
    this.applySuggestion();
    this.draw();
  }

  private computeCompletion(): CompletionResult {
    const cursor = this.buffer.getCursor();
    const lineText = this.buffer.getLine(cursor.row);
    return complete({
      text: lineText,
      cursor: cursor.col,
      cwd: this.opts.cwd(),
      commandNames: this.opts.commandNames(),
    });
  }

  private applySuggestion(): void {
    const state = this.completionState;
    if (!state || state.suggestions.length === 0) return;
    const cursor = this.buffer.getCursor();
    const lineText = this.buffer.getLine(cursor.row);
    const before = lineText.slice(0, state.replaceFrom);
    const after = lineText.slice(cursor.col);
    const next = state.suggestions[state.index] ?? '';
    const newLine = before + next + after;
    // Replace whole line through buffer manipulation: navigate to row
    // start, delete to end, insert. (No setLine API yet.)
    this.buffer.moveLineStart();
    this.buffer.deleteToLineEnd();
    this.buffer.insert(newLine);
    // Move cursor to the end of the suggestion (between before+next).
    const targetCol = (before + next).length;
    while (this.buffer.getCursor().col > targetCol) this.buffer.moveLeft();
  }

  private onUp(): void {
    if (!this.buffer.cursorIsOnFirstLine() && this.buffer.moveUp()) {
      this.draw();
      return;
    }
    // History prev
    if (this.historyIndex === -1) {
      this.historyDraft = this.buffer.toString();
    }
    const next = this.opts.history.at(this.historyIndex + 1);
    if (next === undefined) return; // already at oldest
    this.historyIndex += 1;
    this.buffer.setValue(next);
    this.draw();
  }

  private onDown(): void {
    if (!this.buffer.cursorIsOnLastLine() && this.buffer.moveDown()) {
      this.draw();
      return;
    }
    if (this.historyIndex === -1) return; // not browsing history; nothing below
    if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.buffer.setValue(this.historyDraft);
      this.draw();
      return;
    }
    this.historyIndex -= 1;
    const entry = this.opts.history.at(this.historyIndex);
    if (entry !== undefined) {
      this.buffer.setValue(entry);
      this.draw();
    }
  }

  private onClearScreen(): void {
    // \x1b[H moves cursor home; \x1b[2J clears entire screen.
    this.out.write(`${ESC}[H${ESC}[2J`);
    this.renderedLines = 0;
    this.renderInitial();
  }

  private onCtrlC(): void {
    if (this.buffer.isEmpty()) {
      // Two Ctrl-Cs in a row, or any Ctrl-C on empty buffer → exit.
      this.out.write('\n');
      this.finalizeWithError(eofError());
      return;
    }
    // Otherwise: clear buffer (next Ctrl-C on empty buffer exits).
    this.buffer.clear();
    this.completionState = null;
    this.draw();
  }

  private onCtrlD(): void {
    if (this.buffer.isEmpty()) {
      this.out.write('\n');
      this.finalizeWithError(eofError());
      return;
    }
    this.buffer.deleteRight();
    this.draw();
  }

  // ──────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────

  private finalize(value: string): void {
    const resolve = this.resolve;
    this.cleanup();
    resolve?.(value);
  }

  private finalizeWithError(err: Error): void {
    const reject = this.reject;
    this.cleanup();
    reject?.(err);
  }

  private cleanup(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.opts.keypress.disable();
    this.resolve = null;
    this.reject = null;
    this.renderedLines = 0;
    if (this.signalListener) {
      // Best-effort detach; Node's AbortSignal removeEventListener
      // is symmetric with addEventListener.
      this.signalListener = null;
    }
  }

  /** Test seam: drive a key directly without a real keypress
   *  dispatcher. Tests use this to assert keybind behavior without
   *  managing stdin. */
  __testFeed(key: Key): void {
    this.handleKey(key);
  }

  /** Test seam: snapshot the current buffer value. */
  __testValue(): string {
    return this.buffer.toString();
  }
}

function abortError(): Error {
  const err = new Error('input editor aborted');
  err.name = 'AbortError';
  return err;
}

function eofError(): Error {
  const err = new Error('EOF');
  err.name = 'EOF';
  return err;
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}
