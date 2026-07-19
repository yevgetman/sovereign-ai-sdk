// Fix wave (review finding, 2026-07-19 attestation evidence) — host turn
// identity on the OPENAI-COMPAT drive surface.
//
// POST /v1/chat/completions binds `runtime.conduct` (the boot-wired provider
// whose attestationSink persists DecisionRecords), so pre-fix an OpenAI-compat
// turn emitted records with `turnIdSource:'synthesized'` and no io row —
// permanent floor-B orphans that fold every audit of the session INCOMPLETE.
//
// Pins the fix on BOTH branches (non-streaming + streaming): each request
// mints ONE fresh host turnId through `runtime.attestationEvidence` and
// settles exactly ONE io row for it. Absent coordinator ⇒ byte-identical.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConductContext, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { createTurnEvidence, withEvidenceSink } from '../../src/attestation/turnEvidence.js';
import type { IoEvidenceWriter } from '../../src/attestation/turnEvidence.js';
import type { ObservedTurnRow } from '../../src/attestation/writer.js';
import { buildOpenAIApp } from '../../src/openai/app.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

function captureWriter(): { rows: ObservedTurnRow[]; writer: IoEvidenceWriter } {
  const rows: ObservedTurnRow[] = [];
  return { rows, writer: { recordIo: (row) => rows.push(row) } };
}

function contextRecordingProvider(seen: ConductContext[]): ConductProvider {
  return {
    outputGuard: {
      onFinal: (_message, ctx) => {
        seen.push(ctx);
        return { action: 'pass' as const };
      },
    },
  };
}

async function buildAttestedRuntime(
  home: string,
  seen: ConductContext[],
  rows: { writer: IoEvidenceWriter },
): Promise<Runtime> {
  const evidence = createTurnEvidence({ writer: rows.writer, io: true });
  if (evidence.evidenceSink === undefined) throw new Error('io mode must expose the sink');
  const conduct = withEvidenceSink(contextRecordingProvider(seen), evidence.evidenceSink);
  return buildRuntime({
    harnessHome: home,
    cwd: process.cwd(),
    provider: 'mock',
    model: 'mock-haiku',
    cronEnabled: false,
    conduct,
    attestationEvidence: evidence,
  });
}

function chatBody(stream: boolean): string {
  return JSON.stringify({
    model: 'harness-default',
    messages: [{ role: 'user', content: 'hi' }],
    stream,
  });
}

const POST_HEADERS = {
  authorization: 'Bearer test',
  'content-type': 'application/json',
};

describe('POST /v1/chat/completions — host turnId + io row (attestation evidence)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'openai-attest-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(home, { recursive: true, force: true });
  });

  test('non-streaming: mints a host turnId and settles exactly ONE io row', async () => {
    const seen: ConductContext[] = [];
    const { rows, writer } = captureWriter();
    const runtime = await buildAttestedRuntime(home, seen, { writer });

    try {
      const app = buildOpenAIApp({ runtime, apiKey: 'test' });
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: POST_HEADERS,
        body: chatBody(false),
      });
      expect(res.status).toBe(200);

      expect(seen.length).toBeGreaterThanOrEqual(1);
      const ctx = seen[0];
      if (ctx === undefined) throw new Error('no conduct context captured');
      expect(ctx.turnId).toBeDefined();
      expect(ctx.turnId).toMatch(/^[0-9a-f-]{36}$/);

      // MONEY: one io row for the minted id, joined to the request session.
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('no io row written');
      expect(row.turnId).toBe(ctx.turnId as string);
      expect(row.sessionId).toBe(ctx.sessionId);
      expect(row.delivered).toBe('Hello world.');
    } finally {
      await runtime.dispose();
    }
  });

  test('streaming: mints a host turnId and settles exactly ONE io row', async () => {
    const seen: ConductContext[] = [];
    const { rows, writer } = captureWriter();
    const runtime = await buildAttestedRuntime(home, seen, { writer });

    try {
      const app = buildOpenAIApp({ runtime, apiKey: 'test' });
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: POST_HEADERS,
        body: chatBody(true),
      });
      expect(res.status).toBe(200);
      // Drain the SSE wire so the stream (and its finally) completes.
      await res.text();

      expect(seen.length).toBeGreaterThanOrEqual(1);
      const ctx = seen[0];
      if (ctx === undefined) throw new Error('no conduct context captured');
      expect(ctx.turnId).toBeDefined();

      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('no io row written');
      expect(row.turnId).toBe(ctx.turnId as string);
      expect(row.sessionId).toBe(ctx.sessionId);
    } finally {
      await runtime.dispose();
    }
  });

  test('absent coordinator ⇒ no turnId on the conduct context (byte-identical)', async () => {
    const seen: ConductContext[] = [];
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
      conduct: contextRecordingProvider(seen),
    });

    try {
      const app = buildOpenAIApp({ runtime, apiKey: 'test' });
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: POST_HEADERS,
        body: chatBody(false),
      });
      expect(res.status).toBe(200);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.turnId).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
