// src/learning-layer/index.ts — the layer factory: wires Recall over the Persist port (Observe is a Phase 1 no-op) and returns a LearningLayer.

import type { LearningHostDeps, LearningLayer } from './ports.js';
import { assembleLessons } from './recall/assemble.js';
import { formatRecallSnapshot } from './recall/format.js';
import { readInstincts } from './recall/readInstincts.js';

/** Construct a LearningLayer from host-provided dependencies (Reason + Persist).
 *  Phase 1 implements Recall only; the Observe ports are intentional no-ops. */
export function createLearningLayer(deps: LearningHostDeps): LearningLayer {
  return {
    async recall(ctx) {
      try {
        // Phase E T6 — userId rides the per-turn RecallContext (the layer is a
        // shared singleton; never store userId on it). Scopes the corpus read
        // to the owning principal; undefined reads the legacy top-level corpus.
        const instincts = await readInstincts(deps.persist, ctx.projectId, ctx.userId);
        const lessons = assembleLessons({
          instincts,
          latestUserText: ctx.latestUserText,
          maxLessons: ctx.maxLessons,
          tokenBudget: ctx.tokenBudget,
        });
        return { injectionText: formatRecallSnapshot(lessons), lessons };
      } catch {
        // fail-open: recall must never break the host turn — any error yields an empty result
        return { injectionText: '', lessons: [] };
      }
    },

    async observeSession(_session) {
      // Phase 1 no-op: existing capture hooks remain authoritative this phase (design decision D1);
      // Observe rebinding is deferred to Phase 2 to avoid double-writing the corpus.
    },

    observeToolEvent(_event) {
      // Phase 1 no-op: existing capture hooks remain authoritative this phase (design decision D1);
      // Observe rebinding is deferred to Phase 2 to avoid double-writing the corpus.
    },
  };
}
