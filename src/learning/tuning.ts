// src/learning/tuning.ts
// Backlog Item 6 — bridge between settings.learning.* and the pure
// ConfidenceTuning interface in confidence.ts. Kept separate so
// confidence.ts remains I/O-free (loadSettings reads disk).

import { loadSettings } from '../config/loader.js';
import type { ConfidenceTuning } from './confidence.js';

/** Build a ConfidenceTuning from settings.learning.* — only includes
 *  keys that are explicitly set so reinforce/contradict fall back to
 *  module defaults for unset knobs. */
export function loadConfidenceTuning(): ConfidenceTuning {
  const settings = loadSettings();
  const learning = settings.learning;
  if (!learning) return {};
  const tuning: ConfidenceTuning = {};
  if (learning.reinforcementCurveK !== undefined) {
    tuning.reinforcementCurveK = learning.reinforcementCurveK;
  }
  if (learning.contradictionDelta !== undefined) {
    tuning.contradictionDelta = learning.contradictionDelta;
  }
  if (learning.confidenceCap !== undefined) {
    tuning.confidenceCap = learning.confidenceCap;
  }
  if (learning.initialConfidenceBaseline !== undefined) {
    tuning.initialConfidenceBaseline = learning.initialConfidenceBaseline;
  }
  return tuning;
}
