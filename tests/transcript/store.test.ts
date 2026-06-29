// FileTranscriptStore — runtime-level per-session writer cache (2026-06-15).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTranscriptStore, type TranscriptSessionInfo } from '../../src/transcript/store.js';

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sov-tstore-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const session = (over: Partial<TranscriptSessionInfo> = {}): TranscriptSessionInfo => ({
  ownerId: null,
  parentSessionId: null,
  model: 'm',
  provider: 'p',
  metadata: {},
  ...over,
});

describe('FileTranscriptStore', () => {
  test('records a message to a per-session file (enabled)', async () => {
    await withTmp(async (base) => {
      const store = new FileTranscriptStore({
        enabled: true,
        base,
        redactSecrets: true,
        cwd: '/proj',
        getSession: () => session(),
      });
      store.recordMessage('s1', 'user', [{ type: 'text', text: 'hi' }], 1);
      await store.closeAll();
      const path = join(base, 'projects', '-proj', 's1.jsonl');
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2); // session_meta + the user message
    });
  });

  test('enabled:false is a complete no-op (no file written)', async () => {
    await withTmp(async (base) => {
      const store = new FileTranscriptStore({
        enabled: false,
        base,
        redactSecrets: true,
        cwd: '/proj',
        getSession: () => session(),
      });
      store.recordMessage('s1', 'user', [{ type: 'text', text: 'hi' }], 1);
      await store.closeAll();
      expect(existsSync(join(base, 'projects'))).toBe(false);
    });
  });

  test('owner-scoped sessions land under users/<owner>/projects', async () => {
    await withTmp(async (base) => {
      const store = new FileTranscriptStore({
        enabled: true,
        base,
        redactSecrets: true,
        cwd: '/proj',
        getSession: () => session({ ownerId: 'alice' }),
      });
      store.recordMessage('s1', 'assistant', [{ type: 'text', text: 'yo' }], 1);
      await store.closeSession('s1');
      expect(existsSync(join(base, 'users', 'alice', 'projects', '-proj', 's1.jsonl'))).toBe(true);
    });
  });

  test('reuses one writer per session (multiple messages → one file, accruing)', async () => {
    await withTmp(async (base) => {
      const store = new FileTranscriptStore({
        enabled: true,
        base,
        redactSecrets: true,
        cwd: '/proj',
        getSession: () => session(),
      });
      store.recordMessage('s1', 'user', [{ type: 'text', text: 'a' }], 1);
      store.recordMessage('s1', 'assistant', [{ type: 'text', text: 'b' }], 2);
      await store.closeAll();
      const lines = readFileSync(join(base, 'projects', '-proj', 's1.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(3); // meta + 2 messages on ONE file
    });
  });

  test('projectsDir reflects enabled state', () => {
    const on = new FileTranscriptStore({
      enabled: true,
      base: '/hh',
      redactSecrets: true,
      cwd: '/p',
      getSession: () => null,
    });
    expect(on.projectsDir).toBe('/hh/projects');
    const off = new FileTranscriptStore({
      enabled: false,
      base: '/hh',
      redactSecrets: true,
      cwd: '/p',
      getSession: () => null,
    });
    expect(off.projectsDir).toBeNull();
  });
});
