// Shared judge-prompt construction and verdict parsing. Backends differ in
// HOW they call out to the LLM; the prompt and the verdict shape are the
// same across all of them. Splitting this out keeps backend implementations
// tiny and makes it obvious how to add a new backend.

import type { JudgeVerdict, SemanticTest } from '../types.js';

const MAX_TRANSCRIPT_CHARS = 60_000;

/** JSON schema for the verdict — used by backends that support structured output.
 *  Typed as a plain object (not `as const`) so the Anthropic SDK's mutable
 *  `Tool.input_schema` accepts it without a cast. */
export const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pass: {
      type: 'boolean',
      description:
        'True iff every must-satisfy (M*) criterion holds AND no should-not (S*) criterion is violated.',
    },
    reasoning: {
      type: 'string',
      description:
        'Concise explanation (2-4 sentences) citing specific transcript evidence for the verdict.',
    },
    satisfiedCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'Labels (e.g., "M1", "S2") of criteria the transcript clearly demonstrates.',
    },
    failedCriteria: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Labels (e.g., "M3") of criteria that were missed (M-criteria) or violated (S-criteria).',
    },
  },
  required: ['pass', 'reasoning', 'satisfiedCriteria', 'failedCriteria'],
};

export function buildJudgePrompt(test: SemanticTest, transcript: string): string {
  const must = test.judgeCriteria.mustSatisfy;
  const shouldNot = test.judgeCriteria.shouldNot ?? [];

  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? `[transcript truncated to last ${MAX_TRANSCRIPT_CHARS} chars]\n${transcript.slice(
          -MAX_TRANSCRIPT_CHARS,
        )}`
      : transcript;

  const lines: string[] = [];
  lines.push('You are a strict test judge for an AI agent harness. Read the transcript');
  lines.push('of one harness session and decide whether the agent behaved correctly.');
  lines.push('');
  lines.push('# Test');
  lines.push(`Name: ${test.name}`);
  lines.push(`Goal: ${test.description}`);
  if (Array.isArray(test.prompt)) {
    lines.push('User prompts (multi-turn — each is a separate turn the agent answered in order):');
    test.prompt.forEach((p, i) => {
      lines.push(`  Turn ${i + 1}: ${JSON.stringify(p)}`);
    });
  } else {
    lines.push(`User prompt sent to the agent: ${JSON.stringify(test.prompt)}`);
  }
  lines.push('');
  lines.push('# Must-satisfy criteria (all required for pass)');
  must.forEach((c, i) => lines.push(`M${i + 1}. ${c}`));
  if (shouldNot.length) {
    lines.push('');
    lines.push('# Should-not criteria (any violation forces fail)');
    shouldNot.forEach((c, i) => lines.push(`S${i + 1}. ${c}`));
  }
  lines.push('');
  lines.push('# Transcript');
  lines.push('```');
  lines.push(truncated);
  lines.push('```');
  lines.push('');
  lines.push('Respond with ONLY a JSON object in exactly this shape — no prose, no markdown:');
  lines.push('{');
  lines.push('  "pass": <boolean>,');
  lines.push('  "reasoning": "<2-4 sentences citing transcript evidence>",');
  lines.push('  "satisfiedCriteria": ["M1", ...],');
  lines.push('  "failedCriteria": ["M2", ...]');
  lines.push('}');
  lines.push('');
  lines.push('Be strict: when the transcript does not clearly demonstrate a must-satisfy');
  lines.push('criterion, treat it as failed. The verdict passes only if all M criteria hold');
  lines.push('and no S criterion is violated.');
  return lines.join('\n');
}

/** Shape of the verdict body before backend-specific fields (cost, tokens, backend) are added. */
export interface VerdictCore {
  pass: boolean;
  reasoning: string;
  satisfiedCriteria: string[];
  failedCriteria: string[];
}

/** Parse a verdict from a raw judge response. Tolerant of:
 *   - the raw JSON object (text/structured output)
 *   - a {"result":"<json>",...} envelope (claude --output-format json wrapping)
 *   - JSON wrapped in ```json fences
 *   - JSON with leading/trailing prose
 *  Throws if no JSON shaped like a VerdictCore can be extracted.
 */
export function parseVerdictFromText(raw: string): VerdictCore {
  const candidates: unknown[] = [];

  const trimmed = raw.trim();
  pushIfJson(candidates, trimmed);

  // Strip common markdown fence wrappers.
  const fence = trimmed.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  if (fence !== trimmed) pushIfJson(candidates, fence);

  // Last resort: find the first {...} block via a non-greedy regex.
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) pushIfJson(candidates, match[0]);

  for (const cand of candidates) {
    const verdict = extractVerdict(cand);
    if (verdict) return verdict;
  }

  throw new Error(
    `judge response was not a valid VerdictCore JSON object:\n${trimmed.slice(0, 800)}`,
  );
}

function pushIfJson(out: unknown[], s: string): void {
  try {
    out.push(JSON.parse(s));
  } catch {
    // ignore — caller has fallbacks.
  }
}

function extractVerdict(value: unknown): VerdictCore | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  // Unwrap claude --output-format json envelope: { type, subtype, result: "<json>", ... }.
  // The result may be raw JSON, fenced JSON, or JSON embedded in prose.
  if (typeof v.result === 'string') {
    for (const candidate of stringCandidates(v.result)) {
      try {
        const inner = JSON.parse(candidate);
        const unwrapped = extractVerdict(inner);
        if (unwrapped) return unwrapped;
      } catch {
        // try next candidate
      }
    }
  }
  if (typeof v.result === 'object' && v.result !== null) {
    const unwrapped = extractVerdict(v.result);
    if (unwrapped) return unwrapped;
  }
  // Also accept claude's `structured_output` field when --json-schema is in use.
  if (typeof v.structured_output === 'object' && v.structured_output !== null) {
    const unwrapped = extractVerdict(v.structured_output);
    if (unwrapped) return unwrapped;
  }

  if (
    typeof v.pass === 'boolean' &&
    typeof v.reasoning === 'string' &&
    Array.isArray(v.satisfiedCriteria) &&
    Array.isArray(v.failedCriteria)
  ) {
    return {
      pass: v.pass,
      reasoning: v.reasoning,
      satisfiedCriteria: v.satisfiedCriteria.map(String),
      failedCriteria: v.failedCriteria.map(String),
    };
  }
  return null;
}

function stringCandidates(s: string): string[] {
  const candidates = [s];
  const fence = s.replace(/^\s*```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  if (fence !== s) candidates.push(fence);
  const match = s.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);
  return candidates;
}

/** Minimal common verdict factory used by all backends. */
export function makeVerdict(
  core: VerdictCore,
  extras: Pick<JudgeVerdict, 'costUsd' | 'tokens' | 'backend'>,
): JudgeVerdict {
  return { ...core, ...extras };
}
