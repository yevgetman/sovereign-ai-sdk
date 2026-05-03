// Multi-line text buffer with cursor — the data structure behind
// inputEditor. Every keypress mutates this; the editor calls
// render(width) to get display lines and write them to stdout.
//
// Wave 4 scope: code-unit-level cursor (no grapheme cluster
// awareness). UTF-16 surrogates may be split by left/right motion
// in pathological cases; in practice users typing emoji into a
// CLI prompt rarely hit this. A future polish wave can graduate
// to Intl.Segmenter if a felt need shows up.
//
// Invariant: lines.length >= 1 (empty buffer has lines=['']).
//   cursor.row in [0, lines.length-1].
//   cursor.col in [0, lines[row].length].

export type Cursor = { row: number; col: number };

export class TextBuffer {
  private lines: string[] = [''];
  private cursorRow = 0;
  private cursorCol = 0;

  // ──────────────────────────────────────────────────────────────────
  // Read access
  // ──────────────────────────────────────────────────────────────────

  /** Full buffer contents joined with \n. */
  toString(): string {
    return this.lines.join('\n');
  }

  /** Convenience: count of lines (always >= 1). */
  lineCount(): number {
    return this.lines.length;
  }

  getLine(row: number): string {
    return this.lines[row] ?? '';
  }

  /** {row, col} — both 0-indexed. */
  getCursor(): Cursor {
    return { row: this.cursorRow, col: this.cursorCol };
  }

  isEmpty(): boolean {
    return this.lines.length === 1 && (this.lines[0]?.length ?? 0) === 0;
  }

  /** Last character of the line containing the cursor, or '' if at start. */
  charBeforeCursor(): string {
    const line = this.lines[this.cursorRow] ?? '';
    if (this.cursorCol === 0) return '';
    return line[this.cursorCol - 1] ?? '';
  }

  /** Trailing character of the LAST line (regardless of cursor position).
   *  Used for the `\` line-continuation check at submit time. */
  charAtBufferEnd(): string {
    const last = this.lines[this.lines.length - 1] ?? '';
    return last.length > 0 ? (last[last.length - 1] ?? '') : '';
  }

  // ──────────────────────────────────────────────────────────────────
  // Write access
  // ──────────────────────────────────────────────────────────────────

  setValue(text: string): void {
    this.lines = text.length === 0 ? [''] : text.split('\n');
    this.cursorRow = this.lines.length - 1;
    this.cursorCol = (this.lines[this.cursorRow] ?? '').length;
  }

  clear(): void {
    this.lines = [''];
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  /** Insert a literal text fragment at the cursor. Embedded newlines
   *  split the buffer into multiple lines. Cursor lands at the end
   *  of the inserted content. */
  insert(text: string): void {
    if (text.length === 0) return;
    const parts = text.split('\n');
    const current = this.lines[this.cursorRow] ?? '';
    const before = current.slice(0, this.cursorCol);
    const after = current.slice(this.cursorCol);
    const firstPart = parts[0] ?? '';
    if (parts.length === 1) {
      this.lines[this.cursorRow] = before + firstPart + after;
      this.cursorCol += firstPart.length;
      return;
    }
    const middle = parts.slice(1, -1);
    const lastPart = parts[parts.length - 1] ?? '';
    const newLines = [before + firstPart, ...middle, lastPart + after];
    this.lines.splice(this.cursorRow, 1, ...newLines);
    this.cursorRow += parts.length - 1;
    this.cursorCol = lastPart.length;
  }

  insertNewline(): void {
    this.insert('\n');
  }

  // Backspace: delete one char to the left of the cursor. At column 0,
  // join with the previous line.
  deleteLeft(): void {
    if (this.cursorCol === 0 && this.cursorRow === 0) return;
    if (this.cursorCol === 0) {
      const previous = this.lines[this.cursorRow - 1] ?? '';
      const current = this.lines[this.cursorRow] ?? '';
      this.lines.splice(this.cursorRow - 1, 2, previous + current);
      this.cursorRow -= 1;
      this.cursorCol = previous.length;
      return;
    }
    const line = this.lines[this.cursorRow] ?? '';
    this.lines[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
    this.cursorCol -= 1;
  }

  // Delete: delete one char to the right of the cursor. At end of line,
  // join with the next line.
  deleteRight(): void {
    const line = this.lines[this.cursorRow] ?? '';
    if (this.cursorCol < line.length) {
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
      return;
    }
    if (this.cursorRow < this.lines.length - 1) {
      const next = this.lines[this.cursorRow + 1] ?? '';
      this.lines.splice(this.cursorRow, 2, line + next);
    }
  }

  // Ctrl-W: delete the word immediately to the left of the cursor.
  deleteWordLeft(): void {
    if (this.cursorCol === 0) {
      this.deleteLeft();
      return;
    }
    const line = this.lines[this.cursorRow] ?? '';
    let start = this.cursorCol;
    // Skip trailing whitespace.
    while (start > 0 && /\s/.test(line[start - 1] ?? '')) start--;
    // Skip the word itself.
    while (start > 0 && !/\s/.test(line[start - 1] ?? '')) start--;
    this.lines[this.cursorRow] = line.slice(0, start) + line.slice(this.cursorCol);
    this.cursorCol = start;
  }

  // Ctrl-U: delete from start of line to cursor.
  deleteToLineStart(): void {
    const line = this.lines[this.cursorRow] ?? '';
    this.lines[this.cursorRow] = line.slice(this.cursorCol);
    this.cursorCol = 0;
  }

  // Ctrl-K: delete from cursor to end of line.
  deleteToLineEnd(): void {
    const line = this.lines[this.cursorRow] ?? '';
    this.lines[this.cursorRow] = line.slice(0, this.cursorCol);
  }

  // ──────────────────────────────────────────────────────────────────
  // Cursor motion
  // ──────────────────────────────────────────────────────────────────

  moveLeft(): void {
    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
      return;
    }
    if (this.cursorRow > 0) {
      this.cursorRow -= 1;
      this.cursorCol = (this.lines[this.cursorRow] ?? '').length;
    }
  }

  moveRight(): void {
    const line = this.lines[this.cursorRow] ?? '';
    if (this.cursorCol < line.length) {
      this.cursorCol += 1;
      return;
    }
    if (this.cursorRow < this.lines.length - 1) {
      this.cursorRow += 1;
      this.cursorCol = 0;
    }
  }

  moveUp(): boolean {
    if (this.cursorRow === 0) return false;
    this.cursorRow -= 1;
    const line = this.lines[this.cursorRow] ?? '';
    if (this.cursorCol > line.length) this.cursorCol = line.length;
    return true;
  }

  moveDown(): boolean {
    if (this.cursorRow >= this.lines.length - 1) return false;
    this.cursorRow += 1;
    const line = this.lines[this.cursorRow] ?? '';
    if (this.cursorCol > line.length) this.cursorCol = line.length;
    return true;
  }

  moveLineStart(): void {
    this.cursorCol = 0;
  }

  moveLineEnd(): void {
    this.cursorCol = (this.lines[this.cursorRow] ?? '').length;
  }

  moveBufferStart(): void {
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  moveBufferEnd(): void {
    this.cursorRow = this.lines.length - 1;
    this.cursorCol = (this.lines[this.cursorRow] ?? '').length;
  }

  /** True when the cursor is on the topmost line. The editor uses
   *  this to decide whether Up should navigate history. */
  cursorIsOnFirstLine(): boolean {
    return this.cursorRow === 0;
  }

  /** True when the cursor is on the bottommost line. The editor uses
   *  this to decide whether Down should navigate history. */
  cursorIsOnLastLine(): boolean {
    return this.cursorRow === this.lines.length - 1;
  }

  // ──────────────────────────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────────────────────────

  /** Lines for display. Wave 4 returns one entry per logical line —
   *  no soft-wrapping. The editor writes each one and uses ANSI cursor
   *  positioning to place the cursor. Wide-character / RTL handling
   *  and soft-wrap are explicit Wave 5+ work. */
  render(): { lines: string[]; cursor: Cursor } {
    return {
      lines: this.lines.slice(),
      cursor: { row: this.cursorRow, col: this.cursorCol },
    };
  }
}
