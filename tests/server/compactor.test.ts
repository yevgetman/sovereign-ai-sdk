import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Message } from '@yevgetman/sov-sdk/core/types';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/index';
import { getRoute, validateRouteSelection } from '@yevgetman/sov-sdk/providers/routes/index';
import type { LLMProvider, ProviderRequest, Transport } from '@yevgetman/sov-sdk/providers/types';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { buildServerCompactor } from '../../src/server/compactor.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('server compactor primitive', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m6-t2-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('runtime.compact resolves with CompactResult and persists lineage', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
    });

    const sessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      platform: 'test',
    });

    // Backlog #36: a small history that fits entirely within the default
    // tail budget (4_000 tokens) AND under the min-tail floor
    // (DEFAULT_MIN_TAIL_MESSAGES=4) yields an empty `head` — compactSession
    // short-circuits to a no-op (parentSessionId === newSessionId, noOp:
    // true), and the same-provider summarize callback never runs. Seed
    // enough messages to clear the floor and large enough text per message
    // to push some content into `head`, so the same-provider summarize
    // path is genuinely exercised here (the original test's purpose).
    const filler = 'lorem ipsum dolor sit amet '.repeat(500);
    const history: Message[] = [];
    for (let i = 0; i < 3; i += 1) {
      history.push({ role: 'user', content: [{ type: 'text', text: `user ${i}: ${filler}` }] });
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant ${i}: ${filler}` }],
      });
    }

    const result = await runtime.compact(history, sessionId, new AbortController().signal);

    expect(result.parentSessionId).toBe(sessionId);
    expect(result.newSessionId).not.toBe(sessionId);
    expect(result.noOp).not.toBe(true);
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
    // Proves the same-provider summarize closure ran (vs. compactSession
    // falling through to its deterministic auxiliary fallback). The mock
    // provider's streamHelloWorld emission is exactly "Hello world.".
    expect(result.summary).toContain('Hello world.');

    const lineage = runtime.sessionDb.getCompactionsForParent(sessionId);
    expect(lineage.length).toBe(1);
    expect(lineage[0]?.childSessionId).toBe(result.newSessionId);

    await runtime.dispose();
  });
  test('native summary preserves a high-only owner subscription selection and exact output evidence', async () => {
    const db = SessionDb.open({ path: join(tmpHome, 'native-summary.db') });
    const modelMetadata: ModelRecord = {
      id: 'gpt-5-owner',
      displayName: 'Owner high only',
      provider: 'chatgpt',
      routeId: 'chatgpt-subscription',
      auth: 'subscription',
      availability: 'account',
      metadata: { source: 'subscription-account-catalog', stale: false },
      efforts: ['high'],
      maxOutputTokens: 128,
      contextWindow: 65536,
      capabilities: {
        textOutput: 'supported',
        images: 'unknown',
        tools: 'supported',
        reasoning: 'supported',
      },
    };
    const selected = validateRouteSelection(getRoute('chatgpt-subscription', {}), {
      model: modelMetadata.id,
      effort: 'high',
      modelMetadata,
    });
    let request: ProviderRequest | undefined;
    let expectedMetadata = modelMetadata;
    const transport: LLMProvider = {
      name: 'chatgpt',
      async *stream(req) {
        request = req;
        // The subscription transport's model-aware validator sees the exact
        // owner evidence and selection, rather than synthesizing route-default low.
        expect(req.modelMetadata).toBe(expectedMetadata);
        expect(
          validateRouteSelection(getRoute('chatgpt-subscription', {}), {
            model: req.model,
            ...(req.effort !== undefined ? { effort: req.effort } : {}),
            ...(req.modelMetadata ? { modelMetadata: req.modelMetadata } : {}),
          }),
        ).toEqual(selected);
        yield { type: 'usage_delta', usage: { inputTokens: 12, outputTokens: 6 } };
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Preserve the task.' }],
        };
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const sessionId = db.createSession({ model: selected.model, provider: 'chatgpt' });
    const compact = buildServerCompactor({
      sessionDb: db,
      model: selected.model,
      systemSegments: [],
      resolvedProvider: {
        transport: transport as Transport,
        client: transport,
        model: selected.model,
        baseUrl: 'mock://',
        contextLength: 65536,
        authType: 'oauth',
        metadata: { provider: 'chatgpt', apiMode: 'openai', purpose: 'main' },
      },
    });
    const history: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: 'history '.repeat(400) }],
    }));
    try {
      const result = await compact(history, sessionId, new AbortController().signal, {
        modelMetadata,
        effort: selected.effort,
      });
      expect(result.noOp).not.toBe(true);
      expect(request?.effort).toBe('high');
      expect(request?.maxTokens).toBe(128);
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
      expect(result.costEstimate).toMatchObject({ state: 'subscription', complete: false });
      request = undefined;
      await expect(
        compact(history, sessionId, new AbortController().signal, {
          modelMetadata: { ...modelMetadata, contextWindow: 900 },
          effort: selected.effort,
        }),
      ).rejects.toThrow('request exceeds effective model limits');
      expect(request).toBeUndefined();
      expect(db.getCompactionsForParent(sessionId)).toHaveLength(1);
      const ownerMetadata = {
        ...modelMetadata,
        contextWindow: 100000,
        maxOutputTokens: 10000,
        metadata: { ...modelMetadata.metadata, stale: true, ownerManaged: true },
      };
      expectedMetadata = ownerMetadata;
      const largeHistory: Message[] = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: '1 '.repeat(1500) }],
      }));
      const ownerResult = await compact(largeHistory, sessionId, new AbortController().signal, {
        modelMetadata: ownerMetadata,
        effort: selected.effort,
      });
      expect(ownerResult.newSessionId).not.toBe(sessionId);
      expect((request as ProviderRequest | undefined)?.maxTokens).toBe(1500);
      expect(db.getCompactionsForParent(sessionId)).toHaveLength(2);
      // The marker alone cannot certify a non-subscription record's window.
      request = undefined;
      await expect(
        compact(largeHistory, sessionId, new AbortController().signal, {
          modelMetadata: { ...ownerMetadata, auth: 'api_key' },
          effort: selected.effort,
        }),
      ).rejects.toThrow('request exceeds effective model limits');
      expect(request).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
