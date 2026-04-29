// Transcript writer tests for redacted manual REPL event logs.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTranscriptLogger,
  redactTranscriptText,
  resolveDebugTranscriptPath,
} from '../../src/ui/transcript.js';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sovereign-transcript-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('transcript logger', () => {
  test('writes redacted JSONL events', () => {
    withTmp((dir) => {
      const logger = createTranscriptLogger(join(dir, 'logs', 'trace.jsonl'), {
        now: () => new Date('2026-04-27T12:00:00.000Z'),
      });
      if (!logger) throw new Error('expected logger');

      logger.record({
        type: 'user_input',
        sessionId: 'session-1',
        text: 'ANTHROPIC_API_KEY=sk-ant-secret123',
      });
      logger.record({
        type: 'permission_answer',
        sessionId: 'session-1',
        answer: 'allow',
      });

      const lines = readFileSync(logger.path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? '{}')).toEqual({
        timestamp: '2026-04-27T12:00:00.000Z',
        type: 'user_input',
        sessionId: 'session-1',
        text: 'ANTHROPIC_API_KEY=[REDACTED]',
      });
      expect(lines.join('\n')).not.toContain('sk-ant-secret123');
      expect(JSON.parse(lines[1] ?? '{}').answer).toBe('allow');
    });
  });

  test('redacts common API key forms', () => {
    expect(redactTranscriptText('sk-or-secret123')).toBe('sk-or-[REDACTED]');
    expect(redactTranscriptText('Authorization: Bearer abc123')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });
});

describe('resolveDebugTranscriptPath', () => {
  const harnessHome = '/tmp/harness-home';
  const now = (): Date => new Date('2026-04-28T10:30:45.123Z');

  test('CLI path always wins', () => {
    expect(
      resolveDebugTranscriptPath({
        cliPath: '/explicit/path.jsonl',
        debugMode: { transcript: true },
        harnessHome,
        now,
      }),
    ).toBe('/explicit/path.jsonl');
  });

  test('returns undefined when transcript not enabled', () => {
    expect(resolveDebugTranscriptPath({ harnessHome, now })).toBeUndefined();
    expect(
      resolveDebugTranscriptPath({ debugMode: { transcript: false }, harnessHome, now }),
    ).toBeUndefined();
    expect(resolveDebugTranscriptPath({ debugMode: {}, harnessHome, now })).toBeUndefined();
  });

  test('defaults to <harnessHome>/debug with timestamped filename', () => {
    expect(resolveDebugTranscriptPath({ debugMode: { transcript: true }, harnessHome, now })).toBe(
      '/tmp/harness-home/debug/transcript-2026-04-28T10-30-45-123Z.jsonl',
    );
  });

  test('honors custom transcriptDir', () => {
    expect(
      resolveDebugTranscriptPath({
        debugMode: { transcript: true, transcriptDir: '/var/log/sovereign' },
        harnessHome,
        now,
      }),
    ).toBe('/var/log/sovereign/transcript-2026-04-28T10-30-45-123Z.jsonl');
  });

  test('umbrella debugMode.enabled forces transcript on', () => {
    expect(resolveDebugTranscriptPath({ debugMode: { enabled: true }, harnessHome, now })).toBe(
      '/tmp/harness-home/debug/transcript-2026-04-28T10-30-45-123Z.jsonl',
    );
  });

  test('umbrella enabled wins over child transcript=false', () => {
    expect(
      resolveDebugTranscriptPath({
        debugMode: { enabled: true, transcript: false },
        harnessHome,
        now,
      }),
    ).toBe('/tmp/harness-home/debug/transcript-2026-04-28T10-30-45-123Z.jsonl');
  });

  test('child transcript still works a la carte when umbrella is unset', () => {
    expect(
      resolveDebugTranscriptPath({
        debugMode: { transcript: true },
        harnessHome,
        now,
      }),
    ).toBe('/tmp/harness-home/debug/transcript-2026-04-28T10-30-45-123Z.jsonl');
  });

  test('both flags off → undefined', () => {
    expect(
      resolveDebugTranscriptPath({
        debugMode: { enabled: false, transcript: false },
        harnessHome,
        now,
      }),
    ).toBeUndefined();
  });
});
