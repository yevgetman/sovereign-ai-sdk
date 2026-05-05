// Phase 10.5 part 2 — runner unit tests. The spawn path is integration-
// shaped; here we focus on the pure helpers (parseToolCalls,
// parseEstCost, stripAnsi) and the sandbox setup. End-to-end runs of
// `sov eval run` are covered by manual smoke + the seed goldens running
// against a live binary.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { parseEstCost, parseToolCalls, stripAnsi } from '../../src/eval/runner.js';
import { createEvalSandbox } from '../../src/eval/sandbox.js';

describe('stripAnsi', () => {
  test('removes CSI sequences', () => {
    const input = '\x1b[31mred\x1b[0m text';
    expect(stripAnsi(input)).toBe('red text');
  });

  test('removes OSC sequences', () => {
    const input = '\x1b]0;title\x07hello';
    expect(stripAnsi(input)).toBe('hello');
  });

  test('passes through plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('parseToolCalls', () => {
  test('extracts ok / err from a session-summary footer', () => {
    const transcript = [
      '│  Interaction Summary                                  │',
      '│  Session ID:    8ad28e05-...                           │',
      '│  Tool Calls:    5 ( OK 4 X 1 )                        │',
      '│  Success Rate:  80.0%                                  │',
    ].join('\n');
    const counts = parseToolCalls(transcript);
    expect(counts).toEqual({ ok: 4, err: 1 });
  });

  test('returns undefined when the line is missing', () => {
    expect(parseToolCalls('no summary here')).toBeUndefined();
  });

  test('handles the unicode checkmarks the real summary uses', () => {
    const transcript = '  Tool Calls:    3 ( ✓ 3 · ✗ 0 )';
    expect(parseToolCalls(transcript)).toEqual({ ok: 3, err: 0 });
  });
});

describe('parseEstCost', () => {
  test('extracts cost from the footer', () => {
    const transcript = [
      'Tokens',
      'Total:         4.7K  (↑ 2 · ↓ 13)',
      'Est. Cost:     $0.0011',
    ].join('\n');
    expect(parseEstCost(transcript)).toBe(0.0011);
  });

  test('returns undefined when the line is missing', () => {
    expect(parseEstCost('nothing')).toBeUndefined();
  });
});

describe('createEvalSandbox', () => {
  test('creates a tempdir tree and seeds files into cwd', () => {
    const sandbox = createEvalSandbox({
      'note.txt': 'hello',
      'sub/dir/file.md': '# heading',
    });
    try {
      expect(existsSync(sandbox.cwd)).toBe(true);
      expect(existsSync(`${sandbox.cwd}/note.txt`)).toBe(true);
      expect(existsSync(`${sandbox.cwd}/sub/dir/file.md`)).toBe(true);
      expect(sandbox.envAdditions.HARNESS_HOME).toContain(sandbox.rootDir);
      expect(sandbox.envAdditions.HARNESS_CONFIG).toContain(sandbox.rootDir);
    } finally {
      sandbox.cleanup();
    }
    expect(existsSync(sandbox.rootDir)).toBe(false);
  });

  test('rejects seed paths that escape the sandbox cwd', () => {
    expect(() => createEvalSandbox({ '../escape.txt': 'no' })).toThrow(/escapes sandbox/);
  });

  test('cleanup is idempotent', () => {
    const sandbox = createEvalSandbox();
    sandbox.cleanup();
    sandbox.cleanup();
    expect(existsSync(sandbox.rootDir)).toBe(false);
  });
});
