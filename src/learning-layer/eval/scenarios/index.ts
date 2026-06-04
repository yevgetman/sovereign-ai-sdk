// src/learning-layer/eval/scenarios/index.ts — curated + real-synthesis scenarios for the learning eval.
import type { Instinct } from '../../../learning/types.js';

export interface LearningScenario {
  readonly name: string;
  /** Files written into the sandbox cwd before the run (relative path -> contents). */
  readonly sandbox: Readonly<Record<string, string>>;
  /** Instincts seeded into the corpus (Track A). Empty for Track B (real synthesis). */
  readonly seedInstincts: readonly { readonly instinct: Instinct; readonly body: string }[];
  /** The dependent task run in the (N+1) session. */
  readonly task: string;
  /** Judge criteria deciding pass/fail of the task outcome. */
  readonly mustSatisfy: readonly string[];
  readonly shouldNot?: readonly string[];
  readonly track: 'A' | 'B';
}

export const scenarios: LearningScenario[] = []; // populated in the next tasks
