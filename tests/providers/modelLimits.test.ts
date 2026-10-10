import { expect, test } from 'bun:test';
import { AnthropicProvider } from '@yevgetman/sov-sdk/providers/anthropic';
import {
  assertRequestFits,
  requestInputTokenBound,
  resolveModelLimits,
} from '@yevgetman/sov-sdk/providers/modelLimits';
import { contextLengthFor } from '@yevgetman/sov-sdk/providers/models';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/types';
test('fresh exact metadata grows windows while host caps always win', () => {
  expect(
    resolveModelLimits(
      { contextTokens: 1_000_000, outputTokens: 64_000, source: 'sonnet' },
      { contextTokens: 500_000, outputTokens: 12_000 },
    ),
  ).toEqual({ contextTokens: 500_000, outputTokens: 12_000, source: 'sonnet' });
  expect(resolveModelLimits({ contextTokens: 500_000, outputTokens: 20_000 }).contextTokens).toBe(
    500_000,
  );
});
test('unknown/stale metadata cannot expand fallback but small models tighten it', () => {
  expect(resolveModelLimits(undefined).contextTokens).toBe(32_768);
  expect(
    resolveModelLimits({
      contextTokens: 1_000_000,
      outputTokens: 64_000,
      stale: true,
    }).contextTokens,
  ).toBe(32_768);
  expect(
    resolveModelLimits({ contextTokens: 2048, outputTokens: 256, stale: true }).outputTokens,
  ).toBe(256);
  expect(() => resolveModelLimits({ contextTokens: 0 })).toThrow();
  expect(() => resolveModelLimits(undefined, { contextTokens: Number.NaN })).toThrow();
});
test('system/tools/history and answer reservation share one bounded window', () => {
  const empty = requestInputTokenBound([], []);
  const withSystem = requestInputTokenBound([], [{ text: 'long system', cacheable: false }]);
  const withTools = requestInputTokenBound(
    [],
    [],
    [{ name: 'long tool', description: 'd', input_schema: {} }],
  );
  expect(withSystem).toBeGreaterThan(empty);
  expect(withTools).toBeGreaterThan(empty);
  expect(() =>
    assertRequestFits(900, 200, {
      contextTokens: 1000,
      outputTokens: 500,
      source: 'test',
    }),
  ).toThrow();
  expect(() =>
    assertRequestFits(100, 600, {
      contextTokens: 1000,
      outputTokens: 500,
      source: 'test',
    }),
  ).toThrow();
});

test('known historical registry mismatches yield to exact fresh metadata and preserve host cap', () => {
  const record: ModelRecord = {
    id: 'grok-4.6',
    provider: 'xai',
    routeId: 'grok-api',
    auth: 'api_key',
    displayName: 'Grok',
    capabilities: {
      textOutput: 'supported',
      tools: 'supported',
      images: 'supported',
      reasoning: 'supported',
    },
    availability: 'advertised',
    metadata: { stale: false, source: 'fixture' },
    contextWindow: 500000,
    maxOutputTokens: 64000,
  };
  expect(contextLengthFor('xai', record.id, record)).toBe(500000);
  expect(contextLengthFor('xai', record.id, undefined, 1000)).toBe(1000);
  expect(contextLengthFor('xai', record.id, undefined, 500000)).toBe(32768);
  expect(contextLengthFor('xai', record.id, record, 200000)).toBe(200000);
  expect(
    contextLengthFor('xai', record.id, {
      ...record,
      metadata: { ...record.metadata, stale: true },
    }),
  ).toBe(32768);
  const sonnet = {
    ...record,
    id: 'anthropic/claude-sonnet-4.6',
    provider: 'openrouter',
    contextWindow: 1000000,
  };
  expect(contextLengthFor('openrouter', sonnet.id, sonnet)).toBe(1000000);
});
test('Anthropic thinking cannot raise a metadata-budgeted output reservation after preflight', () => {
  const metadata: ModelRecord = {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    routeId: 'anthropic-api',
    auth: 'api_key',
    displayName: 'Sonnet',
    capabilities: {
      textOutput: 'supported',
      tools: 'supported',
      images: 'supported',
      reasoning: 'supported',
    },
    availability: 'advertised',
    metadata: { stale: false, source: 'fixture' },
    contextWindow: 1000000,
    maxOutputTokens: 64000,
  };
  const p = new AnthropicProvider({ apiKey: 'fake' });
  const body = p.buildKwargs({
    model: metadata.id,
    modelMetadata: metadata,
    system: [],
    messages: [],
    maxTokens: 12000,
    effort: 'high',
  });
  expect(body.max_tokens).toBe(12000);
  expect(body.thinking?.type).toBe('enabled');
  if (body.thinking?.type === 'enabled')
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
});

test('host-only output reservations retain the Anthropic thinking minimum at small caps', () => {
  const provider = new AnthropicProvider({ apiKey: 'fake' });
  for (const maxTokens of [1025, 1500, 12000]) {
    const body = provider.buildKwargs({
      model: 'claude-sonnet-4-6',
      system: [],
      messages: [],
      maxTokens,
      outputBudgetEnforced: true,
      effort: 'high',
    });
    expect(body.max_tokens).toBe(maxTokens);
    expect(body.thinking?.type).toBe('enabled');
    if (body.thinking?.type === 'enabled') {
      expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
      expect(body.thinking.budget_tokens).toBeLessThan(maxTokens);
    }
  }
});
