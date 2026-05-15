import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../../src/core/types.js';
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

    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
      { role: 'user', content: [{ type: 'text', text: 'one more thing' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];

    const result = await runtime.compact(history, sessionId, new AbortController().signal);

    expect(result.parentSessionId).toBe(sessionId);
    expect(result.newSessionId).not.toBe(sessionId);
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
});
