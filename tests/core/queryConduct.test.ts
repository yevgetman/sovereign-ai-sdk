// tests/core/queryConduct.test.ts — conduct seams inside query(): preGate
// (post-rewrite placement, deny/rewrite/refusal semantics) and triage
// (fail-open, refuse short-circuit). Task 4 appends the triage cases.

import { describe, expect, test } from 'bun:test';
import type {
  ConductAuditEvent,
  ConductContext,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';

/** One-turn scripted provider: replays a single assistant text reply. */
function scriptedProvider(replyText: string, seen: { requests: Message[][] }): LLMProvider {
  return {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      seen.requests.push(req.messages as Message[]);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: replyText }],
      };
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: replyText };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
}

const ctx: ConductContext = {
  sessionId: 'conduct-test',
  surface: 'user',
  model: 'test-model',
  providerName: 'scripted',
};

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<{ events: (StreamEvent | Message)[]; terminal: Terminal }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('query() preGate seam', () => {
  test('absent conduct: behavior unchanged (baseline)', async () => {
    const seen = { requests: [] as Message[][] };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(seen.requests).toHaveLength(1);
  });

  test('preGate allow: model sees the original text; audit event fires', async () => {
    const seen = { requests: [] as Message[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      auditSink: (e) => audits.push(e),
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('completed');
    const pregate = audits.filter((e) => e.stage === 'pregate');
    expect(pregate).toHaveLength(1);
    expect(pregate[0]?.verdict).toBe('allow');
  });

  test('preGate rewrite: the model sees the rewritten text', async () => {
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      preGate: (text) => ({ action: 'rewrite', text: `${text} [gated]` }),
    };
    await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    const sent = seen.requests[0]?.[0]?.content[0];
    expect(sent?.type === 'text' && sent.text).toBe('hello [gated]');
  });

  test('preGate deny WITH refusalText: no model call; synthesized assistant refusal; completed', async () => {
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'deny', refusalText: 'No can do.' }),
    };
    const { events, terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(seen.requests).toHaveLength(0); // pre-model short-circuit
    expect(terminal.reason).toBe('completed');
    const finals = events.filter(
      (e): e is Extract<StreamEvent, { type: 'assistant_message' }> =>
        'type' in e && e.type === 'assistant_message',
    );
    expect(finals).toHaveLength(1);
    const block = finals[0]?.message.content[0];
    expect(block?.type === 'text' && block.text).toBe('No can do.');
  });

  test('preGate deny WITHOUT refusalText: terminal error (UserPromptSubmit-deny precedent)', async () => {
    const conduct: ConductProvider = { preGate: () => ({ action: 'deny' }) };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', { requests: [] }),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('error');
    expect(terminal.error?.message).toContain('conduct preGate');
  });

  test('preGate throw fails OPEN: turn proceeds; audit verdict = error', async () => {
    const seen = { requests: [] as Message[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      preGate: () => {
        throw new Error('gate exploded');
      },
      auditSink: (e) => audits.push(e),
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(seen.requests).toHaveLength(1);
    expect(audits.find((e) => e.stage === 'pregate')?.verdict).toBe('error');
  });

  test('preGate sees the UserPromptSubmit-rewritten text, not the original (D23 post-rewrite ordering)', async () => {
    // Behavioral pin for D23: preGate runs AFTER the UserPromptSubmit hook's
    // rewrite, so a hook that rewrites the prompt must be reflected in what
    // preGate receives — nothing smuggles past preGate via a rewriting hook.
    const seen = { requests: [] as Message[][] };
    const ORIGINAL = 'original prompt';
    const REWRITTEN = 'rewritten by hook';
    let gateTextSeen: string | undefined;
    const conduct: ConductProvider = {
      preGate: (text) => {
        gateTextSeen = text;
        return { action: 'allow' };
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg(ORIGINAL)],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
        sessionId: 'hook-rewrite-test',
        cwd: process.cwd(),
        hookRunner: async (event) => {
          if (event === 'UserPromptSubmit') return { block: false, rewrittenPrompt: REWRITTEN };
          return { block: false };
        },
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(gateTextSeen).toBe(REWRITTEN);
    expect(gateTextSeen).not.toBe(ORIGINAL);
    const sent = seen.requests[0]?.[0]?.content[0];
    expect(sent?.type === 'text' && sent.text).toBe(REWRITTEN);
  });

  test("internal surface: preGate does NOT run (persona/triage/preGate are 'user'-only)", async () => {
    const seen = { requests: [] as Message[][] };
    let called = false;
    const conduct: ConductProvider = {
      preGate: () => {
        called = true;
        return { action: 'deny' };
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: { ...ctx, surface: 'internal' },
      }),
    );
    expect(called).toBe(false);
    expect(terminal.reason).toBe('completed');
  });
});
