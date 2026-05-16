// Phase 16.1 M8 T2 — replay-mode wiring in `buildRuntime`.
//
// Pins the contract that `replayFixturePath` short-circuits provider
// resolution entirely: `buildRuntime` constructs a `ReplayProvider`
// around the loaded fixture and surfaces it via `resolvedProvider`. The
// provider's `name` reflects the fixture's metadata (so REPL banners,
// audit logs, and tests see "this is a replay of X") and the resolved
// model tracks the fixture's recorded model. Live preflight is skipped
// implicitly — the fixture replaces the model call entirely, so a
// preflight probe against a replay provider would be a no-op at best
// and confusing at worst.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — replay fixture loads ReplayProvider (M8 T2)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-t2-replay-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('replayFixturePath constructs ReplayProvider and skips preflight', async () => {
    const fixturePath = join(tmpHome, 'fixture.json');
    // Minimal valid fixture: one turn emitting a single text_delta +
    // assistant message. ReplayProvider's contract requires every turn
    // to end with an assistant_message; without it the replay throws.
    writeFileSync(
      fixturePath,
      JSON.stringify({
        meta: {
          sessionId: 'fixture-session',
          provider: 'mock',
          model: 'mock-haiku',
          capturedAt: '2026-05-16T00:00:00Z',
        },
        turns: [
          {
            turn: 0,
            providerEvents: [
              { type: 'text_delta', text: 'hello from replay' },
              {
                type: 'assistant_message',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'hello from replay' }],
                },
              },
            ],
            toolResults: [],
          },
        ],
      }),
    );

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      // provider intentionally omitted — replay path drives provider selection
      replayFixturePath: fixturePath,
    });

    expect(runtime.resolvedProvider.transport.name).toBe('mock');
    expect(runtime.model).toBe('mock-haiku');
    expect(runtime.resolvedProvider.metadata.provider).toBe('mock');
    // Confirm we got a ReplayProvider underneath — fixture metadata
    // carries the marker the REPL splash uses to badge a replay session.
    expect(runtime.resolvedProvider.metadata.replay).toBe(true);

    await runtime.dispose();
  });
});
