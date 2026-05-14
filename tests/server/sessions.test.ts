// Phase 16.1 M4 Task 3 — GET /sessions/:id/messages route.
//
// The TUI calls this once on Init() to hydrate the transcript with prior
// conversation history before subscribing to the SSE event stream.
// Hydrate-then-subscribe keeps the SSE stream lean for live events and
// lets the HTTP fetch be retried independently.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('GET /sessions/:id/messages — message backlog', () => {
  test('returns empty array for a freshly created session', async () => {
    const home = join(tmpdir(), `m4-task3a-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      const app = buildAppWithRuntime(runtime);
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      const res = await app.request(`/sessions/${sessionId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: unknown[] };
      expect(body.messages).toEqual([]);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns persisted messages in time order', async () => {
    const home = join(tmpdir(), `m4-task3b-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      const sessionId = runtime.sessionDb.createSession({
        model: 'mock',
        provider: 'mock',
        systemPrompt: [],
        metadata: {},
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
      });

      const app = buildAppWithRuntime(runtime);
      const res = await app.request(`/sessions/${sessionId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]?.role).toBe('user');
      expect(body.messages[0]?.content[0]?.text).toBe('hello');
      expect(body.messages[1]?.role).toBe('assistant');
      expect(body.messages[1]?.content[0]?.text).toBe('hi back');
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns 400 for invalid session id', async () => {
    const home = join(tmpdir(), `m4-task3c-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      const app = buildAppWithRuntime(runtime);
      // isValidSessionId rejects ids with characters outside [A-Za-z0-9_-].
      // 'bad id!' has a space and '!' which fail the character-class check.
      const res = await app.request('/sessions/bad%20id!/messages');
      expect(res.status).toBe(400);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns 404 for unknown session', async () => {
    const home = join(tmpdir(), `m4-task3d-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
      });
      const app = buildAppWithRuntime(runtime);
      const res = await app.request('/sessions/00000000-0000-0000-0000-000000000000/messages');
      expect(res.status).toBe(404);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
