// THE 0.1.0 SEMVER CONTRACT (Task 2.9): this witness is the frozen Contract #2
// TYPE surface — removing/renaming a listed export = major bump; additions = minor.
//
// Task 8.1 — the Contract #2 TYPE-surface snapshot (typecheck-only).
//
// This is NOT a `.test.ts` (bun does not run it); it is compiled by
// `bun run typecheck` (tsc includes tests/**). Its only job is to NAME every
// exported TYPE of the protocol barrel (src/protocol/index.ts) in a witness, so
// that removing or renaming any of them stops the project from typechecking —
// the type half of the surface snapshot the value snapshot
// (tests/protocol/surface.test.ts) cannot see, because types erase at runtime.
//
// Pair: a removed VALUE export is caught by surface.test.ts; a removed TYPE
// export is caught HERE. Update the witness deliberately when the protocol
// contract changes.

import type {
  CancelTurnRequest,
  CancelTurnResponse,
  CompactionCompleteEvent,
  CreateSessionRequest,
  CreateSessionResponse,
  DelegatorAtomCompleteEvent,
  DelegatorAtomStartedEvent,
  DelegatorCompleteEvent,
  DelegatorPlanEvent,
  EmptyRequest,
  ErrorResponse,
  HealthResponse,
  PermissionRequestEvent,
  PostApprovalRequest,
  PostApprovalResponse,
  PostTurnRequest,
  PostTurnResponse,
  ProtocolPathName,
  ServerEvent,
  ServerEventBase,
  ServerEventType,
  SessionResumedEvent,
  SessionSummaryEvent,
  StallDetectedEvent,
  StatusUpdateEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolResultEvent,
  ToolUseDoneEvent,
  ToolUseInputDeltaEvent,
  ToolUseStartEvent,
  TurnCompleteEvent,
  TurnErrorEvent,
} from '@yevgetman/sov-protocol';

/** One optional slot per exported protocol TYPE. If any is removed/renamed in
 *  the barrel, this stops typechecking. Exported so it is never flagged unused. */
export type ProtocolTypeSurfaceWitness = {
  // --- SSE event union (events.ts) ---
  serverEventBase?: ServerEventBase;
  textDeltaEvent?: TextDeltaEvent;
  thinkingDeltaEvent?: ThinkingDeltaEvent;
  toolUseStartEvent?: ToolUseStartEvent;
  toolUseInputDeltaEvent?: ToolUseInputDeltaEvent;
  toolUseDoneEvent?: ToolUseDoneEvent;
  toolResultEvent?: ToolResultEvent;
  permissionRequestEvent?: PermissionRequestEvent;
  statusUpdateEvent?: StatusUpdateEvent;
  turnCompleteEvent?: TurnCompleteEvent;
  turnErrorEvent?: TurnErrorEvent;
  sessionResumedEvent?: SessionResumedEvent;
  compactionCompleteEvent?: CompactionCompleteEvent;
  sessionSummaryEvent?: SessionSummaryEvent;
  stallDetectedEvent?: StallDetectedEvent;
  delegatorPlanEvent?: DelegatorPlanEvent;
  delegatorAtomStartedEvent?: DelegatorAtomStartedEvent;
  delegatorAtomCompleteEvent?: DelegatorAtomCompleteEvent;
  delegatorCompleteEvent?: DelegatorCompleteEvent;
  serverEvent?: ServerEvent;
  serverEventType?: ServerEventType;
  // --- endpoint request/response shapes + path names (endpoints.ts) ---
  errorResponse?: ErrorResponse;
  emptyRequest?: EmptyRequest;
  createSessionRequest?: CreateSessionRequest;
  createSessionResponse?: CreateSessionResponse;
  postTurnRequest?: PostTurnRequest;
  postTurnResponse?: PostTurnResponse;
  postApprovalRequest?: PostApprovalRequest;
  postApprovalResponse?: PostApprovalResponse;
  cancelTurnRequest?: CancelTurnRequest;
  cancelTurnResponse?: CancelTurnResponse;
  healthResponse?: HealthResponse;
  protocolPathName?: ProtocolPathName;
};
