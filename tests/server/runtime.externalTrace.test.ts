// Observability & audit logging (Part 2) — Runtime.recordExternalTrace, the
// general per-session external-observability inlet. A third-party producer
// (e.g. the decorum governance adapter) injects a TraceEvent routed by
// sessionId; it lands in that LIVE session's trace. Two invariants pinned:
//   1. writes into a resident session's traceWriter, and
//   2. no lazy build + no throw for an unknown/absent session (observer
//      isolation — a producer's logging never breaks or forges a turn).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { buildRuntime } from '../../src/server/runtime.js';

describe('Runtime.recordExternalTrace', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-ext-trace-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('writes into a live session and no-ops (no throw) for unknown', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    try {
      // Materialize a live session context (this opens its trace writer).
      const ctx = runtime.getSessionContext('live1');

      // Spy on the exact live traceWriter the runtime will route into.
      const recorded: TraceEvent[] = [];
      (ctx.traceWriter as unknown as { record: (e: TraceEvent) => void }).record = (e) => {
        recorded.push(e);
      };

      runtime.recordExternalTrace('live1', {
        type: 'external',
        source: 'decorum',
        iso: 'now',
        payload: { verdict: 'block' },
      });

      expect(recorded).toHaveLength(1);
      expect((recorded[0] as { source: string }).source).toBe('decorum');

      // Unknown session → no lazy build, no throw, no effect.
      expect(() =>
        runtime.recordExternalTrace('nope', {
          type: 'external',
          source: 'x',
          iso: 'now',
          payload: {},
        }),
      ).not.toThrow();
      expect(recorded).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
