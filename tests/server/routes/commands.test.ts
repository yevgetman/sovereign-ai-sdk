// M10.5 — server-side slash-command dispatcher tests.
//
// Covers POST /sessions/:id/commands { name, args } via the in-process
// `app.request()` pattern. Mocks the provider (SOV_TEST_MOCK_PROVIDER=1)
// so tests don't burn API budget.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache } from '../../../src/learning/project.js';
import { buildAppWithRuntime } from '../../../src/server/app.js';
import { type Runtime, buildRuntime } from '../../../src/server/runtime.js';

describe('POST /sessions/:id/commands (M10.5)', () => {
  let runtime: Runtime;
  let app: ReturnType<typeof buildAppWithRuntime>;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m10-5-commands-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
    runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    app = buildAppWithRuntime(runtime);
  });

  afterAll(async () => {
    await runtime.dispose();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function newSession(): Promise<string> {
    const res = await app.request('/sessions', { method: 'POST' });
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    return sessionId;
  }

  async function postCommand(
    sessionId: string,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  test('happy path — /help returns non-empty output listing commands', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, { name: 'help', args: '' });
    expect(status).toBe(200);
    expect(typeof json.output).toBe('string');
    expect((json.output as string).length).toBeGreaterThan(0);
    // /help text references slash commands — at least /help itself.
    expect(json.output as string).toContain('/help');
  });

  test('happy path — /cost returns output mentioning tokens or cost', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, { name: 'cost' });
    expect(status).toBe(200);
    expect(typeof json.output).toBe('string');
    const out = (json.output as string).toLowerCase();
    const mentionsTokens = out.includes('token') || out.includes('cost') || out.includes('$');
    expect(mentionsTokens).toBe(true);
  });

  test('happy path — /tasks returns 200 (tasks list, possibly empty)', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, { name: 'tasks' });
    expect(status).toBe(200);
    expect(typeof json.output).toBe('string');
    // Output is always a string (may be "no tasks" or a list)
  });

  test('/clear mints a child session and surfaces newSessionId side-effect (backlog #41)', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, { name: 'clear' });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    expect((json.output as string).toLowerCase()).toContain('cleared into child session');
    expect(json.output as string).toContain('parent session preserved');

    const se = json.sideEffects as { newSessionId?: string };
    const newSessionId = se?.newSessionId;
    expect(newSessionId).toBeDefined();
    expect(newSessionId).not.toBe(sessionId);

    // The new id should be a real session — subsequent /cost on it works.
    if (newSessionId === undefined) throw new Error('newSessionId missing');
    const followup = await postCommand(newSessionId, { name: 'cost' });
    expect(followup.status).toBe(200);
    expect(followup.json.output).toBeDefined();
  });

  test('/rollback from a child returns parent id via newSessionId side-effect', async () => {
    // First mint a child via /clear so the rollback target exists.
    const parentId = await newSession();
    const clearRes = await postCommand(parentId, { name: 'clear' });
    const childId = (clearRes.json.sideEffects as { newSessionId: string }).newSessionId;

    // Now /rollback from the child should hop back to the parent.
    const { status, json } = await postCommand(childId, { name: 'rollback' });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    expect((json.output as string).toLowerCase()).toContain('rolled back to parent session');

    const se = json.sideEffects as { newSessionId?: string };
    expect(se?.newSessionId).toBe(parentId);
  });

  test('/rollback from a session with no parent returns descriptive error message', async () => {
    const orphanId = await newSession();
    const { status, json } = await postCommand(orphanId, { name: 'rollback' });
    expect(status).toBe(200);
    // The "no parent" path returns the message as output (not error)
    // because it's a user-facing surface, not a route failure.
    expect((json.output as string).toLowerCase()).toContain('no parent session');
    expect(json.sideEffects).toBeUndefined();
  });

  test('unknown command — /healp returns error field with unknown-command message', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, { name: 'healp' });
    expect(status).toBe(200);
    expect(json.error).toBeDefined();
    expect((json.error as string).toLowerCase()).toContain('unknown command');
    // output stays empty so the TUI renders the error
    expect(json.output).toBe('');
  });

  test('side-effect — /model <name> sets modelChanged in sideEffects', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, {
      name: 'model',
      args: 'claude-sonnet-4-6',
    });
    expect(status).toBe(200);
    expect(json.sideEffects).toBeDefined();
    const se = json.sideEffects as { modelChanged?: string };
    expect(se.modelChanged).toBe('claude-sonnet-4-6');
    // runtime.model has been mutated
    expect(runtime.model).toBe('claude-sonnet-4-6');
  });

  test('validation — invalid session id returns 400', async () => {
    // The session-id regex is /^[A-Za-z0-9_-]+$/. A shaped-valid but
    // nonexistent id returns 404 (covered in the next test); a shaped-
    // invalid id (e.g., containing punctuation) returns 400 here.
    const res = await app.request('/sessions/not%21a%21id/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'help' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid session id');
  });

  test('validation — unknown session id returns 404', async () => {
    const res = await app.request('/sessions/00000000-0000-0000-0000-000000000000/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'help' }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('not found');
  });

  test('validation — missing name field returns 400', async () => {
    const sessionId = await newSession();
    const res = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: 'no name' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid request body');
  });

  test('validation — name starting with slash is rejected', async () => {
    const sessionId = await newSession();
    const res = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '/help', args: '' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid request body');
  });

  test('validation — malformed JSON body returns 400', async () => {
    const sessionId = await newSession();
    const res = await app.request(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('args default to empty string when omitted', async () => {
    const sessionId = await newSession();
    const { status, json } = await postCommand(sessionId, { name: 'help' });
    expect(status).toBe(200);
    expect(typeof json.output).toBe('string');
  });

  test('no sideEffects field when command has no side effects', async () => {
    const sessionId = await newSession();
    const { json } = await postCommand(sessionId, { name: 'help' });
    expect(json.sideEffects).toBeUndefined();
  });
});
