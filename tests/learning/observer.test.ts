import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningObserver } from '../../src/learning/observer.js';
import { observationsPath } from '../../src/learning/paths.js';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';

// FileReadTool's hard cap (src/tools/FileReadTool.ts MAX_BYTES). The
// synthesizer Reads observations.jsonl whole; if it exceeds this it errors and
// synthesis silently wedges (finding #6).
const FILE_READ_TOOL_CAP_BYTES = 1024 * 1024;

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

  // Finding #6 — observations.jsonl must stay readable by the synthesizer's
  // whole-file Read (which hard-errors above FileReadTool's 1 MiB cap), so the
  // observer rotates/caps it to a recent tail on append. Without the fix the
  // file grows unbounded and synthesis silently wedges once it crosses 1 MiB.
  describe('size cap (finding #6 — keep the learning loop readable)', () => {
    test('a file far over the cap is reduced to a recent tail of whole lines', async () => {
      const project = getProjectId(cwd);
      const path = observationsPath(home, project.id);
      // Seed a synthetic corpus well over the 1 MiB FileReadTool cap.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(home, 'learning', project.id), { recursive: true });
      const line = (i: number) =>
        `${JSON.stringify({ id: `obs-${i}`, seq: i, pad: 'x'.repeat(200) })}\n`;
      let bloated = '';
      let i = 0;
      while (bloated.length < 2 * 1024 * 1024) {
        bloated += line(i);
        i += 1;
      }
      writeFileSync(path, bloated, 'utf-8');
      expect(statSync(path).size).toBeGreaterThan(FILE_READ_TOOL_CAP_BYTES);

      await LearningObserver.__test_capObservationsFile(path);

      // Now comfortably under the FileReadTool cap.
      expect(statSync(path).size).toBeLessThan(FILE_READ_TOOL_CAP_BYTES);
      // Every retained line is a complete, parseable JSON record (no truncated
      // leading line that would poison the synthesizer's parse).
      const raw = readFileSync(path, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(() => JSON.parse(l)).not.toThrow();
      }
      // Retained tail keeps the MOST RECENT observations (recency drives
      // synthesis clustering): the last seeded record survives.
      const last = JSON.parse(lines.at(-1) ?? '');
      expect(last.seq).toBe(i - 1);
    });

    test('a small file is left untouched (no-op below threshold)', async () => {
      const project = getProjectId(cwd);
      const path = observationsPath(home, project.id);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(home, 'learning', project.id), { recursive: true });
      const original = `${JSON.stringify({ id: 'obs-1', seq: 0 })}\n`;
      writeFileSync(path, original, 'utf-8');

      await LearningObserver.__test_capObservationsFile(path);

      expect(readFileSync(path, 'utf-8')).toBe(original);
    });

    test('observe() keeps the live file under the FileReadTool cap across many appends', async () => {
      const obs = new LearningObserver({ harnessHome: home, cwd, sessionId: 'sess-cap' });
      // Each observation carries a large command so we cross the cap quickly.
      for (let n = 0; n < 6000; n++) {
        obs.observe({
          toolName: 'Bash',
          toolInput: { command: 'c'.repeat(400), n },
          status: 'success',
          durationMs: 1,
        });
      }
      await obs.drain(20000);
      const project = getProjectId(cwd);
      const path = observationsPath(home, project.id);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeLessThan(FILE_READ_TOOL_CAP_BYTES);
    });
  });
});
