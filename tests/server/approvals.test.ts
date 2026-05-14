// Phase 16.1 M5 Task 4 — POST /sessions/:id/approvals/:requestId route tests.
//
// Exercises the approvals route end-to-end against an in-process Hono app:
//  - approved=true resolves the pending request with approved=true and HTTP 200
//  - approved=false resolves the pending request with approved=false
//  - unknown requestId returns HTTP 404

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('approvals route', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'm5-approvals-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'm5-approvals-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('POST /sessions/:id/approvals/:requestId resolves a pending request', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    // Pre-arm a pending request directly on the queue.
    const pending = runtime.approvalQueue.createPending('test-req-1', 5000);

    const res = await app.request('/sessions/sess-1/approvals/test-req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const resolved = await pending;
    expect(resolved.approved).toBe(true);

    await runtime.dispose();
  });

  test('POST with approved:false resolves with denied response', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const pending = runtime.approvalQueue.createPending('test-req-2', 5000);
    await app.request('/sessions/sess-1/approvals/test-req-2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });

    const resolved = await pending;
    expect(resolved.approved).toBe(false);

    await runtime.dispose();
  });

  test('POST on unknown requestId returns 404', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const res = await app.request('/sessions/sess-1/approvals/does-not-exist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);

    await runtime.dispose();
  });
});
