import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import { estimateUsageCost, pricingSnapshotForModel } from '@yevgetman/sov-sdk/providers/pricing';
import { SessionDb } from '../../src/agent/sessionDb.js';

test('unknown paid IDs retain usage and do not fabricate a free bill', () => {
  const db = SessionDb.open({ path: ':memory:' });
  const id = db.createSession({ provider: 'openrouter', model: 'new-author/new-model' });
  const usage = { inputTokens: 1000, outputTokens: 20 };
  const unknown = estimateUsageCost('openrouter', 'new-author/new-model', usage);
  expect(unknown.complete).toBe(false);
  expect(unknown.amountUsd).toBeUndefined();
  db.recordUsageEstimate(id, usage, unknown);
  expect(db.getSessionCost(id).inputTokens).toBe(1000);
  expect(db.getSessionCost(id).costComplete).toBe(false);
  expect(db.listSessions()[0]?.costComplete).toBe(false);
  expect(db.getUsageEstimates(id)[0]).toEqual(unknown);
  db.close();
});

test('rates are immutable snapshots; reasoning is already within output', () => {
  const rates = { input: 1, output: 4, cacheReadInput: 0.25, cacheCreationInput: 1.2 };
  const estimate = estimateUsageCost(
    'xai',
    'future',
    {
      inputTokens: 1000000,
      outputTokens: 1000000,
      reasoningTokens: 800000,
      cacheReadInputTokens: 1000000,
      cacheCreationInputTokens: 1000000,
    },
    { state: 'paid', source: 'fixture', rates, fetchedAt: '2026-10-10T00:00:00Z', version: 8 },
  );
  expect(estimate.amountUsd).toBe(6.45);
  rates.output = 100;
  expect(estimate.rates?.output).toBe(4);
  expect(estimate.version).toBe(8);
  expect(estimate.pricedAt).toBe('2026-10-10T00:00:00Z');
});

test('known local/free and subscriptions remain different from unknown', () => {
  expect(estimateUsageCost('ollama', 'qwen2.5:3b', { inputTokens: 1 }).state).toBe('free');
  const quota = estimateUsageCost(
    'grok',
    'new',
    { inputTokens: 1 },
    { state: 'subscription', source: 'quota' },
  );
  expect(quota.state).toBe('subscription');
  expect(quota.amountUsd).toBeUndefined();
  expect(
    estimateUsageCost(
      'openai',
      'gpt-4o',
      { inputTokens: 1 },
      { state: 'unknown', source: 'missing' },
    ).amountUsd,
  ).toBeUndefined();
});

test('discovery per-million prices preserve identity and cache normalization', () => {
  const snapshot = pricingSnapshotForModel({
    id: 'vendor/future',
    displayName: 'Future',
    routeId: 'openrouter-api',
    provider: 'openrouter',
    auth: 'api_key',
    availability: 'advertised',
    capabilities: {
      textOutput: 'supported',
      images: 'unknown',
      tools: 'unknown',
      reasoning: 'unknown',
    },
    pricing: {
      currency: 'USD',
      source: 'fixture',
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.2,
    },
    metadata: { source: 'fixture', stale: false },
  });
  expect(
    estimateUsageCost('openrouter', 'vendor/future', { cacheReadInputTokens: 1000000 }, snapshot)
      .amountUsd,
  ).toBe(0.2);
  expect(
    estimateUsageCost('openrouter', 'other', { inputTokens: 100 }, snapshot).amountUsd,
  ).toBeUndefined();
});

test('missing discovered cache tariffs never claim complete pricing', () => {
  const estimate = estimateUsageCost(
    'openrouter',
    'future',
    { cacheReadInputTokens: 1000000 },
    { state: 'paid', source: 'fixture', rates: { input: 5, output: 10 } },
  );
  expect(estimate.complete).toBe(false);
  expect(estimate.amountUsd).toBeUndefined();
});
test('pricing is frozen before the first provider call', async () => {
  const rates = { input: 1, output: 2 };
  const agent = createAgent({
    model: 'future',
    pricingSnapshot: { state: 'paid', source: 'fixture', rates },
    provider: {
      name: 'openrouter',
      async *stream() {
        rates.input = 100;
        yield { type: 'usage_delta' as const, usage: { inputTokens: 1000000, outputTokens: 0 } };
        yield { type: 'message_stop' as const, stop_reason: 'end_turn' };
        const message = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'done' }],
        };
        yield { type: 'assistant_message' as const, message };
        return message;
      },
    },
  });
  const run = agent.run('hello');
  let next = await run.next();
  while (!next.done) next = await run.next();
  expect(next.value.estimatedCostUsd).toBe(1);
});
test('migration does not certify historical unknown-price zero usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'sov-price-migration-'));
  const path = join(root, 'sessions.db');
  try {
    const current = SessionDb.open({ path });
    const id = current.createSession({ provider: 'unknown', model: 'unpriced' });
    current.recordTokenUsage(id, { inputTokens: 100 }, 0);
    const noUsageId = current.createSession({ provider: 'openai', model: 'gpt-4o' });
    current.saveMessage(noUsageId, {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    });
    current.close();
    const old = new Database(path);
    old.run('DROP TABLE usage_estimates');
    old.run('ALTER TABLE sessions DROP COLUMN cost_complete');
    old.run('UPDATE state_meta SET schema_version = 5');
    old.close();
    const migrated = SessionDb.open({ path });
    expect(migrated.getSessionCost(id).costComplete).toBe(false);
    expect(migrated.getSessionCost(id).inputTokens).toBe(100);
    expect(migrated.getSessionCost(noUsageId).costComplete).toBe(false);
    migrated.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a provider call with no usage persists an incomplete receipt', async () => {
  const db = SessionDb.open({ path: ':memory:' });
  const agent = createAgent({
    model: 'gpt-4o',
    sessionStore: db,
    provider: {
      name: 'openai',
      async *stream() {
        const message = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'done' }],
        };
        yield { type: 'assistant_message' as const, message };
        yield { type: 'message_stop' as const, stop_reason: 'end_turn' };
        return message;
      },
    },
  });
  const run = agent.run('hello');
  let next = await run.next();
  while (!next.done) next = await run.next();
  expect(next.value.estimatedCostUsd).toBeUndefined();
  expect(db.getSessionCost(next.value.sessionId).costComplete).toBe(false);
  expect(db.getUsageEstimates(next.value.sessionId)[0]?.complete).toBe(false);
  expect(db.getUsageEstimates(next.value.sessionId)[0]?.amountUsd).toBeUndefined();
  expect(db.getUsageEstimates(next.value.sessionId)[0]?.state).toBe('unknown');
  db.close();
});

test('observed tokens from a partial provider stream remain an incomplete bill', async () => {
  const agent = createAgent({
    model: 'gpt-4o',
    provider: {
      name: 'openai',
      async *stream() {
        yield { type: 'usage_delta' as const, usage: { inputTokens: 100, outputTokens: 20 } };
        throw new Error('fixture interrupted provider');
      },
    },
  });
  const run = agent.run('hello');
  let next = await run.next();
  while (!next.done) next = await run.next();
  expect(next.value.usage?.inputTokens).toBe(100);
  expect(next.value.estimatedCostUsd).toBeUndefined();
  expect(next.value.costEstimate?.complete).toBe(false);
  expect(next.value.costEstimate?.amountUsd).toBeUndefined();
});

test('invalid usage and overflowing future tariffs never produce a complete bill', () => {
  const snapshot = {
    state: 'paid' as const,
    source: 'fixture',
    rates: { input: Number.MAX_VALUE, output: 1 },
  };
  expect(
    estimateUsageCost('openai', 'future', { inputTokens: Number.MAX_SAFE_INTEGER }, snapshot)
      .complete,
  ).toBe(false);
  expect(
    estimateUsageCost('openai', 'future', { inputTokens: -1 }, snapshot).amountUsd,
  ).toBeUndefined();
  expect(
    estimateUsageCost('openai', 'future', { outputTokens: Number.NaN }, snapshot).amountUsd,
  ).toBeUndefined();
});
