// Usage-telemetry T5 (F1 + F3) — full-turn usage accumulation on the gateway.
//
// The load-bearing regression pin: a tool-loop turn makes N provider calls,
// and the turn's reported usage (sessionDb.recordTokenUsage + the final
// status_update + turn_complete.usage) must carry the SUM of every call — not
// the last call only (the pre-T5 last-writer-wins undercount). These tests
// drive real turns through the mock provider + custom scripted transports and
// observe the SSE wire + the sessionDb cost rows.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, ContentBlock, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { ProviderRequest, Transport } from '@yevgetman/sov-sdk/providers/types';
import { compressionSystemPrompt } from '../../src/compact/compactor.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

/** Parse every SSE `data:` line into a typed event bag. */
function parseSseEvents(body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const json = line.slice('data: '.length).trim();
    if (!json) continue;
    try {
      out.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // framing-only line; skip.
    }
  }
  return out;
}

function finalStatusUpdate(events: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const statuses = events.filter((e) => e.type === 'status_update');
  return statuses[statuses.length - 1];
}

function turnComplete(events: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return events.find((e) => e.type === 'turn_complete');
}

/** Single-call provider that reports all four phase fields (input, output,
 *  cache-read, cache-creation) so the cacheHitRate + turn_complete.usage cache
 *  fields can be pinned. */
class CacheReportingProvider extends MockProvider {
  override async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    yield { type: 'message_start' };
    yield { type: 'text_delta', text: 'hi' };
    yield {
      type: 'usage_delta',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 50,
      },
    };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    const content: ContentBlock[] = [{ type: 'text', text: 'hi' }];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }
}

/** Single-call provider that reports NO usage at all — pins the byte-compatible
 *  no-usage path (turn_complete.usage absent, status_update has no token/cost
 *  fields). */
class NoUsageProvider extends MockProvider {
  override async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
    yield { type: 'message_start' };
    yield { type: 'text_delta', text: 'hi' };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    const content: ContentBlock[] = [{ type: 'text', text: 'hi' }];
    const assistant: AssistantMessage = { role: 'assistant', content };
    yield { type: 'assistant_message', message: assistant };
    return assistant;
  }
}

/** Wrap a transport so the FIRST main call emits `usage_delta{outputTokens:5}`
 *  and then throws an overflow; the summarize call and the SECOND main call
 *  pass through to the inner mock (hello-world → outputTokens:2). Exercises the
 *  overflow-recovery two-hop path with usage on BOTH hops so the per-hop
 *  attribution (hop1→parent id, hop2→child id) AND the summed turn total can be
 *  pinned together. */
function wrapWithUsageThenOverflow(inner: Transport): Transport {
  const compressionPrompt = compressionSystemPrompt();
  let mainCalls = 0;
  return {
    name: inner.name,
    apiMode: inner.apiMode,
    toProviderMessages: inner.toProviderMessages.bind(inner),
    toProviderTools: inner.toProviderTools.bind(inner),
    buildKwargs: inner.buildKwargs.bind(inner),
    normalizeResponse: inner.normalizeResponse.bind(inner),
    async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const isSummarize = req.system.some((seg) => seg.text === compressionPrompt);
      if (isSummarize) return yield* inner.stream(req);
      mainCalls += 1;
      if (mainCalls === 1) {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 0, outputTokens: 5 } };
        // Surface an overflow — captured by query() into Terminal.error and
        // routed to the recovery branch. The usage_delta above was already
        // yielded to the route loop before this throw.
        throw new Error('context length exceeded by 12000 tokens');
      }
      return yield* inner.stream(req);
    },
  };
}

describe('turns route — full-turn usage accumulation (T5 / F1 + F3)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sov-t5-usage-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('multi-call tool-loop turn reports the SUM of all provider calls, not the last', async () => {
    // streamToolUse emits two usage_delta across the two model calls:
    //   call 1 (preamble + tool_use): outputTokens 5
    //   call 2 (final "done."):       outputTokens 1
    // The correct turn total is 5 + 1 = 6 — the F1 undercount fix.
    MockProvider.toolUseMode = true;
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run echo hi' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      const body = await eventsRes.text();
      const events = parseSseEvents(body);

      // sessionDb recorded the SUMMED figure, not the last call's 1.
      const cost = runtime.sessionDb.getSessionCost(sessionId);
      expect(cost.outputTokens).toBe(6);

      // Final status_update carries the summed tokensOut.
      const status = finalStatusUpdate(events);
      expect(status?.streaming).toBe(false);
      expect(status?.tokensOut).toBe(6);
      // No cache fields reported → no cacheHitRate on the wire.
      expect(status?.cacheHitRate).toBeUndefined();

      // turn_complete.usage populated with the summed phase totals.
      const complete = turnComplete(events);
      expect(complete?.usage).toBeDefined();
      const usage = complete?.usage as { input_tokens: number; output_tokens: number };
      expect(usage.output_tokens).toBe(6);
    } finally {
      await runtime.dispose();
    }
  });

  test('turn_complete.usage carries the phase-broken totals incl. cache fields; cacheHitRate correct', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    runtime.resolvedProvider.transport = new CacheReportingProvider();
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      const body = await eventsRes.text();
      const events = parseSseEvents(body);

      const complete = turnComplete(events);
      expect(complete?.usage).toEqual({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 300,
      });

      // cacheHitRate = 300 / (100 + 300 + 50) = 0.6667 (4 dp).
      const status = finalStatusUpdate(events);
      expect(status?.cacheHitRate).toBe(0.6667);
      expect(status?.tokensIn).toBe(100);
      expect(status?.tokensOut).toBe(20);
    } finally {
      await runtime.dispose();
    }
  });

  test('turn with no usage reported: turn_complete.usage absent, status_update has no token/cost fields', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    runtime.resolvedProvider.transport = new NoUsageProvider();
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      const body = await eventsRes.text();
      const events = parseSseEvents(body);

      const complete = turnComplete(events);
      expect(complete).toBeDefined();
      expect(complete?.usage).toBeUndefined();

      const status = finalStatusUpdate(events);
      expect(status?.streaming).toBe(false);
      expect(status?.tokensIn).toBeUndefined();
      expect(status?.tokensOut).toBeUndefined();
      expect(status?.cost).toBeUndefined();
      expect(status?.cacheHitRate).toBeUndefined();

      // sessionDb never recorded a usage row.
      const cost = runtime.sessionDb.getSessionCost(sessionId);
      expect(cost.outputTokens).toBe(0);
      expect(cost.inputTokens).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('overflow-recovery: hop1 usage records under parent, hop2 under child; wire total = hop1 + hop2', async () => {
    const runtime = await buildRuntime({
      cwd: home,
      harnessHome: home,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });
    runtime.resolvedProvider.transport = wrapWithUsageThenOverflow(
      runtime.resolvedProvider.transport,
    );
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // Seed history so the recovery's compactSession has a non-empty head.
      const filler = 'lorem ipsum dolor sit amet '.repeat(500);
      for (let i = 0; i < 3; i += 1) {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: [{ type: 'text', text: `prior user turn ${i}: ${filler}` }],
        });
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'assistant',
          content: [{ type: 'text', text: `prior reply ${i}: ${filler}` }],
        });
      }

      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      const body = await eventsRes.text();
      const events = parseSseEvents(body);

      // Recovery fired.
      const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
      expect(lineage.length).toBe(1);
      const childSessionId = lineage[0]?.childSessionId as string;
      expect(typeof childSessionId).toBe('string');

      // hop1 (outputTokens 5) recorded under the PARENT; hop2 (hello-world
      // outputTokens 2) under the CHILD — compaction attribution preserved.
      expect(runtime.sessionDb.getSessionCost(sessionId).outputTokens).toBe(5);
      expect(runtime.sessionDb.getSessionCost(childSessionId).outputTokens).toBe(2);

      // Wire total = hop1 + hop2 = 7.
      const status = finalStatusUpdate(events);
      expect(status?.tokensOut).toBe(7);
      const complete = turnComplete(events);
      const usage = complete?.usage as { output_tokens: number };
      expect(usage.output_tokens).toBe(7);
    } finally {
      await runtime.dispose();
    }
  });
});
