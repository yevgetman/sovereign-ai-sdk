import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { MarkdownStream } from '../../src/ui/markdownStream.js';

chalk.level = 1;

class StringSink {
  out = '';
  write(chunk: string): boolean {
    this.out += chunk;
    return true;
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

function render(...chunks: string[]): { raw: string; plain: string } {
  const sink = new StringSink();
  const md = new MarkdownStream(sink);
  for (const c of chunks) md.write(c);
  md.flush();
  return { raw: sink.out, plain: strip(sink.out) };
}

describe('MarkdownStream', () => {
  test('renders a heading with bold ANSI and trailing newline', () => {
    const { raw, plain } = render('# Hello\n');
    expect(plain).toBe('Hello\n');
    expect(raw).toContain(`${ESC}[1m`);
  });

  test('handles bold split across deltas', () => {
    const { raw, plain } = render('say **bo', 'ld** word\n');
    expect(plain).toBe('say bold word\n');
    expect(raw).toContain(`${ESC}[1m`);
  });

  test('renders italic without consuming bold markers', () => {
    const { raw, plain } = render('a **bold** and *em* end\n');
    expect(plain).toBe('a bold and em end\n');
    expect(raw).toContain(`${ESC}[1m`);
    expect(raw).toContain(`${ESC}[3m`);
  });

  test('inline code is colored, not stripped', () => {
    const { plain } = render('use `cat file.txt` to read\n');
    expect(plain).toBe('use cat file.txt to read\n');
  });

  test('inline code uses the active theme — cyan in dark (matches bullet/number color)', () => {
    // Regression guard: renderer used to call chalk.yellow directly,
    // bypassing the theme system entirely. Yellow conflicted with
    // status-warning yellow and made code-heavy paragraphs look like
    // walls of warnings. Now: theme.tokens.codeInline → cyan in dark
    // theme, matching `accent` (which is what bullets/numbers use).
    const { raw } = render('the `verify_token` function\n');
    // Cyan foreground = ESC[36m.
    expect(raw).toContain(`${ESC}[36m`);
    // No yellow.
    expect(raw).not.toContain(`${ESC}[33mverify_token`);
  });

  test('inline code matches bullet-marker color in the same render', () => {
    // Concrete proof of the unification: a bullet line with inline
    // code should color both the bullet glyph and the code span the
    // same way (the user's stated goal — "same color as the number
    // bullet points").
    const { raw } = render('- use `verify_token` to check\n');
    // Both should color spans appear within the same line.
    // chalk.cyan opens with ESC[36m, closes with ESC[39m.
    const cyanOpens = (raw.match(new RegExp(`${ESC}\\[36m`, 'g')) ?? []).length;
    expect(cyanOpens).toBeGreaterThanOrEqual(2); // bullet + code
  });

  test('bullet list renders bullet glyph', () => {
    const { plain } = render('- one\n- two\n');
    expect(plain).toBe('• one\n• two\n');
  });

  test('numbered list preserves the number', () => {
    const { plain } = render('1. first\n2. second\n');
    expect(plain).toBe('1. first\n2. second\n');
  });

  test('blockquote gets a left bar', () => {
    const { plain } = render('> a quote\n');
    expect(plain).toBe('│ a quote\n');
  });

  test('fenced code block disables inline rendering inside', () => {
    const { plain } = render('```ts\nconst x = **not bold**;\n```\n');
    expect(plain).toContain('const x = **not bold**;');
  });

  test('flush emits buffered partial line without newline', () => {
    const sink = new StringSink();
    const md = new MarkdownStream(sink);
    md.write('partial text');
    md.flush();
    expect(strip(sink.out)).toBe('partial text\n');
  });

  test('horizontal rule renders as a line', () => {
    const { plain } = render('---\n');
    expect(plain).toMatch(/^─+\n$/);
  });

  test('flush returns 1 when a partial line was emitted, 0 otherwise', () => {
    const sink = new StringSink();
    const md = new MarkdownStream(sink);
    expect(md.flush()).toBe(0);
    md.write('partial');
    expect(md.flush()).toBe(1);
    expect(md.flush()).toBe(0);
  });

  test('discard drops the buffered partial without emitting', () => {
    const sink = new StringSink();
    const md = new MarkdownStream(sink);
    md.write('about to be discarded');
    md.discard();
    md.flush();
    expect(sink.out).toBe('');
  });
});
