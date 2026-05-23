// Phase 18 T8 — X-Session-Id header + DB persistence.
//
// Pins the observability contract: each /v1/chat/completions request
// mints a SessionDb row tagged metadata.kind='openai-api'; if the client
// supplies X-Session-Id, that string drives both the DB row's session_id
// and the response's chatcmpl-<id> wire id; otherwise the runtime mints
// a UUID. User + assistant messages persist to the row.
//
// D10 invariant: history is NOT hydrated from the DB. The request's
// messages[] is the source of truth; the row exists purely for trace +
// learning observability.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

describe('X-Session-Id header + DB persistence', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'openai-session-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('without X-Session-Id, mints a UUID session row tagged kind=openai-api', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toMatch(/^chatcmpl-/);
    // H1 — the wire id is the UNPREFIXED UUID; the DB row uses the
    // `openai:`-prefixed form. Look up under the prefixed key.
    const wireSessionId = body.id?.replace(/^chatcmpl-/, '') ?? '';
    expect(wireSessionId.length).toBeGreaterThan(0);
    const session = runtime.sessionDb.getSession(`openai:${wireSessionId}`);
    expect(session).not.toBeNull();
    expect(session?.metadata).toBeDefined();
    expect((session?.metadata as { kind?: string }).kind).toBe('openai-api');
    // UUID v4 shape (loose check — 8-4-4-4-12 hex groups).
    expect(wireSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('with X-Session-Id, the session row uses the namespaced id and the wire id echoes the client view', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const customId = `client-conv-${Date.now()}`;
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': customId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    // H1 — wire response echoes the CLIENT-supplied id (unprefixed).
    expect(body.id).toBe(`chatcmpl-${customId}`);
    // DB row uses the namespaced key.
    const session = runtime.sessionDb.getSession(`openai:${customId}`);
    expect(session).not.toBeNull();
    expect((session?.metadata as { kind?: string }).kind).toBe('openai-api');
    // The client's view is preserved in metadata for observability.
    expect((session?.metadata as { clientSessionId?: string }).clientSessionId).toBe(customId);
  });

  test('user + assistant messages are persisted to the session row', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'persist this' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    const wireSessionId = body.id.replace(/^chatcmpl-/, '');
    // H1 — messages persist under the namespaced PK.
    const messages = runtime.sessionDb.loadMessages(`openai:${wireSessionId}`);
    // At minimum: 1 user + 1 assistant message persisted.
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const roles = messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  test('reusing the same X-Session-Id appends to the existing row (not duplicate creation)', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const customId = `reused-session-id-${Date.now()}`;
    const internalKey = `openai:${customId}`;
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': customId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'first request' }],
        stream: false,
      }),
    });
    const messagesAfterFirst = runtime.sessionDb.loadMessages(internalKey);
    const countAfterFirst = messagesAfterFirst.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(2);

    // Second request with different messages[]. The row already exists,
    // so we expect appends rather than a re-create.
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': customId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'second request' }],
        stream: false,
      }),
    });
    const messagesAfterSecond = runtime.sessionDb.loadMessages(internalKey);
    // DB has BOTH requests' messages persisted (at least +2: user +
    // assistant from the second turn).
    expect(messagesAfterSecond.length).toBeGreaterThanOrEqual(countAfterFirst + 2);
    // The session row still exists (single id, not duplicated).
    const session = runtime.sessionDb.getSession(internalKey);
    expect(session).not.toBeNull();
  });

  test('streaming branch persists messages too', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const customId = `streaming-session-${Date.now()}`;
    const internalKey = `openai:${customId}`;
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': customId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'stream me' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    // Drain the SSE body so the streaming generator completes.
    await res.text();
    const messages = runtime.sessionDb.loadMessages(internalKey);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const roles = messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    const session = runtime.sessionDb.getSession(internalKey);
    expect((session?.metadata as { kind?: string }).kind).toBe('openai-api');
  });

  test('X-Session-Id is namespaced — cannot collide with non-openai-api sessions', async () => {
    // H1 — create a non-OpenAI session first (simulating TUI / cron /
    // drive). Verify it has zero messages, then send an OpenAI request
    // with X-Session-Id pointing at that session's id. The TUI session's
    // transcript MUST be untouched; the OpenAI request lands in a
    // namespaced row (`openai:<id>`).
    const tuiSessionId = runtime.sessionDb.createSession({
      provider: 'mock',
      model: 'mock-haiku',
      title: 'TUI session',
      metadata: { kind: 'chat' },
    });
    expect(runtime.sessionDb.loadMessages(tuiSessionId).length).toBe(0);

    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': tuiSessionId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'malicious cross-surface request' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);

    // The TUI session row is UNTOUCHED.
    expect(runtime.sessionDb.loadMessages(tuiSessionId).length).toBe(0);
    const tuiSession = runtime.sessionDb.getSession(tuiSessionId);
    expect((tuiSession?.metadata as { kind?: string }).kind).toBe('chat');

    // The OpenAI request landed in a SEPARATE, namespaced session row.
    const openaiSession = runtime.sessionDb.getSession(`openai:${tuiSessionId}`);
    expect(openaiSession).not.toBeNull();
    expect((openaiSession?.metadata as { kind?: string }).kind).toBe('openai-api');
    expect(runtime.sessionDb.loadMessages(`openai:${tuiSessionId}`).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  test('chatcmpl-<id> in response echoes the CLIENT-supplied id unprefixed', async () => {
    const app = buildOpenAIApp({ runtime, apiKey: 'test' });
    const customId = 'my-conv-123';
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'x-session-id': customId,
      },
      body: JSON.stringify({
        model: 'harness-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    const body = (await res.json()) as { id: string };
    // Client sees its own id, not the openai: prefix.
    expect(body.id).toBe(`chatcmpl-${customId}`);
    // But the DB row uses the prefix.
    expect(runtime.sessionDb.getSession(`openai:${customId}`)).not.toBeNull();
    // The unprefixed id is NOT a separate row.
    expect(runtime.sessionDb.getSession(customId)).toBeNull();
  });
});
