// System prompt assembly. Phase 1: base instructions + bundle's CONTEXT.md
// merged into one cacheable segment (Invariant #4 — frozen per session).
// Memory files (preferences, decisions-made, session-log tail) come through
// as a separate static segment so they stay stable across turns. Phase 6
// will split these into multiple cache boundaries with per-segment markers.
//
// Source of pattern: Claude Code src/QueryEngine.ts + src/context.ts.

import type { Bundle } from '../bundle/types.js';
import type { SystemSegment } from './types.js';

const BASE_INSTRUCTIONS = `\
You are the canonical AI entity of the business described in the harness bundle
you have been given. The bundle's CONTEXT.md, memory files, and index are below.
Speak in first person where natural ("our plan", "our tech stack") rather than
detached review language. Consult specific business/ or harness/ docs on demand
when the user's request requires depth beyond the context already provided.
`.trim();

/**
 * Assemble the system prompt for a session. Called once at session start.
 * The returned segments are stored verbatim (Invariant #4) and reused on
 * every continuation — any dynamic content must flow as user messages.
 *
 * Phase 1 shape: two segments both marked cacheable. Phase 6 will split
 * into a richer hierarchy (tool descriptions, ephemeral marker, system
 * context, user context).
 */
export function buildSystemSegments(bundle?: Bundle): SystemSegment[] {
  const segments: SystemSegment[] = [{ text: BASE_INSTRUCTIONS, cacheable: true }];
  if (!bundle) return segments;

  const contextText = bundle.state.context?.trim();
  if (contextText) {
    segments.push({
      text: `<bundle-context>\n${contextText}\n</bundle-context>`,
      cacheable: true,
    });
  }

  const memoryChunks: string[] = [];
  if (bundle.state.preferences?.trim()) {
    memoryChunks.push(
      `<bundle-preferences>\n${bundle.state.preferences.trim()}\n</bundle-preferences>`,
    );
  }
  if (bundle.state.decisionsMade?.trim()) {
    memoryChunks.push(
      `<bundle-decisions>\n${bundle.state.decisionsMade.trim()}\n</bundle-decisions>`,
    );
  }
  if (memoryChunks.length > 0) {
    segments.push({ text: memoryChunks.join('\n\n'), cacheable: true });
  }

  return segments;
}
