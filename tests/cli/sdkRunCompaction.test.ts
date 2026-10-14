import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { ContextOverflowError } from '@yevgetman/sov-sdk/providers/errors';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import type { LLMProvider, ProviderRequest, Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { type SdkRunDependencies, runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import { type Runtime, buildRuntime } from '../../src/server/runtime.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const opts = {
  json: true,
  stdin: true,
  route: 'openai-api',
  inputFormat: 'json',
  toolset: 'chat',
  maxTokens: 100,
};
function fixture(provider: LLMProvider, mutate?: (runtime: Runtime) => void) {
  const home = mkdtempSync(join(tmpdir(), 'native-compact-'));
  dirs.push(home);
  const dbPath = join(home, 'sessions.db');
  const db = SessionDb.open({ path: dbPath });
  const parent = db.createSession({ provider: 'openai', model: 'gpt-4.1', platform: 'cli' });
  for (let i = 0; i < 10; i++)
    db.saveMessage(parent, {
      role: i % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: `history-${i} ${'a'.repeat(2000)}` }],
    });
  db.close();
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
        metadata: { provider: 'openai', apiMode: 'openai', purpose: 'main' },
      },
    }),
    runtime: async (input) => {
      const runtime = await buildRuntime({
        ...input,
        harnessHome: home,
        dbPath,
        settings: {
          learning: {
            disabled: true,
            recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
          },
          review: { disabled: true },
        },
      });
      runtime.systemSegments.splice(0, runtime.systemSegments.length, {
        text: 'Be helpful.',
        cacheable: false,
      });
      runtime.proactiveCompactThreshold = 1;
      mutate?.(runtime);
      return runtime;
    },
  };
  const events: Record<string, unknown>[] = [];
  const io = {
    readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'Continue.' }),
    writeStdout: (line: string) => events.push(JSON.parse(line)),
  };
  return { deps, io, events, parent, dbPath };
}
function isSummary(req: ProviderRequest) {
  return req.system.some((segment) =>
    segment.text.includes('compressing an agent harness conversation'),
  );
}

test('fitting Kernel-sized native input avoids byte-derived overflow and paid compaction', async () => {
  let summaries = 0;
  let main = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(request) {
      if (isSummary(request)) summaries++;
      else main++;
      const message = answer();
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider);
  f.io.readStdin = async () =>
    JSON.stringify({ inputVersion: 1, text: 'The owner wants a clear answer. '.repeat(2500) });
  expect(await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, f.deps)).toBe(0);
  expect(main).toBe(1);
  expect(summaries).toBe(0);
  expect(f.events.find((event) => event.type === 'context.accounting')).toMatchObject({
    complete: true,
    enforce: true,
    effectiveLimit: 32768,
    reservedOutput: 100,
    source: 'openai/gpt-4.1:js-tiktoken/o200k_base:chunked-wire-estimate',
  });
});
function answer(text = 'done'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

test('native overflow compacts once, continues on durable child, and returns its active id', async () => {
  let calls = 0;
  let summaries = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req): AsyncGenerator<StreamEvent, AssistantMessage> {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 20, outputTokens: 3 } };
      if (isSummary(req)) {
        summaries++;
        const message = answer('Preserve the task.');
        yield { type: 'assistant_message', message };
        return message;
      }
      calls++;
      if (calls === 1) throw new ContextOverflowError('openai');
      expect(JSON.stringify(req.messages)).toContain('handoff summary');
      const message = answer();
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider);
  expect(await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, f.deps)).toBe(0);
  expect(calls).toBe(2);
  expect(summaries).toBe(1);
  const final = f.events.at(-1);
  expect(final).toMatchObject({ type: 'turn.completed', reply: 'done' });
  expect(final?.activeSessionId).not.toBe(f.parent);
  expect(final?.sessionId).toBe(final?.activeSessionId);
  expect(final?.usage).toEqual({ inputTokens: 60, outputTokens: 9 });
  const db = SessionDb.open({ path: f.dbPath });
  try {
    expect(db.getCompactionsForParent(f.parent).map((row) => row.childSessionId)).toEqual([
      String(final?.activeSessionId),
    ]);
  } finally {
    db.close();
  }
});

test.each([false, true])(
  'native proactive compaction and optional overflow recovery (%s) rebuild every hop',
  async (overflow) => {
    const requests: ProviderRequest[] = [];
    let mains = 0;
    let summaries = 0;
    const traces: string[] = [];
    const contexts: string[] = [];
    const provider: LLMProvider = {
      name: 'openai',
      async *stream(req) {
        requests.push(req);
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 10, outputTokens: 2 } };
        if (isSummary(req)) {
          summaries++;
          const message = answer('Task remains active.');
          yield { type: 'assistant_message', message };
          return message;
        }
        mains++;
        if (overflow && mains === 1) throw new ContextOverflowError('openai');
        const message = answer();
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const f = fixture(provider, (runtime) => {
      runtime.proactiveCompactThreshold = 0.005;
      const getContext = runtime.getSessionContext.bind(runtime);
      runtime.getSessionContext = (id) => {
        contexts.push(id);
        const ctx = getContext(id);
        const record = ctx.traceWriter.record.bind(ctx.traceWriter);
        ctx.traceWriter.record = (event) => {
          traces.push(id);
          record(event);
        };
        return ctx;
      };
    });
    f.io.readStdin = async () =>
      JSON.stringify({ inputVersion: 1, text: 'Continue.', instructions: 'EPHEMERAL' });
    expect(await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, f.deps)).toBe(0);
    const pivots = f.events.filter((e) => e.type === 'compaction_complete');
    expect(pivots).toHaveLength(overflow ? 2 : 1);
    expect(summaries).toBe(pivots.length);
    expect(mains).toBe(overflow ? 2 : 1);
    const child = String(f.events.at(-1)?.activeSessionId);
    expect(child).toBe(String(pivots.at(-1)?.activeSessionId));
    expect(contexts).toContain(child);
    expect(traces).toContain(child);
    for (const req of requests) {
      expect(req.model).toBe('gpt-4.1');
      expect(req.effort).toBe('off');
      expect(req.modelMetadata?.id).toBe('gpt-4.1');
    }
    const driveRequests = requests.filter((req) => !isSummary(req));
    for (const req of driveRequests) {
      expect(req.effort).toBe('off');
      expect(req.system.at(-1)?.text).toBe('EPHEMERAL');
      expect(req.tools ?? []).toEqual([]);
    }
    expect(f.events.at(-1)?.usage).toEqual({
      inputTokens: requests.length * 10,
      outputTokens: requests.length * 2,
    });
    expect(f.events.at(-1)?.costEstimate).toMatchObject({ state: 'unknown', complete: false });
    expect(f.events.at(-1)?.estimatedCostUsd).toBeUndefined();
    const db = SessionDb.open({ path: f.dbPath });
    try {
      expect(db.getCompactionsForParent(f.parent)[0]?.childSessionId).toBe(
        String(pivots[0]?.activeSessionId),
      );
      if (overflow)
        expect(
          db.getCompactionsForParent(String(pivots[0]?.activeSessionId))[0]?.childSessionId,
        ).toBe(child);
      expect(
        db
          .loadMessages(child)
          .filter((m) => m.content.some((b) => b.type === 'text' && b.text === 'Continue.')),
      ).toHaveLength(1);
      expect(JSON.stringify(db.loadMessages(child))).not.toContain('EPHEMERAL');
    } finally {
      db.close();
    }
    // The adapter's terminal id resumes the durable newest child.
    f.events.length = 0;
    expect(await runSdkRunCommand({ ...opts, resume: child }, f.io, f.deps)).toBe(0);
    expect(f.events[0]).toMatchObject({ sessionId: child, activeSessionId: child, resumed: true });
  },
);

test('native second overflow stops with the newest child and full attempted usage', async () => {
  let mains = 0;
  let summaries = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream(req) {
      yield { type: 'message_start' };
      yield { type: 'usage_delta', usage: { inputTokens: 5, outputTokens: 1 } };
      if (isSummary(req)) {
        summaries++;
        const message = answer('task');
        yield { type: 'assistant_message', message };
        return message;
      }
      mains++;
      throw new ContextOverflowError('openai');
    },
  };
  const f = fixture(provider);
  expect(await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, f.deps)).toBe(1);
  expect(mains).toBe(2);
  expect(summaries).toBe(1);
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn.error',
    code: 'context_overflow',
    recoverable: false,
    usage: { inputTokens: 15, outputTokens: 3 },
  });
  expect(f.events.at(-1)?.activeSessionId).toBe(
    f.events.find((e) => e.type === 'compaction_complete')?.activeSessionId,
  );
  expect(f.events.at(-1)?.sessionId).not.toBe(f.parent);
});

test('native no-op compaction never retries the unchanged request', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      calls++;
      yield { type: 'message_start' };
      throw new ContextOverflowError('openai');
    },
  };
  const f = fixture(provider);
  const db = SessionDb.open({ path: f.dbPath });
  db.truncateMessages(f.parent, 2);
  db.close();
  expect(await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, f.deps)).toBe(1);
  expect(calls).toBe(1);
  expect(f.events.filter((e) => e.type === 'compaction_complete')).toHaveLength(0);
  expect(f.events.at(-1)).toMatchObject({ code: 'context_overflow', activeSessionId: f.parent });
});

test.each(['summary', 'retry'] as const)(
  'native cancellation during %s is bounded and keeps partial usage without a late pivot',
  async (phase) => {
    const abort = new AbortController();
    let main = 0;
    const provider: LLMProvider = {
      name: 'openai',
      async *stream(req) {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 7 } };
        if (
          (phase === 'summary' && isSummary(req)) ||
          (phase === 'retry' && !isSummary(req) && ++main === 2)
        ) {
          abort.abort();
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          yield { type: 'text_delta', text: 'late' };
          const message = answer('late');
          yield { type: 'assistant_message', message };
          return message;
        }
        if (!isSummary(req)) throw new ContextOverflowError('openai');
        const message = answer('summary');
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const f = fixture(provider, (runtime) => {
      if (phase === 'summary') runtime.proactiveCompactThreshold = 0.005;
    });
    const start = Date.now();
    expect(
      await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, {
        ...f.deps,
        signal: abort.signal,
      }),
    ).toBe(130);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(f.events.filter((e) => e.type === 'turn.error')).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({
      code: 'interrupted',
      usage: { inputTokens: phase === 'summary' ? 7 : 21 },
      costEstimate: { complete: false, state: 'unknown' },
    });
    expect(JSON.stringify(f.events)).not.toContain('late');
    const db = SessionDb.open({ path: f.dbPath });
    try {
      if (phase === 'summary') {
        expect(db.getCompactionsForParent(f.parent)).toHaveLength(0);
        expect(f.events.at(-1)?.activeSessionId).toBe(f.parent);
      } else {
        const child = String(f.events.at(-1)?.activeSessionId);
        expect(child).not.toBe(f.parent);
        expect(db.getUsageEstimates(child)).toHaveLength(2); // summary + one cancelled drive
        expect(db.getSession(child)?.inputTokens).toBe(7);
        expect(db.getSession(child)?.compactionInputTokens).toBe(7);
      }
    } finally {
      db.close();
    }
  },
);

test.each([false, true])(
  'native overflow %s after a completed tool preserves its receipt and one real effect',
  async (proactive) => {
    let effects = 0;
    let mains = 0;
    let summaries = 0;
    const seenContexts: string[] = [];
    const provider: LLMProvider = {
      name: 'openai',
      async *stream(req) {
        yield { type: 'message_start' };
        yield { type: 'usage_delta', usage: { inputTokens: 20, outputTokens: 3 } };
        if (isSummary(req)) {
          summaries++;
          const message = answer('The completed probe result is durable.');
          yield { type: 'assistant_message', message };
          return message;
        }
        mains++;
        if (mains === 1) {
          const message: AssistantMessage = {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'one-effect', name: 'probe', input: {} }],
          };
          yield { type: 'assistant_message', message };
          return message;
        }
        expect(
          req.messages.some((m) =>
            m.content.some(
              (b) =>
                b.type === 'tool_result' &&
                b.tool_use_id === 'one-effect' &&
                b.content === 'effect-complete' &&
                !b.is_error,
            ),
          ),
        ).toBe(true);
        if (mains === 2) throw new ContextOverflowError('openai');
        const message = answer('used durable result');
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const f = fixture(provider, (runtime) => {
      if (proactive) runtime.proactiveCompactThreshold = 0.005;
      runtime.toolPool.splice(
        0,
        runtime.toolPool.length,
        buildTool<unknown, unknown>({
          name: 'probe',
          description: () => 'probe',
          inputSchema: z.unknown(),
          renderResult: () => ({ content: 'effect-complete' }),
          async call(_input, context) {
            effects++;
            seenContexts.push(context.sessionId ?? 'missing');
            return { data: 'effect-complete' };
          },
        }),
      );
    });
    expect(
      await runSdkRunCommand(
        { ...opts, resume: f.parent, toolset: 'coding', permissionMode: 'bypass' },
        f.io,
        f.deps,
      ),
    ).toBe(0);
    expect(effects).toBe(1);
    expect(mains).toBe(3);
    expect(summaries).toBe(proactive ? 2 : 1);
    const pivots = f.events.filter((e) => e.type === 'compaction_complete');
    expect(pivots).toHaveLength(proactive ? 2 : 1);
    expect(seenContexts).toEqual([proactive ? String(pivots[0]?.activeSessionId) : f.parent]);
    const final = f.events.at(-1);
    expect(final).toMatchObject({
      type: 'turn.completed',
      reply: 'used durable result',
      usage: { inputTokens: (3 + summaries) * 20, outputTokens: (3 + summaries) * 3 },
    });
    const db = SessionDb.open({ path: f.dbPath });
    try {
      const child = String(final?.activeSessionId);
      const rows = db.loadMessages(child);
      expect(
        rows.filter((m) => m.content.some((b) => b.type === 'tool_use' && b.id === 'one-effect')),
      ).toHaveLength(1);
      expect(
        rows.filter((m) =>
          m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'one-effect'),
        ),
      ).toHaveLength(1);
      expect(
        rows.filter((m) => m.content.some((b) => b.type === 'text' && b.text === 'Continue.')),
      ).toHaveLength(1);
      expect(
        rows.filter((m) =>
          m.content.some((b) => b.type === 'text' && b.text === 'used durable result'),
        ),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
    const seqs = f.events.filter((event) => event.seq !== undefined).map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  },
);

test('native post-pivot setup failure still reports the newest child', async () => {
  const provider: LLMProvider = {
    name: 'openai',
    async *stream() {
      const message = answer();
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  const f = fixture(provider, (runtime) => {
    runtime.proactiveCompactThreshold = 0.005;
    const original = runtime.getSessionContext.bind(runtime);
    let count = 0;
    runtime.getSessionContext = (id) => {
      if (++count > 1) throw new Error('private child setup');
      return original(id);
    };
  });
  expect(await runSdkRunCommand({ ...opts, resume: f.parent }, f.io, f.deps)).toBe(1);
  const child = f.events.find((event) => event.type === 'compaction_complete')?.activeSessionId;
  expect(child).not.toBe(f.parent);
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn.error',
    sessionId: child,
    activeSessionId: child,
  });
  expect(JSON.stringify(f.events)).not.toContain('private child setup');
});

test.each(['system', 'schema', 'latest-input'] as const)(
  'irreducible %s budget causes no paid summary and keeps the parent',
  async (fixed) => {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'openai',
      async *stream() {
        calls++;
        const message = answer();
        yield { type: 'assistant_message', message };
        return message;
      },
    };
    const f = fixture(provider, (runtime) => {
      runtime.proactiveCompactThreshold = 0.005;
      if (fixed === 'schema')
        runtime.toolPool.splice(
          0,
          runtime.toolPool.length,
          buildTool<unknown, unknown>({
            name: 'probe',
            description: () => 'schema '.repeat(40000),
            inputSchema: z.unknown(),
            async call() {
              throw new Error('must not execute');
            },
          }),
        );
      if (fixed === 'system')
        runtime.systemSegments.splice(0, runtime.systemSegments.length, {
          text: 'owner '.repeat(40000),
          cacheable: false,
        });
    });
    if (fixed === 'latest-input')
      f.io.readStdin = async () =>
        JSON.stringify({ inputVersion: 1, text: 'owner '.repeat(40000) });
    expect(
      await runSdkRunCommand(
        { ...opts, resume: f.parent, toolset: fixed === 'schema' ? 'coding' : 'chat' },
        f.io,
        f.deps,
      ),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(f.events.filter((event) => event.type === 'compaction_complete')).toHaveLength(0);
    expect(f.events.at(-1)).toMatchObject({
      code: 'context_overflow',
      sessionId: f.parent,
      activeSessionId: f.parent,
    });
    const db = SessionDb.open({ path: f.dbPath });
    try {
      expect(db.getCompactionsForParent(f.parent)).toHaveLength(0);
    } finally {
      db.close();
    }
  },
);
