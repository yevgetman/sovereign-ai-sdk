// Transcript writer tests for redacted manual REPL event logs.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptLogger, redactTranscriptText } from '../../src/ui/transcript.js';

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
