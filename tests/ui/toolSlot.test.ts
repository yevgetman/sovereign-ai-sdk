// CompactToolSlot — claude-code-style tool block rendering with deferred
// (correct-under-batch) semantics.
//
// Each tool call renders as:
//   ToolName(args)
//     <output line, dim>
//     ...
//   <marker> <per-tool footer>
//   <blank line>
//
// Rendering is DEFERRED — begin() just stashes; end() writes the
// complete block. This makes the slot correct under the orchestrator's
// batched dispatch (model emits N tool_use blocks → N begin()s back-
// to-back, then N end()s as tools complete possibly out of issue
// order). Each end() looks up its meta by toolUseId and renders.
//
// Tests check: header form, inline output truncation, per-tool footer
// derivation, error rendering, and the multi-tool ordering invariant.

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

describe('CompactToolSlot — deferred rendering', () => {
  test('begin writes nothing — only end() produces visible output', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('id-1', 'FileRead', 'README.md');
    expect(sink.out).toBe('');
  });

  test('end writes Tool(args) header, inline output, footer, blank line', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('id-1', 'Bash', 'ls');
    slot.end('id-1', 'total 4\nfile.txt\nREADME.md', false);
    const visible = strip(sink.out);
    expect(visible).toContain('Bash(ls)\n');
    expect(visible).toContain('  total 4\n');
    expect(visible).toContain('  file.txt\n');
    expect(visible).toContain('  README.md\n');
    expect(visible.endsWith('\n\n')).toBe(true); // trailing blank
  });

  test('end without a matching begin is a no-op (defensive)', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.end('unknown-id', 'orphan content', false);
    expect(sink.out).toBe('');
  });

  test('end omits parens when args is empty', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('id-1', 'HarnessInfo', '');
    slot.end('id-1', 'snapshot text', false);
    const visible = strip(sink.out);
    // Look for the header line specifically: HarnessInfo<newline>
    expect(visible.split('\n')[0]).toBe('HarnessInfo');
  });

  test('truncates very long arg strings', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('id-1', 'Bash', 'x'.repeat(300));
    slot.end('id-1', 'ok', false);
    const headerLine = strip(sink.out).split('\n')[0] ?? '';
    expect(headerLine).toContain('…');
    expect(headerLine.length).toBeLessThan(200);
  });
});

describe('CompactToolSlot — inline output rendering', () => {
  test('truncates output past inlineLines and reports overflow in footer', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 3 });
    slot.begin('id-1', 'Bash', 'big');
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    slot.end('id-1', lines, false);
    const visible = strip(sink.out);
    expect(visible).toContain('  line 1\n');
    expect(visible).toContain('  line 2\n');
    expect(visible).toContain('  line 3\n');
    expect(visible).not.toContain('line 4');
    expect(visible).toContain('+5 more lines');
  });

  test('inlineLines: 0 skips inline content (header + footer only)', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 0 });
    slot.begin('id-1', 'Bash', 'ls');
    slot.end('id-1', 'total 4\nfile.txt', false);
    const visible = strip(sink.out);
    expect(visible).not.toContain('total 4');
    expect(visible).not.toContain('file.txt');
    expect(visible).toContain('2 lines');
  });

  test('empty output renders no inline lines and a "0 lines" footer', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('id-1', 'Bash', 'true');
    slot.end('id-1', '', false);
    expect(strip(sink.out)).toContain('0 lines');
  });

  test('error output is rendered with ✗ marker', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('id-1', 'Bash', 'oops');
    slot.end('id-1', 'Error: command not found', true);
    const visible = strip(sink.out);
    expect(visible).toContain('✗');
    expect(visible).toContain('Error: command not found');
  });
});

describe('CompactToolSlot — per-tool footer derivation', () => {
  test('FileRead footer says "read N lines"', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 2 });
    slot.begin('id-1', 'FileRead', 'src/foo.ts');
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    slot.end('id-1', content, false);
    expect(strip(sink.out)).toContain('read 50 lines');
  });

  test('Glob footer says "found N files"', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 2 });
    slot.begin('id-1', 'Glob', '*.ts');
    slot.end('id-1', 'foo.ts\nbar.ts\nbaz.ts', false);
    expect(strip(sink.out)).toContain('found 3 files');
  });

  test('Grep footer says "matched N lines · in M files" when multiple files', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 5 });
    slot.begin('id-1', 'Grep', '"foo"');
    const content = ['src/a.ts:1:foo', 'src/a.ts:5:foo bar', 'src/b.ts:3:foo'].join('\n');
    slot.end('id-1', content, false);
    const visible = strip(sink.out);
    expect(visible).toContain('matched 3 lines');
    expect(visible).toContain('in 2 files');
  });

  test('AgentTool footer extracts terminal/turns/tool_calls from envelope', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 5 });
    slot.begin('id-1', 'AgentTool', 'explore: investigate');
    const envelope =
      '<subagent_result name="explore" session="abc" lane="anthropic/claude-haiku-4-5" turns="3" tool_calls="2" duration_ms="5400" terminal="completed">\nFound the auth module.\n</subagent_result>';
    slot.end('id-1', envelope, false);
    const visible = strip(sink.out);
    expect(visible).toContain('completed');
    expect(visible).toContain('3 turns');
    expect(visible).toContain('2 tool calls');
  });

  test('Unknown tool falls back to generic "N lines" footer', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 2 });
    slot.begin('id-1', 'Mystery', '');
    slot.end('id-1', 'a\nb\nc', false);
    expect(strip(sink.out)).toContain('3 lines');
  });
});

describe('CompactToolSlot — multi-tool ordering (the parallel-tools fix)', () => {
  test('multiple begins back-to-back then ends in completion order — each block intact', () => {
    // The bug this guards against: model emits 3 tool_use blocks in
    // one assistant message, firing 3 begin()s before any end()
    // arrives. Pre-deferred renderer would clobber headers via ANSI
    // overwrite. Now: begin() stores; end() writes complete blocks
    // in completion order.
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 1 });

    slot.begin('a', 'FileRead', 'src/auth.py');
    slot.begin('b', 'Grep', '"BEARER" in src/');
    slot.begin('c', 'Glob', 'src/**');

    // Nothing visible yet.
    expect(sink.out).toBe('');

    // Ends fire in completion order — possibly different from issue order.
    slot.end('a', 'auth content line', false);
    slot.end('b', 'src/auth.py:1:BEARER', false);
    slot.end('c', 'src/auth.py\nsrc/main.py', false);

    const visible = strip(sink.out);
    // All three headers present.
    expect(visible).toContain('FileRead(src/auth.py)');
    expect(visible).toContain('Grep("BEARER" in src/)');
    expect(visible).toContain('Glob(src/**)');
    // FileRead's content appears below FileRead's header (not below Glob's).
    const fileReadIdx = visible.indexOf('FileRead');
    const fileReadContentIdx = visible.indexOf('auth content line');
    const grepIdx = visible.indexOf('Grep');
    expect(fileReadIdx).toBeLessThan(fileReadContentIdx);
    expect(fileReadContentIdx).toBeLessThan(grepIdx);
  });

  test('out-of-order completion still routes content under the right header', () => {
    // Model issued A then B then C. Tools complete in order C, A, B.
    // Each end()'s block should still associate with its header
    // (because we render the complete block on each end).
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 1 });
    slot.begin('a', 'A', '');
    slot.begin('b', 'B', '');
    slot.begin('c', 'C', '');
    slot.end('c', 'c-content', false);
    slot.end('a', 'a-content', false);
    slot.end('b', 'b-content', false);
    const visible = strip(sink.out);
    // First block in scrollback should be C (it completed first).
    const cIdx = visible.indexOf('c-content');
    const aIdx = visible.indexOf('a-content');
    const bIdx = visible.indexOf('b-content');
    expect(cIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(bIdx);
    // Each content lands directly under its own header (within ~5 lines).
    const cHeaderIdx = visible.indexOf('C\n');
    expect(cHeaderIdx).toBeLessThan(cIdx);
    expect(cIdx - cHeaderIdx).toBeLessThan(20);
  });
});

describe('CompactToolSlot — expand() resurrects truncated content', () => {
  test('returns false when no blocks have completed', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    expect(slot.expand(1)).toBe(false);
    expect(slot.completedCount()).toBe(0);
  });

  test('returns false for out-of-range N', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    slot.begin('a', 'A', '');
    slot.end('a', 'one\ntwo', false);
    expect(slot.expand(0)).toBe(false);
    expect(slot.expand(2)).toBe(false);
  });

  test('expands the most recent block with no truncation', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 2 });
    slot.begin('a', 'Bash', 'big');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    slot.end('a', lines, false);
    sink.out = ''; // isolate the expand output

    expect(slot.expand(1)).toBe(true);
    const visible = strip(sink.out);
    // All 10 lines should be visible (not truncated).
    for (let i = 1; i <= 10; i++) {
      expect(visible).toContain(`  line ${i}\n`);
    }
    // Footer should mention the expansion.
    expect(visible).toContain('expanded · block 1 of 1');
    // No "+ N more lines" — the expand path drops that suffix.
    expect(visible).not.toContain('more lines');
  });

  test('1-indexed: expand(2) hits the second-most-recent block', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 1 });
    slot.begin('a', 'A', '');
    slot.end('a', 'a-content', false);
    slot.begin('b', 'B', '');
    slot.end('b', 'b-content', false);
    sink.out = '';

    expect(slot.expand(2)).toBe(true);
    expect(strip(sink.out)).toContain('a-content');
    expect(strip(sink.out)).not.toContain('b-content');

    sink.out = '';
    expect(slot.expand(1)).toBe(true);
    expect(strip(sink.out)).toContain('b-content');
  });

  test('ring buffer caps retention; oldest blocks drop off', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 1, retain: 3 });
    for (let i = 0; i < 5; i++) {
      const id = `id-${i}`;
      slot.begin(id, `T${i}`, '');
      slot.end(id, `content-${i}`, false);
    }
    expect(slot.completedCount()).toBe(3);
    // expand(1) = most recent (T4), expand(2) = T3, expand(3) = T2.
    // T0 and T1 dropped off.
    sink.out = '';
    expect(slot.expand(3)).toBe(true);
    expect(strip(sink.out)).toContain('content-2');
    sink.out = '';
    expect(slot.expand(4)).toBe(false); // T1 evicted
  });

  test('preserves error state on expansion (✗ marker re-renders)', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink, { inlineLines: 1 });
    slot.begin('a', 'Bash', 'fail');
    slot.end('a', 'Error: nope', true);
    sink.out = '';
    expect(slot.expand(1)).toBe(true);
    const visible = strip(sink.out);
    expect(visible).toContain('✗');
    expect(visible).toContain('Error: nope');
  });
});

describe('CompactToolSlot — commit() is a no-op (back-compat)', () => {
  test('commit() does not throw and does not affect rendering', () => {
    const sink = new StringSink();
    const slot = new CompactToolSlot(sink);
    expect(() => slot.commit()).not.toThrow();
    slot.begin('id-1', 'A', '');
    slot.commit();
    slot.end('id-1', 'x', false);
    const visible = strip(sink.out);
    expect(visible).toContain('A\n');
    expect(visible).toContain('  x\n');
  });
});
