import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningObserver } from '../../src/learning/observer.js';
import { observationsPath } from '../../src/learning/paths.js';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';

describe('LearningObserver', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    __test_resetProjectIdCache();
    home = mkdtempSync(join(tmpdir(), 'sov-obs-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-obs-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes one observation per observe() call to project-scoped file', async () => {
    const obs = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-1' });
    obs.observe({
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      status: 'success',
      durationMs: 12,
    });
    obs.observe({
      toolName: 'FileRead',
      toolInput: { path: '/etc/hosts' },
      status: 'success',
      durationMs: 3,
    });
    await obs.drain();

    const project = getProjectId(cwd);
    const path = observationsPath(home, project.id);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const records = lines.map((l) => JSON.parse(l));
    expect(records[0].tool_name).toBe('Bash');
    expect(records[1].tool_name).toBe('FileRead');
    // Provenance fields populated
    expect(records[0].project_id).toBe(project.id);
    expect(records[0].project_name).toBe(project.name);
    expect(records[0].session_id).toBe('sess-1');
    expect(records[0].tool_input_hash).toMatch(/^sha256:/);
  });

  test('redacts secrets in tool_input_summary and envelope summary (audit 2026-06-10)', async () => {
    const obs = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-r' });
    obs.observe({
      toolName: 'Bash',
      toolInput: {
        command: 'curl -H "authorization: Bearer sk-ant-deadbeef0123456789abcd" https://x',
      },
      status: 'error',
      durationMs: 5,
      observationEnvelope: {
        status: 'error',
        summary: 'failed with token sk-ant-deadbeef0123456789abcd in the URL',
      },
    });
    await obs.drain();
    const project = getProjectId(cwd);
    const raw = readFileSync(observationsPath(home, project.id), 'utf-8');
    expect(raw).not.toContain('sk-ant-deadbeef0123456789abcd');
    expect(raw).toContain('[REDACTED]');
    // The hash is over the RAW input (stable identity), so it still differs from
    // the redacted summary — provenance preserved.
    const rec = JSON.parse(raw.trim());
    expect(rec.tool_input_hash).toMatch(/^sha256:/);
  });

  test('disabled observer is a no-op', async () => {
    const obs = new LearningObserver({
      harnessHome: home,
      cwd,
      sessionId: 'sess-1',
      enabled: false,
    });
    obs.observe({ toolName: 'Bash', toolInput: {}, status: 'success', durationMs: 0 });
    await obs.drain();
    const project = getProjectId(cwd);
    expect(existsSync(observationsPath(home, project.id))).toBe(false);
  });

  test('bounded buffer drops on overflow', async () => {
    const obs = new LearningObserver({
      harnessHome: home,
      cwd,
      sessionId: 'sess-1',
      bufferSize: 3,
    });
    // Fire 10 synchronously; with bufferSize=3 and the write-chain async,
    // at least 7 should be dropped before the chain has a chance to drain
    // one slot. The exact count depends on microtask scheduling, but the
    // floor is well above zero.
    for (let i = 0; i < 10; i++) {
      obs.observe({
        toolName: 'Bash',
        toolInput: { i },
        status: 'success',
        durationMs: 0,
      });
    }
    // Some accepted records have already started writing; allow them to
    // settle before asserting on dropped count.
    await obs.drain();
    expect(obs.getDroppedCount()).toBeGreaterThanOrEqual(7);
  });

  test('unserializable inputs increment drop counter', async () => {
    const obs = new LearningObserver({
      harnessHome: home,
      cwd,
      sessionId: 'sess-1',
    });
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    obs.observe({
      toolName: 'Bash',
      toolInput: circular,
      status: 'success',
      durationMs: 0,
    });
    await obs.drain();
    expect(obs.getDroppedCount()).toBe(1);
  });

  test('serialized writes preserve order in the JSONL file', async () => {
    const obs = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-1' });
    for (let i = 0; i < 5; i++) {
      obs.observe({
        toolName: 'Bash',
        toolInput: { seq: i },
        status: 'success',
        durationMs: i,
      });
    }
    await obs.drain();
    const project = getProjectId(cwd);
    const lines = readFileSync(observationsPath(home, project.id), 'utf-8').trim().split('\n');
    const seqs = lines.map((l) => JSON.parse(l).duration_ms);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  test('observation_envelope and traceId are included when provided', async () => {
    const obs = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-1' });
    obs.observe({
      toolName: 'Bash',
      toolInput: { x: 1 },
      status: 'success',
      durationMs: 10,
      observationEnvelope: { status: 'success', summary: 'ok' },
      traceId: 'trace-abc',
    });
    await obs.drain();
    const project = getProjectId(cwd);
    const line = readFileSync(observationsPath(home, project.id), 'utf-8').trim();
    const record = JSON.parse(line);
    expect(record.observation_envelope).toEqual({ status: 'success', summary: 'ok' });
    expect(record.trace_id).toBe('trace-abc');
  });

  test('large tool inputs are summarized to <= 256 chars', async () => {
    const obs = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-1' });
    obs.observe({
      toolName: 'Bash',
      toolInput: { command: 'a'.repeat(5000) },
      status: 'success',
      durationMs: 10,
    });
    await obs.drain();
    const project = getProjectId(cwd);
    const record = JSON.parse(readFileSync(observationsPath(home, project.id), 'utf-8').trim());
    expect(record.tool_input_summary.length).toBeLessThanOrEqual(256);
    expect(record.tool_input_summary.endsWith('...')).toBe(true);
  });
});
