import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import type { LLMProvider, ProviderRequest, Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { MAX_INPUT_BYTES } from '../../src/cli/sdkInput.js';
import { runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import type { SdkRunDependencies } from '../../src/cli/sdkRunCommand.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(provider: LLMProvider, mutate?: (r: Runtime) => void) {
  const home = mkdtempSync(join(tmpdir(), 'sdk-run-'));
  dirs.push(home);
  const db = join(home, 'sessions.db');
  const route = getRoute('openai-api', {});
  const resolve: NonNullable<SdkRunDependencies['resolve']> = async () => ({
    route,
    model: 'gpt-4.1',
    effort: 'off',
    provider,
    resolved: {
      transport: provider as Transport,
      client: provider,
      baseUrl: 'mock://',
      model: 'gpt-4.1',
      contextLength: 200000,
      authType: 'api_key',
      metadata: { provider: 'openai', apiMode: 'openai', purpose: 'main' },
    },
  });
  const runtime: NonNullable<SdkRunDependencies['runtime']> = async (opts) => {
    const r = await buildRuntime({
      ...opts,
      harnessHome: home,
      dbPath: db,
      settings: {
        learning: { disabled: true, recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 } },
        review: { disabled: true },
      },
      cronEnabled: false,
    });
    mutate?.(r);
    return r;
  };
  return { home, db, deps: { resolve, runtime } };
}
function capture() {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    io: {
      readStdin: async () =>
        JSON.stringify({ inputVersion: 1, text: 'question', instructions: 'EPHEMERAL TRUSTED' }),
      writeStdout: (s: string) => {
        events.push(JSON.parse(s));
      },
    },
  };
}
const opts = { json: true, stdin: true, route: 'openai-api', inputFormat: 'json', toolset: 'chat' };
test('native runs direct SDK with no preflight; preserves instructions/base and saves one user/assistant per resumed turn', async () => {
  const calls: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls.push(req);
      yield { type: 'message_start' };
      yield { type: 'thinking_delta', thinking: 'reason' };
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'usage_delta', usage: { inputTokens: 4, outputTokens: 2 } };
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider);
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, preflight: true }, c.io, f.deps)).toBe(0);
  expect(calls.length).toBe(1);
  expect(calls[0]?.system.at(-1)?.text).toBe('EPHEMERAL TRUSTED');
  expect(calls[0]?.system.length).toBeGreaterThan(1);
  expect(calls[0]?.tools ?? []).toEqual([]);
  expect(c.events.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
  expect(c.events.find((e) => e.type === 'thinking_delta')).toMatchObject({ text: 'reason' });
  const sessionId = String(c.events[0]?.sessionId);
  const next = capture();
  expect(await runSdkRunCommand({ ...opts, resume: sessionId }, next.io, f.deps)).toBe(0);
  const db = SessionDb.open({ path: f.db });
  try {
    const rows = db.loadMessages(sessionId);
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(rows)).not.toContain('EPHEMERAL TRUSTED');
    expect(db.getSession(sessionId)?.metadata.sdkTurns).toHaveLength(2);
  } finally {
    db.close();
  }
  expect(calls[1]?.messages.filter((m) => m.role === 'user')).toHaveLength(2);
});
test('two calls get distinct tool block ids; saved call exists before tool runs and resume never reruns orphan', async () => {
  let calls = 0;
  let ran = 0;
  let sessionId = '';
  let dbPath = '';
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls++;
      yield { type: 'message_start' };
      if (calls === 1) {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', name: 'probe', input: {} },
            { type: 'tool_use', id: 'b', name: 'probe', input: {} },
          ],
        };
        yield { type: 'assistant_message', message };
        return message;
      }
      expect(req.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(true);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider, (r) => {
    r.toolPool.splice(
      0,
      r.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'probe',
        description: () => 'probe',
        inputSchema: z.unknown(),
        renderResult: (result) => ({ content: String(result) }),
        isReadOnly: () => true,
        async call() {
          ran++;
          const db = SessionDb.open({ path: dbPath });
          try {
            expect(
              db.loadMessages(sessionId).some((m) => m.content.some((b) => b.type === 'tool_use')),
            ).toBe(true);
          } finally {
            db.close();
          }
          return { data: 'ok' };
        },
      }),
    );
  });
  dbPath = f.db;
  const c = capture();
  const writeStdout = c.io.writeStdout;
  c.io.writeStdout = (s) => {
    writeStdout(s);
    if (c.events.at(-1)?.type === 'session.started') sessionId = String(c.events.at(-1)?.sessionId);
  };
  expect(
    await runSdkRunCommand({ ...opts, toolset: 'coding', permissionMode: 'bypass' }, c.io, f.deps),
  ).toBe(0);
  expect(ran).toBe(2);
  const starts = c.events.filter((e) => e.type === 'tool_use_start');
  expect(starts).toHaveLength(2);
  expect(new Set(starts.map((e) => e.block)).size).toBe(2);
  expect(c.events.filter((e) => e.type === 'tool_result').map((e) => e.block)).toEqual(
    starts.map((e) => e.block),
  );
});
test('invalid machine options have one safe terminal; no credential access', async () => {
  const c = capture();
  let resolves = 0;
  expect(
    await runSdkRunCommand({ ...opts, provider: 'openai' }, c.io, {
      resolve: async () => {
        resolves++;
        throw new Error('secret token');
      },
    }),
  ).toBe(2);
  expect(resolves).toBe(0);
  expect(c.events).toHaveLength(1);
  expect(c.events[0]).toMatchObject({ type: 'turn.error', code: 'invalid_input', sessionId: null });
});
test.each(['pipe', 'file', 'blob'] as const)(
  'real source CLI missing credentials never starts inference/listener with %s stdin',
  async (transport) => {
    const home = mkdtempSync(join(tmpdir(), 'sdk-cli-'));
    dirs.push(home);
    const input = JSON.stringify({ inputVersion: 1, text: 'hello' });
    const inputPath = join(home, 'input.json');
    writeFileSync(inputPath, input);
    const proc = Bun.spawn(
      [
        process.execPath,
        'src/main.ts',
        'run',
        '--sdk',
        '--route',
        'openai-api',
        '--json',
        '--stdin',
        '--input-format',
        'json',
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          HARNESS_HOME: home,
          HARNESS_CONFIG: join(home, 'config.json'),
        },
        stdin:
          transport === 'pipe'
            ? 'pipe'
            : transport === 'file'
              ? Bun.file(inputPath)
              : new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    if (transport === 'pipe') {
      const stdin = proc.stdin;
      if (typeof stdin === 'number') throw new Error('expected piped stdin');
      stdin.write(input);
      stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe('');
    expect(
      stdout
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s)),
    ).toEqual([
      expect.objectContaining({
        type: 'turn.error',
        code: 'credential_missing',
        route: 'openai-api',
        sessionId: null,
      }),
    ]);
  },
);

test('real source CLI rejects oversized file stdin before credential access', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sdk-cli-oversized-'));
  dirs.push(home);
  const inputPath = join(home, 'input.txt');
  writeFileSync(inputPath, 'x'.repeat(MAX_INPUT_BYTES + 1));
  const proc = Bun.spawn(
    [process.execPath, 'src/main.ts', 'run', '--sdk', '--route', 'openai-api', '--json', '--stdin'],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: home,
        HARNESS_HOME: home,
        HARNESS_CONFIG: join(home, 'config.json'),
      },
      stdin: Bun.file(inputPath),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(2);
  expect(stderr).toBe('');
  expect(
    stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    expect.objectContaining({ type: 'turn.error', code: 'invalid_input', sessionId: null }),
  ]);
});

test('real CLI refuses a route on legacy run before ambient provider inference', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sov-native-route-fence-'));
  dirs.push(home);
  const proc = Bun.spawn(
    [
      process.execPath,
      'src/main.ts',
      'run',
      '--route',
      'chatgpt-subscription',
      '--provider',
      'mock',
      '--json',
      '--stdin',
      '--no-preflight',
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HARNESS_HOME: home,
        HARNESS_CONFIG: join(home, 'config.json'),
        SOV_TEST_MOCK_PROVIDER: '1',
      },
      stdin: new Blob(['hello']),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(2);
  const events = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events).toEqual([
    expect.objectContaining({ type: 'turn.error', code: 'invalid_input', sessionId: null }),
  ]);
  expect(
    events.some((event) => event.type === 'session.started' || event.type === 'turn.completed'),
  ).toBe(false);
});

test('legacy orphan tool calls receive a stored-history repair and are not executed again', async () => {
  let request: ProviderRequest | undefined;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req) {
      request = req;
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'continued' }],
      };
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider);
  const db = SessionDb.open({ path: f.db });
  const sessionId = db.createSession({ provider: 'anthropic', model: 'legacy' });
  db.saveMessage(sessionId, { role: 'user', content: [{ type: 'text', text: 'old request' }] });
  db.saveMessage(sessionId, {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'orphan', name: 'Bash', input: { command: 'never execute' } },
    ],
  });
  db.close();
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, resume: sessionId }, c.io, f.deps)).toBe(0);
  expect(
    request?.messages.some((m) =>
      m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'orphan' && b.is_error),
    ),
  ).toBe(true);
  const reopened = SessionDb.open({ path: f.db });
  try {
    expect(reopened.loadMessages(sessionId)).toHaveLength(4);
  } finally {
    reopened.close();
  }
});
test('save failure stops inference tool execution with typed storage error', async () => {
  let ran = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'save-first', name: 'probe', input: {} }],
      };
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider, (r) => {
    const save = r.sessionDb.saveMessage.bind(r.sessionDb);
    r.sessionDb.saveMessage = (id, msg) => {
      if (msg.role === 'assistant') throw new Error('private storage path');
      return save(id, msg);
    };
    r.toolPool.splice(
      0,
      r.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'probe',
        description: () => 'probe',
        inputSchema: z.unknown(),
        renderResult: () => ({ content: 'ok' }),
        async call() {
          ran++;
          return { data: 'ok' };
        },
      }),
    );
  });
  const c = capture();
  expect(
    await runSdkRunCommand({ ...opts, toolset: 'coding', permissionMode: 'bypass' }, c.io, f.deps),
  ).toBe(1);
  expect(ran).toBe(0);
  expect(c.events.at(-1)).toMatchObject({ type: 'turn.error', code: 'storage_failed' });
  expect(JSON.stringify(c.events)).not.toContain('private storage path');
});
test('final assistant storage failure is typed and never reports completion', async () => {
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
      };
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider, (r) => {
    const save = r.sessionDb.saveMessage.bind(r.sessionDb);
    r.sessionDb.saveMessage = (id, message) => {
      if (message.role === 'assistant') throw new Error('secret storage path');
      return save(id, message);
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(1);
  expect(c.events.at(-1)).toMatchObject({ type: 'turn.error', code: 'storage_failed' });
  expect(c.events.some((event) => event.type === 'turn.completed')).toBe(false);
  expect(JSON.stringify(c.events)).not.toContain('secret storage path');
});
test('cancellation aborts provider and emits exactly one terminal with no late deltas', async () => {
  const abort = new AbortController();
  let sawAbort = false;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req) {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'before' };
      setTimeout(() => abort.abort(), 5);
      await new Promise<void>((resolve) =>
        req.signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        ),
      );
      yield { type: 'text_delta', text: 'late' };
      return { role: 'assistant', content: [{ type: 'text', text: 'late' }] };
    },
  };
  const f = fixture(provider);
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: abort.signal })).toBe(130);
  expect(sawAbort).toBe(true);
  expect(c.events.filter((e) => e.type === 'turn.error')).toHaveLength(1);
  expect(c.events.at(-1)).toMatchObject({ type: 'turn.error', code: 'interrupted' });
  expect(JSON.stringify(c.events)).not.toContain('late');
});
test('incompatible signed Anthropic history is refused before new user row or inference', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      return { role: 'assistant', content: [] };
    },
  };
  const f = fixture(provider);
  const db = SessionDb.open({ path: f.db });
  const id = db.createSession({ provider: 'anthropic', model: 'claude' });
  db.saveMessage(id, {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'old', signature: 'signed' }],
  });
  db.close();
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, resume: id }, c.io, f.deps)).toBe(2);
  expect(calls).toBe(0);
  expect(c.events.at(-1)).toMatchObject({ code: 'unsupported_input' });
  const reopened = SessionDb.open({ path: f.db });
  try {
    expect(reopened.loadMessages(id)).toHaveLength(1);
  } finally {
    reopened.close();
  }
});
