// Bracketed-paste transform tests. The transform sits between stdin and
// readline; it strips paste markers, escapes embedded newlines, and
// passes everything else through unchanged.

import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  BracketedPasteTransform,
  PASTE_NEWLINE_PLACEHOLDER,
  restoreEmbeddedNewlines,
} from '../../src/ui/bracketedPaste.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

async function runTransform(inputs: string[]): Promise<string> {
  const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (fakeStdin as { setRawMode?: (m: boolean) => void }).setRawMode = () => {};
  const transform = new BracketedPasteTransform(fakeStdin);
  let captured = '';
  transform.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8');
  });
  for (const chunk of inputs) {
    transform.write(chunk);
  }
  transform.end();
  await new Promise<void>((resolve) => transform.on('end', () => resolve()));
  return captured;
}

describe('BracketedPasteTransform', () => {
  test('passes ordinary input through unchanged', async () => {
    const result = await runTransform(['hello world\n']);
    expect(result).toBe('hello world\n');
  });

  test('strips paste markers and escapes embedded newlines', async () => {
    const paste = `${PASTE_START}line1\nline2\nline3${PASTE_END}`;
    const result = await runTransform([paste]);
    expect(result).toBe(`line1${PASTE_NEWLINE_PLACEHOLDER}line2${PASTE_NEWLINE_PLACEHOLDER}line3`);
  });

  test('handles a paste interleaved with regular input', async () => {
    const data = `before${PASTE_START}A\nB${PASTE_END}after\n`;
    const result = await runTransform([data]);
    expect(result).toBe(`beforeA${PASTE_NEWLINE_PLACEHOLDER}Bafter\n`);
  });

  test('handles paste markers split across chunk boundaries', async () => {
    // Split the start marker between two chunks, then the end marker too.
    const result = await runTransform(['prefix\x1b[2', '00~hello\nworld\x1b[20', '1~suffix\n']);
    expect(result).toBe(`prefixhello${PASTE_NEWLINE_PLACEHOLDER}worldsuffix\n`);
  });

  test('replaces \\r\\n and bare \\r the same way as \\n', async () => {
    const paste = `${PASTE_START}a\r\nb\rc${PASTE_END}`;
    const result = await runTransform([paste]);
    expect(result).toBe(`a${PASTE_NEWLINE_PLACEHOLDER}b${PASTE_NEWLINE_PLACEHOLDER}c`);
  });

  test('forwards setRawMode to the underlying stream', () => {
    let mode: boolean | undefined;
    const fakeStdin = new PassThrough() as unknown as NodeJS.ReadStream;
    (fakeStdin as { setRawMode?: (m: boolean) => void }).setRawMode = (m: boolean) => {
      mode = m;
    };
    const transform = new BracketedPasteTransform(fakeStdin);
    transform.setRawMode(true);
    expect(mode).toBe(true);
    transform.setRawMode(false);
    expect(mode).toBe(false);
  });
});

describe('restoreEmbeddedNewlines', () => {
  test('swaps the placeholder back to \\n', () => {
    const masked = `line1${PASTE_NEWLINE_PLACEHOLDER}line2${PASTE_NEWLINE_PLACEHOLDER}line3`;
    expect(restoreEmbeddedNewlines(masked)).toBe('line1\nline2\nline3');
  });

  test('leaves input without placeholders untouched', () => {
    expect(restoreEmbeddedNewlines('plain text')).toBe('plain text');
  });
});
