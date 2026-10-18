import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

test('real CLI distinguishes omitted permission mode from explicit default against configured bypass', () => {
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify({ permissionMode: 'bypass', learning: { disabled: true } }));
  for (const requested of [undefined, 'default', 'ask', 'bypass'] as const) {
    const result = spawnSync(
      process.execPath,
      [
        MAIN,
        'run',
        '--json',
        '--stdin',
        '--provider',
        'mock',
        '--no-preflight',
        ...(requested !== undefined ? ['--permission-mode', requested] : []),
      ],
      {
        cwd,
        input: 'fixture question',
        encoding: 'utf8',
        env: { ...process.env, HARNESS_HOME: home, HARNESS_CONFIG: config },
      },
    );
    expect(result.status).toBe(0);
    const events = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonEvent);
    expect(events.find((event) => event.type === 'session.started')?.permissionMode).toBe(
      requested ?? 'bypass',
    );
  }
});

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

  test('rejects --continue-logical-turn without --sdk before a turn starts', async () => {
    let stdinReads = 0;
    let stdout = '';
    let stderr = '';
    const code = await runRunCommand(
      {
        json: true,
        stdin: true,
        continueLogicalTurn: 'lt-existing',
        provider: 'mock',
        model: 'mock-haiku',
        db: dbPath,
        permissionMode: 'bypass',
        preflight: false,
      },
      {
        readStdin: async () => {
          stdinReads += 1;
          return 'should not start a new turn';
        },
        writeStdout: (s) => {
          stdout += s;
        },
        writeStderr: (s) => {
          stderr += s;
        },
      },
    );
    const events = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonEvent);

    expect(code).toBe(2);
    expect(stdinReads).toBe(0);
    expect(stderr).toBe('');
    expect(events).toEqual([
      {
        type: 'turn.error',
        sessionId: null,
        code: 'invalid_input',
        error: 'Native route and input controls require --sdk; no provider was started.',
        recoverable: false,
      },
    ]);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, 'projects'))).toBe(false);
  });

  test('help describes prompt-free continuation without --stdin', () => {
    const help = spawnSync(process.execPath, [MAIN, 'run', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_HOME: home },
    });
    expect(help.status).toBe(0);
    const helpText = help.stdout ?? '';
    const normalized = helpText.replace(/\s+/g, ' ');
    const example = 'sov run --sdk --json --continue-logical-turn <id>';
    const continuation = normalized.match(/Prompt-free continuation:.*?<id>\./)?.[0] ?? '';
    expect(continuation).toBe(`Prompt-free continuation: ${example}.`);
    expect(continuation).not.toContain('--stdin');
    const flagAt = helpText.indexOf('\n  --continue-logical-turn <id>');
    expect(flagAt).toBeGreaterThanOrEqual(0);
    const nextFlag = helpText.indexOf('\n  --', flagAt + 1);
    const flagBlock = helpText.slice(flagAt, nextFlag === -1 ? undefined : nextFlag);
    expect(flagBlock).toContain('--sdk');
    expect(flagBlock).toContain('--json');
    expect(flagBlock).toContain('prompt-free');
    expect(flagBlock).not.toContain('--stdin');
    expect(flagBlock).not.toContain('--route');
  });

  test('continuation names the one missing --sdk or --json flag', async () => {
    const capture = async (
      opts: RunOptions,
    ): Promise<{ code: number; stdout: string; stderr: string; stdinReads: number }> => {
      let stdout = '';
      let stderr = '';
      let stdinReads = 0;
      const code = await runRunCommand(opts, {
        readStdin: async () => {
          stdinReads += 1;
          return 'should not be read';
        },
        writeStdout: (s) => {
          stdout += s;
        },
        writeStderr: (s) => {
          stderr += s;
        },
      });
      return { code, stdout, stderr, stdinReads };
    };

    const missingSdk = await capture({ continueLogicalTurn: 'lt-existing' });
    expect(missingSdk.code).toBe(2);
    expect(missingSdk.stdinReads).toBe(0);
    expect(missingSdk.stdout).toBe('');
    expect(missingSdk.stderr).toBe('sov run: --continue-logical-turn requires --sdk\n');

    const jsonWithoutStdin = await capture({
      json: true,
      continueLogicalTurn: 'lt-existing',
    });
    expect(jsonWithoutStdin.code).toBe(2);
    expect(jsonWithoutStdin.stdinReads).toBe(0);
    expect(jsonWithoutStdin.stdout).toBe('');
    expect(jsonWithoutStdin.stderr).toBe('sov run: --continue-logical-turn requires --sdk\n');

    const missingJson = await capture({ sdk: true, continueLogicalTurn: 'lt-existing' });
    expect(missingJson.code).toBe(2);
    expect(missingJson.stdinReads).toBe(0);
    expect(missingJson.stdout).toBe('');
    expect(missingJson.stderr).toBe('sov run: --continue-logical-turn requires --json\n');
    expect(existsSync(dbPath)).toBe(false);

    const cli = (args: string[]) =>
      spawnSync(process.execPath, [MAIN, ...args], {
        encoding: 'utf8',
        cwd,
        input: '',
        env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
      });
    const cliMissingSdk = cli(['run', '--continue-logical-turn', 'lt-existing']);
    expect(cliMissingSdk.status).toBe(2);
    expect(cliMissingSdk.stdout).toBe('');
    expect(cliMissingSdk.stderr).toBe('sov run: --continue-logical-turn requires --sdk\n');
    const cliMissingJson = cli(['run', '--sdk', '--continue-logical-turn', 'lt-existing']);
    expect(cliMissingJson.status).toBe(2);
    expect(cliMissingJson.stdout).toBe('');
    expect(cliMissingJson.stderr).toBe('sov run: --continue-logical-turn requires --json\n');
  });

  test('prompt-free --sdk --json continuation reaches the stored turn', async () => {
    let stdinReads = 0;
    let stdout = '';
    let stderr = '';
    const code = await runRunCommand(
      { sdk: true, json: true, continueLogicalTurn: 'lt-missing', db: dbPath },
      {
        readStdin: async () => {
          stdinReads += 1;
          return 'should not be read';
        },
        writeStdout: (s) => {
          stdout += s;
        },
        writeStderr: (s) => {
          stderr += s;
        },
      },
    );
    const events = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonEvent);

    expect(code).toBe(2);
    expect(stdinReads).toBe(0);
    expect(stderr).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBe('logical turn does not exist');
    expect(JSON.stringify(events[0])).not.toContain('--stdin');
    expect(JSON.stringify(events[0])).not.toContain('--route');

    const cli = spawnSync(
      process.execPath,
      [MAIN, 'run', '--sdk', '--json', '--continue-logical-turn', 'lt-missing', '--db', dbPath],
      {
        encoding: 'utf8',
        cwd,
        input: '',
        env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
      },
    );
    expect(cli.status).toBe(2);
    expect(cli.stderr).toBe('');
    const cliEvents = (cli.stdout ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonEvent);
    expect(cliEvents).toHaveLength(1);
    expect(cliEvents[0]?.error).toBe('logical turn does not exist');
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

  test.each(['pipe', 'file'] as const)(
    'real CLI keeps diagnostics on stderr and machine events on stdout with %s stdin',
    async (transport) => {
      const missingFlag = spawnSync(process.execPath, [MAIN, 'run', '--json'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
      });
      expect(missingFlag.status).toBe(2);
      expect(missingFlag.stdout).toBe('');
      expect(missingFlag.stderr).toContain('--json and --stdin');

      const inputPath = join(home, 'input.txt');
      writeFileSync(inputPath, 'hello from a real subprocess');
      const inputFd = transport === 'file' ? openSync(inputPath, 'r') : undefined;
      const ok = spawn(
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
          stdio: [inputFd ?? 'pipe', 'pipe', 'pipe'],
          env: { ...process.env, HARNESS_HOME: home, SOV_TEST_MOCK_PROVIDER: '1' },
        },
      );
      if (inputFd !== undefined) closeSync(inputFd);
      let stdout = '';
      let stderr = '';
      ok.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      ok.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        ok.once('error', reject);
        ok.once('close', resolve);
      });
      if (transport === 'pipe') ok.stdin?.end('hello from a real subprocess');
      expect(await exited).toBe(0);
      expect(stderr).toBe('');
      const lines = stdout.split('\n').filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const events = lines.map((line) => JSON.parse(line) as JsonEvent);
      expect(events[0]?.type).toBe('session.started');
      expect(events.at(-1)?.type).toBe('turn.completed');
    },
  );

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
