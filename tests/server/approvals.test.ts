// Phase 16.1 M5 Task 4 — POST /sessions/:id/approvals/:requestId route tests.
//
// Exercises the approvals route end-to-end against an in-process Hono app:
//  - approved=true resolves the pending request with approved=true and HTTP 200
//  - approved=false resolves the pending request with approved=false
//  - unknown requestId returns HTTP 404
//  - missing `approved` returns HTTP 400 (no boolean coercion)
//  - non-boolean `approved` returns HTTP 400
//  - updatedInput round-trips through ApprovalQueue.resolve()

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

  test('POST with missing `approved` field returns 400', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    // Pre-arm so the 404 branch doesn't pre-empt the 400 branch.
    const pending = runtime.approvalQueue.createPending('test-req-missing', 5000);

    const res = await app.request('/sessions/sess-1/approvals/test-req-missing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    // The pending promise must still be unresolved — the route rejected the
    // request before touching the queue.
    runtime.approvalQueue.resolve('test-req-missing', { approved: false });
    const resolved = await pending;
    expect(resolved.approved).toBe(false);

    await runtime.dispose();
  });

  test('POST with non-boolean `approved` returns 400 (no truthy coercion)', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const pending = runtime.approvalQueue.createPending('test-req-nonbool', 5000);

    const res = await app.request('/sessions/sess-1/approvals/test-req-nonbool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: 1 }),
    });
    expect(res.status).toBe(400);

    // Confirm the truthy non-boolean did not slip through as approved=true.
    runtime.approvalQueue.resolve('test-req-nonbool', { approved: false });
    const resolved = await pending;
    expect(resolved.approved).toBe(false);

    await runtime.dispose();
  });

  test('POST forwards updatedInput through to ApprovalQueue.resolve()', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);

    const pending = runtime.approvalQueue.createPending('test-req-update', 5000);

    const res = await app.request('/sessions/sess-1/approvals/test-req-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, updatedInput: { foo: 1 } }),
    });
    expect(res.status).toBe(200);

    const resolved = await pending;
    expect(resolved.approved).toBe(true);
    expect(resolved.updatedInput).toEqual({ foo: 1 });

    await runtime.dispose();
  });
});
