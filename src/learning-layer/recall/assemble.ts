// src/learning-layer/recall/assemble.ts — PURE, deterministic Recall assembly: tokenize the latest user text, score instincts by trigger-token overlap, rank, trim to maxLessons, and greedily fit a token budget (no model call).

import type { Instinct } from '../../learning/types.js';
import type { RecalledLesson } from '../ports.js';

export interface AssembleInput {
  readonly instincts: readonly Instinct[];
  readonly latestUserText: string | undefined;
  readonly maxLessons: number;
  readonly tokenBudget: number;
  /** Drop instincts whose relevance is <= this (default 0 — any overlap survives). */
  readonly relevanceFloor?: number;
}

/** Average chars per token — mirrors src/context/budget.ts's 4-chars/token heuristic. */
const CHARS_PER_TOKEN = 4;

/** Split text into lowercased word tokens, dropping empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

/** Estimated token cost of a single lesson's injected text.
 *  Matches the rendered line format in format.ts (`- when … → …`).
 *  The fixed PREAMBLE + <learned-context> fence wrapper is a small constant
 *  intentionally NOT counted here, so this is a conservative lower bound. */
function estimateLessonTokens(instinct: Instinct): number {
  const text = `- when ${instinct.trigger} → ${instinct.action}`;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type ScoredInstinct = { readonly instinct: Instinct; readonly relevance: number };

/**
 * Assemble the most relevant instincts for the upcoming turn as RecalledLessons.
 *
 * Deterministic and side-effect-free: no model call, no mutation. Relevance is
 * the fraction of an instinct's trigger tokens present in the user-text token
 * set. Survivors are ranked by (relevance desc, confidence desc, id asc), trimmed
 * to `maxLessons`, then greedily packed until the next lesson would exceed
 * `tokenBudget` (stop on the first overflow for a stable, predictable result).
 */
export function assembleLessons(input: AssembleInput): RecalledLesson[] {
  const { instincts, latestUserText, maxLessons, tokenBudget } = input;
  const relevanceFloor = input.relevanceFloor ?? 0;

  if (latestUserText === undefined || latestUserText.trim().length === 0) return [];

  const userTokens = new Set(tokenize(latestUserText));
  if (userTokens.size === 0) return [];

  const scored: ScoredInstinct[] = instincts
    .map((instinct): ScoredInstinct => {
      const triggerTokens = tokenize(instinct.trigger);
      if (triggerTokens.length === 0) return { instinct, relevance: 0 };
      const matches = triggerTokens.filter((token) => userTokens.has(token)).length;
      return { instinct, relevance: matches / triggerTokens.length };
    })
    .filter((entry) => entry.relevance > relevanceFloor);

  const ranked = [...scored].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (b.instinct.confidence !== a.instinct.confidence) {
      return b.instinct.confidence - a.instinct.confidence;
    }
    return a.instinct.id < b.instinct.id ? -1 : a.instinct.id > b.instinct.id ? 1 : 0;
  });

  const lessons: RecalledLesson[] = [];
  let usedTokens = 0;
  for (const { instinct } of ranked.slice(0, maxLessons)) {
    const cost = estimateLessonTokens(instinct);
    if (usedTokens + cost > tokenBudget) break;
    usedTokens += cost;
    lessons.push({
      id: instinct.id,
      trigger: instinct.trigger,
      action: instinct.action,
      confidence: instinct.confidence,
    });
  }
  return lessons;
}
