// Tests for `sov config` / runConfigOnlyMode (config UX rebuild T6).
//
// Validates the minimal Hono server + stub Runtime boot path that
// `sov config` rides on. The stub runtime does NOT call buildRuntime —
// no providers, no preflight, no bundle, no agents — so the boot is
// orders of magnitude faster than the full TUI launch path.
//
// Coverage:
//   * boot path: bootConfigOnly returns a port + sessionId; server
//     responds to /health
//   * sessions route: POST /sessions mints a real session row in the
//     stub runtime's SessionDb
//   * commands route: POST /sessions/:id/commands works against a known
//     simple command (/help) — proves the dispatcher is reachable with
//     no agent runtime
//   * clean shutdown: bootConfigOnly's shutdown closes the server +
//     disposes the runtime; a second call is idempotent
//   * the stub Runtime exposes the "no provider" sentinel through the
//     resolved-provider transport name

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, bootConfigOnly } from '../../src/cli/configMode.js';

describe('runConfigOnlyMode — minimal server', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-config-mode-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('bootConfigOnly returns a reachable server with a real session id', async () => {
    const booted = await bootConfigOnly({ harnessHomeOverride: tmpHome });
    try {
      expect(typeof booted.port).toBe('number');
      expect(booted.port).toBeGreaterThan(0);
      expect(typeof booted.sessionId).toBe('string');
      expect(booted.sessionId.length).toBeGreaterThan(0);

      // /health is up and reports the version (no auth needed).
      const healthRes = await fetch(`http://127.0.0.1:${booted.port}/health`);
      expect(healthRes.status).toBe(200);
      const healthBody = (await healthRes.json()) as { ok: boolean; version: string };
      expect(healthBody.ok).toBe(true);
      expect(typeof healthBody.version).toBe('string');
    } finally {
      await booted.shutdown();
    }
  });

  test('the minted session id resolves via GET /sessions/:id', async () => {
    const booted = await bootConfigOnly({ harnessHomeOverride: tmpHome });
    try {
      const res = await fetch(`http://127.0.0.1:${booted.port}/sessions/${booted.sessionId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; model: string; provider: string };
      expect(body.sessionId).toBe(booted.sessionId);
      // Stub runtime exposes the "(none)" sentinel — no real provider booted.
      expect(body.provider).toBe('(none)');
      expect(body.model).toBe('(none)');
    } finally {
      await booted.shutdown();
    }
  });

  test('POST /sessions/:id/commands dispatches /help against the stub runtime', async () => {
    const booted = await bootConfigOnly({ harnessHomeOverride: tmpHome });
    try {
      const res = await fetch(
        `http://127.0.0.1:${booted.port}/sessions/${booted.sessionId}/commands`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'help', args: '' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { output: string; error?: string };
      expect(body.error).toBeUndefined();
      expect(typeof body.output).toBe('string');
      // /help renders the slash-command list. The exact content is
      // brittle across milestones; assert the structural marker.
      expect(body.output.length).toBeGreaterThan(0);
      expect(body.output).toContain('/help');
    } finally {
      await booted.shutdown();
    }
  });

  test('POST /sessions/:id/commands surfaces /config without crashing', async () => {
    // /config is the slash command this whole mode exists to serve.
    // Whether it returns the new picker (Agent A's work) or a fallback
    // JSON dump, what matters here is that the dispatcher path itself
    // succeeds — no missing runtime field surfaces as a 500.
    const booted = await bootConfigOnly({ harnessHomeOverride: tmpHome });
    try {
      const res = await fetch(
        `http://127.0.0.1:${booted.port}/sessions/${booted.sessionId}/commands`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'config', args: '' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        output: string;
        error?: string;
        sideEffects?: { pickerOpen?: unknown };
      };
      // The command must not throw — either output OR a pickerOpen side
      // effect (or both) is acceptable. A 500 here would mean the stub
      // runtime is missing a field the command actually uses.
      const hasOutput = body.output !== undefined && body.output.length > 0;
      const hasPicker = body.sideEffects?.pickerOpen !== undefined;
      expect(hasOutput || hasPicker).toBe(true);
    } finally {
      await booted.shutdown();
    }
  });

  test('shutdown is idempotent', async () => {
    const booted = await bootConfigOnly({ harnessHomeOverride: tmpHome });
    await booted.shutdown();
    await booted.shutdown(); // no throw
    // The server should be down — a fetch to /health should fail.
    try {
      const res = await fetch(`http://127.0.0.1:${booted.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      // If somehow the request succeeded, the body should not be 200 ok.
      // Most environments will throw a network error before reaching here.
      expect(res.status).not.toBe(200);
    } catch {
      // Expected — server is gone.
    }
  });
});

describe('stub Runtime shape', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-config-mode-rt-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('the stub runtime exposes the sentinel provider+model', () => {
    const runtime = __test__.buildConfigOnlyRuntime(tmpHome);
    try {
      expect(runtime.model).toBe('(none)');
      expect(runtime.resolvedProvider.transport.name).toBe('(none)');
      expect(runtime.bundle).toBeNull();
      expect(runtime.toolPool.length).toBe(0);
      expect(runtime.systemSegments.length).toBe(0);
      expect(runtime.agents.agents.length).toBe(0);
      expect(runtime.skills.skills.length).toBe(0);
    } finally {
      void runtime.dispose();
    }
  });

  test('the stub runtime opens a real session DB at <home>/sessions.db', () => {
    const runtime = __test__.buildConfigOnlyRuntime(tmpHome);
    try {
      // Create a session — proves the DB is writable.
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        systemPrompt: [],
        metadata: {},
      });
      expect(typeof sessionId).toBe('string');
      const fetched = runtime.sessionDb.getSession(sessionId);
      expect(fetched).not.toBeNull();
    } finally {
      void runtime.dispose();
    }
  });

  test('the stub SessionContext factory returns a minimal but type-valid context', () => {
    const ctx = __test__.buildStubSessionContext('test-session-id');
    expect(ctx.sessionId).toBe('test-session-id');
    // Stub TraceWriter is inert.
    expect(ctx.traceWriter.path).toBe('');
    // No review manager → buildServerCommandContext skips the field via
    // optional chaining.
    expect(ctx.reviewManager).toBeUndefined();
    expect(ctx.trajectoryMetadata.toolCallCount).toBe(0);
    expect(ctx.projectScope.kind).toBe('none');
  });
});
