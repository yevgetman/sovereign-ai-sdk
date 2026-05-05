// Phase 10.5 — TraceWriter unit tests. Cover the happy path (records
// land as JSONL), redaction, sequential ordering under concurrent record()
// calls, default-path resolution, close() drain semantics, and findTracePath.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEvent } from '../../src/trace/types.js';
import { TraceWriter, findTracePath } from '../../src/trace/writer.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-trace-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ISO = '2026-05-04T20:00:00.000Z';

function event(over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    type: 'tool_start',
    tool: 'Bash',
    toolUseId: 'tu_001',
    iso: ISO,
    ...over,
  } as TraceEvent;
}

describe('TraceWriter', () => {
  test('writes one JSON-encoded record per record() call to the resolved path', async () => {
    const writer = new TraceWriter({ sessionId: 'abc-123', harnessHome: home });
    expect(writer.path).toBe(join(home, 'traces', 'abc-123.jsonl'));
    writer.record(
      event({
        type: 'session_start',
        sessionId: 'abc-123',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        cwd: '/x',
        iso: ISO,
      }),
    );
    writer.record(event());
    await writer.close();
    expect(writer.count).toBe(2);
    const lines = readFileSync(writer.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      type: 'session_start',
      sessionId: 'abc-123',
    });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ type: 'tool_start', tool: 'Bash' });
  });

  test('respects an explicit path opt', async () => {
    const explicit = join(home, 'somewhere/else.jsonl');
    const writer = new TraceWriter({ sessionId: 'sid', path: explicit });
    expect(writer.path).toBe(explicit);
    writer.record(event());
    await writer.close();
    expect(readFileSync(explicit, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('redacts API-key-shaped content before append', async () => {
    const writer = new TraceWriter({ sessionId: 'red', harnessHome: home });
    writer.record(
      event({
        type: 'tool_error',
        tool: 'Bash',
        toolUseId: 'tu_red',
        durationMs: 1,
        message:
          'failed: ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        iso: ISO,
      }),
    );
    await writer.close();
    const written = readFileSync(writer.path, 'utf8');
    expect(written).not.toContain(
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(written).toContain('[REDACTED]');
  });

  test('preserves order when many record() calls are issued back-to-back', async () => {
    const writer = new TraceWriter({ sessionId: 'order', harnessHome: home });
    for (let i = 0; i < 25; i++) {
      writer.record(event({ type: 'turn_start', turn: i, iso: ISO }));
    }
    await writer.close();
    const lines = readFileSync(writer.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(JSON.parse(lines[i] ?? '')).toMatchObject({ type: 'turn_start', turn: i });
    }
  });

  test('records issued after close() are silently dropped', async () => {
    const writer = new TraceWriter({ sessionId: 'closed', harnessHome: home });
    writer.record(event());
    await writer.close();
    writer.record(
      event({
        type: 'tool_end',
        tool: 'Bash',
        toolUseId: 'tu',
        durationMs: 1,
        outputBytes: 1,
        iso: ISO,
      }),
    );
    expect(writer.count).toBe(1);
    expect(readFileSync(writer.path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('logs but never throws when the destination is unwritable', async () => {
    // Point at a path under a read-only ancestor: /dev/null/cant-write/file.jsonl
    // (writing under /dev/null fails with ENOTDIR, which is what we want).
    const errors: string[] = [];
    const writer = new TraceWriter({
      sessionId: 'fail',
      path: '/dev/null/cant-write/file.jsonl',
      log: (m) => errors.push(m),
    });
    writer.record(event());
    await writer.close();
    expect(writer.count).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('[trace] append failed');
  });
});

describe('findTracePath', () => {
  test('returns the path when the file exists', async () => {
    const writer = new TraceWriter({ sessionId: 'found', harnessHome: home });
    writer.record(event());
    await writer.close();
    expect(findTracePath('found', home)).toBe(writer.path);
  });

  test('returns null when the file does not exist', () => {
    expect(findTracePath('ghost', home)).toBeNull();
  });
});
