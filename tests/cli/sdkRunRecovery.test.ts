import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';
import { RouteError, getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import type { LLMProvider, Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { type SdkRunDependencies, runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

const roots: string[] = [];
const captures: Record<string, unknown>[][] = [];
afterAll(() => {
  if (process.env.SDK_RECOVERY_WIRE_OUTPUT)
    writeFileSync(process.env.SDK_RECOVERY_WIRE_OUTPUT, JSON.stringify(captures));
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const opts = { json: true, stdin: true, route: 'openai-api', inputFormat: 'json', toolset: 'chat' };
const message = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
function fixture(provider: LLMProvider, mutate?: (runtime: Runtime) => void) {
  const home = mkdtempSync(join(tmpdir(), 'sdk-run-recovery-'));
  roots.push(home);
  const db = join(home, 'sessions.db');
  const deps: SdkRunDependencies = {
    resolve: async () => ({
      route: getRoute('openai-api', {}),
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
        metadata: { provider: provider.name, apiMode: 'openai', purpose: 'main' },
      },
    }),
    runtime: async (options) => {
      const runtime = await buildRuntime({
        ...options,
        harnessHome: home,
        dbPath: db,
        settings: {
          learning: {
            disabled: true,
            recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
          },
          review: { disabled: true },
        },
        cronEnabled: false,
      });
      mutate?.(runtime);
      return runtime;
    },
  };
  return { db, deps };
}
function capture(onEvent?: (event: Record<string, unknown>) => void) {
  const events: Record<string, unknown>[] = [];
  captures.push(events);
  return {
    events,
    io: {
      readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'question' }),
      writeStdout: (line: string) => {
        const event = JSON.parse(line);
        events.push(event);
        onEvent?.(event);
      },
    },
  };
}
for (const cause of ['cancelled', 'deadline'] as const) {
  test(`pre-session ${cause} has no recoverable target`, async () => {
    const controller = new AbortController();
    if (cause === 'cancelled') controller.abort();
    const c = capture();
    expect(
      await runSdkRunCommand(
        { ...opts, ...(cause === 'deadline' ? { deadlineMs: 1 } : {}) },
        { ...c.io, readStdin: async () => new Promise<string>(() => {}) },
        { signal: controller.signal },
      ),
    ).toBe(130);
    expect(c.events).toHaveLength(1);
    expect(Object.hasOwn(c.events[0] ?? {}, 'activeSessionId')).toBe(false);
    expect(c.events[0]).toMatchObject({
      type: 'turn.error',
      outcome: 'interrupted',
      reason: cause,
      recoverable: false,
      sessionId: null,
      nextAction: 'retry',
    });
  });
}
for (const exhausted of ['max_tokens', 'max_turns'] as const) {
  test(`${exhausted} is continuation with nonzero exit and durable target`, async () => {
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        yield {
          type: 'message_stop',
          stop_reason: exhausted === 'max_tokens' ? 'max_tokens' : 'tool_use',
        };
        const reply: AssistantMessage =
          exhausted === 'max_tokens'
            ? message('partial')
            : {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'refused', name: 'WebSearch', input: {} }],
              };
        yield { type: 'assistant_message', message: reply };
        return reply;
      },
    };
    const f = fixture(provider, (runtime) => {
      runtime.loop = { mode: 'off' };
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'WebSearch',
          description: () => 'fixture',
          inputSchema: z.unknown(),
          async call() {
            return { data: 'receipt' };
          },
        }),
      );
    });
    const c = capture();
    expect(
      await runSdkRunCommand(
        { ...opts, toolset: exhausted === 'max_turns' ? 'web' : 'chat' },
        c.io,
        f.deps,
      ),
    ).toBe(3);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'needs_continuation',
      reason: exhausted,
      continuationCause: exhausted,
      recoverable: true,
      nextAction: 'resume',
    });
    expect(c.events.some((event) => event.type === 'turn.completed')).toBe(false);
    const db = SessionDb.open({ path: f.db });
    try {
      expect(db.getSession(String(terminal?.activeSessionId))).not.toBeNull();
      expect(db.loadMessages(String(terminal?.activeSessionId)).length).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });
}
for (const stage of ['post-session', 'mid-stream', 'after-final-event'] as const) {
  test(`cancellation ${stage} preserves only a verified durable session and usage once`, async () => {
    const controller = new AbortController();
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        if (stage === 'mid-stream') {
          controller.abort();
          throw new Error('fixture aborted');
        }
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: message('complete') };
        return message('complete');
      },
    };
    let usageWrites = 0;
    const f = fixture(provider, (runtime) => {
      const write = runtime.sessionDb.recordUsageEstimate.bind(runtime.sessionDb);
      runtime.sessionDb.recordUsageEstimate = (...args) => {
        usageWrites++;
        return write(...args);
      };
    });
    const c = capture((event) => {
      if (
        (stage === 'post-session' && event.type === 'session.started') ||
        (stage === 'after-final-event' && event.type === 'text_delta')
      )
        controller.abort();
    });
    expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(130);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'interrupted',
      recoverable: true,
      nextAction: 'resume',
    });
    const db = SessionDb.open({ path: f.db });
    try {
      const rows = db.loadMessages(String(terminal?.activeSessionId));
      expect(rows[0]?.role).toBe('user');
      if (stage === 'after-final-event')
        expect(rows.at(-1)?.content).toEqual(message('complete').content);
    } finally {
      db.close();
    }
    expect(usageWrites).toBe(stage === 'post-session' ? 0 : 1);
  });
}

test('an uncooperative cancelled provider never advertises recovery', async () => {
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      controller.abort();
      await new Promise<void>(() => {});
      return message('never');
    },
  };
  const f = fixture(provider);
  const c = capture();
  const started = Date.now();
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(130);
  expect(Date.now() - started).toBeLessThan(4000);
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    recoverable: false,
    sessionId: null,
  });
});

test('a requested nonexistent resume id is refused without creating a recovery target', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      return message('never');
    },
  };
  const f = fixture(provider);
  const runtime = f.deps.runtime;
  // Test the native boundary even if an injected runtime skips boot validation.
  f.deps.runtime = (options) => {
    const { resumeId: _ignored, ...fresh } = options;
    return runtime?.(fresh) as Promise<Runtime>;
  };
  const c = capture();
  expect(await runSdkRunCommand({ ...opts, resume: 'missing-session' }, c.io, f.deps)).toBe(2);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'invalid_input',
    recoverable: false,
    sessionId: null,
  });
  expect(calls).toBe(0);
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

test('completed tool receipt survives post-tool cancellation and is not replayed on resume', async () => {
  let effects = 0;
  let rounds = 0;
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      const reply: AssistantMessage =
        rounds++ === 0
          ? {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'effect', name: 'receipt_probe', input: {} }],
            }
          : message('finished');
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message: reply };
      return reply;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'receipt_probe',
        description: () => 'fixture receipt',
        inputSchema: z.object({}),
        async call() {
          effects++;
          return { data: 'effect done' };
        },
      }),
    );
  });
  const c = capture((event) => {
    if (event.type === 'tool_result') controller.abort();
  });
  expect(
    await runSdkRunCommand({ ...opts, toolset: 'coding' }, c.io, {
      ...f.deps,
      signal: controller.signal,
    }),
  ).toBe(130);
  const terminal = c.events.at(-1);
  expect(terminal).toMatchObject({ type: 'turn.error', recoverable: true, nextAction: 'resume' });
  const resumed = capture();
  expect(
    await runSdkRunCommand(
      { ...opts, toolset: 'coding', resume: String(terminal?.activeSessionId) },
      resumed.io,
      f.deps,
    ),
  ).toBe(0);
  expect(resumed.events.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'completed' });
  expect(effects).toBe(1);
});

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal?.addEventListener('abort', () => resolve(), { once: true }),
  );
}
for (const stage of [
  'post-session',
  'mid-stream',
  'mid-tool',
  'post-tool',
  'after-final-event',
] as const) {
  test(`deadline ${stage} reports its cause and only durable recovery`, async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'openai',
      async *stream(request) {
        calls++;
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
        if (stage === 'mid-stream') {
          await waitForAbort(request.signal);
          throw new Error('fixture timeout');
        }
        const reply: AssistantMessage =
          (stage === 'mid-tool' || stage === 'post-tool') && calls === 1
            ? {
                role: 'assistant',
                content: [
                  { type: 'tool_use', id: 'deadline-effect', name: 'deadline_probe', input: {} },
                ],
              }
            : message('complete');
        yield {
          type: 'message_stop',
          stop_reason:
            calls === 1 && (stage === 'mid-tool' || stage === 'post-tool')
              ? 'tool_use'
              : 'end_turn',
        };
        yield { type: 'assistant_message', message: reply };
        if (stage === 'after-final-event') await waitForAbort(request.signal);
        return reply;
      },
    };
    const f = fixture(provider, (runtime) => {
      if (stage === 'post-session' || stage === 'post-tool')
        runtime.hookRunner = async (event, _payload, signal) => {
          if (
            (stage === 'post-session' && event === 'UserPromptSubmit') ||
            (stage === 'post-tool' && event === 'PostToolUse')
          )
            await waitForAbort(signal);
          return { block: false };
        };
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'deadline_probe',
          description: () => 'deadline fixture',
          inputSchema: z.unknown(),
          async call(_input, context) {
            if (stage === 'mid-tool') await waitForAbort(context.signal);
            return { data: 'safe receipt' };
          },
        }),
      );
    });
    const c = capture();
    expect(
      await runSdkRunCommand({ ...opts, toolset: 'coding', deadlineMs: 1000 }, c.io, f.deps),
    ).toBe(130);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({
      type: 'turn.error',
      outcome: 'interrupted',
      reason: 'deadline',
    });
    if (terminal?.recoverable) {
      expect(terminal.activeSessionId).toEqual(expect.any(String));
      expect(terminal.nextAction).toBe('resume');
      const db = SessionDb.open({ path: f.db });
      try {
        expect(db.getSession(String(terminal.activeSessionId))).not.toBeNull();
      } finally {
        db.close();
      }
    } else {
      expect(Object.hasOwn(terminal ?? {}, 'activeSessionId')).toBe(false);
    }
    if (stage === 'post-session') expect(calls).toBe(0);
  });
}

test('a usage storage failure during cancellation disables recovery and keeps errors secret-safe', async () => {
  const controller = new AbortController();
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      controller.abort();
      throw new Error('fixture aborted');
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.sessionDb.recordUsageEstimate = () => {
      throw new Error('private usage store failure');
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'failed',
    code: 'storage_failed',
    recoverable: false,
    nextAction: 'inspect_storage',
  });
  expect(JSON.stringify(c.events)).not.toContain('private usage store failure');
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

for (const cooperative of [true, false]) {
  test(`mid-tool cancellation ${cooperative ? 'settles its receipt' : 'refuses unknown effects'}`, async () => {
    const controller = new AbortController();
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        const reply: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'mid-effect', name: 'mid_tool_probe', input: {} }],
        };
        yield { type: 'message_start' };
        yield { type: 'assistant_message', message: reply };
        return reply;
      },
    };
    const f = fixture(provider, (runtime) => {
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'mid_tool_probe',
          description: () => 'mid-tool fixture',
          inputSchema: z.unknown(),
          async call(_input, context) {
            controller.abort();
            if (!cooperative) await new Promise<void>(() => {});
            await waitForAbort(context.signal);
            return { data: 'settled safe effect' };
          },
        }),
      );
    });
    const c = capture();
    expect(
      await runSdkRunCommand({ ...opts, toolset: 'coding' }, c.io, {
        ...f.deps,
        signal: controller.signal,
      }),
    ).toBe(130);
    const terminal = c.events.at(-1);
    expect(terminal).toMatchObject({ type: 'turn.error', outcome: 'interrupted' });
    if (cooperative) expect(terminal?.recoverable).toBe(true);
    else {
      expect(terminal?.recoverable).toBe(false);
      expect(Object.hasOwn(terminal ?? {}, 'activeSessionId')).toBe(false);
    }
  });
}

test('late cancelled transcript storage failure never duplicates the canonical assistant or exposes recovery', async () => {
  const controller = new AbortController();
  let failed = false;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'partial' };
      yield { type: 'assistant_message', message: message('complete') };
      return message('complete');
    },
  };
  const f = fixture(provider, (runtime) => {
    const transcript = runtime.transcripts;
    if (!transcript) throw new Error('fixture requires transcripts');
    const record = transcript.recordMessage.bind(transcript);
    transcript.recordMessage = (...args) => {
      if (args[1] === 'assistant' && !failed) {
        failed = true;
        throw new Error('private transcript failure');
      }
      record(...args);
    };
  });
  const c = capture((event) => {
    if (event.type === 'text_delta') controller.abort();
  });
  expect(await runSdkRunCommand(opts, c.io, { ...f.deps, signal: controller.signal })).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'storage_failed',
    recoverable: false,
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
  const id = String(c.events.find((event) => event.type === 'session.started')?.sessionId);
  const db = SessionDb.open({ path: f.db });
  try {
    expect(db.loadMessages(id).map((row) => row.role)).toEqual(['user', 'assistant']);
  } finally {
    db.close();
  }
  expect(JSON.stringify(c.events)).not.toContain('private transcript failure');
});

test('a final storage verification fault cannot report completed success or lose completed rows/usage', async () => {
  let failReads = false;
  let usageWrites = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
      yield { type: 'assistant_message', message: message('complete') };
      return message('complete');
    },
  };
  const f = fixture(provider, (runtime) => {
    const get = runtime.sessionDb.getSession.bind(runtime.sessionDb);
    runtime.sessionDb.getSession = (...args) => {
      if (failReads) throw new Error('private final store verification failure');
      return get(...args);
    };
    const write = runtime.sessionDb.recordUsageEstimate.bind(runtime.sessionDb);
    runtime.sessionDb.recordUsageEstimate = (...args) => {
      const value = write(...args);
      usageWrites++;
      failReads = true;
      return value;
    };
  });
  const c = capture();
  expect(await runSdkRunCommand(opts, c.io, f.deps)).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'failed',
    code: 'storage_failed',
    recoverable: false,
    nextAction: 'inspect_storage',
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
  expect(c.events.some((event) => event.type === 'turn.completed')).toBe(false);
  expect(usageWrites).toBe(1);
  const id = String(c.events.find((event) => event.type === 'session.started')?.sessionId);
  const db = SessionDb.open({ path: f.db });
  try {
    expect(db.loadMessages(id).map((row) => row.role)).toEqual(['user', 'assistant']);
  } finally {
    db.close();
  }
  expect(JSON.stringify(c.events)).not.toContain('private final store verification failure');
});

test('actual native checkin wire uses continuation rather than completion', async () => {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/sdk-run-checkin.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(errors).not.toContain('error:');
  const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
  captures.push(result.events);
  expect(result.exit).toBe(3);
  expect(result.events.at(-1)).toMatchObject({
    type: 'turn.error',
    outcome: 'needs_continuation',
    continuationCause: 'checkin',
    recoverable: true,
    nextAction: 'resume',
  });
  expect(result.effects).toBe(1);
  expect(result.rows).toEqual(['user', 'assistant', 'user']);
});

test('pre-session rate limit requests retry without claiming a nonexistent recovery target', async () => {
  const c = capture();
  expect(
    await runSdkRunCommand(opts, c.io, {
      resolve: async () => {
        throw new RouteError('rate_limited', 'mock transient limit');
      },
    }),
  ).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'rate_limited',
    recoverable: false,
    sessionId: null,
    nextAction: 'retry',
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});

// The separate #73 route mapper introduces this stable token-service code.
// Inject that future typed route outcome here without importing its branch.
test('pre-session malformed token response requests provider inspection rather than automatic retry', async () => {
  const c = capture();
  expect(
    await runSdkRunCommand(opts, c.io, {
      resolve: async () => {
        const error = new RouteError('rate_limited', 'mock malformed token response');
        Object.defineProperty(error, 'code', { value: 'provider_response_invalid' });
        throw error;
      },
    }),
  ).toBe(1);
  expect(c.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'provider_response_invalid',
    recoverable: false,
    sessionId: null,
    nextAction: 'check_provider',
  });
  expect(Object.hasOwn(c.events.at(-1) ?? {}, 'activeSessionId')).toBe(false);
});
