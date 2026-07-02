import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@yevgetman/sov-sdk/core/types';
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

    // Backlog #36: a small history that fits entirely within the default
    // tail budget (4_000 tokens) AND under the min-tail floor
    // (DEFAULT_MIN_TAIL_MESSAGES=4) yields an empty `head` — compactSession
    // short-circuits to a no-op (parentSessionId === newSessionId, noOp:
    // true), and the same-provider summarize callback never runs. Seed
    // enough messages to clear the floor and large enough text per message
    // to push some content into `head`, so the same-provider summarize
    // path is genuinely exercised here (the original test's purpose).
    const filler = 'lorem ipsum dolor sit amet '.repeat(500);
    const history: Message[] = [];
    for (let i = 0; i < 3; i += 1) {
      history.push({ role: 'user', content: [{ type: 'text', text: `user ${i}: ${filler}` }] });
      history.push({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant ${i}: ${filler}` }],
      });
    }

    const result = await runtime.compact(history, sessionId, new AbortController().signal);

    expect(result.parentSessionId).toBe(sessionId);
    expect(result.newSessionId).not.toBe(sessionId);
    expect(result.noOp).not.toBe(true);
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
