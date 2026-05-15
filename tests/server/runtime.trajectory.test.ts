// Phase 16.1 M7 T4 — trajectory capture on session disposal.
//
// When runtime.disposeSession(sessionId) is invoked, the session's full
// message history is written as a ShareGPT-shaped JSONL record into
// <artifactsRoot>/trajectories/{samples,failed}.jsonl. Bucket selection is
// driven by SessionContext.trajectoryMetadata.terminalReason (default
// 'completed'). Redaction is applied at write per Invariant #15.
//
// These tests pin the contract around the disposal write. T4 introduces
// trajectoryMetadata with default zeros; turn-time updates to those counters
// are out of T4 scope — the disposal write picks up whatever's accumulated.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('disposeSession writes trajectory (M7 T4)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t4-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('completed terminal → samples.jsonl bucket with ShareGPT shape', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
      });

      // Register the session context so disposeSession has a context to
      // dispose. The turns route does this implicitly when it calls
      // getSessionContext for the trace writer.
      runtime.getSessionContext(sessionId);

      // Default terminalReason is 'completed' (no error recorded → graceful end).
      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(samplesPath)).toBe(true);
      const content = readFileSync(samplesPath, 'utf8');
      expect(content).toContain(`"sessionId":"${sessionId}"`);
      // ShareGPT shape: `conversations` array with from/value records.
      expect(content).toContain('"from":"human"');
      expect(content).toContain('"from":"gpt"');
      expect(content).toContain('"completed":true');
      expect(content).toContain('"terminalReason":"completed"');
      // Default zero metadata from buildSessionContext.
      expect(content).toContain('"toolCallCount":0');
      expect(content).toContain('"iterationsUsed":0');
      expect(content).toContain('"estimatedCostUsd":0');
    } finally {
      await runtime.dispose();
    }
  });

  test('redaction applied at write — Bearer tokens scrubbed', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'authorization: Bearer sk-proj-VERY-SECRET-1234567890abcdef',
          },
        ],
      });

      runtime.getSessionContext(sessionId);
      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(samplesPath)).toBe(true);
      const content = readFileSync(samplesPath, 'utf8');
      // Load-bearing negative assertion: the secret must not appear verbatim.
      expect(content).not.toContain('sk-proj-VERY-SECRET-1234567890abcdef');
      // Positive marker: redact.ts substitutes '[REDACTED]'.
      expect(content).toContain('[REDACTED]');
    } finally {
      await runtime.dispose();
    }
  });

  test('empty-history session writes no trajectory file', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      // No messages saved — disposeSession should short-circuit the
      // trajectory write since an empty record adds noise to the bucket.
      runtime.getSessionContext(sessionId);
      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
      expect(existsSync(samplesPath)).toBe(false);
      expect(existsSync(failedPath)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('error terminal → failed.jsonl bucket', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'trigger' }],
      });

      const ctx = runtime.getSessionContext(sessionId);
      ctx.trajectoryMetadata.terminalReason = 'error';
      ctx.trajectoryMetadata.terminalError = 'simulated provider failure';

      await runtime.disposeSession(sessionId);

      const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(failedPath)).toBe(true);
      expect(existsSync(samplesPath)).toBe(false);
      const content = readFileSync(failedPath, 'utf8');
      expect(content).toContain('"completed":false');
      expect(content).toContain('"terminalReason":"error"');
    } finally {
      await runtime.dispose();
    }
  });

  test('accumulated trajectoryMetadata flushes through to the record', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      const sessionId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });

      runtime.sessionDb.saveMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      });

      const ctx = runtime.getSessionContext(sessionId);
      ctx.trajectoryMetadata.toolCallCount = 3;
      ctx.trajectoryMetadata.iterationsUsed = 5;
      ctx.trajectoryMetadata.estimatedCostUsd = 0.0042;

      await runtime.disposeSession(sessionId);

      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      const content = readFileSync(samplesPath, 'utf8');
      expect(content).toContain('"toolCallCount":3');
      expect(content).toContain('"iterationsUsed":5');
      expect(content).toContain('"estimatedCostUsd":0.0042');
    } finally {
      await runtime.dispose();
    }
  });
});
