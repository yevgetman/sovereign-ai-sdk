// Pure parser tests for keypress.ts. The full dispatcher loop is
// integration-tested via inputEditor.test.ts; this file pins the
// raw-byte → Key mapping for control chars, ANSI escapes, and
// bracketed-paste bursts.

import { describe, expect, test } from 'bun:test';
import { parseChunk } from '../../src/ui/keypress.js';

const ESC = '\x1b';

function parse(input: string) {
  return parseChunk(input, { inPaste: false, pasteBuffer: '' });
}

describe('keypress.parseChunk — control chars', () => {
  test('Enter (CR) → enter', () => {
    const { keys } = parse('\r');
    expect(keys).toHaveLength(1);
    expect(keys[0]?.name).toBe('enter');
  });

  test('Enter (LF) → enter', () => {
    const { keys } = parse('\n');
    expect(keys[0]?.name).toBe('enter');
  });

  test('Tab → tab', () => {
    const { keys } = parse('\t');
    expect(keys[0]?.name).toBe('tab');
  });

  test('Backspace (0x7f) → backspace', () => {
    const { keys } = parse('\x7f');
    expect(keys[0]?.name).toBe('backspace');
  });

  test('Ctrl-A → ctrl=true, sequence=a', () => {
    const { keys } = parse('\x01');
    expect(keys[0]?.ctrl).toBe(true);
    expect(keys[0]?.sequence).toBe('a');
    expect(keys[0]?.name).toBe('ctrl-a');
  });

  test('Ctrl-C → ctrl-c', () => {
    const { keys } = parse('\x03');
    expect(keys[0]?.name).toBe('ctrl-c');
    expect(keys[0]?.ctrl).toBe(true);
  });

  test('Ctrl-D → ctrl-d', () => {
    const { keys } = parse('\x04');
    expect(keys[0]?.name).toBe('ctrl-d');
  });

  test('Ctrl-H decodes to backspace alias', () => {
    const { keys } = parse('\x08');
    expect(keys[0]?.name).toBe('backspace');
  });
});

describe('keypress.parseChunk — printable input', () => {
  test('plain ASCII → sequence char, no modifiers', () => {
    const { keys } = parse('h');
    expect(keys[0]?.sequence).toBe('h');
    expect(keys[0]?.ctrl).toBe(false);
    expect(keys[0]?.alt).toBe(false);
  });

  test('multiple chars produce one key per char', () => {
    const { keys } = parse('abc');
    expect(keys.map((k) => k.sequence)).toEqual(['a', 'b', 'c']);
  });
});

describe('keypress.parseChunk — ANSI escape sequences', () => {
  test('ESC[A → up', () => {
    const { keys } = parse(`${ESC}[A`);
    expect(keys[0]?.name).toBe('up');
  });

  test('ESC[B → down', () => {
    const { keys } = parse(`${ESC}[B`);
    expect(keys[0]?.name).toBe('down');
  });

  test('ESC[C → right, ESC[D → left', () => {
    expect(parse(`${ESC}[C`).keys[0]?.name).toBe('right');
    expect(parse(`${ESC}[D`).keys[0]?.name).toBe('left');
  });

  test('ESC[H → home, ESC[F → end', () => {
    expect(parse(`${ESC}[H`).keys[0]?.name).toBe('home');
    expect(parse(`${ESC}[F`).keys[0]?.name).toBe('end');
  });

  test('ESC[3~ → delete', () => {
    expect(parse(`${ESC}[3~`).keys[0]?.name).toBe('delete');
  });

  test('ESC[5~ → pageup, ESC[6~ → pagedown', () => {
    expect(parse(`${ESC}[5~`).keys[0]?.name).toBe('pageup');
    expect(parse(`${ESC}[6~`).keys[0]?.name).toBe('pagedown');
  });

  test('ESC[Z → shift-tab', () => {
    const { keys } = parse(`${ESC}[Z`);
    expect(keys[0]?.name).toBe('tab');
    expect(keys[0]?.shift).toBe(true);
  });

  test('SS3 sequence ESC O A → up', () => {
    expect(parse(`${ESC}OA`).keys[0]?.name).toBe('up');
  });

  test('Alt+letter (ESC h) → alt=true, sequence=h', () => {
    const { keys } = parse(`${ESC}h`);
    expect(keys[0]?.alt).toBe(true);
    expect(keys[0]?.sequence).toBe('h');
  });
});

describe('keypress.parseChunk — bracketed paste', () => {
  test('marks every char inside paste markers as paste=true', () => {
    const input = `${ESC}[200~hello\n world${ESC}[201~`;
    const { keys } = parse(input);
    for (const k of keys) expect(k.paste).toBe(true);
    const reconstructed = keys.map((k) => k.sequence).join('');
    expect(reconstructed).toBe('hello\n world');
  });

  test('paste content outside markers is normal', () => {
    const input = `${ESC}[200~ab${ESC}[201~cd`;
    const { keys } = parse(input);
    expect(keys[0]?.paste).toBe(true);
    expect(keys[1]?.paste).toBe(true);
    expect(keys[2]?.paste).toBe(false);
    expect(keys[3]?.paste).toBe(false);
  });

  test('partial paste burst is buffered for the next chunk', () => {
    const first = parse(`${ESC}[200~abc`);
    expect(first.inPaste).toBe(true);
    expect(first.pasteBuffer).toBe('');
    const second = parseChunk(`def${ESC}[201~ghi`, {
      inPaste: first.inPaste,
      pasteBuffer: first.pasteBuffer,
    });
    expect(second.inPaste).toBe(false);
    const allKeys = [...first.keys, ...second.keys];
    const pasted = allKeys
      .filter((k) => k.paste)
      .map((k) => k.sequence)
      .join('');
    expect(pasted).toBe('abcdef');
  });

  test('partial escape sequence is buffered until complete', () => {
    const first = parse(`${ESC}[`);
    // ESC[<EOF> is incomplete — the chunk parser buffers it. The
    // pasteBuffer field carries pending escape bytes too.
    expect(first.keys).toHaveLength(0);
    expect(first.pasteBuffer).toBe(`${ESC}[`);
    const second = parseChunk('A', {
      inPaste: first.inPaste,
      pasteBuffer: first.pasteBuffer,
    });
    expect(second.keys[0]?.name).toBe('up');
  });
});
