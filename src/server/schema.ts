// SSE event schemas + types for the Phase 16.1 HTTP server.
// Single source of truth for what the server may emit on /sessions/:id/events.
// The Go TUI mirrors these shapes in packages/tui/internal/transport/types.go.

import { z } from 'zod';
import {
  DelegatorAtomCompleteEventSchema,
  DelegatorAtomStartedEventSchema,
  DelegatorCompleteEventSchema,
  DelegatorPlanEventSchema,
} from '../router/progressEvents.js';

const BaseEvent = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
});

export const TextDeltaEvent = BaseEvent.extend({
  type: z.literal('text_delta'),
  block: z.number().int().nonnegative(),
  text: z.string(),
});

export const ThinkingDeltaEvent = BaseEvent.extend({
  type: z.literal('thinking_delta'),
  block: z.number().int().nonnegative(),
  text: z.string(),
});

export const ToolUseStartEvent = BaseEvent.extend({
  type: z.literal('tool_use_start'),
  block: z.number().int().nonnegative(),
  tool: z.string(),
  inputPartial: z.unknown().optional(),
});

export const ToolUseInputDeltaEvent = BaseEvent.extend({
  type: z.literal('tool_use_input_delta'),
  block: z.number().int().nonnegative(),
  delta: z.string(),
});

export const ToolUseDoneEvent = BaseEvent.extend({
  type: z.literal('tool_use_done'),
  block: z.number().int().nonnegative(),
  input: z.unknown(),
});

export const ToolResultEvent = BaseEvent.extend({
  type: z.literal('tool_result'),
  block: z.number().int().nonnegative(),
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  renderHint: z.string(),
  language: z.string().optional(),
});

export const PermissionRequestEvent = BaseEvent.extend({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  reason: z.string().optional(),
});

export const StatusUpdateEvent = BaseEvent.extend({
  type: z.literal('status_update'),
  cost: z.number().optional(),
  tokensIn: z.number().int().optional(),
  tokensOut: z.number().int().optional(),
  cacheHitRate: z.number().optional(),
  streaming: z.boolean().optional(),
});

export const TurnCompleteEvent = BaseEvent.extend({
  type: z.literal('turn_complete'),
  finishReason: z.string(),
  usage: z
    .object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cache_creation_input_tokens: z.number().int().optional(),
      cache_read_input_tokens: z.number().int().optional(),
    })
    .optional(),
});

export const TurnErrorEvent = BaseEvent.extend({
  type: z.literal('turn_error'),
  error: z.string(),
  recoverable: z.boolean(),
});

export const SessionResumedEvent = BaseEvent.extend({
  type: z.literal('session_resumed'),
  resumedFromSeq: z.number().int().nonnegative(),
});

// M6 T3 — proactive (and, in T4, overflow-recovery) compaction surface.
// `sessionId` is the parent — the id the SSE subscriber connected to.
// `activeSessionId` is the new child id; the TUI must pivot subsequent
// POSTs (turns, approvals) onto it for the rest of the conversation.
// Token estimates expose the compaction's effect for footer / status
// rendering without forcing the TUI to recompute them.
export const CompactionCompleteEvent = BaseEvent.extend({
  type: z.literal('compaction_complete'),
  activeSessionId: z.string(),
  summary: z.string(),
  estimatedBeforeTokens: z.number().int().nonnegative(),
  estimatedAfterTokens: z.number().int().nonnegative(),
});

// M7 T6 — session-end goodbye summary. Emitted by disposeSession when an
// attached bus is supplied (single-session explicit disposal path). Carries
// the ReviewManager's getDispatchSummary payload: total dispatched review
// forks across the session plus a per-agent breakdown (review-memory,
// review-skill, review-consolidate, instinct-synthesizer). The TUI renders
// this as a goodbye card; M9 polish wires the renderer.
//
// M8 T7 — extended payload for the M9 goodbye-card consumer. All extension
// fields are optional so M7-vintage consumers (and the existing wire-event
// suite) still parse the event. Populated by disposeSessionContext from
// SessionDb.getSessionMetrics — the token columns come from the M7 cost-fix
// recordTokenUsage call site, and the tool-call count is a transcript scan
// for tool_use blocks on the persisted messages. Durations are left optional
// (no DB-side tracking yet — durations are deferred until SessionContext
// gains per-turn timing accumulators in a future milestone).
export const SessionSummaryEvent = BaseEvent.extend({
  type: z.literal('session_summary'),
  totalDispatched: z.number().int().nonnegative(),
  byAgent: z.record(z.string(), z.number().int().nonnegative()),
  tokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative().optional(),
      cacheWrite: z.number().int().nonnegative().optional(),
      estimatedCostUsd: z.number().nonnegative(),
    })
    .optional(),
  startedAtMs: z.number().nonnegative().optional(),
  endedAtMs: z.number().nonnegative().optional(),
  agentActiveMs: z.number().nonnegative().optional(),
  apiTimeMs: z.number().nonnegative().optional(),
  toolTimeMs: z.number().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  toolOk: z.number().int().nonnegative().optional(),
  toolErr: z.number().int().nonnegative().optional(),
});

// M8 T7 — stall detection wire event. Emitted by the turns route when the
// orchestrator's per-turn detectStall (src/core/query.ts:391) flags a
// 3-iteration window with no progress (no edits, no decisions, no memory
// writes — or repeated tool errors). Forwarded from query()'s recordTrace
// closure via the route's traceRecorder decoration in runTurnInBackground
// (option (c) from the M8 T7 brief — least invasive; no new StreamEvent
// type needed since stall_detected is a TraceEvent, not a StreamEvent).
// Advisory only — the turn continues normally; the TUI surfaces it as a
// soft warning the user can act on.
export const StallDetectedEvent = BaseEvent.extend({
  type: z.literal('stall_detected'),
  reason: z.string(),
  turn: z.number().int().nonnegative(),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolUseStartEvent,
  ToolUseInputDeltaEvent,
  ToolUseDoneEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  StatusUpdateEvent,
  TurnCompleteEvent,
  TurnErrorEvent,
  SessionResumedEvent,
  CompactionCompleteEvent,
  SessionSummaryEvent,
  StallDetectedEvent,
  // Phase 2 T4 — router synthesizes these from the scheduler's delegation
  // lifecycle. See src/router/progressEvents.ts.
  DelegatorPlanEventSchema,
  DelegatorAtomStartedEventSchema,
  DelegatorAtomCompleteEventSchema,
  DelegatorCompleteEventSchema,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const obj: unknown = JSON.parse(raw);
    return ServerEventSchema.parse(obj);
  } catch {
    return null;
  }
}

// M10.5 — slash-command dispatcher request/response envelope.
// POST /sessions/:id/commands { name, args } → { output, error?, sideEffects? }
// The Go TUI mirrors these shapes in
// packages/tui/internal/transport/commands.go. The route bridges the
// existing src/commands/registry.ts dispatchSlashCommand into server-mode;
// /compact, /skills, /theme keep their dedicated routes (different result
// shapes; M9.6 cache-invalidation depends on /skills's existing surface).

export const CommandRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    // Reject leading slash — the TUI strips the slash before POSTing.
    // The registry's dispatchSlashCommand also accepts the bare name.
    .regex(/^[^/]/, 'name must not start with /'),
  args: z.string().max(8192).default(''),
});

export type CommandRequest = z.infer<typeof CommandRequestSchema>;

// M11.5 — picker-driven commands (/model, /resume, /export) emit this
// in lieu of running an in-process raw-mode pick(). The TUI renders an
// inline card; selection re-dispatches `/<onSelect.command> <value>`.
// ADR M11.5-01, ADR M11.5-03.
//
// 2026-05-24 (config UX rebuild) — `valueColumn` and `badge` added so
// the same PickerCard component can render the config submenu rows
// (current value right-aligned, ✓ live / ⟳ next session badge after).
// Both are optional; existing picker callers (/model, /resume, /export,
// /theme) keep working unchanged.
export const PickerOpenItemSchema = z.object({
  label: z.string(),
  value: z.string(),
  hint: z.string().optional(),
  valueColumn: z.string().optional(),
  badge: z.enum(['live', 'reload']).optional(),
});

export const PickerOpenConfigSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  items: z.array(PickerOpenItemSchema),
  initial: z.number().int().nonnegative().optional(),
  onSelect: z.object({ command: z.string() }),
  // 2026-05-24 patch — when present, the TUI re-dispatches this
  // command on `backspace` so the user can navigate back to the
  // previous menu without re-running /config. Absence means there's
  // no parent (root menu / standalone picker), so backspace is a
  // no-op. Esc still cancels the picker outright.
  onBack: z.object({ command: z.string() }).optional(),
  // 2026-05-24 patch — when present, the TUI dispatches this command
  // on the `S` key (commit & exit). Used by /config pickers to wire
  // the "Save and Exit" affordance. Absent on pickers that don't
  // need this (/model, /resume, /export, /theme — they're atomic
  // single-shot edits).
  onSave: z.object({ command: z.string() }).optional(),
  // 2026-05-24 patch — when present, the TUI dispatches this command
  // on `Esc`. Used by /config pickers to wire the "Cancel and Exit"
  // affordance (which rolls back the draft session). When absent,
  // Esc falls back to the existing behavior (back-nav in configOnly
  // mode when OnBack is set, "(cancelled)" close otherwise).
  onCancel: z.object({ command: z.string() }).optional(),
});

export type PickerOpenConfigWire = z.infer<typeof PickerOpenConfigSchema>;

// 2026-05-24 — Config UX rebuild. Parallel to PickerOpenConfigSchema
// but for free-text edits (string, number, secret). The TUI renders an
// InputCard; on Enter it re-dispatches `/<onSubmit.command> <typed>`.
// `masked: true` displays bullets while typing (API keys, secrets).
export const InputOpenConfigSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  initial: z.string().optional(),
  placeholder: z.string().optional(),
  masked: z.boolean().optional(),
  onSubmit: z.object({ command: z.string() }),
  // 2026-05-24 patch — back-navigation. When present, Esc closes the
  // InputCard and re-dispatches this command (e.g., `config providers-
  // anthropic` from an apiKey edit) so the user returns to the parent
  // submenu. Absence falls back to the M11.5-style "(cancelled)"
  // close. Symmetric with PickerOpenConfigSchema.onBack.
  onBack: z.object({ command: z.string() }).optional(),
});

export type InputOpenConfigWire = z.infer<typeof InputOpenConfigSchema>;

export const CommandSideEffectsSchema = z.object({
  // Set by /clear when it mints a new child session. The TUI hops
  // m.sessionID to this value for subsequent POSTs. Unwired in M10.5
  // (backlog #41); set to undefined.
  newSessionId: z.string().optional(),
  // Set by /quit. The TUI signals graceful exit.
  exitRequested: z.boolean().optional(),
  // Set by /model. The TUI updates its model display.
  modelChanged: z.string().optional(),
  // Set by /model, /resume, /export when invoked with no args (M11.5).
  // The TUI renders the inline card; on Enter it re-dispatches the
  // command with the chosen value as args.
  pickerOpen: PickerOpenConfigSchema.optional(),
  // Set by /theme <name> (backlog #46). Tells the TUI to apply the
  // theme to its in-process state — the TS-side singleton update
  // from applyAndPersistTheme has no effect on the Go renderer.
  themeChanged: z.string().optional(),
  // Set by /config edit on free-text fields (2026-05-24). The TUI
  // renders an InputCard from this payload; on Enter it re-dispatches
  // `/<onSubmit.command> <typed-value>`.
  inputOpen: InputOpenConfigSchema.optional(),
  // Set by /config set verbose <bool> (2026-05-24). Tells the TUI to
  // toggle its verbose-mode flag (controls toolcard render: one-liner
  // compact vs. full bordered output).
  verboseChanged: z.boolean().optional(),
  // Set by /clear (2026-05-24 patch). Tells the TUI to wipe the
  // terminal's scrollback buffer so the new (cleared) session starts
  // visually fresh. Without this, the old transcript stays visible.
  clearScrollback: z.boolean().optional(),
});

export type CommandSideEffects = z.infer<typeof CommandSideEffectsSchema>;

export const CommandResponseSchema = z.object({
  output: z.string(),
  error: z.string().optional(),
  sideEffects: CommandSideEffectsSchema.optional(),
  /** For prompt-type slash commands (e.g., /init, /commit, /security-audit,
   *  every skill-sourced command): the expanded prompt body, ready to
   *  POST as a turn. Callers that have an active session — the TUI, the
   *  drive subcommand — auto-send it. Headless slash-only callers
   *  (dispatch) ignore it. Added 2026-05-22 PM alongside the sov drive
   *  subcommand; before that, the server folded prompt content into the
   *  output string, which interpolated the ContentBlock[] array as
   *  "[object Object]". */
  promptToSend: z.string().optional(),
});

export type CommandResponse = z.infer<typeof CommandResponseSchema>;
