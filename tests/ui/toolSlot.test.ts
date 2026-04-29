import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { CompactToolSlot } from '../../src/ui/toolSlot.js';

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

describe('CompactToolSlot', () => {
  test('begin writes a running line; no clear when slot was inactive', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('FileRead', 'path=README.md');
    expect(strip(sink.out)).toContain('→ FileRead path=README.md');
    // No cursor-up sequence on the very first begin.
    expect(sink.out).not.toContain(`${ESC}[1A`);
  });

  test('end overwrites the running line with a result summary', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('Bash', 'command=ls');
    sink.out = ''; // isolate the end() output
    slot.end('total 4\nfile.txt', false);
    // end emits ANSI up + clear, then the result summary.
    expect(sink.out).toContain(`${ESC}[1A`);
    expect(sink.out).toContain(`${ESC}[2K`);
    expect(strip(sink.out)).toContain('✓');
    expect(strip(sink.out)).toContain('2 lines');
  });

  test('error result renders red and shows a one-line error preview', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('Bash', 'command=oops');
    sink.out = '';
    slot.end('Error: command not found\nstack trace', true);
    expect(strip(sink.out)).toContain('✗');
    expect(strip(sink.out)).toContain('Error: command not found');
  });

  test('sequential begin clears the previous slot via ANSI up + clear', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('Tool A', '');
    slot.end('content', false);
    sink.out = '';
    slot.begin('Tool B', '');
    // begin uses \x1b[J (clear from cursor to end of screen), not \x1b[2K.
    expect(sink.out).toContain(`${ESC}[1A`);
    expect(sink.out).toContain(`${ESC}[J`);
    expect(strip(sink.out)).toContain('→ Tool B');
  });

  test('commit() makes the next begin start fresh without clearing', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('Tool A', '');
    slot.commit();
    sink.out = '';
    slot.begin('Tool B', '');
    expect(sink.out).not.toContain(`${ESC}[1A`);
    expect(strip(sink.out)).toContain('→ Tool B');
  });

  test('begin honors interToolLines to ANSI-up past inter-tool text', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('Tool A', '');
    slot.end('ok', false);
    sink.out = '';
    // Pretend the agent streamed 3 lines of text between tools.
    slot.begin('Tool B', '', 3);
    // 3 inter-tool lines + 1 previous slot line = up 4 rows
    expect(sink.out).toContain(`${ESC}[4A`);
  });

  test('begin truncates very long inputs', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('Bash', 'x'.repeat(200));
    const visibleLine = strip(sink.out);
    // truncate(s, 80) → 79 chars + ellipsis
    expect(visibleLine).toContain('…');
    expect(visibleLine.length).toBeLessThan(120);
  });
});
