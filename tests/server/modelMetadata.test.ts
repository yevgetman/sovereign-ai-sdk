import { expect, test } from 'bun:test';
import { fallbackModelCatalog, findModel } from '@yevgetman/sov-sdk/providers/models/index';
import { estimateUsageCost } from '@yevgetman/sov-sdk/providers/pricing';
import {
  modelRunUsageWriter,
  modelSystemPrompt,
  selectedTurnModel,
  shouldCompactModelRequest,
} from '../../src/server/modelMetadata.js';

const record = () => ({
  ...findModel(fallbackModelCatalog('openrouter-api'), 'vendor/future'),
  contextWindow: 8_000_000,
  maxOutputTokens: 128_000,
  metadata: { source: 'fixture', stale: false },
});
test('fresh large windows and output maxima survive into the frozen turn snapshot', () => {
  const source = record();
  const selected = selectedTurnModel('openrouter', source.id, {
    modelMetadata: source,
    maxTokens: 4000,
  });
  if (!selected) throw new Error('Expected built-in model snapshot');
  expect(selected?.limits).toMatchObject({ contextTokens: 8_000_000, outputTokens: 4000 });
  source.contextWindow = 1;
  expect(selected?.metadata.contextWindow).toBe(8_000_000);
  expect(selected?.pricing.model).toBe('vendor/future');
  const history = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(200_000) }] },
  ];
  expect(shouldCompactModelRequest(history, [], [], selected.limits)).toBe(false);
});
test('stale windows cannot enlarge the conservative request budget', () => {
  const source = record();
  source.metadata.stale = true;
  const selected = selectedTurnModel('openrouter', source.id, {
    modelMetadata: source,
    maxTokens: 4000,
  });
  if (!selected) throw new Error('Expected built-in model snapshot');
  expect(selected?.limits.contextTokens).toBe(32_768);
  expect(
    shouldCompactModelRequest(
      [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(30_000) }] }],
      [],
      [],
      selected.limits,
    ),
  ).toBe(true);
  expect(
    shouldCompactModelRequest(
      [],
      [{ text: 'x'.repeat(30_000), cacheable: false }],
      [],
      selected.limits,
    ),
  ).toBe(false);
});
test('snapshot rejects route/model mismatches while custom transports retain their own contract', () => {
  expect(() => selectedTurnModel('openrouter', 'other', { modelMetadata: record() })).toThrow(
    'another model or route',
  );
  expect(selectedTurnModel('mock', 'other', { modelMetadata: record() })).toBeUndefined();
});

test('an offline missing exact OpenRouter ID still carries conservative unknown evidence', () => {
  const selected = selectedTurnModel('openrouter', 'unknown-provider/not-in-catalog', {
    settings: {},
  });
  expect(selected?.metadata.id).toBe('unknown-provider/not-in-catalog');
  expect(selected?.metadata.capabilities.tools).toBe('unknown');
  expect(selected?.limits.contextTokens).toBe(32_768);
  expect(selected?.pricing.state).toBe('unknown');
});

test('host receipt writer records one run, retaining unknown missing usage', () => {
  const rows: Array<{ usage: unknown; estimate: unknown }> = [];
  const db = {
    recordUsageEstimate: (_session: string, usage: unknown, estimate: unknown) =>
      rows.push({ usage, estimate }),
  };
  const missing = modelRunUsageWriter(
    { sessionDb: db as never },
    's',
    'openrouter',
    'future/model',
  );
  missing();
  missing();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.estimate).toMatchObject({
    complete: false,
    state: 'unknown',
    model: 'future/model',
  });
  const known = modelRunUsageWriter({ sessionDb: db as never }, 's', 'openrouter', 'future/model');
  const costEstimate = estimateUsageCost(
    'openrouter',
    'future/model',
    { inputTokens: 5, outputTokens: 3 },
    { state: 'paid', source: 'fixture', rates: { input: 1, output: 2 } },
  );
  known({ usage: { inputTokens: 5, outputTokens: 3 }, costEstimate });
  known();
  expect(rows).toHaveLength(2);
  expect(rows[1]?.estimate).toMatchObject({
    complete: true,
    amountUsd: 0.000011,
    source: 'fixture',
  });
});

test('unknown-window projection removes only duplicate tool help and keeps standing directives', () => {
  const unknown = findModel(fallbackModelCatalog('openai-api'), 'future');
  const system = [
    { text: 'governance: keep all instructions', cacheable: true },
    {
      text: '<available-tools>\n- Forbidden: huge duplicated description\n</available-tools>',
      cacheable: true,
    },
    { text: '<user-context>project directives</user-context>', cacheable: false },
  ];
  expect(modelSystemPrompt(system, [], unknown)).toEqual(system.filter((_, index) => index !== 1));
  const tools = modelSystemPrompt(system, [{ name: 'Allowed' }], unknown);
  expect(tools[1]?.text).toContain('- Allowed');
  expect(tools[1]?.text).not.toContain('Forbidden');
  expect(system[1]?.text).toContain('Forbidden');
  expect(modelSystemPrompt(system, [], record())).toEqual(system);
});

test('proactive compaction measures reducible history when the unused output ceiling exceeds threshold', () => {
  const limits = { contextTokens: 32768, outputTokens: 8192, source: 'unknown' };
  const system = [{ text: 'x'.repeat(20_000), cacheable: false }];
  const message = (size: number) => [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(size) }] },
  ];
  expect(shouldCompactModelRequest(message(15_000), system, [], limits)).toBe(true);
  expect(shouldCompactModelRequest(message(1000), system, [], limits)).toBe(false);
  expect(shouldCompactModelRequest([], system, [], limits)).toBe(false);
  expect(
    shouldCompactModelRequest(
      message(15_000),
      [{ text: 'x'.repeat(33_000), cacheable: false }],
      [],
      limits,
    ),
  ).toBe(false);
});
