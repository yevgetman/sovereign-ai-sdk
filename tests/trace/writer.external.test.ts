// Observability & audit logging (Part 2) — round-trip the open `external`
// TraceEvent variant through the TraceWriter. `external` is the SDK's
// vendor-neutral inlet for third-party observability (a governance engine,
// a SIEM adapter, …): `source` names the producer, `payload` is the
// producer's own opaque event. This pins that a content-free payload
// survives the writer's redaction pass structurally intact.
//
// Mirrors the sibling writer test's temp-`harnessHome` setup
// (tests/trace/writer.test.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter } from '@yevgetman/sov-sdk/trace/writer';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-trace-ext-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('TraceWriter external variant', () => {
  test('records an external event and reads it back', async () => {
    const writer = new TraceWriter({ sessionId: 'ext1', harnessHome: home });
    writer.record({
      type: 'external',
      source: 'decorum',
      iso: new Date().toISOString(),
      payload: {
        schemaVersion: 'decorum.audit/1',
        stage: 'output',
        verdict: 'block',
        ruleIds: ['r1'],
      },
    });
    await writer.close();

    const lines = readFileSync(writer.path, 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1] ?? '{}');
    expect(parsed.type).toBe('external');
    expect(parsed.source).toBe('decorum');
    // redact() targets secret-shaped substrings; a content-free governance
    // payload passes through structurally unchanged.
    expect(parsed.payload.ruleIds).toEqual(['r1']);
    expect(parsed.payload.schemaVersion).toBe('decorum.audit/1');
    expect(parsed.payload.verdict).toBe('block');
  });
});
