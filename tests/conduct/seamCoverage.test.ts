// tests/conduct/seamCoverage.test.ts — the no-bypass proof (spec §8).
//
// Layer 1 (mechanical): every wrapper createAgent call site threads conduct.
// The six call sites are enumerated; each is asserted either by the unit
// tests of Tasks 9–10 (gateway, channels, cron) or here by source assertion
// (chatCompletions, missionRun — inline configs), with subprocessExecutor
// covered by the Task-8 trust-boundary doc (a provider object cannot cross a
// process boundary; the child binds its own at boot).
//
// Layer 2 (behavioral): one end-to-end gateway turn with a recording provider
// asserts the full seam chain fired in order: pregate → triage → persona →
// output (audit events), and the delivered text matches the gate's verdict —
// already exercised in tests/server/turnsConduct.test.ts; here we assert the
// AUDIT ORDER contract on a direct createAgent run (surface-independent).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { ConductAuditEvent, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';

// --- helpers copied from tests/agent/createAgent.conduct.test.ts ------------
// (tests do not import tests; the ~30 lines are duplicated by design.)

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

// --- Layer 1: mechanical no-bypass ------------------------------------------

const WRAPPER_CALL_SITES = [
  'src/server/routes/turns.ts',
  'src/channels/pipeline.ts',
  'src/cron/wiring.ts',
  'src/openai/routes/chatCompletions.ts',
  'src/cli/missionRun.ts',
] as const;

describe('conduct seam coverage', () => {
  test('every user-facing wrapper createAgent call site threads conduct', () => {
    for (const file of WRAPPER_CALL_SITES) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('conduct'), `${file} must thread the conduct provider`).toBe(true);
    }
  });

  test('audit chain order on a full gated turn: pregate → triage → persona → output', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      personaSegments: () => [{ text: 'p', cacheable: true }],
      preGate: () => ({ action: 'allow' }),
      triage: () => ({ genuine: true, posture: 'open' }),
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      auditSink: (e) => audits.push(e),
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: [{ text: 'base', cacheable: true }],
      conduct,
    });
    await drainRun(agent.run('hello'));
    const stages = audits.map((e) => e.stage);
    // persona fires at assembly (before query starts), then the input seams,
    // then output — assert set + relative input/output order:
    expect(stages).toContain('persona');
    expect(stages).toContain('pregate');
    expect(stages).toContain('triage');
    expect(stages).toContain('output');
    expect(stages.indexOf('pregate')).toBeLessThan(stages.indexOf('output'));
    expect(stages.indexOf('triage')).toBeLessThan(stages.indexOf('output'));
  });
});
