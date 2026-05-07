// tests/learning/types.test.ts
// Verifies that ObservationSchema and InstinctSchema reject unknown fields
// so producer/consumer drift can't silently drop fields from the long-lived
// observations.jsonl corpus or instinct .md files.

import { describe, expect, test } from 'bun:test';
import { InstinctSchema, ObservationSchema } from '../../src/learning/types.js';

describe('Observation/Instinct schemas reject unknown fields', () => {
  test('ObservationSchema rejects unknown top-level fields', () => {
    const valid = {
      id: 'obs-1',
      ts: '2026-05-06T00:00:00Z',
      project_id: 'p',
      project_name: 'pp',
      session_id: 's',
      tool_name: 'Bash',
      tool_input_hash: 'sha256:x',
      tool_input_summary: 'summary',
      status: 'success',
      duration_ms: 100,
    };
    expect(ObservationSchema.safeParse(valid).success).toBe(true);
    expect(ObservationSchema.safeParse({ ...valid, unexpected_field: 'x' }).success).toBe(false);
  });

  test('ObservationSchema rejects unknown fields inside observation_envelope', () => {
    const valid = {
      id: 'obs-1',
      ts: '2026-05-06T00:00:00Z',
      project_id: 'p',
      project_name: 'pp',
      session_id: 's',
      tool_name: 'Bash',
      tool_input_hash: 'sha256:x',
      tool_input_summary: 'summary',
      status: 'success',
      duration_ms: 100,
      observation_envelope: { status: 'success', summary: 'ok' },
    };
    expect(ObservationSchema.safeParse(valid).success).toBe(true);
    expect(
      ObservationSchema.safeParse({
        ...valid,
        observation_envelope: { status: 'success', summary: 'ok', extra: 'x' },
      }).success,
    ).toBe(false);
  });

  test('InstinctSchema rejects unknown top-level fields', () => {
    const valid = {
      id: 'i-1',
      trigger: 't',
      action: 'a',
      confidence: 0.5,
      evidence_count: 3,
      domain: 'code-style',
      scope: 'project',
      project_id: 'p',
      project_name: 'pp',
      created_at: '2026-05-06T00:00:00Z',
      last_evidence_at: '2026-05-06T00:00:00Z',
      observation_ids: ['o1', 'o2'],
    };
    expect(InstinctSchema.safeParse(valid).success).toBe(true);
    expect(InstinctSchema.safeParse({ ...valid, future_field: 1 }).success).toBe(false);
  });
});
