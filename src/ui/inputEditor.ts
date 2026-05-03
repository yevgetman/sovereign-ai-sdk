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
import { TextBuffer, wrapForDisplay } from './textBuffer.js';
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
  /** Active reverse-i-search session, or null when in normal mode.
   *  `query` is the current substring filter; `matchIndex` is the
   *  offset from the most-recent match (0 = newest match, ++ to
   *  cycle backward). `savedValue` is the buffer's pre-search
   *  contents so Esc / Ctrl-G can restore it. */
  private searchState: {
    query: string;
    matchIndex: number;
    savedValue: string;
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

    // Reverse-search mode replaces the prompt with `(reverse-i-search):
    // <query> → <match>`. Cursor sits at the end of the query.
    const promptText = this.searchState ? this.searchPromptText() : this.prompt;
    const indent = ' '.repeat(visibleWidth(promptText));
    const cols = this.opts.columns?.() ?? process.stdout.columns ?? 80;
    const contentWidth = Math.max(1, cols - visibleWidth(promptText));

    let displayLines: string[];
    let displayCursor: { row: number; col: number };
    if (this.searchState) {
      // In search mode, the buffer body is the matched entry — but
      // we don't write it editable; we just show the match and put
      // the cursor at the end of the query in the prompt line.
      displayLines = [''];
      displayCursor = { row: 0, col: 0 }; // not used for cursor pos below
    } else {
      const wrapped = wrapForDisplay(this.buffer.render(), contentWidth);
      displayLines = wrapped.lines;
      displayCursor = wrapped.cursor;
    }

    const drawn: string[] = [];
    drawn.push(promptText + (displayLines[0] ?? ''));
    for (let i = 1; i < displayLines.length; i++) drawn.push(indent + (displayLines[i] ?? ''));
    this.out.write(drawn.join('\n'));

    // Render completion suggestions below the buffer.
    let extraLines = 0;
    if (this.completionState && this.completionState.suggestions.length > 1) {
      const sugLine = this.formatSuggestionLine();
      this.out.write(`\n${sugLine}`);
      extraLines = 1;
    }

    // Position cursor: from the last drawn line, move up to the
    // target display row, then to the col offset.
    let targetRow: number;
    let colOffset: number;
    if (this.searchState) {
      targetRow = 0;
      // Cursor at end of the prompt's query portion (right before the
      // arrow → match). Approximation: end of prompt line.
      colOffset = visibleWidth(promptText);
    } else {
      targetRow = displayCursor.row;
      colOffset = (targetRow === 0 ? visibleWidth(promptText) : indent.length) + displayCursor.col;
    }
    const lastRow = drawn.length - 1 + extraLines;
    const upBy = lastRow - targetRow;
    if (upBy > 0) this.out.write(`${ESC}[${upBy}A`);
    this.out.write('\r');
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

  /** Render the (reverse-i-search) prompt + matched entry. The cursor
   *  conceptually sits at the end of the query; the matched entry is
   *  shown after a `→` arrow for visibility. */
  private searchPromptText(): string {
    const state = this.searchState;
    if (!state) return this.prompt;
    const t = theme.tokens;
    const match = this.findSearchMatch();
    const matchPart =
      match === null
        ? t.statusWarning(state.query.length > 0 ? '(no match)' : '(type to search)')
        : t.textMuted(`→ ${match}`);
    return `${t.textMuted('(reverse-i-search):')} ${t.accent(state.query)}  ${matchPart}  `;
  }

  // ──────────────────────────────────────────────────────────────────
  // Key handling
  // ──────────────────────────────────────────────────────────────────

  private handleKey(key: Key): void {
    if (!this.resolve) return;

    // Reverse-search mode owns its own dispatch table — character
    // input extends the query; Ctrl-R cycles; Enter accepts; Esc
    // cancels. Any other special key accepts and falls through.
    if (this.searchState) {
      this.handleSearchKey(key);
      return;
    }

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
      case 'r':
        this.enterSearchMode();
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
  // Reverse-i-search (Ctrl-R)
  // ──────────────────────────────────────────────────────────────────

  private enterSearchMode(): void {
    this.searchState = {
      query: '',
      matchIndex: 0,
      savedValue: this.buffer.toString(),
    };
    this.completionState = null;
    this.draw();
  }

  private exitSearchMode(restore: boolean): void {
    if (!this.searchState) return;
    if (restore) this.buffer.setValue(this.searchState.savedValue);
    this.searchState = null;
    this.draw();
  }

  /** Find the Nth-most-recent history entry that contains the query
   *  as a substring. matchIndex 0 = newest match. Returns null when
   *  query is empty or no further matches exist. */
  private findSearchMatch(): string | null {
    if (!this.searchState) return null;
    const { query, matchIndex } = this.searchState;
    if (query.length === 0) return null;
    const all = this.opts.history.snapshot();
    let seen = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const entry = all[i] ?? '';
      if (!entry.includes(query)) continue;
      if (seen === matchIndex) return entry;
      seen++;
    }
    return null;
  }

  private handleSearchKey(key: Key): void {
    if (!this.searchState) return;

    // Cancel keys: Esc / Ctrl-G / Ctrl-C → restore original buffer.
    if (key.name === 'escape') {
      this.exitSearchMode(true);
      return;
    }
    if (key.ctrl && (key.sequence === 'g' || key.sequence === 'c')) {
      this.exitSearchMode(true);
      return;
    }

    // Enter in search mode accepts the matched entry AND submits
    // immediately (matches readline / bash convention). To accept
    // and continue editing, the user presses Right or any motion
    // key — those fall through to the "accept + dispatch" path
    // at the bottom of this function.
    if (key.name === 'enter') {
      const match = this.findSearchMatch();
      if (match !== null) {
        this.buffer.setValue(match);
      }
      this.searchState = null;
      this.onEnter();
      return;
    }

    // Cycle to next-older match.
    if (key.ctrl && key.sequence === 'r') {
      this.searchState.matchIndex += 1;
      if (this.findSearchMatch() === null && this.searchState.matchIndex > 0) {
        // Out of matches — clamp back so the user sees a stable "no
        // more matches" state until they shorten the query.
        this.searchState.matchIndex -= 1;
      }
      this.draw();
      return;
    }

    // Backspace shortens the query.
    if (key.name === 'backspace') {
      this.searchState.query = this.searchState.query.slice(0, -1);
      this.searchState.matchIndex = 0;
      this.draw();
      return;
    }

    // Plain printable char: extend the query, reset the match cursor.
    if (key.sequence.length > 0 && !key.ctrl && !key.name) {
      this.searchState.query += key.sequence;
      this.searchState.matchIndex = 0;
      this.draw();
      return;
    }

    // Other special keys (Tab, arrows, Home/End, Ctrl-A/E/etc.):
    // accept the current match and dispatch the key normally.
    const match = this.findSearchMatch();
    if (match !== null) this.buffer.setValue(match);
    this.searchState = null;
    this.handleKey(key);
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
