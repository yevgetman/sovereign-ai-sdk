// Line-buffered markdown renderer for streaming assistant output.
//
// Text deltas arrive in arbitrary chunks (e.g. "**bo" then "ld**"), so
// inline markdown can't be transformed per delta. We buffer characters
// until a newline, then render the completed line through a small set of
// regex passes (headings, bold, italic, inline code, bullets, blockquote,
// fenced code blocks). Mid-line streaming smoothness is traded for
// correct formatting; in practice assistant output lands in fast line
// bursts and reads fine.

import chalk from 'chalk';
import { theme } from './theme.js';

interface WritableLike {
  write(chunk: string): boolean;
}

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)\.\s+(.*)$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const HRULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

const INLINE_CODE = /`([^`]+)`/g;
const BOLD = /\*\*([^*]+)\*\*/g;
const ITALIC = /(^|[^*])\*([^*\n]+)\*(?!\*)/g;

function renderInline(text: string): string {
  // codeInline pulls from the active theme (cyan in dark, blue in
  // light, identity in no-color) — not chalk.yellow as it was in the
  // pre-wave-3 version. Yellow conflicted with status-warning yellow
  // and made code-heavy paragraphs look alarmist; aligning with the
  // accent color groups inline-code visually with the cyan bullets/
  // numbers below.
  let out = text.replace(INLINE_CODE, (_m, code) => theme.tokens.codeInline(code));
  out = out.replace(BOLD, (_m, inner) => chalk.bold(inner));
  out = out.replace(ITALIC, (_m, pre, inner) => `${pre}${chalk.italic(inner)}`);
  return out;
}

function renderLine(line: string): string {
  if (HRULE.test(line)) return chalk.gray('─'.repeat(40));

  const heading = HEADING.exec(line);
  if (heading) {
    const [, hashes = '', body = ''] = heading;
    const level = hashes.length;
    const text = renderInline(body);
    if (level === 1) return chalk.bold.underline(text);
    if (level === 2) return chalk.bold(text);
    return chalk.bold.gray(text);
  }

  const bullet = BULLET.exec(line);
  if (bullet) {
    const [, indent = '', body = ''] = bullet;
    return `${indent}${chalk.cyan('•')} ${renderInline(body)}`;
  }

  const numbered = NUMBERED.exec(line);
  if (numbered) {
    const [, indent = '', n = '', body = ''] = numbered;
    return `${indent}${chalk.cyan(`${n}.`)} ${renderInline(body)}`;
  }

  const quote = BLOCKQUOTE.exec(line);
  if (quote) {
    const [, body = ''] = quote;
    return chalk.gray(`│ ${renderInline(body)}`);
  }

  return renderInline(line);
}

export class MarkdownStream {
  private out: WritableLike;
  private buf = '';
  private inFence = false;

  constructor(out: WritableLike = process.stdout) {
    this.out = out;
  }

  write(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.emitLine(line);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
    }
  }

  /** Emit any buffered partial line. Returns the number of lines
   *  written to the underlying stream (0 if nothing was buffered, 1
   *  otherwise) so callers tracking line counts for ANSI manipulation
   *  can update without re-counting. */
  flush(): number {
    if (this.buf.length === 0) return 0;
    this.emitLine(this.buf);
    this.buf = '';
    return 1;
  }

  /** Discard any buffered partial line without rendering. Use when the
   *  caller is about to ANSI-clear and replace the affected region. */
  discard(): void {
    this.buf = '';
  }

  private emitLine(line: string): void {
    if (FENCE.test(line)) {
      this.inFence = !this.inFence;
      this.out.write(`${chalk.gray(line)}\n`);
      return;
    }
    if (this.inFence) {
      this.out.write(`${chalk.dim(line)}\n`);
      return;
    }
    this.out.write(`${renderLine(line)}\n`);
  }
}
