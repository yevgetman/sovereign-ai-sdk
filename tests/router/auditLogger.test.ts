// Phase 10.6 — RouterAuditLogger unit tests. Mirror the TraceWriter test
// shape: happy path, sequential ordering, redaction, no-throw on bad
// destination, hashPrompt determinism.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuditEntry, RouterAuditLogger, hashPrompt } from '../../src/router/auditLogger.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-router-audit-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ISO = '2026-05-04T20:00:00.000Z';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestampMs: 1746388800000,
    iso: ISO,
    sessionId: 'sid-router',
    lane: 'local',
    classifierLane: 'local',
    reason: 'default lane: local',
    provider: 'ollama',
    model: 'qwen2.5:14b',
    promptHash: 'a'.repeat(64),
    contextByteCount: 4096,
    ...over,
  };
}

describe('RouterAuditLogger', () => {
  test('writes one JSONL record per record() call', async () => {
    const logger = new RouterAuditLogger({ harnessHome: home });
    expect(logger.path).toBe(join(home, 'router', 'audit.jsonl'));
    logger.record(entry());
    logger.record(entry({ lane: 'frontier', reason: 'user override → frontier' }));
    await logger.close();
    expect(logger.count).toBe(2);
    const lines = readFileSync(logger.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ lane: 'local' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ lane: 'frontier' });
  });

  test('preserves order under concurrent record() calls', async () => {
    const logger = new RouterAuditLogger({ harnessHome: home });
    for (let i = 0; i < 20; i++) {
      logger.record(entry({ contextByteCount: i }));
    }
    await logger.close();
    const lines = readFileSync(logger.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(JSON.parse(lines[i] ?? '')).toMatchObject({ contextByteCount: i });
    }
  });

  test('redacts API-key-shaped content in any field before append', async () => {
    const logger = new RouterAuditLogger({ harnessHome: home });
    logger.record(
      entry({
        reason:
          'failed: ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    );
    await logger.close();
    const written = readFileSync(logger.path, 'utf8');
    expect(written).not.toContain('sk-ant-api03-AAAAAAA');
    expect(written).toContain('[REDACTED]');
  });

  test('records issued after close() are silently dropped', async () => {
    const logger = new RouterAuditLogger({ harnessHome: home });
    logger.record(entry());
    await logger.close();
    logger.record(entry({ lane: 'frontier' }));
    expect(logger.count).toBe(1);
  });

  test('logs but never throws on unwritable destination', async () => {
    const errors: string[] = [];
    const logger = new RouterAuditLogger({
      path: '/dev/null/cant-write/file.jsonl',
      log: (m) => errors.push(m),
    });
    logger.record(entry());
    await logger.close();
    expect(logger.count).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('[router-audit] append failed');
  });
});

describe('hashPrompt', () => {
  test('returns a 64-char hex SHA-256', () => {
    const h = hashPrompt('hello');
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  test('is deterministic — same input → same output', () => {
    expect(hashPrompt('hello')).toBe(hashPrompt('hello'));
  });

  test('different inputs → different hashes', () => {
    expect(hashPrompt('hello')).not.toBe(hashPrompt('world'));
  });
});
