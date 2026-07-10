import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { ConductAuditEvent, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';

/** Scripted provider capturing the system prompt each stream() call receives. */
function scriptedProvider(seen: { systems: SystemSegment[][] }): LLMProvider {
  return {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      seen.systems.push(req.system as SystemSegment[]);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      };
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
}

async function drainRun(gen: AsyncGenerator<StreamEvent | Message, unknown>) {
  const events: (StreamEvent | Message)[] = [];
  let result: unknown;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  return { events, result };
}

const baseSegments: SystemSegment[] = [
  { text: 'base', cacheable: true },
  { text: 'dynamic', cacheable: false },
];

describe('createAgent conduct wiring', () => {
  test('null provider (absent conduct): system prompt reaches provider unchanged', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
    });
    await drainRun(agent.run('hello'));
    expect(seen.systems[0]).toEqual(baseSegments);
  });

  test('personaSegments compose after the cacheable prefix; audit fires with ctx fields', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      personaSegments: (ctx) => {
        expect(ctx.surface).toBe('user');
        expect(ctx.model).toBe('test-model');
        expect(ctx.providerName).toBe('scripted');
        expect(ctx.sessionId.length).toBeGreaterThan(0);
        return [{ text: 'persona', cacheable: true }];
      },
      auditSink: (e) => audits.push(e),
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
    });
    await drainRun(agent.run('hello'));
    expect(seen.systems[0]?.map((s) => s.text)).toEqual(['base', 'persona', 'dynamic']);
    expect(audits.find((e) => e.stage === 'persona')?.verdict).toBe('segments:1');
  });

  test("internal surface: personaSegments skipped ('user'-only)", async () => {
    const seen = { systems: [] as SystemSegment[][] };
    let called = false;
    const conduct: ConductProvider = {
      personaSegments: () => {
        called = true;
        return [{ text: 'persona', cacheable: true }];
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
      conductSurface: 'internal',
    });
    await drainRun(agent.run('hello'));
    expect(called).toBe(false);
    expect(seen.systems[0]).toEqual(baseSegments);
  });

  test('personaSegments throw fails OPEN (base prompt used)', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      personaSegments: () => {
        throw new Error('persona exploded');
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
    });
    const { result } = await drainRun(agent.run('hello'));
    expect(seen.systems[0]).toEqual(baseSegments);
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).terminal.reason).toBe('completed');
  });

  test('perTurn.conduct overrides standing config', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const standing: ConductProvider = {
      personaSegments: () => [{ text: 'standing-persona', cacheable: true }],
    };
    const perTurn: ConductProvider = {
      personaSegments: () => [{ text: 'per-turn-persona', cacheable: true }],
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct: standing,
    });
    await drainRun(agent.run('hello', { conduct: perTurn }));
    expect(seen.systems[0]?.map((s) => s.text)).toEqual(['base', 'per-turn-persona', 'dynamic']);
  });
});
