// persistMessage — writes the DB row AND the transcript line in lock-step,
// returning the row id verbatim (drop-in for saveMessage). (2026-06-15)

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTranscriptStore } from '@yevgetman/sov-sdk/transcript/store';
import { persistMessage } from '../../src/agent/persistMessage.js';
import type { SaveMessageInput, SessionDb } from '../../src/agent/sessionDb.js';

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sov-persist-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A stub SessionDb that records saveMessage calls and returns a monotonic id. */
function stubDb(): { db: SessionDb; calls: Array<{ sessionId: string; msg: SaveMessageInput }> } {
  const calls: Array<{ sessionId: string; msg: SaveMessageInput }> = [];
  let id = 0;
  const db = {
    saveMessage: (sessionId: string, msg: SaveMessageInput) => {
      calls.push({ sessionId, msg });
      return ++id;
    },
    getSession: () => ({
      ownerId: null,
      parentSessionId: null,
      model: 'm',
      provider: 'p',
      metadata: {},
    }),
  } as unknown as SessionDb;
  return { db, calls };
}

describe('persistMessage', () => {
  test('writes the DB row and the transcript line, returning the row id', async () => {
    await withTmp(async (base) => {
      const { db, calls } = stubDb();
      const transcripts = new FileTranscriptStore({
        enabled: true,
        base,
        redactSecrets: true,
        cwd: '/proj',
        getSession: (id) => db.getSession(id),
      });
      const id1 = persistMessage({ sessionDb: db, transcripts }, 's1', {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      });
      const id2 = persistMessage({ sessionDb: db, transcripts }, 's1', {
        role: 'assistant',
        content: [{ type: 'text', text: 'yo' }],
      });
      await transcripts.closeAll();

      // DB side: both saveMessage calls happened, ids returned verbatim.
      expect(calls).toHaveLength(2);
      expect([id1, id2]).toEqual([1, 2]);
      // Transcript side: one file, meta + 2 messages, seq mirrors the row id.
      const path = join(base, 'projects', '-proj', 's1.jsonl');
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[1]).toMatchObject({ type: 'user', seq: 1 });
      expect(lines[2]).toMatchObject({ type: 'assistant', seq: 2 });
    });
  });

  test('works with no transcript store (DB-only surfaces) and still returns the id', () => {
    const { db, calls } = stubDb();
    const id = persistMessage({ sessionDb: db }, 's', {
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
    });
    expect(id).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
