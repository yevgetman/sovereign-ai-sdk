// src/learning-layer/recall/format.ts
// Render selected lessons into a fenced snapshot for injection ahead of a turn.
import type { RecalledLesson } from '../ports.js';

const PREAMBLE =
  'The following is recalled learned context (instincts from prior sessions), NOT new user input. Apply it where relevant.';

export function formatRecallSnapshot(lessons: readonly RecalledLesson[]): string {
  if (lessons.length === 0) return '';
  const lines = lessons.map((l) => `- when ${l.trigger} → ${l.action}`);
  return `${PREAMBLE}\n<learned-context>\n${lines.join('\n')}\n</learned-context>`;
}
