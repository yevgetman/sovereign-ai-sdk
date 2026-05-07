// tests/learning/concurrency.test.ts
// Backlog Item 11 — verifies multi-process concurrent appends to the
// shared observations.jsonl produce no torn lines. Spawns N child Bun
// processes that each construct their own LearningObserver against the
// same harnessHome + cwd, fire M observations, and drain. The parent
// then parses the resulting JSONL and asserts every line is valid JSON
// with the expected per-session counts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { observationsPath } from '../../src/learning/paths.js';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';

// Absolute path to the observer source; child processes import directly
// so we avoid bundling/build steps. Bun runs .ts natively.
const OBSERVER_PATH = resolve(import.meta.dir, '../../src/learning/observer.ts');

function buildWorkerScript(): string {
  // Minimal worker — argv: sessionId, count, harnessHome, cwd.
  // Constructs a fresh LearningObserver, fires `count` observations
  // with predictable payload, drains, exits 0.
  return `
import { LearningObserver } from '${OBSERVER_PATH}';

const sessionId = process.argv[2];
const count = Number(process.argv[3]);
const home = process.argv[4];
const cwd = process.argv[5];

if (!sessionId || !Number.isFinite(count) || !home || !cwd) {
  console.error('worker: missing argv');
  process.exit(2);
}

const obs = new LearningObserver({
  harnessHome: home,
  cwd,
  sessionId,
  bufferSize: 10_000, // generous so we never hit overflow in the stress test
});

for (let i = 0; i < count; i++) {
  obs.observe({
    toolName: 'TestTool',
    toolInput: { sessionId, seq: i, payload: 'x'.repeat(100) },
    status: 'success',
    durationMs: 1,
  });
}

await obs.drain(15_000);
process.exit(0);
`;
}

describe('LearningObserver — concurrent multi-process append', () => {
  let home: string;
  let cwd: string;
  let workerPath: string;

  beforeEach(() => {
    __test_resetProjectIdCache();
    home = mkdtempSync(join(tmpdir(), 'sov-concurr-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'sov-concurr-cwd-'));
    workerPath = join(home, 'worker.ts');
    writeFileSync(workerPath, buildWorkerScript(), 'utf-8');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('two child processes appending 50 observations each produce 100 valid JSON lines (no torn writes)', async () => {
    const p1 = Bun.spawn({
      cmd: ['bun', 'run', workerPath, 'sess-A', '50', home, cwd],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const p2 = Bun.spawn({
      cmd: ['bun', 'run', workerPath, 'sess-B', '50', home, cwd],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await Promise.all([p1.exited, p2.exited]);
    expect(p1.exitCode).toBe(0);
    expect(p2.exitCode).toBe(0);

    const project = getProjectId(cwd);
    const path = observationsPath(home, project.id);
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);

    expect(lines.length).toBe(100);

    let validCount = 0;
    let sessionACount = 0;
    let sessionBCount = 0;
    const tornLines: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { session_id?: string };
        validCount += 1;
        if (parsed.session_id === 'sess-A') sessionACount += 1;
        if (parsed.session_id === 'sess-B') sessionBCount += 1;
      } catch {
        tornLines.push(line);
      }
    }

    expect(tornLines).toEqual([]);
    expect(validCount).toBe(100);
    expect(sessionACount).toBe(50);
    expect(sessionBCount).toBe(50);
  }, 30_000);

  test('three child processes appending 30 observations each produce 90 valid JSON lines (higher contention)', async () => {
    const p1 = Bun.spawn({
      cmd: ['bun', 'run', workerPath, 'sess-A', '30', home, cwd],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const p2 = Bun.spawn({
      cmd: ['bun', 'run', workerPath, 'sess-B', '30', home, cwd],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const p3 = Bun.spawn({
      cmd: ['bun', 'run', workerPath, 'sess-C', '30', home, cwd],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await Promise.all([p1.exited, p2.exited, p3.exited]);
    expect(p1.exitCode).toBe(0);
    expect(p2.exitCode).toBe(0);
    expect(p3.exitCode).toBe(0);

    const project = getProjectId(cwd);
    const path = observationsPath(home, project.id);
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);

    expect(lines.length).toBe(90);

    let validCount = 0;
    const perSession = new Map<string, number>([
      ['sess-A', 0],
      ['sess-B', 0],
      ['sess-C', 0],
    ]);
    const tornLines: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { session_id?: string };
        validCount += 1;
        const sid = parsed.session_id;
        if (sid && perSession.has(sid)) {
          perSession.set(sid, (perSession.get(sid) ?? 0) + 1);
        }
      } catch {
        tornLines.push(line);
      }
    }

    expect(tornLines).toEqual([]);
    expect(validCount).toBe(90);
    expect(perSession.get('sess-A')).toBe(30);
    expect(perSession.get('sess-B')).toBe(30);
    expect(perSession.get('sess-C')).toBe(30);
  }, 45_000);
});
