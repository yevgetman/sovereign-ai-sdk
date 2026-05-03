// Persistent input history. Loaded once at REPL startup; appended
// on every accepted input. Capped at MAX_ENTRIES so the file
// doesn't grow unbounded. Used by inputEditor for Up/Down navigation
// across sessions and by historySearch (Wave 4c+) for Ctrl-R.
//
// File format: one entry per line, UTF-8. Newlines INSIDE a single
// historical entry are escaped as `\n` and unescaped on read; this
// keeps the file format trivial to grep/diff and side-steps a more
// complex serializer.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_ENTRIES = 1000;
const NEWLINE_PLACEHOLDER = '\\n';

export type InputHistoryOpts = {
  path: string;
  maxEntries?: number;
};

export class InputHistory {
  private path: string;
  private entries: string[] = [];
  private maxEntries: number;

  constructor(opts: InputHistoryOpts) {
    this.path = opts.path;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  }

  /** Read the file from disk into the in-memory list. Missing /
   *  unreadable file is treated as an empty history (no throw). */
  load(): void {
    if (!existsSync(this.path)) {
      this.entries = [];
      return;
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      this.entries = raw
        .split('\n')
        .filter((line) => line.length > 0)
        .map(decode);
    } catch {
      // Permissions / corruption — start with empty history rather
      // than blocking the REPL on disk weirdness.
      this.entries = [];
    }
  }

  /** Append `entry` to history. Skips no-ops (empty string, exact
   *  duplicate of the previous entry). Rotates when over max. */
  add(entry: string): void {
    const trimmed = entry.trim();
    if (trimmed.length === 0) return;
    if (this.entries[this.entries.length - 1] === entry) return;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.persist();
  }

  /** Snapshot of current entries (oldest → newest). Defensive copy
   *  so callers can mutate freely. */
  snapshot(): string[] {
    return this.entries.slice();
  }

  /** Returns the entry at offset `i` from the end (0 = most recent),
   *  or undefined when out of range. The editor's Up arrow walks
   *  this with an incrementing index. */
  at(offsetFromEnd: number): string | undefined {
    if (offsetFromEnd < 0) return undefined;
    const idx = this.entries.length - 1 - offsetFromEnd;
    if (idx < 0) return undefined;
    return this.entries[idx];
  }

  size(): number {
    return this.entries.length;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const text = this.entries.map(encode).join('\n');
      writeFileSync(this.path, text.length > 0 ? `${text}\n` : '', 'utf8');
    } catch {
      // Non-fatal. History persistence shouldn't block the user
      // from typing — if we can't write, we just keep the in-memory
      // list and try again next add().
    }
  }
}

function encode(s: string): string {
  // Replace literal newlines with the placeholder so each entry
  // occupies exactly one line in the file.
  return s.split('\n').join(NEWLINE_PLACEHOLDER);
}

function decode(s: string): string {
  return s.split(NEWLINE_PLACEHOLDER).join('\n');
}
