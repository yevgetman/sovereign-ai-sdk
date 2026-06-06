// Phase A gateway hardening (Fix 1) — malformed JSON body → 400, not 500.
//
// Both the turns route (POST /sessions/:id/turns) and the approvals route
// (POST /sessions/:id/approvals/:requestId) read the request body via an
// unguarded `await c.req.json()`. A malformed/empty body makes that throw,
// which Hono surfaces as an HTTP 500 text/plain response. Every other
// body-reading route in the codebase guards the parse and returns a
// structured 400 (see chatCompletions.ts, commands.ts, skills.ts). These
// tests pin the mirrored behavior:
//   - malformed body → 400 with a JSON `error` field (NOT 500)
//   - a well-formed body on the same route still works
//   - auth/validation order is preserved (the 404-before-parse guard on
//     approvals stays ahead of the malformed-body guard).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('malformed JSON body → 400 (not 500)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gw-malformed-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'gw-malformed-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  describe('POST /sessions/:id/turns', () => {
    test('malformed body returns 400 with a JSON error shape, not 500', async () => {
      const runtime = await buildRuntime({
        harnessHome: tmpHome,
        cwd: tmpCwd,
        provider: 'mock',
        preflight: false,
      });
      const app = buildAppWithRuntime(runtime);

      // Create a real session so the malformed-body guard is the failing
      // point — not the valid-id / session-exists guards that precede it.
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const res = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe('string');

      await runtime.dispose();
    });

    test('a well-formed body still works (202)', async () => {
      const runtime = await buildRuntime({
        harnessHome: tmpHome,
        cwd: tmpCwd,
        provider: 'mock',
        preflight: false,
      });
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const res = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(202);

      await runtime.dispose();
    });
  });

  describe('POST /sessions/:id/approvals/:requestId', () => {
    test('malformed body on a VALID pending requestId returns 400, not 500', async () => {
      const runtime = await buildRuntime({
        harnessHome: tmpHome,
        cwd: tmpCwd,
        provider: 'mock',
        preflight: false,
      });
      const app = buildAppWithRuntime(runtime);

      // Pre-arm a pending request so the malformed-body guard is reached:
      // the 404-before-parse guard only fires for unknown requestIds.
      const pending = runtime.approvalQueue.createPending('test-req-malformed', 5000);

      const res = await app.request('/sessions/sess-1/approvals/test-req-malformed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe('string');

      // The pending promise must still be unresolved — the route rejected
      // the request before touching the queue.
      runtime.approvalQueue.resolve('test-req-malformed', { approved: false });
      const resolved = await pending;
      expect(resolved.approved).toBe(false);

      await runtime.dispose();
    });

    test('unknown requestId still 404s before the body is parsed', async () => {
      const runtime = await buildRuntime({
        harnessHome: tmpHome,
        cwd: tmpCwd,
        provider: 'mock',
        preflight: false,
      });
      const app = buildAppWithRuntime(runtime);

      // Even with a malformed body, an unknown requestId resolves to 404
      // because the 404 guard runs ahead of the body parse.
      const res = await app.request('/sessions/sess-1/approvals/does-not-exist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      });
      expect(res.status).toBe(404);

      await runtime.dispose();
    });

    test('a well-formed body still resolves a pending request (200)', async () => {
      const runtime = await buildRuntime({
        harnessHome: tmpHome,
        cwd: tmpCwd,
        provider: 'mock',
        preflight: false,
      });
      const app = buildAppWithRuntime(runtime);

      const pending = runtime.approvalQueue.createPending('test-req-ok', 5000);
      const res = await app.request('/sessions/sess-1/approvals/test-req-ok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      expect(res.status).toBe(200);

      const resolved = await pending;
      expect(resolved.approved).toBe(true);

      await runtime.dispose();
    });
  });
});
