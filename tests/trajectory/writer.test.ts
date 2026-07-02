// Phase 13.1 — JSONL writer. Verifies the bucket split (samples vs
// failed) by terminal reason, the JSONL shape, redaction-at-write, and
// the fire-and-forget tryWriteTrajectory wrapper.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@yevgetman/sov-sdk/core/types';
import {
  buildTrajectoryRecord,
  tryWriteTrajectory,
  writeTrajectory,
} from '@yevgetman/sov-sdk/trajectory/writer';

const META = {
  sessionId: 'session-1',
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  toolCallCount: 2,
  iterationsUsed: 3,
  estimatedCostUsd: 0.0421,
};

const SIMPLE_MESSAGES: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'trajectory-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildTrajectoryRecord', () => {
  test('flags completed: true on Terminal.reason === "completed"', () => {
    const r = buildTrajectoryRecord({
      messages: SIMPLE_MESSAGES,
      terminal: { reason: 'completed' },
      metadata: META,
      artifactsRoot: '/tmp/unused',
    });
    expect(r.completed).toBe(true);
    expect(r.terminalReason).toBe('completed');
    expect(r.conversations.map((c) => c.from)).toEqual(['human', 'gpt']);
    expect(r.sessionId).toBe('session-1');
    expect(r.estimatedCostUsd).toBe(0.0421);
  });

  test('flags completed: false on error / interrupted / max_tokens', () => {
    for (const reason of ['error', 'interrupted', 'max_tokens'] as const) {
      const r = buildTrajectoryRecord({
        messages: SIMPLE_MESSAGES,
        terminal: { reason },
        metadata: META,
        artifactsRoot: '/tmp/unused',
      });
      expect(r.completed).toBe(false);
      expect(r.terminalReason).toBe(reason);
    }
  });

  test('flags completed: true on max_turns (the run loop hit the cap cleanly)', () => {
    const r = buildTrajectoryRecord({
      messages: SIMPLE_MESSAGES,
      terminal: { reason: 'max_turns' },
      metadata: META,
      artifactsRoot: '/tmp/unused',
    });
    expect(r.completed).toBe(true);
  });
});

describe('writeTrajectory', () => {
  test('appends to samples.jsonl when completed', async () => {
    await withTmp(async (dir) => {
      const result = await writeTrajectory({
        messages: SIMPLE_MESSAGES,
        terminal: { reason: 'completed' },
        metadata: META,
        artifactsRoot: dir,
      });
      expect(result.bucket).toBe('samples');
      expect(result.path).toBe(join(dir, 'trajectories', 'samples.jsonl'));
      const body = readFileSync(result.path, 'utf8');
      expect(body.endsWith('\n')).toBe(true);
      const record = JSON.parse(body.trim()) as { sessionId: string };
      expect(record.sessionId).toBe('session-1');
    });
  });

  test('appends to failed.jsonl on interrupt', async () => {
    await withTmp(async (dir) => {
      const result = await writeTrajectory({
        messages: SIMPLE_MESSAGES,
        terminal: { reason: 'interrupted' },
        metadata: META,
        artifactsRoot: dir,
      });
      expect(result.bucket).toBe('failed');
      expect(result.path).toBe(join(dir, 'trajectories', 'failed.jsonl'));
    });
  });

  test('multiple writes append cleanly (one record per line)', async () => {
    await withTmp(async (dir) => {
      await writeTrajectory({
        messages: SIMPLE_MESSAGES,
        terminal: { reason: 'completed' },
        metadata: META,
        artifactsRoot: dir,
      });
      await writeTrajectory({
        messages: SIMPLE_MESSAGES,
        terminal: { reason: 'completed' },
        metadata: { ...META, sessionId: 'session-2' },
        artifactsRoot: dir,
      });
      const body = readFileSync(join(dir, 'trajectories', 'samples.jsonl'), 'utf8');
      const lines = body.trim().split('\n');
      expect(lines.length).toBe(2);
      const recs = lines.map((l) => JSON.parse(l) as { sessionId: string });
      expect(recs.map((r) => r.sessionId)).toEqual(['session-1', 'session-2']);
    });
  });

  test('redacts secrets in the on-disk record (Invariant #15)', async () => {
    await withTmp(async (dir) => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'I copied my key sk-ant-api03-deadbeefABCdef_xyz1234567 by mistake',
            },
          ],
        },
      ];
      await writeTrajectory({
        messages,
        terminal: { reason: 'completed' },
        metadata: META,
        artifactsRoot: dir,
      });
      const body = readFileSync(join(dir, 'trajectories', 'samples.jsonl'), 'utf8');
      expect(body).not.toContain('sk-ant-api03-');
      expect(body).toContain('[REDACTED]');
    });
  });
});

describe('tryWriteTrajectory', () => {
  test('returns null on filesystem failure without throwing', async () => {
    const logs: string[] = [];
    const result = await tryWriteTrajectory(
      {
        messages: SIMPLE_MESSAGES,
        terminal: { reason: 'completed' },
        metadata: META,
        // Path that mkdir-recursive can't create (parent is a file).
        artifactsRoot: '/dev/null/cannot-make-this',
      },
      (msg) => logs.push(msg),
    );
    expect(result).toBeNull();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('[trajectory]');
  });

  test('returns the WriteResult on success', async () => {
    await withTmp(async (dir) => {
      const result = await tryWriteTrajectory({
        messages: SIMPLE_MESSAGES,
        terminal: { reason: 'completed' },
        metadata: META,
        artifactsRoot: dir,
      });
      expect(result).not.toBeNull();
      expect(result?.bucket).toBe('samples');
    });
  });
});
