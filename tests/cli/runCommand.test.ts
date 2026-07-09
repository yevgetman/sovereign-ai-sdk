import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { type RunOptions, runRunCommand } from '../../src/cli/runCommand.js';

type JsonEvent = Record<string, unknown>;

const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');

let home: string;
let cwd: string;
let dbPath: string;
let prevCwd: string;
let prevHarnessHome: string | undefined;
let prevMockEnv: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sov-run-cli-'));
  cwd = mkdtempSync(join(tmpdir(), 'sov-run-cwd-'));
  dbPath = join(home, 'sessions.db');
  prevCwd = process.cwd();
  prevHarnessHome = process.env.HARNESS_HOME;
  prevMockEnv = process.env.SOV_TEST_MOCK_PROVIDER;
  process.chdir(cwd);
  process.env.HARNESS_HOME = home;
  process.env.SOV_TEST_MOCK_PROVIDER = '1';
  MockProvider.lastMessages = undefined;
  MockProvider.lastEffort = undefined;
  MockProvider.streamCalls = 0;
  MockProvider.toolUseMode = false;
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
  MockProvider.lastEffort = undefined;
  MockProvider.toolUseMode = false;
  MockProvider.resetScriptCursor();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
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
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('turn.error');
    expect(result.events[0]?.sessionId).toBeNull();
    expect(result.events[0]?.error).toBe('stdin prompt is empty');
    // Invalid input must not create a persistent session DB or transcript.
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, 'projects'))).toBe(false);
  });

  test('auto-denies permission requests and continues without running the tool', async () => {
    mkdirSync(join(cwd, '.harness'), { recursive: true });
    writeFileSync(
      join(cwd, '.harness', 'settings.json'),
      JSON.stringify({
        permissions: {
          ask: ['Bash(echo hello-from-mock)'],
          allow: [],
          deny: [],
        },
      }),
      'utf8',
    );
    MockProvider.toolUseMode = true;

    const result = await invoke('please inspect safely', { permissionMode: 'ask' });

    expect(result.code).toBe(0);
    const permission = result.events.find((ev) => ev.type === 'permission_request');
    expect(permission?.tool).toBe('Bash');
    const toolResult = result.events.find((ev) => ev.type === 'tool_result');
    expect(toolResult?.tool).toBe('Bash');
    expect(JSON.stringify(toolResult?.output).toLowerCase()).toContain('denied');
    const final = result.events.at(-1);
    expect(final?.type).toBe('turn.completed');
    expect(final?.reply).toContain('done.');
  });

  test('real CLI keeps diagnostics on stderr and machine events on stdout', () => {
    const missingFlag = spawnSync(process.execPath, [MAIN, 'run', '--json'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
    });
    expect(missingFlag.status).toBe(2);
    expect(missingFlag.stdout).toBe('');
    expect(missingFlag.stderr).toContain('--json and --stdin');

    const ok = spawnSync(
      process.execPath,
      [
        MAIN,
        'run',
        '--json',
        '--stdin',
        '--provider',
        'mock',
        '--no-preflight',
        '--permission-mode',
        'bypass',
        '--db',
        join(home, 'cli-real.db'),
      ],
      {
        cwd,
        input: 'hello from a real subprocess',
        encoding: 'utf8',
        env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
      },
    );
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe('');
    const lines = ok.stdout.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const events = lines.map((line) => JSON.parse(line) as JsonEvent);
    expect(events[0]?.type).toBe('session.started');
    expect(events.at(-1)?.type).toBe('turn.completed');
  });

  test('treats whitespace-only stdin as an empty prompt', async () => {
    const result = await invoke('   \n\t\n  \n');

    expect(result.code).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe('turn.error');
    expect(result.events[0]?.sessionId).toBeNull();
    // Whitespace must not boot the runtime or create a persistent session.
    expect(existsSync(dbPath)).toBe(false);
  });

  test('SIGINT mid-turn emits an interrupted terminal event and exits 130', async () => {
    const child = spawn(
      process.execPath,
      [
        MAIN,
        'run',
        '--json',
        '--stdin',
        '--provider',
        'mock',
        '--no-preflight',
        '--permission-mode',
        'bypass',
        '--db',
        join(home, 'sig.db'),
      ],
      {
        cwd,
        env: {
          ...process.env,
          HARNESS_HOME: home,
          SOV_TEST_MOCK_PROVIDER: '1',
          SOV_TEST_MOCK_SLOW_MS: '30000',
        },
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Feed the prompt and EOF so the child boots, registers its interrupt
    // handler, and enters the slow mock turn.
    child.stdin.write('interrupt this turn\n');
    child.stdin.end();
    // Boot (~1s) + enter the 30s/event mock turn, then interrupt mid-turn.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    child.kill('SIGINT');
    const code = await new Promise<number>((resolve) => {
      const fail = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-1);
      }, 15000);
      child.on('close', (status: number | null) => {
        clearTimeout(fail);
        resolve(status ?? -1);
      });
    });

    expect(code).toBe(130);
    const events = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonEvent);
    expect(events.some((ev) => ev.type === 'session.started')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn.error');
    expect(events.at(-1)?.error).toBe('interrupted');
    expect(events.at(-1)?.recoverable).toBe(true);
  }, 30000);
});
