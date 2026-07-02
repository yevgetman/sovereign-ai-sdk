// Phase 16.1 M7 T4 — trajectory capture on session disposal.
//
// When runtime.disposeSession(sessionId) is invoked, the session's full
// message history is written as a ShareGPT-shaped JSONL record into
// <artifactsRoot>/trajectories/{samples,failed}.jsonl. Bucket selection is
// driven by SessionContext.trajectoryMetadata.terminalReason (default
// 'completed'). Redaction is applied at write per Invariant #15.
//
// These tests pin the contract around the disposal write. T4 introduces
// trajectoryMetadata with default zeros; turn-time updates to those counters
// are out of T4 scope — the disposal write picks up whatever's accumulated.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type {
  ApiMode,
  ProviderRequest,
  ToolSchema,
  Transport,
} from '@yevgetman/sov-sdk/providers/types';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('disposeSession writes trajectory (M7 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t4-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('completed terminal → samples.jsonl bucket with ShareGPT shape', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
      });

      // Register the session context so disposeSession has a context to
      // dispose. The turns route does this implicitly when it calls
      // getSessionContext for the trace writer.
      runtime.getSessionContext(sessionId);

      // Default terminalReason is 'completed' (no error recorded → graceful end).
      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(samplesPath)).toBe(true);
      const content = readFileSync(samplesPath, 'utf8');
      expect(content).toContain(`"sessionId":"${sessionId}"`);
      // ShareGPT shape: `conversations` array with from/value records.
      expect(content).toContain('"from":"human"');
      expect(content).toContain('"from":"gpt"');
      expect(content).toContain('"completed":true');
      expect(content).toContain('"terminalReason":"completed"');
      // Default zero metadata from buildSessionContext.
      expect(content).toContain('"toolCallCount":0');
      expect(content).toContain('"iterationsUsed":0');
      expect(content).toContain('"estimatedCostUsd":0');
    } finally {
      await runtime.dispose();
    }
  });

  test('redaction applied at write — Bearer tokens scrubbed', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'authorization: Bearer sk-proj-VERY-SECRET-1234567890abcdef',
          },
        ],
      });

      runtime.getSessionContext(sessionId);
      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(samplesPath)).toBe(true);
      const content = readFileSync(samplesPath, 'utf8');
      // Load-bearing negative assertion: the secret must not appear verbatim.
      expect(content).not.toContain('sk-proj-VERY-SECRET-1234567890abcdef');
      // Positive marker: redact.ts substitutes '[REDACTED]'.
      expect(content).toContain('[REDACTED]');
    } finally {
      await runtime.dispose();
    }
  });

  test('empty-history session writes no trajectory file', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      // No messages saved — disposeSession should short-circuit the
      // trajectory write since an empty record adds noise to the bucket.
      runtime.getSessionContext(sessionId);
      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
      expect(existsSync(samplesPath)).toBe(false);
      expect(existsSync(failedPath)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('error terminal → failed.jsonl bucket', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'trigger' }],
      });

      const ctx = runtime.getSessionContext(sessionId);
      ctx.trajectoryMetadata.terminalReason = 'error';

      await runtime.disposeSession(sessionId);

      const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(failedPath)).toBe(true);
      expect(existsSync(samplesPath)).toBe(false);
      const content = readFileSync(failedPath, 'utf8');
      expect(content).toContain('"completed":false');
      expect(content).toContain('"terminalReason":"error"');
    } finally {
      await runtime.dispose();
    }
  });

  test('accumulated trajectoryMetadata flushes through to the record', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      });

      const ctx = runtime.getSessionContext(sessionId);
      ctx.trajectoryMetadata.toolCallCount = 3;
      ctx.trajectoryMetadata.iterationsUsed = 5;
      ctx.trajectoryMetadata.estimatedCostUsd = 0.0042;

      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      const content = readFileSync(samplesPath, 'utf8');
      expect(content).toContain('"toolCallCount":3');
      expect(content).toContain('"iterationsUsed":5');
      expect(content).toContain('"estimatedCostUsd":0.0042');
    } finally {
      await runtime.dispose();
    }
  });

  // Whole-branch review I2 — drive a real turn that fails inside
  // runTurnInBackground (provider throws). query() catches the throw at
  // src/core/query.ts:156-164 and surfaces it as Terminal { reason:
  // 'error' }, so the wire emits turn_complete{finishReason:'error'} (NOT
  // turn_error — that path fires only for exceptions that escape the
  // generator). The route must propagate `terminal.reason === 'error'`
  // onto the SessionContext so disposal buckets the trajectory into
  // failed.jsonl. Without the production fix in turns.ts the trajectory
  // silently routed into samples.jsonl — corrupting the corpus consumer's
  // success/failure split. The earlier test in this suite injects
  // terminalReason by hand (covering the trajectory writer's bucket
  // selection); this one covers the PRODUCTION write path through the
  // turns route.
  test('terminal-error → trajectory lands in failed.jsonl (production path)', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      // Replace the resolved provider's transport with one that throws on
      // every stream() call (non-summarize path). query()'s in-generator
      // catch absorbs the throw and surfaces Terminal { reason: 'error' };
      // the route's terminal-propagation block (now per the fix) sets
      // sessionCtx.trajectoryMetadata.terminalReason = 'error'.
      runtime.resolvedProvider.transport = wrapTransportThatAlwaysThrows(
        runtime.resolvedProvider.transport,
      );
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'this turn will throw' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn completes — the terminal-error
      // must land before disposal so the route's terminalReason write is
      // observable downstream.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();
      // The wire surfaces error via turn_complete{finishReason:'error'}.
      expect(body).toContain('"finishReason":"error"');

      // Disposal flushes the trajectory.
      await runtime.disposeSession(sessionId);

      const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      // CRITICAL: must land in failed.jsonl. Without the I2 fix this would
      // silently land in samples.jsonl (the trajectory writer defaults
      // terminalReason → 'completed' when unset, and 'completed' bucket-
      // selects samples.jsonl).
      expect(existsSync(failedPath)).toBe(true);
      expect(existsSync(samplesPath)).toBe(false);
      const content = readFileSync(failedPath, 'utf8');
      expect(content).toContain('"completed":false');
      expect(content).toContain('"terminalReason":"error"');
    } finally {
      await runtime.dispose();
    }
  });
});

/** Whole-branch review I2 — wrap a transport so every non-summarize stream
 *  call throws. Used to drive turn_error through the production path. The
 *  thrown error is plain so isContextOverflowError() returns false (we want
 *  the outer catch, not the overflow recovery hop). */
function wrapTransportThatAlwaysThrows<T extends Transport>(inner: T): T {
  const wrapped: Transport = {
    name: inner.name,
    apiMode: inner.apiMode as ApiMode,
    toProviderMessages: inner.toProviderMessages.bind(inner) as (m: Message[]) => Message[],
    toProviderTools: inner.toProviderTools.bind(inner) as (
      t?: ToolSchema[],
    ) => ToolSchema[] | undefined,
    buildKwargs: inner.buildKwargs.bind(inner) as () => unknown,
    normalizeResponse: inner.normalizeResponse.bind(inner) as () => AsyncGenerator<
      StreamEvent,
      AssistantMessage
    >,
    // biome-ignore lint/correctness/useYield: body throws unconditionally; AsyncGenerator return-type required by the Transport interface.
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      throw new Error('mock provider always throws');
    },
  };
  return wrapped as T;
}
