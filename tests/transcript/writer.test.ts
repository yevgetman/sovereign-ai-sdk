// TranscriptWriter — per-session JSONL append (2026-06-15).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWriter } from '@yevgetman/sov-sdk/transcript/writer';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sov-transcript-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('TranscriptWriter', () => {
  test('writes a leading session_meta line then one record per message', async () => {
    await withTmp(async (base) => {
      const w = new TranscriptWriter({
        sessionId: 'sess1',
        cwd: '/proj/app',
        base,
        meta: { model: 'claude-x', provider: 'anthropic', kind: 'interactive' },
      });
      w.appendMessage('user', [{ type: 'text', text: 'hello' }], 1);
      w.appendMessage('assistant', [{ type: 'text', text: 'hi there' }], 2);
      await w.close();

      const lines = readLines(w.path);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({
        type: 'session_meta',
        sessionId: 'sess1',
        cwd: '/proj/app',
        model: 'claude-x',
        provider: 'anthropic',
        kind: 'interactive',
      });
      expect(lines[1]).toMatchObject({
        type: 'user',
        seq: 1,
        sessionId: 'sess1',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });
      expect(lines[2]).toMatchObject({ type: 'assistant', seq: 2 });
      // path is under <base>/projects/<slug(cwd)>/<sessionId>.jsonl
      expect(w.path).toContain('/projects/-proj-app/sess1.jsonl');
    });
  });

  test('no file is created when no message is appended (lazy materialization)', async () => {
    await withTmp(async (base) => {
      const w = new TranscriptWriter({ sessionId: 's', cwd: '/p', base });
      await w.close();
      expect(() => readFileSync(w.path, 'utf8')).toThrow();
    });
  });

  test('redactSecrets:false preserves content verbatim', async () => {
    await withTmp(async (base) => {
      const w = new TranscriptWriter({
        sessionId: 's',
        cwd: '/p',
        base,
        redactSecrets: false,
      });
      w.appendMessage('user', [{ type: 'text', text: 'plain content xyz' }], 1);
      await w.close();
      const lines = readLines(w.path);
      const rec = lines[1] as { message: { content: Array<{ text: string }> } };
      expect(rec.message.content[0]?.text).toBe('plain content xyz');
    });
  });

  test('owner scoping places the file under users/<owner>/projects', async () => {
    await withTmp(async (base) => {
      const w = new TranscriptWriter({ sessionId: 's', cwd: '/p', base, ownerId: 'alice' });
      expect(w.path).toContain('/users/alice/projects/-p/s.jsonl');
    });
  });

  test('append is fail-open: a bad base never throws from appendMessage', async () => {
    // A base under a path that cannot be created (a file used as a dir parent).
    const w = new TranscriptWriter({
      sessionId: 's',
      cwd: '/p',
      base: '/dev/null/cannot/mkdir',
    });
    expect(() => w.appendMessage('user', [{ type: 'text', text: 'x' }], 1)).not.toThrow();
    await w.close(); // drains; the queued append swallowed its error
  });
});
