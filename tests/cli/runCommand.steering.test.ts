// `sov run --steer-file` — mid-turn steering E2E through the full CLI path
// (runRunCommand → buildRuntime → server → turns route → createAgent → query).
// The MockProvider records the messages of every model call, so the tests
// assert the injected steer actually reached the model's context.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { type RunOptions, runRunCommand } from '../../src/cli/runCommand.js';

type JsonEvent = Record<string, unknown>;

let home: string;
let cwd: string;
let dbPath: string;
let steerPath: string;
let prevCwd: string;
let prevHarnessHome: string | undefined;
let prevMockEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-steer-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sov-steer-cwd-'));
  dbPath = join(home, 'sessions.db');
  steerPath = join(home, 'steer.queue');
  prevCwd = process.cwd();
  prevHarnessHome = process.env.HARNESS_HOME;
  prevMockEnv = process.env.SOV_TEST_MOCK_PROVIDER;
  process.chdir(cwd);
  process.env.HARNESS_HOME = home;
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.lastMessages = undefined;
  MockProvider.toolUseMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHarnessHome === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset a key.
    delete process.env.HARNESS_HOME;
  } else {
    process.env.HARNESS_HOME = prevHarnessHome;
  }
  if (prevMockEnv === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  } else {
    process.env.SOV_TEST_MOCK_PROVIDER = prevMockEnv;
  }
  MockProvider.lastMessages = undefined;
  MockProvider.toolUseMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

async function invoke(
  input: string,
  extra: Partial<RunOptions> = {},
): Promise<{ code: number; stderr: string; events: JsonEvent[] }> {
  let stdout = '';
  let stderr = '';
  const code = await runRunCommand(
    {
      json: true,
      stdin: true,
      provider: 'mock',
      model: 'mock-haiku',
      db: dbPath,
      permissionMode: 'bypass',
      preflight: false,
      ...extra,
    },
    {
      readStdin: async () => input,
      writeStdout: (s) => {
        stdout += s;
      },
      writeStderr: (s) => {
        stderr += s;
      },
    },
  );
  return {
    code,
    stderr,
    events: stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonEvent),
  };
}

describe('sov run --steer-file', () => {
  test('tool-boundary injection: a pending steer reaches the model after the tool batch', async () => {
    MockProvider.toolUseScript = [
      { kind: 'tool_use', name: 'Bash', input: { command: 'echo tool-ran' } },
      { kind: 'text', text: 'done after tool.' },
    ];
    writeFileSync(steerPath, `${JSON.stringify({ text: 'STEER: also check the logs' })}\n`);

    const result = await invoke('do the work', { steerFile: steerPath });

    expect(result.code).toBe(0);
    const final = result.events.at(-1);
    expect(final?.type).toBe('turn.completed');
    // The injection was announced on the wire.
    expect(result.events.some((ev) => ev.type === 'steer_injected')).toBe(true);
    // The steer file was consumed exactly-once.
    expect(existsSync(steerPath)).toBe(false);
    // The SECOND model call's messages carry the steer merged into the
    // tool_result user message, wrapped in the operator framing.
    const messages = MockProvider.lastMessages ?? [];
    const flat = JSON.stringify(messages);
    expect(flat).toContain('STEER: also check the logs');
    expect(flat).toContain('OPERATOR STEERING MESSAGE');
  });

  test('turn-end injection: a steer pending at the final answer continues the turn', async () => {
    // Default mock behavior: every model call is a clean text-only answer.
    writeFileSync(steerPath, `${JSON.stringify({ text: 'STEER: include totals' })}\n`);

    const result = await invoke('answer me', { steerFile: steerPath });

    expect(result.code).toBe(0);
    expect(result.events.at(-1)?.type).toBe('turn.completed');
    expect(result.events.some((ev) => ev.type === 'steer_injected')).toBe(true);
    expect(existsSync(steerPath)).toBe(false);
    // The continuation call saw the steer as a standalone user message.
    const flat = JSON.stringify(MockProvider.lastMessages ?? []);
    expect(flat).toContain('STEER: include totals');
    expect(flat).toContain('OPERATOR STEERING MESSAGE');
  });

  test('absent steer file: stream is the normal contract, no steer events', async () => {
    const result = await invoke('hello', { steerFile: steerPath }); // file never created
    expect(result.code).toBe(0);
    expect(result.events.at(-1)?.type).toBe('turn.completed');
    expect(result.events.some((ev) => ev.type === 'steer_injected')).toBe(false);
  });

  test('corrupt lines are skipped, valid ones injected', async () => {
    writeFileSync(
      steerPath,
      `not json at all\n${JSON.stringify({ text: 'STEER: good line' })}\n{"nope": 1}\n`,
    );
    const result = await invoke('answer me', { steerFile: steerPath });
    expect(result.code).toBe(0);
    const flat = JSON.stringify(MockProvider.lastMessages ?? []);
    expect(flat).toContain('STEER: good line');
    const steerEvents = result.events.filter((ev) => ev.type === 'steer_injected');
    expect(steerEvents).toHaveLength(1);
    expect(steerEvents[0]?.count).toBe(1);
  });
});
