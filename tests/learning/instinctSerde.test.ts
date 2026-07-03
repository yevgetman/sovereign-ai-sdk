import { describe, expect, test } from 'bun:test';
import { parseInstinct, serializeInstinct } from '../../src/learning/instinctSerde.js';
import type { Instinct } from '../../src/learning/types.js';

const sample: Instinct = {
  id: '01HKZQR8M5N6P7Q8R9S0T1U2V3',
  trigger: 'when writing TS function',
  action: 'add return type annotation',
  confidence: 0.62,
  evidence_count: 8,
  domain: 'code-style',
  scope: 'project',
  project_id: 'p1',
  project_name: 'sovereign-ai-sdk',
  created_at: '2026-05-06T10:00:00Z',
  last_evidence_at: '2026-05-06T15:30:00Z',
  observation_ids: ['obs-aaa1', 'obs-aaa2'],
};

describe('instinct serde', () => {
  test('serialize -> parse round-trips', () => {
    const raw = serializeInstinct(sample, 'body text');
    const { instinct, body } = parseInstinct(raw);
    expect(instinct).toEqual(sample);
    expect(body).toBe('body text');
  });
  test('parse throws on missing frontmatter', () => {
    expect(() => parseInstinct('no frontmatter here')).toThrow();
  });
});
