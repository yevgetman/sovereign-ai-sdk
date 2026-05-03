// Operation tests for textBuffer.ts. Pure data-structure tests —
// rendering happens via render(), no terminal involved.

import { describe, expect, test } from 'bun:test';
import { TextBuffer } from '../../src/ui/textBuffer.js';

describe('TextBuffer — initialization', () => {
  test('starts empty with cursor at 0,0', () => {
    const buf = new TextBuffer();
    expect(buf.toString()).toBe('');
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
    expect(buf.isEmpty()).toBe(true);
    expect(buf.lineCount()).toBe(1);
  });
});

describe('TextBuffer.insert', () => {
  test('inserts plain text at cursor', () => {
    const buf = new TextBuffer();
    buf.insert('hello');
    expect(buf.toString()).toBe('hello');
    expect(buf.getCursor()).toEqual({ row: 0, col: 5 });
  });

  test('inserts in the middle of a line', () => {
    const buf = new TextBuffer();
    buf.insert('hello world');
    buf.moveLineStart();
    buf.moveRight(); // cursor at col 1 (between 'h' and 'e')
    buf.insert('XX');
    expect(buf.toString()).toBe('hXXello world');
  });

  test('embedded newline splits the line', () => {
    const buf = new TextBuffer();
    buf.insert('foo\nbar');
    expect(buf.lineCount()).toBe(2);
    expect(buf.getLine(0)).toBe('foo');
    expect(buf.getLine(1)).toBe('bar');
    expect(buf.getCursor()).toEqual({ row: 1, col: 3 });
  });

  test('insert with tail preserves text after cursor', () => {
    const buf = new TextBuffer();
    buf.insert('abXYef');
    // move cursor to between 'b' and 'X'
    buf.moveLineStart();
    buf.moveRight();
    buf.moveRight();
    buf.insert('CD');
    expect(buf.toString()).toBe('abCDXYef');
  });
});

describe('TextBuffer — backspace and delete', () => {
  test('deleteLeft removes char before cursor', () => {
    const buf = new TextBuffer();
    buf.insert('hello');
    buf.deleteLeft();
    expect(buf.toString()).toBe('hell');
    expect(buf.getCursor().col).toBe(4);
  });

  test('deleteLeft at column 0 joins with previous line', () => {
    const buf = new TextBuffer();
    buf.insert('foo\nbar');
    buf.moveLineStart();
    expect(buf.getCursor()).toEqual({ row: 1, col: 0 });
    buf.deleteLeft();
    expect(buf.toString()).toBe('foobar');
    expect(buf.lineCount()).toBe(1);
  });

  test('deleteLeft at start of buffer is a no-op', () => {
    const buf = new TextBuffer();
    buf.deleteLeft();
    expect(buf.toString()).toBe('');
  });

  test('deleteRight removes char at cursor', () => {
    const buf = new TextBuffer();
    buf.insert('hello');
    buf.moveLineStart();
    buf.deleteRight();
    expect(buf.toString()).toBe('ello');
  });

  test('deleteRight at end of line joins with next line', () => {
    const buf = new TextBuffer();
    buf.insert('foo\nbar');
    buf.moveUp();
    buf.moveLineEnd();
    buf.deleteRight();
    expect(buf.toString()).toBe('foobar');
    expect(buf.lineCount()).toBe(1);
  });
});

describe('TextBuffer — word and line operations', () => {
  test('deleteWordLeft deletes the word and trailing whitespace', () => {
    const buf = new TextBuffer();
    buf.insert('hello world ');
    buf.deleteWordLeft();
    expect(buf.toString()).toBe('hello ');
  });

  test('deleteWordLeft from column 0 falls through to deleteLeft', () => {
    const buf = new TextBuffer();
    buf.insert('a\nb');
    expect(buf.getCursor()).toEqual({ row: 1, col: 1 });
    buf.moveLineStart();
    buf.deleteWordLeft();
    expect(buf.toString()).toBe('ab');
  });

  test('deleteToLineStart clears from start to cursor', () => {
    const buf = new TextBuffer();
    buf.insert('hello world');
    buf.moveLineStart();
    buf.moveRight();
    buf.moveRight(); // col 2
    buf.deleteToLineStart();
    expect(buf.toString()).toBe('llo world');
  });

  test('deleteToLineEnd clears from cursor to end of line', () => {
    const buf = new TextBuffer();
    buf.insert('hello world');
    buf.moveLineStart();
    buf.moveRight();
    buf.moveRight(); // col 2
    buf.deleteToLineEnd();
    expect(buf.toString()).toBe('he');
  });
});

describe('TextBuffer — cursor motion', () => {
  test('moveLeft / moveRight wrap across line boundaries', () => {
    const buf = new TextBuffer();
    buf.insert('foo\nbar');
    buf.moveBufferStart();
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
    buf.moveRight();
    buf.moveRight();
    buf.moveRight(); // col 3 (end of line 0)
    buf.moveRight(); // wraps to row 1, col 0
    expect(buf.getCursor()).toEqual({ row: 1, col: 0 });
    buf.moveLeft();
    expect(buf.getCursor()).toEqual({ row: 0, col: 3 });
  });

  test('moveUp / moveDown clamp column to line length', () => {
    const buf = new TextBuffer();
    buf.insert('looooong\nshort');
    buf.moveBufferStart();
    buf.moveLineEnd(); // col 8
    buf.moveDown();
    expect(buf.getCursor()).toEqual({ row: 1, col: 5 });
    buf.moveUp();
    // Note: this is a deliberate trade-off — moveUp/Down don't preserve
    // the "remembered" original column across vertical motion.
    expect(buf.getCursor()).toEqual({ row: 0, col: 5 });
  });

  test('cursorIsOnFirstLine / cursorIsOnLastLine', () => {
    const buf = new TextBuffer();
    buf.insert('foo\nbar');
    expect(buf.cursorIsOnFirstLine()).toBe(false);
    expect(buf.cursorIsOnLastLine()).toBe(true);
    buf.moveBufferStart();
    expect(buf.cursorIsOnFirstLine()).toBe(true);
    expect(buf.cursorIsOnLastLine()).toBe(false);
  });
});

describe('TextBuffer.setValue', () => {
  test('replaces buffer contents and parks cursor at end', () => {
    const buf = new TextBuffer();
    buf.insert('original');
    buf.setValue('new\ncontent');
    expect(buf.toString()).toBe('new\ncontent');
    expect(buf.getCursor()).toEqual({ row: 1, col: 7 });
  });

  test('empty string yields a one-line empty buffer', () => {
    const buf = new TextBuffer();
    buf.insert('foo');
    buf.setValue('');
    expect(buf.isEmpty()).toBe(true);
  });
});

describe('TextBuffer.charAtBufferEnd', () => {
  test('returns last char of last line', () => {
    const buf = new TextBuffer();
    buf.insert('hello\\');
    expect(buf.charAtBufferEnd()).toBe('\\');
  });

  test('returns empty when last line is empty', () => {
    const buf = new TextBuffer();
    buf.insert('hello\n');
    expect(buf.charAtBufferEnd()).toBe('');
  });
});

describe('TextBuffer.render', () => {
  test('returns lines + cursor snapshot', () => {
    const buf = new TextBuffer();
    buf.insert('line one\nline two');
    const r = buf.render();
    expect(r.lines).toEqual(['line one', 'line two']);
    expect(r.cursor).toEqual({ row: 1, col: 8 });
  });
});
