// Phase 10.5 part 2 — runner unit tests. The spawn path is integration-
// shaped; here we focus on the pure helpers (parseToolCalls,
// parseEstCost, stripAnsi) and the sandbox setup. End-to-end runs of
// `sov eval run` are covered by manual smoke + the seed goldens running
// against a live binary.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  buildDriveArgs,
  buildDriveStdin,
  parseEstCost,
  parseToolCalls,
  stripAnsi,
} from '../../src/eval/runner.js';
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

// FIX 3 — since M13 (2026-05-20) `sov chat` boots the Go TUI, which exits 1 on
// non-TTY (piped) stdin. The eval runner must drive the headless `sov drive`
// surface instead (the same surface the semantic suite migrated to). drive's
// `/quit` does NOT print the session-summary card, so the runner injects
// `/stats` before `/quit` to emit the card the cost/tool-call parsers read.
describe('buildDriveArgs (FIX 3)', () => {
  test('spawns the `drive` subcommand, not the dead `chat` surface', () => {
    const args = buildDriveArgs('/tmp/sb/sessions.db', []);
    expect(args[0]).toBe('drive');
    expect(args).not.toContain('chat');
  });

  test('passes --db, --no-preflight, and any extraArgs', () => {
    const args = buildDriveArgs('/tmp/sb/sessions.db', ['--provider', 'anthropic']);
    expect(args).toEqual([
      'drive',
      '--db',
      '/tmp/sb/sessions.db',
      '--no-preflight',
      '--provider',
      'anthropic',
    ]);
  });
});

describe('buildDriveStdin (FIX 3)', () => {
  test('emits one prompt per line, then /stats, then /quit', () => {
    expect(buildDriveStdin('list the files')).toBe('list the files\n/stats\n/quit\n');
  });

  test('handles a multi-prompt sequence (one per turn) before /stats', () => {
    expect(buildDriveStdin(['first', 'second'])).toBe('first\nsecond\n/stats\n/quit\n');
  });

  test('always appends /stats so the summary card is emitted (drive /quit does not)', () => {
    const payload = buildDriveStdin('hi');
    const lines = payload.trimEnd().split('\n');
    expect(lines.at(-2)).toBe('/stats');
    expect(lines.at(-1)).toBe('/quit');
  });
});

describe('parse against a captured `sov drive` /stats card (FIX 3)', () => {
  // Verbatim shape `sov drive` prints when `/stats` runs (the renderSessionSummary
  // card, ANSI already stripped — box-drawing borders + the unicode ✓/✗/· glyphs).
  const driveStatsCard = [
    '╭───────────────────────────────────────────────────────╮',
    '│  Agent powering down. Goodbye!                        │',
    '│                                                       │',
    '│  Interaction Summary                                  │',
    '│  Session ID:    d2fe5418-d5e7-460f-9794-0832d488fcbc  │',
    '│  Tool Calls:    5 ( ✓ 4 · ✗ 1 )                       │',
    '│  Success Rate:  80.0%                                  │',
    '│                                                       │',
    '│  Tokens                                               │',
    '│  Total:         4.7K  (↑ 2 · ↓ 13)                    │',
    '│  Est. Cost:     $0.0011                               │',
    '╰───────────────────────────────────────────────────────╯',
  ].join('\n');

  test('parseToolCalls reads ok/err from the drive card', () => {
    expect(parseToolCalls(driveStatsCard)).toEqual({ ok: 4, err: 1 });
  });

  test('parseEstCost reads the cost from the drive card', () => {
    expect(parseEstCost(driveStatsCard)).toBe(0.0011);
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
