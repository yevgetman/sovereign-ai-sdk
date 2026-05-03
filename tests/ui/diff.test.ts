// Inline tool-diff renderer — FileEdit / FileWrite shapes, verbose vs.
// non-verbose truncation, edge cases, alias support.

import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { renderDiff, renderToolDiff } from '../../src/ui/diff.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

describe('renderToolDiff', () => {
  test('returns null for unrecognised tools', () => {
    expect(renderToolDiff('Bash', { command: 'ls' })).toBeNull();
    expect(renderToolDiff('FileRead', { path: '/tmp/x' })).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(renderToolDiff('FileEdit', null)).toBeNull();
    expect(renderToolDiff('FileEdit', { path: '/tmp/x' })).toBeNull();
    expect(renderToolDiff('FileWrite', { content: 'x' })).toBeNull();
  });

  test('renders FileEdit with - and + lines', () => {
    const out = renderToolDiff('FileEdit', {
      path: '/tmp/x.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(out).not.toBeNull();
    const text = strip(out ?? '');
    expect(text).toContain('/tmp/x.ts');
    expect(text).toContain('- foo');
    expect(text).toContain('+ bar');
  });

  test('recognises Edit alias', () => {
    expect(
      renderToolDiff('Edit', { path: '/tmp/x', old_string: 'a', new_string: 'b' }),
    ).not.toBeNull();
  });

  test('recognises Write alias', () => {
    expect(renderToolDiff('Write', { path: '/tmp/x', content: 'hello' })).not.toBeNull();
  });

  test('renders FileWrite as additive block', () => {
    const out = renderToolDiff('FileWrite', {
      path: '/tmp/new.txt',
      content: 'line1\nline2\nline3',
    });
    const text = strip(out ?? '');
    expect(text).toContain('/tmp/new.txt');
    expect(text).toContain('+ line1');
    expect(text).toContain('+ line2');
    expect(text).toContain('+ line3');
  });
});

describe('renderDiff non-verbose truncation', () => {
  test('keeps short diffs whole', () => {
    const out = renderDiff(
      { kind: 'edit', path: '/tmp/x', oldString: 'a\nb', newString: 'c\nd' },
      { verbose: false },
    );
    const text = strip(out);
    expect(text).toContain('- a');
    expect(text).toContain('- b');
    expect(text).toContain('+ c');
    expect(text).toContain('+ d');
    expect(text).not.toContain('more line');
  });

  test('truncates large diffs to head + tail with ellipsis', () => {
    const old = Array.from({ length: 20 }, (_, i) => `old-${i}`).join('\n');
    const next = Array.from({ length: 20 }, (_, i) => `new-${i}`).join('\n');
    const out = renderDiff(
      { kind: 'edit', path: '/tmp/big.ts', oldString: old, newString: next },
      { verbose: false },
    );
    const text = strip(out);
    expect(text).toContain('… ');
    expect(text).toContain('more line');
    // Head should be present (first old lines)
    expect(text).toContain('- old-0');
    // Tail should be the last + lines
    expect(text).toContain('+ new-19');
    // A middle line should NOT be present
    expect(text).not.toContain('+ new-10');
  });

  test('verbose=true renders the full block', () => {
    const old = Array.from({ length: 8 }, (_, i) => `o-${i}`).join('\n');
    const next = Array.from({ length: 8 }, (_, i) => `n-${i}`).join('\n');
    const out = renderDiff(
      { kind: 'edit', path: '/tmp/big.ts', oldString: old, newString: next },
      { verbose: true },
    );
    const text = strip(out);
    for (let i = 0; i < 8; i++) {
      expect(text).toContain(`- o-${i}`);
      expect(text).toContain(`+ n-${i}`);
    }
    expect(text).not.toContain('more line');
  });
});

describe('renderDiff with line context (preContent)', () => {
  test('renders the full line containing the substring as -/+ block', () => {
    const file = 'const greeting = "hello world";\n';
    const out = renderDiff(
      { kind: 'edit', path: 'src/x.ts', oldString: 'hello world', newString: 'hello sovereign' },
      { preContent: file, verbose: true },
    );
    const text = strip(out);
    expect(text).toContain('- const greeting = "hello world";');
    expect(text).toContain('+ const greeting = "hello sovereign";');
    // Substring-only output should NOT appear in line-context mode.
    expect(text).not.toMatch(/^\s*- hello world$/m);
  });

  test('shows 1-based line number for the change', () => {
    const file = 'first\nsecond\nthird matched\nfourth\n';
    const out = renderDiff(
      { kind: 'edit', path: 'a.txt', oldString: 'matched', newString: 'changed' },
      { preContent: file, verbose: true },
    );
    expect(strip(out)).toContain('a.txt:3');
  });

  test('handles multi-line old_string spanning two lines', () => {
    const file = 'header\nold first\nold second\ntail\n';
    const out = renderDiff(
      {
        kind: 'edit',
        path: 'multi.txt',
        oldString: 'old first\nold second',
        newString: 'new only',
      },
      { preContent: file, verbose: true },
    );
    const text = strip(out);
    expect(text).toContain('- old first');
    expect(text).toContain('- old second');
    expect(text).toContain('+ new only');
    expect(text).toContain('multi.txt:2');
  });

  test('annotates multi-occurrence edits (replace_all) with count', () => {
    const file = 'foo\nfoo\nfoo bar\nfoo\n';
    const out = renderDiff(
      { kind: 'edit', path: 'r.txt', oldString: 'foo', newString: 'qux' },
      { preContent: file, verbose: true },
    );
    const text = strip(out);
    expect(text).toContain('4 occurrence');
    // Only the FIRST occurrence's hunk is rendered.
    expect(text).toContain('- foo');
    expect(text).toContain('+ qux');
  });

  test('falls back to substring rendering when preContent does not contain match', () => {
    const file = 'totally unrelated content\n';
    const out = renderDiff(
      { kind: 'edit', path: 'x.ts', oldString: 'missing', newString: 'replacement' },
      { preContent: file, verbose: true },
    );
    const text = strip(out);
    // Substring-style render is back: no line number, raw substring.
    expect(text).toContain('- missing');
    expect(text).toContain('+ replacement');
    expect(text).not.toContain('x.ts:');
  });

  test('falls back when oldString is empty', () => {
    const out = renderDiff(
      { kind: 'edit', path: 'x.ts', oldString: '', newString: 'noop' },
      { preContent: 'whatever\n', verbose: true },
    );
    const text = strip(out);
    expect(text).not.toContain('x.ts:');
  });

  test('non-verbose with line context still truncates large hunks', () => {
    // Single old_string spans many lines.
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const file = lines.join('\n');
    const oldStr = lines.join('\n');
    const newStr = 'replaced everything';
    const out = renderDiff(
      { kind: 'edit', path: 'big.txt', oldString: oldStr, newString: newStr },
      { preContent: file, verbose: false },
    );
    const text = strip(out);
    expect(text).toContain('more line');
    // Head should appear; far middle should not.
    expect(text).toContain('- line-0');
    expect(text).not.toContain('- line-15');
  });
});

describe('renderDiff edge cases', () => {
  test('truncates very long single lines with ellipsis', () => {
    const out = renderDiff(
      { kind: 'edit', path: '/tmp/x', oldString: 'a'.repeat(500), newString: 'b' },
      { verbose: true },
    );
    const text = strip(out);
    expect(text).toContain('…');
  });

  test('uses replacement count when provided', () => {
    const out = renderDiff(
      { kind: 'edit', path: '/tmp/x', oldString: 'a', newString: 'b', replacements: 3 },
      { verbose: true },
    );
    expect(strip(out)).toContain('3 replacements');
  });

  test('FileWrite created flag flips the verb', () => {
    const created = renderDiff(
      { kind: 'write', path: '/tmp/x', content: 'hi', created: true },
      { verbose: true },
    );
    const updated = renderDiff(
      { kind: 'write', path: '/tmp/x', content: 'hi', created: false },
      { verbose: true },
    );
    expect(strip(created)).toContain('created');
    expect(strip(updated)).toContain('wrote');
  });

  test('FileWrite shows byte count when provided', () => {
    const out = renderDiff(
      { kind: 'write', path: '/tmp/x', content: 'hi', created: true, bytesWritten: 2 },
      { verbose: true },
    );
    expect(strip(out)).toContain('2 bytes');
  });

  test('output ends with a trailing newline', () => {
    const out = renderDiff(
      { kind: 'edit', path: '/tmp/x', oldString: 'a', newString: 'b' },
      { verbose: false },
    );
    expect(out.endsWith('\n')).toBe(true);
  });
});
