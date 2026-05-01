// Bracketed-paste support. Modern terminals (iTerm2, Terminal.app, kitty,
// alacritty, GNOME Terminal, Windows Terminal, etc.) can wrap pasted
// content in `\x1b[200~` ... `\x1b[201~` markers when the application
// asks for it via the DECSET 2004 mode. Without this, readline sees the
// embedded `\n` bytes and fragments a multi-line paste into N separate
// 'line' events — each becomes its own message. With this, the Transform
// strips the markers and rewrites embedded newlines to a placeholder so
// readline accumulates the whole paste into one buffer.
//
// `restoreEmbeddedNewlines` swaps the placeholder back to `\n` after the
// user hits Enter, so the model receives the original multi-line message.

import { Transform, type TransformCallback } from 'node:stream';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const NL_RE = /\r\n|\r|\n/g;

/** Visible "↵" placeholder (U+21B5) substituted for newlines that
 *  originated inside a bracketed-paste block. Readline doesn't break on
 *  it (it only breaks on raw `\n`/`\r` bytes), and the user sees the
 *  arrow in the input area while editing — making it clear that the
 *  multiple lines were preserved as part of one message. */
export const PASTE_NEWLINE_PLACEHOLDER = '↵';

const PLACEHOLDER_RE = new RegExp(PASTE_NEWLINE_PLACEHOLDER, 'g');

/** Given a chunk's tail, return the length of the trailing partial that
 *  could be the start of either paste marker (so we can buffer it across
 *  chunk boundaries). 0 when the tail is unambiguous. */
function findPartialMarkerTail(data: string): number {
  for (let len = Math.min(PASTE_START.length, data.length); len > 0; len--) {
    const tail = data.slice(-len);
    if (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail)) {
      return len;
    }
  }
  return 0;
}

/** Wraps a TTY input stream so that bracketed-paste content arrives at
 *  readline as a single line (markers stripped, embedded newlines
 *  replaced with a placeholder). Forwards `setRawMode` and reports
 *  `isTTY: true` so readline still drives terminal mode on the
 *  underlying stdin. */
export class BracketedPasteTransform extends Transform {
  readonly isTTY = true as const;
  private inPaste = false;
  private leftover = '';

  constructor(private readonly source: NodeJS.ReadStream) {
    super();
  }

  setRawMode(mode: boolean): this {
    this.source.setRawMode?.(mode);
    return this;
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const incoming = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const data = this.leftover + incoming;
    this.leftover = '';

    const partial = findPartialMarkerTail(data);
    const safeEnd = data.length - partial;
    if (partial > 0) this.leftover = data.slice(safeEnd);
    const safe = data.slice(0, safeEnd);

    let out = '';
    let i = 0;
    while (i < safe.length) {
      if (!this.inPaste) {
        const startIdx = safe.indexOf(PASTE_START, i);
        if (startIdx === -1) {
          out += safe.slice(i);
          break;
        }
        out += safe.slice(i, startIdx);
        i = startIdx + PASTE_START.length;
        this.inPaste = true;
      } else {
        const endIdx = safe.indexOf(PASTE_END, i);
        if (endIdx === -1) {
          out += safe.slice(i).replace(NL_RE, PASTE_NEWLINE_PLACEHOLDER);
          break;
        }
        out += safe.slice(i, endIdx).replace(NL_RE, PASTE_NEWLINE_PLACEHOLDER);
        i = endIdx + PASTE_END.length;
        this.inPaste = false;
      }
    }

    callback(null, Buffer.from(out, 'utf8'));
  }
}

/** Swap the paste-newline placeholder back to actual `\n` characters. */
export function restoreEmbeddedNewlines(line: string): string {
  return line.replace(PLACEHOLDER_RE, '\n');
}

/** Tell the terminal to wrap pasted content in bracketed-paste markers. */
export function enableBracketedPaste(stream: NodeJS.WriteStream): void {
  if (stream.isTTY) stream.write('\x1b[?2004h');
}

/** Restore the terminal's normal paste behavior. */
export function disableBracketedPaste(stream: NodeJS.WriteStream): void {
  if (stream.isTTY) stream.write('\x1b[?2004l');
}
