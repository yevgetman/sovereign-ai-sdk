// whenToUse — rigor heuristic for skill activation triggers (Phase 9.6).
// `whenToUse` is a free-form string in the skill schema, but the model uses
// it as a predicate: "does this skill apply to the current user prompt?".
// Sentences that describe the skill's *purpose* read as soft signals; trigger
// predicates ("when the user mentions X", "when a Bash command would do Y")
// read as if-then rules. The latter activates more reliably.
//
// This validator is a load-time *warning*, not a block. The user controls
// their bundle's quality bar; we only surface a one-line nudge so that
// authors can tighten triggers as they notice them. ECC's
// continuous-learning-v2 / agent-harness-construction prescribes this style;
// see ../../docs/extending.md and the build plan §"Phase 9.6".

const LOW_RIGOR_PREAMBLES = [
  'use this skill',
  'activate this skill',
  'call this when',
  'call this skill',
  'run when',
  'when to use',
  'when this skill',
  'this skill should be used',
  'invoke this',
] as const;

const TRIGGER_VERBS = [
  'asks',
  'requests',
  'says',
  'mentions',
  'wants',
  'needs',
  'runs',
  'edits',
  'opens',
  'writes',
  'reads',
  'invokes',
  'attempts',
  'tries',
  'pastes',
  'sends',
  'commits',
  'pushes',
  'merges',
  'deploys',
  'installs',
  'configures',
] as const;

const MIN_LENGTH = 8;

export type WhenToUseValidation = { ok: true } | { ok: false; reason: string };

/** Heuristic check: does `whenToUse` read as a trigger predicate or as
 *  a description? Returns `{ok: true}` for plausible triggers; otherwise
 *  returns a short `reason` suitable for a one-line warning. */
export function validateWhenToUse(value: string): WhenToUseValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty whenToUse field' };
  }
  if (trimmed.length < MIN_LENGTH) {
    return {
      ok: false,
      reason: `whenToUse is too short to act as a trigger (${trimmed.length} chars)`,
    };
  }
  const lower = trimmed.toLowerCase();
  for (const preamble of LOW_RIGOR_PREAMBLES) {
    if (lower.startsWith(preamble)) {
      return {
        ok: false,
        reason: `whenToUse opens with descriptive preamble "${preamble}…" — prefer predicate language ("when the user X")`,
      };
    }
  }
  if (!TRIGGER_VERBS.some((verb) => containsTriggerVerb(lower, verb))) {
    return {
      ok: false,
      reason:
        'whenToUse lacks a trigger verb (asks, mentions, runs, edits, …) — describe what the user does, not what the skill does',
    };
  }
  return { ok: true };
}

/** Split a multi-trigger whenToUse on `;` into discrete predicates. Single
 *  triggers return a one-element array. Used by the skills index renderer
 *  so the model sees discrete predicates rather than one long sentence. */
export function splitWhenToUseTriggers(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function containsTriggerVerb(text: string, verb: string): boolean {
  const re = new RegExp(`\\b${verb}\\b`, 'i');
  return re.test(text);
}
