// Anthropic API judge — direct call via @anthropic-ai/sdk. Costs API tokens.
// Useful when claude CLI isn't installed (CI runners, containers) or when
// you want deterministic tokens-and-dollars accounting per run. Opt-in via
// `--judge api`; the default backend is claude-code (subscription-based).

import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { Judge } from '../types.js';
import { VERDICT_SCHEMA, buildJudgePrompt, makeVerdict } from './prompt.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Per-million-token USD rates. Hardcoded so the judge stays independent
// from the harness pricing module. Update when Anthropic prices change.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
};

const VERDICT_TOOL: Tool = {
  name: 'submit_verdict',
  description: 'Record your judgement on whether the harness session passes the test.',
  input_schema: VERDICT_SCHEMA as Tool['input_schema'],
};

export interface AnthropicApiJudgeOptions {
  apiKey: string;
  /** Anthropic model id. Default: claude-haiku-4-5-20251001. */
  model?: string;
}

export function createAnthropicApiJudge(opts: AnthropicApiJudgeOptions): Judge {
  const model = opts.model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: opts.apiKey });

  return async (test, transcript) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_verdict' },
      messages: [{ role: 'user', content: buildJudgePrompt(test, transcript) }],
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(
        `judge model ${model} did not invoke submit_verdict (stop_reason=${response.stop_reason})`,
      );
    }

    const input = toolUse.input as {
      pass: boolean;
      reasoning: string;
      satisfiedCriteria: string[];
      failedCriteria: string[];
    };

    const tokens = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    };
    const price = PRICING[model] ?? PRICING[DEFAULT_MODEL] ?? { input: 1, output: 5 };
    const costUsd = (tokens.input * price.input + tokens.output * price.output) / 1_000_000;

    return makeVerdict(input, { costUsd, tokens, backend: 'anthropic-api' });
  };
}
