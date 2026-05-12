// String-match judge — purely deterministic substring assertion over the
// captured transcript. Intended for headless slash-command tests where the
// expected output is a literal string (no LLM judgment required). Each
// entry in `mustSatisfy` is treated as a literal substring that must appear
// in the transcript; each entry in `shouldNot` is a literal substring that
// must NOT appear. No model is invoked — cost is always zero.
//
// This judge is selected via `--judge string-match`. The other backends
// (claude-code, anthropic-api) remain available for natural-language criteria.

import type { Judge, JudgeVerdict, SemanticTest } from '../types.js';

export function createStringMatchJudge(): Judge {
  return async (test: SemanticTest, transcript: string): Promise<JudgeVerdict> => {
    const must = test.judgeCriteria.mustSatisfy ?? [];
    const shouldNot = test.judgeCriteria.shouldNot ?? [];
    const satisfied: string[] = [];
    const failed: string[] = [];
    const reasoning: string[] = [];

    for (const needle of must) {
      if (transcript.includes(needle)) {
        satisfied.push(needle);
      } else {
        failed.push(needle);
        reasoning.push(`missing required substring: ${JSON.stringify(needle)}`);
      }
    }

    for (const forbidden of shouldNot) {
      if (transcript.includes(forbidden)) {
        failed.push(`shouldNot: ${forbidden}`);
        reasoning.push(`found forbidden substring: ${JSON.stringify(forbidden)}`);
      } else {
        satisfied.push(`shouldNot: ${forbidden}`);
      }
    }

    return {
      pass: failed.length === 0,
      reasoning:
        reasoning.length === 0 ? 'all literal-substring criteria satisfied' : reasoning.join('; '),
      satisfiedCriteria: satisfied,
      failedCriteria: failed,
      costUsd: 0,
      tokens: { input: 0, output: 0 },
      backend: 'string-match',
    };
  };
}
