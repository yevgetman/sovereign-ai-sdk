import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { type RunOptions, runRunCommand } from '../../src/cli/runCommand.js';

type JsonEvent = Record<string, unknown>;

let home: string;
let dbPath: string;
let prevHarnessHome: string | undefined;
let prevMockEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-run-cli-'));
  dbPath = join(home, 'sessions.db');
  prevHarnessHome = process.env.HARNESS_HOME;
  prevMockEnv = process.env.SOV_TEST_MOCK_PROVIDER;
  process.env.HARNESS_HOME = home;
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.lastMessages = undefined;
  MockProvider.lastEffort = undefined;
  MockProvider.streamCalls = 0;
  MockProvider.resetScriptCursor();
});

afterEach(() => {
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
  MockProvider.lastEffort = undefined;
  MockProvider.resetScriptCursor();
  rmSync(home, { recursive: true, force: true });
});

async function invoke(
  input: string,
  extra: Partial<RunOptions> = {},
): Promise<{ code: number; stdout: string; stderr: string; events: JsonEvent[] }> {
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
    stdout,
    stderr,
    events: stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonEvent),
  };
}

describe('runRunCommand', () => {
  test('runs multiline stdin as one prompt and emits machine terminal events', async () => {
    const input = 'hello\nworld\n';
    const result = await invoke(input);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.events[0]?.type).toBe('session.started');
    expect(result.events.filter((ev) => ev.type === 'session.started')).toHaveLength(1);
    expect(result.events.some((ev) => ev.type === 'text_delta')).toBe(true);

    const final = result.events.at(-1);
    expect(final?.type).toBe('turn.completed');
    expect(final?.reply).toBe('Hello world.');
    expect(typeof final?.finishReason).toBe('string');
    expect(final?.sessionId).toBe(result.events[0]?.sessionId);

    const users = (MockProvider.lastMessages ?? []).filter((msg) => msg.role === 'user');
    const lastUser = users.at(-1);
    const textBlock = lastUser?.content.find((block) => block.type === 'text');
    expect(textBlock?.text).toBe(input);
  });

  test('emits resumed session metadata when --resume is supplied', async () => {
    const first = await invoke('first');
    expect(first.code).toBe(0);
    const sessionId = first.events[0]?.sessionId;
    expect(typeof sessionId).toBe('string');

    const second = await invoke('second', { resume: sessionId });

    expect(second.code).toBe(0);
    expect(second.events[0]?.type).toBe('session.started');
    expect(second.events[0]?.sessionId).toBe(sessionId);
    expect(second.events[0]?.resumed).toBe(true);
    expect(second.events.at(-1)?.type).toBe('turn.completed');
  });

  test('threads --effort into the runtime boot default', async () => {
    const result = await invoke('use more reasoning', { effort: 'high' });

    expect(result.code).toBe(0);
    expect(result.events[0]?.effort).toBe('high');
    expect(MockProvider.lastEffort).toBe('high');
  });

  test('requires --json and --stdin for the initial machine contract', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runRunCommand(
      { json: true },
      {
        readStdin: async () => 'ignored',
        writeStdout: (s) => {
          stdout += s;
        },
        writeStderr: (s) => {
          stderr += s;
        },
      },
    );

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--json and --stdin');
  });

  test('reports empty stdin as a structured machine error', async () => {
    const result = await invoke('');

    expect(result.code).toBe(2);
    expect(result.events[0]?.type).toBe('session.started');
    const final = result.events.at(-1);
    expect(final?.type).toBe('turn.error');
    expect(final?.error).toBe('stdin prompt is empty');
  });
});
