// Phase 10.5 — `sov trace show <session-id>` reads the JSONL trace file
// for a session and renders the high-signal path: header (provider/model/cwd
// /bundle), per-turn breakdown (provider request/response, tool calls,
// permissions, microcompact), and the terminal session_end reason.
//
// Pure formatter (`formatTrace`) + IO wrapper (`showTrace`) for testability.

import { readFileSync } from 'node:fs';
import type { TraceEvent } from '../trace/types.js';
import { findTracePath } from '../trace/writer.js';

export type ShowTraceOpts = {
  sessionId: string;
  /** Override the harness home root used to locate the trace file. */
  harnessHome?: string;
};

export type ShowTraceResult =
  | { ok: true; output: string; eventCount: number }
  | { ok: false; error: string };

export function showTrace(opts: ShowTraceOpts): ShowTraceResult {
  const path = findTracePath(opts.sessionId, opts.harnessHome);
  if (!path) {
    return {
      ok: false,
      error: `no trace file found for session '${opts.sessionId}'`,
    };
  }
  let events: TraceEvent[];
  try {
    events = parseTraceFile(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read trace file ${path}: ${msg}` };
  }
  return { ok: true, output: formatTrace(events), eventCount: events.length };
}

/** Parse JSONL into TraceEvent[]; malformed lines are skipped (not fatal —
 *  the writer is best-effort, and partial lines from a crash mid-write
 *  shouldn't break the viewer). */
export function parseTraceFile(content: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // Malformed line — skip silently.
    }
  }
  return events;
}

/** Pure renderer. Groups events by turn (using turn_start as the boundary
 *  marker) and emits a tabular human-readable summary. */
export function formatTrace(events: TraceEvent[]): string {
  const lines: string[] = [];
  const sessionStart = events.find((e) => e.type === 'session_start');
  if (sessionStart && sessionStart.type === 'session_start') {
    lines.push(`═══ session ${sessionStart.sessionId} ═══`);
    const bundleSuffix = sessionStart.bundlePath ? ` | bundle: ${sessionStart.bundlePath}` : '';
    lines.push(`provider: ${sessionStart.provider} | model: ${sessionStart.model}${bundleSuffix}`);
    lines.push(`cwd: ${sessionStart.cwd}`);
    lines.push(`started: ${sessionStart.iso}`);
    lines.push('');
  }

  // Group post-session_start events by turn. Events between turn_start and
  // the next turn_start (or session_end) belong to that turn.
  const groups: { turnIndex: number | null; events: TraceEvent[] }[] = [];
  let currentTurn: number | null = null;
  let currentBucket: TraceEvent[] = [];
  for (const event of events) {
    if (event.type === 'session_start') continue;
    if (event.type === 'turn_start') {
      if (currentBucket.length > 0 || currentTurn !== null) {
        groups.push({ turnIndex: currentTurn, events: currentBucket });
      }
      currentTurn = event.turn;
      currentBucket = [];
      continue;
    }
    currentBucket.push(event);
  }
  if (currentBucket.length > 0 || currentTurn !== null) {
    groups.push({ turnIndex: currentTurn, events: currentBucket });
  }

  for (const group of groups) {
    if (group.turnIndex === null) {
      // Pre-turn events (rare). Render header-less.
      for (const event of group.events) {
        const rendered = renderEvent(event);
        if (rendered) lines.push(rendered);
      }
      continue;
    }
    lines.push(`Turn ${group.turnIndex}`);
    for (const event of group.events) {
      const rendered = renderEvent(event);
      if (rendered) lines.push(`  ${rendered}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderEvent(event: TraceEvent): string | null {
  switch (event.type) {
    case 'provider_request':
      return `→ request (${event.purpose}, ${event.messageCount} msg, ${event.systemBytes} sys bytes)`;
    case 'provider_response': {
      const usage = formatUsage(event.usage);
      const ttft = event.ttftMs !== undefined ? `, ttft ${event.ttftMs}ms` : '';
      return `← response: ${event.stopReason} (${event.latencyMs}ms${ttft}; ${usage})`;
    }
    case 'permission_check': {
      const reason = event.reason ? ` (${event.reason})` : '';
      const transformed = event.transformed ? ' [input-transformed]' : '';
      return `permission ${event.tool}: ${event.decision}${reason}${transformed}`;
    }
    case 'tool_start':
      return `${event.tool}#${event.toolUseId}: start`;
    case 'tool_end':
      return `${event.tool}#${event.toolUseId}: ok (${event.durationMs}ms, ${event.outputBytes} bytes)`;
    case 'tool_error':
      return `${event.tool}#${event.toolUseId}: ERROR (${event.durationMs}ms) — ${event.message}`;
    case 'microcompact':
      return `microcompact: cleared ${event.cleared} stale results (~${event.estimatedTokensSaved} tokens saved, ${event.keptRecent} kept recent)`;
    case 'compaction_start':
      return `compaction_start (parent=${event.parentSessionId})`;
    case 'compaction_end':
      return `compaction_end (parent=${event.parentSessionId} → child=${event.childSessionId}, ~${event.tokensSaved} tokens saved)`;
    case 'memory_write':
      return `memory_write: ${event.path} (${event.bytes} bytes)`;
    case 'skill_write':
      return `skill_write: ${event.name} → ${event.path}`;
    case 'interrupt':
      return `interrupt at ${event.stage}`;
    case 'loop_detected':
      return `loop_detected (${event.detector}, ${event.repetitionCount}x; hash=${event.hash.slice(0, 12)}…)`;
    case 'session_end':
      return `session_end: ${event.reason}`;
    case 'session_start':
    case 'turn_start':
      return null;
    default: {
      // Future event types: render the raw JSON line so the viewer doesn't
      // silently drop them.
      return `[unknown] ${JSON.stringify(event)}`;
    }
  }
}

function formatUsage(usage: import('../core/types.js').TokenUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  if (usage.cacheReadInputTokens !== undefined) {
    parts.push(`cache_r ${usage.cacheReadInputTokens}`);
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    parts.push(`cache_w ${usage.cacheCreationInputTokens}`);
  }
  return parts.length > 0 ? parts.join(' / ') : 'no usage';
}
