// Task 10 — conduct threading through `buildCronAgentConfig`.
//
// Mirrors the recall conditional-spread precedent in `wiring.reseat.test.ts`
// (the exact unit-level `buildCronAgentConfig` field-parity harness): a
// deps-supplied `conduct` provider lands on the constructed `AgentConfig` by
// reference; absent → the field stays ABSENT (not `undefined`), preserving the
// null-provider byte-identical invariant (an absent provider must leave the
// config exactly as it was pre-conduct).
//
// The two INLINE-createAgent surfaces (openai-compat `chatCompletions` +
// `missionRun`) have no builder fn to unit-test here — their conduct threading
// is covered by Task 12's coverage test, per the Task 10 brief.

import { describe, expect, test } from 'bun:test';
import type { MicrocompactConfig } from '@yevgetman/sov-sdk/compact/microcompact';
import type { ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';
import type { MemoryRuntime } from '@yevgetman/sov-sdk/memory/provider';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { type CronAgentConfigInput, buildCronAgentConfig } from '../../src/cron/wiring.js';

/** The minimal standing input `wiring.reseat.test.ts` uses, plus any override
 *  (here: a `conduct` sentinel). Distinct sentinel objects so the assertion can
 *  prove reference-identity pass-through, not a copy. */
function makeInput(overrides: Partial<CronAgentConfigInput> = {}): CronAgentConfigInput {
  const provider = { name: 'sentinel-provider' } as unknown as LLMProvider;
  const systemPrompt: SystemSegment[] = [{ text: 'cron system', cacheable: true }];
  const tools = [{ name: 'sentinel-tool' }] as unknown as Tool<unknown, unknown>[];
  const memoryManager = { id: 'sentinel-memory' } as unknown as MemoryRuntime;
  const microcompactConfig: MicrocompactConfig = {
    enabled: true,
    keepRecent: 3,
    triggerThresholdPct: 25,
    compactableTools: new Set(['Bash']),
  };
  return {
    provider,
    model: 'mock-model',
    effort: 'medium',
    systemPrompt,
    maxTokens: 4096,
    cwd: '/cron/cwd',
    tools,
    memoryManager,
    microcompactConfig,
    ...overrides,
  };
}

describe('cron conduct threading — buildCronAgentConfig', () => {
  test('a deps-supplied conduct provider lands on the AgentConfig by reference', () => {
    const conduct: ConductProvider = {};
    const config = buildCronAgentConfig(makeInput({ conduct }));
    expect(config.conduct).toBe(conduct);
  });

  test('absent conduct stays ABSENT (null-provider invariant, not undefined)', () => {
    const config = buildCronAgentConfig(makeInput());
    expect('conduct' in config).toBe(false);
  });
});
