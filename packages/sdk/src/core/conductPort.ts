// packages/sdk/src/core/conductPort.ts — the vendor-neutral Conduct Port.
//
// Agent-plane governance choke points (Conduct & Persona Engine spec §6.1,
// ~/code/me/specs/2026-07-08-sov-conduct-module-design.md). The SDK ships the
// PORT + seams only; any engine (our decorum, or a third party) implements
// this interface. ALL capabilities are optional — one interface, optional
// capability slices (resolves spec §10 item 9) — and an ABSENT provider (or an
// empty object) is the null provider: byte-identical to pre-port behavior at
// every seam. That invariant is enforced by the existing full test suite plus
// tests/core/conductPort.test.ts and tests/agent/createAgent.conduct.test.ts.
//
// Seam placement (who calls what):
//   - query():      preGate (AFTER the UserPromptSubmit rewrite — it sees the
//                   FINAL text, including injected memory/recall prefix; D23),
//                   triage (once, before the first provider call; fail-open).
//   - createAgent(): personaSegments (system-prompt composition), toolPolicy
//                   (outer deny-first wrapper around canUseTool), outputGuard
//                   (the drive-loop delivery gate every surface passes through),
//                   audit wiring.
//   - wrapper:      per-session/runtime binding; allowPerTurnInstructions
//                   gating at the gateway wire boundary.
//
// Surface discipline (D23): persona/preGate/triage run only on 'user' turns;
// toolPolicy and outputGuard run on EVERY turn ('internal' sub-turns keep
// their floors). NOTE: sub-agents that run as SUBPROCESSES (tasks/manager
// spawning `sov drive`) are separate processes — an in-process provider object
// does not cross that boundary; those runs bind their own provider via their
// own runtime. This is a named trust boundary, not a gap in this port.
//
// Failure posture at the SDK seams: a THROWN capability fails OPEN (the turn
// proceeds; the audit event records verdict 'error'). Fail-closed postures
// (D4: regulated packs) are the ENGINE's job, implemented INSIDE its
// capability functions — the SDK never decides policy.
//
// Hot-reload: the provider HANDLE is stable per session; the engine hot-reloads
// packs/config internally behind it. No liveApply hook is needed at this layer.

import type { AssistantMessage, SystemSegment } from './types.js';

/** Which kind of turn this is. 'user' = a human-facing turn (gateway, TUI,
 *  channels, cron reply, machine contract). 'internal' = an in-process
 *  sub-turn driven by the harness itself. */
export type ConductSurface = 'user' | 'internal';

/** Per-turn identity the seams hand to every capability. Content-free. */
export type ConductContext = {
  readonly sessionId: string;
  readonly surface: ConductSurface;
  readonly model: string;
  readonly providerName: string;
  readonly cwd?: string;
};

/** preGate verdict — deny/rewrite semantics mirroring the UserPromptSubmit
 *  hook (query.ts): 'allow' proceeds; 'rewrite' replaces the latest user
 *  message's text block WHOLESALE (the gate saw the full composed text,
 *  including any injected memory/recall prefix — preserving that prefix is
 *  the rewriter's responsibility); 'deny' with refusalText synthesizes an
 *  assistant refusal reply and completes the turn; 'deny' without refusalText
 *  terminates with reason 'error' (the UserPromptSubmit-deny precedent). */
export type PreGateVerdict =
  | { action: 'allow' }
  | { action: 'rewrite'; text: string }
  | { action: 'deny'; refusalText?: string };

/** Intent-triage verdict (spec D3): posture-shaping, small-model, fail-open.
 *  posture 'refuse' short-circuits pre-model into a synthesized refusal reply
 *  (refusalText, else DEFAULT_CONDUCT_REFUSAL). Other postures are advisory
 *  in 1b — recorded to audit; the engine consumes them when it arrives. */
export type TriageVerdict = {
  genuine: boolean;
  posture?: 'open' | 'guarded' | 'refuse';
  refusalText?: string;
};

/** Tool-policy verdict. 'deny' wins outright (deny-first composition); a
 *  non-deny defers to the inner canUseTool cascade unchanged. */
export type ConductToolVerdict = { behavior: 'allow' } | { behavior: 'deny'; reason?: string };

/** Output-gate verdict for one assistant message. 'replace' / 'block'
 *  substitute the message's TEXT blocks only — tool_use blocks are preserved
 *  verbatim so tool_use/tool_result adjacency in the persisted transcript is
 *  never broken. 'block' without a template uses DEFAULT_CONDUCT_REFUSAL. */
export type OutputFinalVerdict =
  | { action: 'pass' }
  | { action: 'replace'; text: string }
  | { action: 'block'; template?: string };

/** The output-delivery gate. onDelta transforms/holds streaming text deltas
 *  (return '' to hold — the ENGINE owns any internal lookahead buffer; the SDK
 *  only routes deltas through). onFinal verdicts each assistant message before
 *  it reaches consumers/persistence. Both optional. */
export type ConductOutputGuard = {
  onDelta?(text: string, ctx: ConductContext): string;
  onFinal?(
    message: AssistantMessage,
    ctx: ConductContext,
  ): Promise<OutputFinalVerdict> | OutputFinalVerdict;
};

export type ConductStage = 'persona' | 'pregate' | 'triage' | 'tool' | 'output';

/** Typed, CONTENT-FREE audit event (spec §6.2 Audit). Never carries message
 *  text — verdict labels, ids, and latency only. */
export type ConductAuditEvent = {
  readonly stage: ConductStage;
  readonly sessionId: string;
  readonly surface: ConductSurface;
  readonly verdict: string;
  readonly latencyMs?: number;
  readonly iso: string;
};

/** The vendor-neutral Conduct Port. All capabilities optional; absent = null
 *  provider = today's behavior, byte-identical. */
export interface ConductProvider {
  /** Ordered persona segments composed into the system prompt (inserted after
   *  the cacheable prefix — see insertPersonaSegments). 'user' surface only. */
  personaSegments?(ctx: ConductContext): Promise<SystemSegment[]> | SystemSegment[];
  /** Input gate over the FINAL post-rewrite user text. 'user' surface only. */
  preGate?(finalUserText: string, ctx: ConductContext): Promise<PreGateVerdict> | PreGateVerdict;
  /** Pre-generation intent triage. 'user' surface only; fail-open. */
  triage?(finalUserText: string, ctx: ConductContext): Promise<TriageVerdict> | TriageVerdict;
  /** Deny-first tool gate composed OUTSIDE the canUseTool cascade. Every surface. */
  toolPolicy?(
    toolName: string,
    input: unknown,
    ctx: ConductContext,
  ): Promise<ConductToolVerdict> | ConductToolVerdict;
  /** The output-delivery gate. Every surface (floors run on internal turns too). */
  outputGuard?: ConductOutputGuard;
  /** Gateway wire-boundary gate for PostTurnRequest.instructions (D23):
   *  return false to drop the per-turn instruction field for this session. */
  allowPerTurnInstructions?(ctx: ConductContext): boolean;
  /** Sink for typed content-free audit events. Wrapped no-throw by the SDK. */
  auditSink?(event: ConductAuditEvent): void;
}

/** Default refusal text when a deny/refuse verdict supplies none. */
export const DEFAULT_CONDUCT_REFUSAL = "I can't help with that request.";

/** Wrap an optional audit sink with a no-throw shim (the makeTraceRecorder
 *  pattern — query.ts): absent → no-op; a throwing sink never breaks a turn. */
export function wrapConductAuditSink(
  sink: ((event: ConductAuditEvent) => void) | undefined,
): (event: ConductAuditEvent) => void {
  if (!sink) return () => {};
  return (event) => {
    try {
      sink(event);
    } catch {
      // Audit is an observer; never propagate.
    }
  };
}
