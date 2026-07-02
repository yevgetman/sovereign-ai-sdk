// src/mission/segments.ts
// Prompt segment builders for scheduled-mission system prompt injection (Phase 13.5).

import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';
import type { MissionFiles, WakeLogEntry } from './types.js';

export type BuildMissionSegmentsOpts = {
  cacheEnabled?: boolean;
};

export function buildMissionSegments(
  files: MissionFiles,
  opts: BuildMissionSegmentsOpts,
): SystemSegment[] {
  const cache = opts.cacheEnabled !== false;
  const segments: SystemSegment[] = [];

  // Cacheable: mission goal (mission.md content)
  segments.push({
    text: `<mission-goal>\n${files.mission.trim()}\n</mission-goal>`,
    cacheable: cache,
  });

  // Cacheable: plan (plan.md content) — omitted if empty
  if (files.plan.trim()) {
    segments.push({
      text: `<mission-plan>\n${files.plan.trim()}\n</mission-plan>`,
      cacheable: cache,
    });
  }

  // Cacheable: FSM state + turn budget
  segments.push({
    text: formatMissionState(files.state),
    cacheable: cache,
  });

  // Ephemeral: notes from last wake (notes.md content)
  if (files.notes.trim()) {
    segments.push({
      text: `<mission-notes>\n${files.notes.trim()}\n</mission-notes>`,
      cacheable: false,
    });
  }

  // Ephemeral: recent wake history
  if (files.recentWakeLog.length > 0) {
    segments.push({
      text: formatWakeLogTail(files.recentWakeLog),
      cacheable: false,
    });
  }

  return segments;
}

function formatMissionState(state: MissionFiles['state']): string {
  return [
    '<mission-state>',
    `fsm-state: ${state.fsmState}`,
    `wake-count: ${state.wakeCount}`,
    `per-wake-turn-budget: ${state.perWakeTurnBudget}`,
    `goal: ${state.goal}`,
    '</mission-state>',
  ].join('\n');
}

function formatWakeLogTail(entries: WakeLogEntry[]): string {
  const lines = entries.map(
    (e) =>
      `  wake ${e.wakeNumber} (${e.timestamp}): ${e.fsmStateBefore} → ${e.fsmStateAfter}${e.sentinel ? ` [${e.sentinel}]` : ''} ${e.durationMs}ms`,
  );
  return ['<wake-log-tail>', ...lines, '</wake-log-tail>'].join('\n');
}
