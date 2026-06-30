// Contract #2 — the SSE event union, as PURE TypeScript types.
//
// This module is OPEN (boundary-manifest.json → openFullyDirs) and imports
// NOTHING: no zod, no runtime deps, no proprietary code. It is the canonical
// wire shape the gateway emits on `GET /sessions/:id/events`. The gateway keeps
// its zod schemas (src/server/schema.ts + src/router/progressEvents.ts) for
// runtime validation; a type-level conformance assertion on the proprietary/test
// side (tests/protocol/conformance.test.ts) proves `z.infer<ServerEventSchema>`
// is identical to `ServerEvent` here, so the two CANNOT drift. In Phase 8 this
// becomes the `@yevgetman/sov-protocol` package that the Go TUI + resume-as-code
// adopt, collapsing today's three hand-copies.
//
// Field-fidelity notes (these mirror zod v3's `z.infer` exactly, which the
// conformance guard enforces):
//   - `z.unknown()` keys infer as OPTIONAL (`?: unknown`) even when the schema
//     marks them required — so `input`, `output`, `inputPartial` are `?: unknown`.
//   - `.optional()` scalars infer as `?: T | undefined` (exactOptionalPropertyTypes).
//   - `z.record(z.string(), z.number())` infers as `Record<string, number>`.

/** Common envelope every server event carries: a monotonic sequence number
 *  (the SSE `id:` line / Last-Event-ID cursor) and the owning session id. */
export interface ServerEventBase {
  seq: number;
  sessionId: string;
}

export interface TextDeltaEvent extends ServerEventBase {
  type: 'text_delta';
  block: number;
  text: string;
}

export interface ThinkingDeltaEvent extends ServerEventBase {
  type: 'thinking_delta';
  block: number;
  text: string;
}

export interface ToolUseStartEvent extends ServerEventBase {
  type: 'tool_use_start';
  block: number;
  tool: string;
  inputPartial?: unknown;
}

export interface ToolUseInputDeltaEvent extends ServerEventBase {
  type: 'tool_use_input_delta';
  block: number;
  delta: string;
}

export interface ToolUseDoneEvent extends ServerEventBase {
  type: 'tool_use_done';
  block: number;
  input?: unknown;
}

export interface ToolResultEvent extends ServerEventBase {
  type: 'tool_result';
  block: number;
  tool: string;
  input?: unknown;
  output?: unknown;
  renderHint: string;
  language?: string | undefined;
}

export interface PermissionRequestEvent extends ServerEventBase {
  type: 'permission_request';
  requestId: string;
  tool: string;
  input?: unknown;
  reason?: string | undefined;
}

export interface StatusUpdateEvent extends ServerEventBase {
  type: 'status_update';
  cost?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  cacheHitRate?: number | undefined;
  streaming?: boolean | undefined;
}

export interface TurnCompleteEvent extends ServerEventBase {
  type: 'turn_complete';
  finishReason: string;
  usage?:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | undefined;
        cache_read_input_tokens?: number | undefined;
      }
    | undefined;
}

export interface TurnErrorEvent extends ServerEventBase {
  type: 'turn_error';
  error: string;
  recoverable: boolean;
}

export interface SessionResumedEvent extends ServerEventBase {
  type: 'session_resumed';
  resumedFromSeq: number;
}

/** Proactive / overflow-recovery compaction. `sessionId` is the PARENT (the id
 *  the SSE subscriber connected to); `activeSessionId` is the new child id the
 *  client must pivot subsequent POSTs (turns, approvals) onto. */
export interface CompactionCompleteEvent extends ServerEventBase {
  type: 'compaction_complete';
  activeSessionId: string;
  summary: string;
  estimatedBeforeTokens: number;
  estimatedAfterTokens: number;
}

export interface SessionSummaryEvent extends ServerEventBase {
  type: 'session_summary';
  totalDispatched: number;
  byAgent: Record<string, number>;
  tokens?:
    | {
        input: number;
        output: number;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
        estimatedCostUsd: number;
      }
    | undefined;
  startedAtMs?: number | undefined;
  endedAtMs?: number | undefined;
  agentActiveMs?: number | undefined;
  apiTimeMs?: number | undefined;
  toolTimeMs?: number | undefined;
  toolCalls?: number | undefined;
  toolOk?: number | undefined;
  toolErr?: number | undefined;
}

export interface StallDetectedEvent extends ServerEventBase {
  type: 'stall_detected';
  reason: string;
  turn: number;
}

// --- Delegator events (Phase 2 T4) ------------------------------------------
// Authored here as pure types. The proprietary runtime (src/router/progressEvents.ts)
// synthesizes these from the scheduler's delegation lifecycle; their zod schemas
// live there and are conformance-guarded against these types.

export interface DelegatorPlanEvent extends ServerEventBase {
  type: 'delegator_plan';
  scheduledAtomCount?: number | undefined;
}

export interface DelegatorAtomStartedEvent extends ServerEventBase {
  type: 'delegator_atom_started';
  atomIndex: number;
  laneName: string;
  promptPreview: string;
  laneProvider?: string | undefined;
  laneModel?: string | undefined;
}

export interface DelegatorAtomCompleteEvent extends ServerEventBase {
  type: 'delegator_atom_complete';
  atomIndex: number;
  laneName: string;
  success: boolean;
  durationMs: number;
  laneProvider?: string | undefined;
  laneModel?: string | undefined;
}

export interface DelegatorCompleteEvent extends ServerEventBase {
  type: 'delegator_complete';
  totalAtomCount: number;
  laneDistribution: Record<string, number>;
}

/** The discriminated union (on `type`) of every event the gateway may emit on
 *  `GET /sessions/:id/events`. Identical to `z.infer<typeof ServerEventSchema>`
 *  — enforced by the conformance guard. */
export type ServerEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolUseStartEvent
  | ToolUseInputDeltaEvent
  | ToolUseDoneEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | StatusUpdateEvent
  | TurnCompleteEvent
  | TurnErrorEvent
  | SessionResumedEvent
  | CompactionCompleteEvent
  | SessionSummaryEvent
  | StallDetectedEvent
  | DelegatorPlanEvent
  | DelegatorAtomStartedEvent
  | DelegatorAtomCompleteEvent
  | DelegatorCompleteEvent;

/** The discriminant literal of every `ServerEvent` variant. */
export type ServerEventType = ServerEvent['type'];
