// Live integration test (T4-live) for the `sov` lane against a RUNNING L1 engine.
//
// Gated on SOV_ENGINE_URL — skipped unless it points at a live OpenAI-compatible
// Sovereign engine (e.g. `http://127.0.0.1:8000/v1`). Optionally SOV_ENGINE_MODEL
// (default the engine's real served model id, `mlx-community/Qwen3-4B-4bit`).
//
//   SOV_ENGINE_URL=http://127.0.0.1:8000/v1 bun test tests/providers/sov.live.test.ts
//
// It proves the engine's *real* streaming shapes flow through SovProvider:
//   - reasoning_content streams as the `thinking` channel, separate from the answer
//   - a whole tool_call delta becomes a tool_use block carrying the engine's `call_` id
// (Both shapes were captured from vllm-mlx 0.3.0 serving Qwen3-4B-4bit; the offline
// tests in sov.test.ts model the same shapes with a fake fetch.)

import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, ContentBlock, StreamEvent } from '../../src/core/types.js';
import { SovProvider } from '../../src/providers/sov.js';

const ENGINE = process.env.SOV_ENGINE_URL;
const MODEL = process.env.SOV_ENGINE_MODEL ?? 'mlx-community/Qwen3-4B-4bit';
const live = ENGINE ? test : test.skip;

async function drain(
  gen: AsyncGenerator<StreamEvent, AssistantMessage>,
): Promise<{ yielded: StreamEvent[]; returned: AssistantMessage }> {
  const yielded: StreamEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { yielded, returned: step.value };
    yielded.push(step.value);
  }
}

const find = <T extends ContentBlock['type']>(blocks: ContentBlock[], type: T) =>
  blocks.find((b): b is Extract<ContentBlock, { type: T }> => b.type === type);

// Only include baseURL when ENGINE is set (the gating guarantees it is, but the
// conditional spread also satisfies exactOptionalPropertyTypes without a cast).
const makeSov = () => new SovProvider(ENGINE ? { baseURL: ENGINE } : {});

describe('SovProvider — live engine (gated on SOV_ENGINE_URL)', () => {
  live(
    'reasoning_content surfaces on the thinking channel, separate from the answer',
    async () => {
      const sov = makeSov();
      const { yielded, returned } = await drain(
        sov.stream({
          model: MODEL,
          system: [],
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'What is 2+2? Answer in one short sentence.' }],
            },
          ],
          maxTokens: 600,
        }),
      );

      // Reasoning streamed on the thinking channel...
      expect(yielded.some((e) => e.type === 'thinking_delta')).toBe(true);
      // ...and landed in a thinking block, with the answer in a separate text block.
      const thinking = find(returned.content, 'thinking');
      const text = find(returned.content, 'text');
      expect(thinking?.thinking.length ?? 0).toBeGreaterThan(0);
      expect(text?.text.length ?? 0).toBeGreaterThan(0);
      // The reasoning did NOT contaminate the answer text.
      expect(text?.text ?? '').not.toContain('<think>');
    },
    120_000,
  );

  live(
    'a tool call carries the engine `call_` id and parsed arguments',
    async () => {
      const sov = makeSov();
      const { returned } = await drain(
        sov.stream({
          model: MODEL,
          system: [],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is the weather in Paris right now? Call the tool.' },
              ],
            },
          ],
          tools: [
            {
              name: 'get_weather',
              description: 'Get the current weather for a location',
              input_schema: {
                type: 'object',
                properties: { location: { type: 'string' } },
                required: ['location'],
              },
            },
          ],
          toolChoice: { type: 'auto' },
          maxTokens: 256,
        }),
      );

      const toolUse = find(returned.content, 'tool_use');
      expect(toolUse).toBeDefined();
      // The engine assigns ids of the form `call_<hex>` — they must survive to the block.
      expect(toolUse?.id).toMatch(/^call_/);
      expect(toolUse?.name).toBe('get_weather');
      expect(toolUse?.input).toHaveProperty('location');
    },
    120_000,
  );
});
