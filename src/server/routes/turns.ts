// Phase 16.1 M3.4 — turns route.
//
// POST /sessions/:id/turns body { text: string } kicks off a background
// query() loop. The handler returns 202 immediately; events flow through
// the per-session bus to the SSE subscriber. M3 wires text_delta,
// thinking_delta, tool_use_start, tool_use_done, tool_result, and a
// single turn_complete per user turn. Richer event types (permission_request,
// status_update, microcompact, route_decision) land in M4+.
//
// Background-run discipline: errors from the query() loop publish a
// turn_error event onto the bus rather than crashing the server.
//
// Turn-boundary discipline (the M3 bug fix): query() emits an internal
// `message_stop` event after EVERY model call within a turn — including
// the intermediate ones that precede tool execution. Mapping every
// `message_stop` to a wire `turn_complete` truncated tool-using turns
// after the model's preamble (the events route closes the SSE on the
// first `turn_complete`). We now ignore `message_stop` on the wire and
// use the AsyncGenerator's return value (`Terminal`) — emitted exactly
// once when the generator returns — as the turn boundary.

import type { PostTurnRequest, PostTurnResponse } from '@yevgetman/sov-protocol';
import { accumulateUsage, createUsageAccumulator, finalizeUsage } from '@yevgetman/sov-sdk';
import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import { expandContextReferences } from '@yevgetman/sov-sdk/context/references';
import type { Message, Terminal } from '@yevgetman/sov-sdk/core/types';
import { REASONING_EFFORTS, type ReasoningEffort } from '@yevgetman/sov-sdk/providers/effort';
import { isContextOverflowError } from '@yevgetman/sov-sdk/providers/errors';
import { estimateUsageCost } from '@yevgetman/sov-sdk/providers/pricing';
import { expandSkillPrompt } from '@yevgetman/sov-sdk/skills/loader';
import { filterParseableRules } from '@yevgetman/sov-sdk/tool/toolScope';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { Hono } from 'hono';
import { type CompactResult, shouldCompactProactively } from '../../compact/compactor.js';
import { synthesizeDelegationEvents } from '../../router/progressEvents.js';
import type { AppVariables } from '../auth.js';
import { type ServerEventBus, getOrCreateBus } from '../eventBus.js';
import { type Runtime, createServerAsk } from '../runtime.js';
import { isValidSessionId } from '../sessionId.js';
import {
  type TurnPersistence,
  buildTurnCanUseTool,
  composeTurn,
  createSteeringPoller,
  gateTurnInstructions,
  hydrateSessionHistory,
  loadStoredMessages,
  persistTurnMessage,
} from '../turnComposition.js';
import { mapTerminalReason, relayAgentRun } from '../turnRelay.js';
import { loadOwnedSession } from './ownership.js';

// Moved to the shared composition modules; re-exported so existing importers
// (cron, channels, OpenAI, workflows, command context, tests) are unchanged.
export { buildSessionToolContext } from '../sessionToolContext.js';
export { mergeConsecutiveSameRoleMessages } from '../turnComposition.js';

/** Type-guard narrowing an UNTRUSTED wire value to a known effort level.
 *  Takes `unknown` (not `string`) because `PostTurnRequest.effort` is typed on
 *  the protocol but the parsed JSON body is whatever the client sent — a
 *  number, an object, or null all have to fail closed here rather than at the
 *  provider. Mirrors the guard in `src/commands/effortControl.ts` (the
 *  `/effort` slash command), which validates the same vocabulary for the
 *  session-wide level. */
function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Publish a `compaction_complete` SSE event for the given parent → child hop.
 *
 *  Field-ordering invariant: `sessionId` carries the PARENT id (the one the
 *  client subscribed against) and `activeSessionId` carries the new child id
 *  the rest of the turn pivots onto. Callers MUST publish under the parent id
 *  BEFORE reassigning their local `sessionId` let to the child — otherwise the
 *  TUI never learns of the hop and continues POSTing onto the stale parent.
 *
 *  Three call sites in M6: T3 (proactive block, before query() runs), T4
 *  (overflow recovery branch, between the two runOnce calls), and T5 (the
 *  POST /sessions/:id/compact route — explicit user-driven compaction). All
 *  three share the same wire shape so the TUI handles them uniformly. */
function publishCompactionComplete(
  bus: ServerEventBus,
  parentSessionId: string,
  result: CompactResult,
): void {
  bus.publish({
    type: 'compaction_complete',
    seq: bus.nextSeq(),
    sessionId: parentSessionId,
    activeSessionId: result.newSessionId,
    summary: result.summary,
    estimatedBeforeTokens: result.estimatedBeforeTokens,
    estimatedAfterTokens: result.estimatedAfterTokens,
  });
}

export function turnsRoute(runtime: Runtime): Hono<{ Variables: AppVariables }> {
  const r = new Hono<{ Variables: AppVariables }>();

  r.post('/sessions/:id/turns', async (c) => {
    const sessionId = c.req.param('id');
    // Backlog #31 — sibling routes (sessions, events, approvals, compact) all
    // validate :id via isValidSessionId and 400 on malformed input. Without
    // this guard, a malformed id flows into getOrCreateBus + the persisted
    // user message — neither call sanitizes, so the id would echo
    // unsanitized into SSE event payloads and the sessions table.
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    // Mirror sibling routes: reject a well-formed but nonexistent session id.
    // Without this, saveMessage in runTurnInBackground's pre-try setup hits the
    // messages.session_id FOREIGN KEY and throws — and because the turn is
    // fire-and-forget (void below), that becomes a process-killing unhandled
    // rejection rather than a clean 404.
    //
    // Phase E T4 — owner-only access. loadOwnedSession ALSO hides a session
    // owned by another principal (or unowned, when the caller is a real
    // principal) as non-existent → 404 (existence-hiding; never 403). This runs
    // at the TOP of the handler, BEFORE getOrCreateBus / markTurnStart / the
    // background turn — so bob's turn on alice's session creates no bus and runs
    // nothing. Implicit/null owner sees all (back-compat).
    if (loadOwnedSession(runtime, c, sessionId) === null) {
      return c.json({ error: 'session not found' }, 404);
    }
    // Guard the body parse: a malformed/empty body makes `c.req.json()`
    // throw, which Hono surfaces as an HTTP 500 text/plain response.
    // Mirror the structured 400 every other body-reading route returns
    // (chatCompletions.ts, commands.ts, skills.ts). Auth + the id/session
    // guards above run BEFORE this, so order is preserved.
    let body: PostTurnRequest;
    try {
      body = (await c.req.json()) as PostTurnRequest;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const rawText = typeof body.text === 'string' ? body.text : '';
    if (rawText === '') return c.json({ error: 'text is required' }, 400);

    // Per-turn reasoning depth (PostTurnRequest.effort) — additive + optional,
    // but STRICTLY validated. Absent/undefined → undefined → the PerTurn slice
    // below falls back to `sessionCtx.effort` (the session's own level, set by
    // `/effort` or the `thinking.effort` config), byte-identical to today. A
    // string inside the REASONING_EFFORTS vocabulary → that level for THIS turn.
    //
    // ANYTHING else — an empty string, a misspelling ('huge'), a non-string —
    // is a 400. This is deliberately UNLIKE the tolerant `model` /
    // `instructions` guards below, which coerce junk to undefined: those degrade
    // to a sane default, whereas a dropped `effort` degrades to the OPPOSITE of
    // what the caller asked for. A client posting `effort: 'off'` to stop a
    // reasoning model from burning thousands of thinking tokens must never have
    // a typo silently become "no control at all" — that is the exact failure the
    // feature exists to remove, and it is invisible except in the bill.
    //
    // Emitted HERE — right after the `text is required` guard and BEFORE the
    // skill-expansion block (which can create a bus, mark a turn start, and
    // publish a turn_error) — so a rejected body touches NO turn state at all,
    // mirroring the `kind: skill requires text to start with /` 400.
    //
    // Widened to `unknown` before the guard: the field is TYPED `string` on
    // PostTurnRequest, but the body is untrusted JSON that can carry any value.
    const rawEffort: unknown = body.effort;
    const perTurnEffort: ReasoningEffort | undefined = isReasoningEffort(rawEffort)
      ? rawEffort
      : undefined;
    if (rawEffort !== undefined && perTurnEffort === undefined) {
      return c.json({ error: `effort must be one of ${REASONING_EFFORTS.join('|')}` }, 400);
    }

    // M8 T5 — skill-as-slash dispatch. When the client (Go TUI) recognises
    // the leading slash as a known skill name, it POSTs with `kind: 'skill'`
    // to opt into server-side expansion. We parse `/name args…`, resolve
    // `name` against `runtime.skills.byName` (T4-populated), and replace
    // `text` with the expanded body BEFORE the rest of the turn runs.
    // Downstream @file expansion (T3) then sees the expanded prompt and
    // composes naturally — a skill body containing `@file:foo.md` gets the
    // file inlined the same way a hand-typed prompt would. The `kind` is
    // intentionally NOT forwarded; `runTurnInBackground` treats the post-
    // expansion text as plain user input. Unknown-skill names short-circuit
    // with a 400 so the TUI surfaces the mistake immediately rather than
    // letting a raw `/foo` slash leak into the model's context.
    let text = rawText;
    // Feature B — the resolved skill's allowedTools, retained across the
    // expansion so runTurnInBackground can scope the live tool pool to it for
    // THIS turn only. Passed only for kind:'skill' turns with a non-empty
    // allow-list; undefined (no restriction) otherwise.
    let skillScope: readonly string[] | undefined;
    if (body.kind === 'skill') {
      const trimmed = rawText.trim();
      if (!trimmed.startsWith('/')) {
        return c.json({ error: 'kind: skill requires text to start with /' }, 400);
      }
      const space = trimmed.indexOf(' ');
      const skillName = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
      const skill = runtime.skills.byName.get(skillName);
      if (!skill) {
        return c.json({ error: `unknown skill: ${skillName}` }, 400);
      }
      // Retain the allow-list before discarding the rest of the skill object.
      // Empty array → leave undefined so buildToolScope falls through to the
      // identity (no narrowing) path downstream.
      //
      // F2 — filter to entries parsePermissionRule accepts BEFORE the scope is
      // built. A single genuinely-malformed entry (e.g. an imported Claude Code
      // skill carrying `Bash(git log` with no closing paren) would otherwise
      // throw inside buildToolScope → runTurnInBackground's catch → the whole
      // turn fails with turn_error. Dropping a malformed allow-entry is
      // fail-CLOSED for that entry (the tool it would have permitted stays out
      // of scope), so filtering only ever narrows — never widens — what a valid
      // entry would have allowed.
      //
      // Three cases at this scope-build site (SWEEP-1):
      //   1. No allowedTools declared (length 0) → skillScope stays undefined →
      //      buildToolScope falls through to the full pool (the established
      //      "no restriction → full pool" semantic). Unchanged.
      //   2. Declared, ≥1 entry parses → scope to the parseable subset. The
      //      dropped entries are warned so the broken skill is fixable.
      //      Tolerant — unchanged.
      //   3. Declared (length > 0) but ZERO entries parse → fail LOUD. The
      //      author INTENDED a restriction but none of it is honorable; the
      //      "empty list → full pool" semantic would silently WIDEN to the full
      //      pool (fail-OPEN — the opposite of intent). Refuse to run: emit a
      //      turn_error naming the skill + the invalid entries (rather than
      //      running unrestricted or crashing with an opaque parse error).
      const parseableTools = filterParseableRules(skill.allowedTools, (m) =>
        process.stderr.write(`[skill:${skillName}] ${m}\n`),
      );
      if (skill.allowedTools.length > 0 && parseableTools.length === 0) {
        // Case 3 — all-invalid. Surface a clear turn_error onto the bus (so
        // the SSE subscriber sees a turn-level failure and the stream ends)
        // and return 202 without ever building a scope or running the turn.
        // markTurnStart re-scopes the bus so a fresh subscriber replays this
        // turn's error; publishing turn_error resets turnActive so the stream
        // closes cleanly.
        const errBus = getOrCreateBus(sessionId);
        errBus.markTurnStart();
        const invalidEntries = skill.allowedTools.map((e) => JSON.stringify(e)).join(', ');
        errBus.publish({
          type: 'turn_error',
          seq: errBus.nextSeq(),
          sessionId,
          error: `skill "${skillName}": every allowedTools entry is invalid (${invalidEntries}) — refusing to run (would otherwise run with no restriction)`,
          recoverable: false,
        });
        return c.json({ accepted: true } satisfies PostTurnResponse, 202);
      }
      if (parseableTools.length > 0) {
        skillScope = parseableTools;
      }
      text = await expandSkillPrompt(skill, { args, cwd: runtime.cwd, sessionId });
    }

    // Per-turn model override (PostTurnRequest.model) — additive + optional.
    // A non-empty string runs THIS turn on that model via PerTurn.model
    // (createAgent applies `perTurn.model ?? config.model`); anything else
    // (absent, empty, or non-string) → undefined → the turn falls back to the
    // gateway's configured global model, byte-identical to today. Validated
    // here at the untrusted-body boundary, mirroring the inline `text`/`kind`
    // guards above. This never mutates the process-global `runtime.model`.
    const perTurnModel =
      typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;

    // Per-turn system instruction (PostTurnRequest.instructions) — additive +
    // optional + ephemeral. A non-empty string is delivered to the model as an
    // extra system segment for THIS turn only (via PerTurn.systemPrompt below),
    // AUGMENTING — never replacing — the standing base system prompt, and is
    // NEVER written to the messages table (the provider `system:` field is
    // separate from `messages: history`). Anything else (absent, empty, or
    // non-string) → undefined → the PerTurn.systemPrompt field is omitted and
    // the turn uses the unchanged base `config.systemPrompt`, byte-identical to
    // today. Validated here at the untrusted-body boundary, mirroring the inline
    // `text`/`kind`/`model` guards above. Never mutates `runtime.systemSegments`.
    const perTurnInstructions =
      typeof body.instructions === 'string' && body.instructions.length > 0
        ? body.instructions
        : undefined;

    // Conduct gate (D23): a bound provider may veto the per-turn instruction
    // wire field (a regulated pack disables client-appended system segments).
    // Applied at the wire boundary so the dropped field never reaches the
    // PerTurn systemPrompt assembly in runTurnInBackground. Absent provider (or
    // an absent `allowPerTurnInstructions` capability) → allowed → byte-identical
    // to today. This is the ONE per-turn conduct decision the wrapper owns; the
    // in-turn seams (persona/preGate/triage/toolPolicy/outputGuard) all live
    // inside createAgent, bound via the standing `conduct` config below.
    const gatedPerTurnInstructions = gateTurnInstructions(runtime, sessionId, perTurnInstructions);

    const bus = getOrCreateBus(sessionId);
    // POST /turns is fire-and-forget: kick off the background turn loop
    // and return 202 immediately. The per-session bus buffers events
    // until the SSE subscriber attaches (see eventBus.ts) — that's what
    // keeps the "POST then GET /events" sequence race-free without
    // any in-route awaiting. The `void` discards the returned promise
    // intentionally; runTurnInBackground catches its own errors and
    // publishes them as turn_error events onto the bus.
    void runTurnInBackground(
      runtime,
      sessionId,
      text,
      bus,
      skillScope,
      perTurnModel,
      gatedPerTurnInstructions,
      perTurnEffort,
    ).catch((err) => {
      // Defense in depth: runTurnInBackground catches errors inside its try and
      // publishes turn_error, but a throw in its pre-try setup would otherwise
      // be an unhandled rejection that crashes the process. Surface it as a
      // turn_error so the client sees an error instead of a frozen turn.
      bus.publish({
        type: 'turn_error',
        seq: bus.nextSeq(),
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        recoverable: false,
      });
    });
    return c.json({ accepted: true } satisfies PostTurnResponse, 202);
  });

  return r;
}

async function runTurnInBackground(
  runtime: Runtime,
  sessionIdInitial: string,
  text: string,
  bus: ServerEventBus,
  // Feature B — when this turn consumes a skill body whose frontmatter
  // declares `allowedTools`, the route passes that allow-list here. It scopes
  // the live tool pool (and the pool sub-agents inherit) for THIS turn only —
  // the restriction lives entirely in a turn-local const and evaporates at
  // turn end (no persistence, no clearing, no resume hazard). Undefined/empty
  // → identity (no narrowing), byte-identical to a non-skill turn.
  skillScope?: readonly string[],
  // Per-turn model override (PostTurnRequest.model). A non-empty string set by
  // the route runs THIS turn on that model via the PerTurn slice below
  // (createAgent: `perTurn.model ?? config.model`); undefined → the turn falls
  // back to the standing `config.model` (= runtime.model), byte-identical to
  // today. Never mutates the process-global model — the override is turn-local.
  perTurnModel?: string,
  // Per-turn system instruction (PostTurnRequest.instructions). A non-empty
  // string set by the route is APPENDED to the standing base system segments
  // (runtime.systemSegments) and handed to agent.run() via PerTurn.systemPrompt
  // below for THIS turn only — ephemeral (the provider `system:` field is never
  // persisted to the messages table). undefined → the PerTurn.systemPrompt field
  // is omitted and the turn uses the unchanged base `config.systemPrompt`,
  // byte-identical to today. Turn-local; never mutates runtime.systemSegments.
  perTurnInstructions?: string,
  // Per-turn reasoning depth (PostTurnRequest.effort). A level from the
  // REASONING_EFFORTS vocabulary, already validated at the route boundary (an
  // out-of-vocabulary value never reaches here — it is a 400). It WINS over the
  // session's own level for THIS turn via the PerTurn slice below
  // (`perTurnEffort ?? sessionCtx.effort`); undefined → the session level,
  // byte-identical to today. Turn-local: `sessionCtx.effort` is never mutated,
  // so the next turn without an `effort` field is back on the session level.
  perTurnEffort?: ReasoningEffort,
): Promise<void> {
  // Phase B T3 — mark the turn boundary on the bus BEFORE this turn stamps
  // its first event (the status_update{streaming:true} below is the first
  // bus.nextSeq() / bus.publish() of the turn). markTurnStart records
  // `seq + 1` as currentTurnStartSeq so a fresh subscriber (no Last-Event-ID)
  // replays only THIS turn's events, not prior turns retained in the ring.
  // Now that the bus persists across turns (disposal moved to disposeSession),
  // this re-scoping is what keeps a mid-turn fresh subscribe from replaying
  // every accumulated event. Placed at the very top so it precedes every
  // bus interaction on every code path (including the catch's turn_error).
  bus.markTurnStart();
  // Mutable across the proactive-compaction hop below — once compactSession
  // returns, the rest of the turn (persistence, query(), serverAsk binding)
  // must target the new child session id, not the parent.
  // Declared OUTSIDE the try block so the catch can reference the current
  // sessionId for turn_error attribution (the value at the moment of throw —
  // pre-hop if compact() throws, post-hop if query() throws afterwards).
  let sessionId = sessionIdInitial;
  // ux-fixes round 4 — per-turn AbortController. Registered on the bus
  // so the POST /sessions/:id/cancel route can fire it. The signal
  // passed to query() combines the bus-level signal (fires on SSE
  // disconnect / server.stop) with this turn-level signal (fires on
  // explicit user cancel) so either path stops the in-flight provider
  // stream + tool loop. The controller is cleared in the finally
  // block below so a fresh controller is allocated per turn.
  const turnAbort = new AbortController();
  bus.setCurrentTurnAbort(turnAbort);
  const turnSignal = AbortSignal.any([bus.abortSignal, turnAbort.signal]);
  // Attestation evidence (spec 2026-07-19 §3.3/§3.4) — this request's ledger of
  // host-minted turnIds. Each drive below (runOnce; the compaction-retry hop is
  // a second drive) mints ONE fresh id through the evidence coordinator and
  // records it here; the finally block settles every minted id so EVERY one
  // ends with exactly one io row even when the turn aborts undelivered (the
  // backfill row, `delivered` OMITTED — never ''). No coordinator (attestation
  // off) ⇒ the array stays empty and no id is ever minted — byte-identical.
  const mintedTurnIds: string[] = [];
  // M7 T3 — per-session trace writer. The context is fetched (and lazily
  // built) up-front and re-fetched after each compaction pivot below so
  // the post-pivot trace events land in the child's trace file. The
  // `traceRecorder` closure dereferences `sessionCtx` dynamically so a
  // single bound function survives both compaction sites without needing
  // to re-thread itself into the query() call.
  let sessionCtx = runtime.getSessionContext(sessionId);
  const traceRecorder = (event: TraceEvent): void => {
    sessionCtx.traceWriter.record(event);
    // SOV-ASSAY WIRE v1 (config.assay) — fold every TraceEvent into the boot-
    // bound usage-only recorder (absent → no-op). `record` never throws and
    // content never rides this wire; only tokens/cost/tool names/timings.
    runtime.assayRecorder?.record(event);
    // M8 T7 — forward stall_detected onto the SSE bus so the TUI can render
    // it as a soft warning. The trace event itself is emitted by query()
    // at src/core/query.ts:393; the route's traceRecorder closure already
    // dual-purposes (trace file write + post-pivot session id awareness),
    // so adding the bus publish here keeps the wire surface synchronized
    // with the trace surface without introducing a new StreamEvent type
    // through core/query.ts. Other trace events stay file-only — only
    // stall_detected has a wire counterpart today.
    if (event.type === 'stall_detected') {
      bus.publish({
        type: 'stall_detected',
        seq: bus.nextSeq(),
        sessionId,
        reason: event.reason,
        turn: event.turn,
      });
    }
  };
  // SOV-ASSAY WIRE v1 — seed the recorder with the REAL session id at the top of
  // every user turn so its spans carry gen_ai.conversation.id = this session (not
  // the recorder's boot-time random UUID — the recorder never sees the
  // buildSessionContext session_start, which writes only to the trace file).
  // Emitted DIRECTLY to the recorder (not via traceRecorder) so the per-session
  // trace file isn't double-stamped. Idempotent (re-affirming the same id is a
  // cheap no-op that never resets the monotonic turn counter).
  runtime.assayRecorder?.record({
    type: 'session_start',
    sessionId,
    provider: runtime.resolvedProvider.transport.name,
    model: runtime.model,
    cwd: runtime.cwd,
    iso: new Date().toISOString(),
  });
  // M8 T3 — expand @file:path / @folder: / @url: / @diff / @staged
  // references in the user's text BEFORE persisting + handing it to the
  // model. Failures inline as `[ERROR: ...]` markers —
  // `expandContextReferences` never throws — so this never blocks the
  // turn. The expanded text is what lands in `sessionDb` AND what the
  // model sees, so resume reconstructs the exact same context the
  // original turn ran against.
  const expandedText = await expandContextReferences(text, { cwd: runtime.cwd });
  const userMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text: expandedText }],
  };
  const persistence: TurnPersistence = { mode: 'gateway-callbacks', host: runtime };
  // Persist before the try block so a query() failure still preserves the user's prompt in the transcript.
  persistTurnMessage(persistence, sessionId, userMessage);
  // M9 T10 — kick off the live status indicator. The TUI's statusline
  // consumes status_update events to drive the streaming spinner and the
  // live cost field; firing one with streaming:true at turn start is the
  // explicit start-of-stream marker the spinner pivots on. A matching
  // streaming:false event lands right before turn_complete below.
  bus.publish({
    type: 'status_update',
    seq: bus.nextSeq(),
    sessionId,
    streaming: true,
  });
  // M7 T6 follow-up (review I1) — fire the review/synthesizer user-turn
  // trigger exactly once per user prompt: right after persisting the
  // user's message, before the model run. This is the only call site
  // that increments userTurnsSince / synthesizerSince — without it, the
  // user-tunable `review.userTurnsForMemoryReview` and
  // `learning.synthesizerEveryN` settings would be silently inert. The
  // optional-chain handles the review-disabled case (reviewManager
  // undefined → no-op).
  sessionCtx.reviewManager?.onUserTurn(sessionId);
  // Hydrate the model's context with the full conversation history
  // (including the user message we just persisted). T9 hydrates the TUI
  // transcript visually on resume; this is the model-side companion.
  // Without it, the LLM sees only the new turn and responds as if every
  // resume is a fresh session, defeating the persistence work entirely.
  // Local closure binds the helper to the current sessionId — the value
  // changes when the proactive / recovery hops reassign it below, so each
  // hydrate() call picks up the post-hop child id automatically.
  //
  // M10 audit fix (slice 2 HIGH): wire `repairMissingToolResults` into
  // the resume path so the runtime synthesizes missing tool_result
  // blocks for any orphaned tool_use in the persisted history. Without
  // it, a session whose last persisted assistant turn had an unfulfilled
  // tool_use (e.g., process crash mid-turn) would 400 on the next
  // /turns call because Anthropic rejects the messages array as
  // invalid. The repair is purely additive and idempotent — no orphan
  // tool_use → no synthesized result → identical messages array.
  const hydrate = (): Message[] =>
    hydrateSessionHistory(loadStoredMessages(persistence, sessionId), sessionId);
  let messages: Message[] = hydrate();

  // Usage telemetry (T5 / F1). A tool-loop turn makes N provider calls; the
  // pre-T5 wiring tracked only the LAST call's `usage_delta` (last-writer-wins),
  // so every multi-call turn under-recorded and under-reported its tokens/cost.
  // We now fold the provider's usage stream through the SDK's PUBLIC accumulator
  // (`createUsageAccumulator`/`accumulateUsage`/`finalizeUsage`) — the exact
  // summed per-call semantics `createAgent` uses (W1). Two accumulators, both
  // fed from the SAME StreamEvent stream the loop already consumes:
  //
  //   - `hopUsageAcc` — RESET before each runOnce. Its per-hop final drives
  //     `sessionDb.recordTokenUsage` under the sessionId THAT hop ran as, so
  //     the parent/child compaction-hop attribution is preserved exactly as the
  //     old recordUsageIfPresent did (hop1 → parent id, hop2 → child id). This
  //     is the only wiring that populates the sessionDb cost table (read at
  //     disposal by disposeSessionContext); without it every trajectory ships
  //     estimatedCostUsd: 0 — caught by the autonomous smoke against real Haiku.
  //   - `turnUsageAcc` — NOT reset across hops. It yields the TURN TOTAL
  //     (hop1 + hop2 when overflow recovery fires) for the wire fields
  //     (status_update tokens/cost/cacheHitRate + turn_complete.usage).
  //
  // Declared OUTSIDE runOnce because the recovery branch creates a SECOND
  // runOnce invocation (after the overflow-driven compaction hop) — the outer
  // lets keep both accumulators stable across the two calls. `accumulateUsage`
  // folds message_start/message_stop/usage_delta and ignores everything else,
  // so feeding it the whole stream is safe; `finalizeUsage` returns undefined
  // when no usage_delta ever arrived, so `recordTokenUsage` stays skipped and
  // the wire fields stay absent exactly as before on a no-usage turn.
  let hopUsageAcc = createUsageAccumulator();
  let turnUsageAcc = createUsageAccumulator();
  let hopResult: RunResult | undefined;
  let knownTurnCost = 0;
  let turnCostComplete = true;
  // Item 3 — turn-level "did any text stream?" flag. Set at the text_delta
  // publish site below; read by handleAssistantMessage to decide whether the
  // final message's text needs projecting onto the wire. Declared OUTSIDE
  // runOnce so it spans both the initial hop and the overflow-recovery retry:
  // once ANY delta has streamed this turn, the buffered-delivery branch stays
  // skipped for every subsequent assistant_message (streaming byte-identical).
  let sawTextDelta = false;
  const recordHopUsage = (currentSessionId: string): void => {
    if (!hopResult) return;
    const usage = hopResult.usage ?? finalizeUsage(hopUsageAcc) ?? {};
    const receipt =
      hopResult.costEstimate ??
      estimateUsageCost(
        runtime.resolvedProvider.transport.name,
        perTurnModel ?? runtime.model,
        usage,
        { state: 'unknown', source: 'usage-unavailable' },
      );
    runtime.sessionDb.recordUsageEstimate(currentSessionId, usage, receipt);
    if (hopResult.estimatedCostUsd === undefined) turnCostComplete = false;
    else knownTurnCost += hopResult.estimatedCostUsd;
  };

  try {
    // M6 T3 — proactive compaction. If the hydrated history (including
    // the freshly-persisted user message) is over the configured
    // threshold, compact BEFORE handing it to the model. compactSession
    // mints a new child session, persists the summary + retained tail
    // onto it, and records lineage (compactor.ts:145). The rest of the
    // turn pivots onto the child id — including the SSE permission
    // bridge below.
    //
    // Wrapped in the try {} so a compact() failure (summarizer throws,
    // sessionDb write fails, auxiliary provider 429s, etc.) routes through
    // the existing turn_error catch instead of escaping as an unhandled
    // promise rejection — the route's invariant ("runTurnInBackground
    // catches its own errors and publishes them as turn_error events") must
    // hold for compaction failures too.
    //
    // Per-turn compaction budget: this proactive hop and the M6 T4
    // overflow recovery branch below are INDEPENDENT — both can fire in
    // the same turn if proactive succeeds but the post-proactive
    // query() still surfaces an overflow (e.g., the freshly-compacted
    // context plus a runaway tool loop pushes back over the limit). The
    // `retriedAfterCompact` flag below guards ONLY the recovery retry,
    // not all compactions per turn. TUI consumers must therefore handle
    // TWO `compaction_complete` events per turn (each with a distinct
    // `activeSessionId`) and pivot to the latest one.
    if (
      shouldCompactProactively({
        messages,
        systemPrompt: runtime.systemSegments,
        contextLength: runtime.resolvedProvider.contextLength,
        threshold: runtime.proactiveCompactThreshold,
      })
    ) {
      const result = await runtime.compact(messages, sessionId, turnSignal);
      // Backlog #36: when the entire history fit within the tail budget,
      // compactSession returns a no-op (parentSessionId === newSessionId,
      // noOp: true) — there's no new child id to pivot onto and no SSE
      // event worth publishing. Skip both. The TUI never sees a phantom
      // marker, the local sessionId stays on the parent, and the next
      // query() call uses the unchanged hydrated messages.
      if (result.noOp !== true) {
        publishCompactionComplete(bus, sessionId, result);
        sessionId = result.newSessionId;
        // M7 T3 — re-fetch the SessionContext so the post-compaction trace
        // events land in the child's trace file rather than the parent's.
        // The `traceRecorder` closure picks up the new ref on its next call
        // because it dereferences `sessionCtx` dynamically.
        sessionCtx = runtime.getSessionContext(sessionId);
        // The child's persisted state (summary + tail) is now the source of
        // truth for the model. Reload from the DB rather than mutating
        // result.tail in place so we pick up the persisted summary message
        // compactSession wrote at the head of the child's transcript.
        messages = hydrate();
      }
    }

    // Build a session-scoped canUseTool. The runtime's own `canUseTool`
    // carries the M3 deny placeholder for out-of-band callers; here we
    // replace its `ask` callback with a serverAsk bound to THIS session's
    // bus, so a tool that falls through to `ask` mode emits a
    // `permission_request` SSE event and parks on the matching
    // ApprovalQueue entry. The bus is per-session and the queue is
    // per-runtime — the wiring lives here because both refs are in scope.
    // The layered rules, `always` persistence and secrets redactor are the
    // shared composition (buildTurnCanUseTool).
    const sessionAsk = createServerAsk(runtime.approvalQueue, bus, sessionId);
    const sessionCanUseTool = buildTurnCanUseTool(runtime, { ask: sessionAsk });

    // Phase 2 T4 — per-turn delegation lifecycle recorder. Bound to the
    // initial sessionId so all four delegator_* SSE events publish under
    // the root session id the SSE subscriber connected against. The
    // closure tracks the delegator's call graph internally; a turn with
    // no delegator dispatch simply never fires any events. Recompaction
    // hops within a turn keep the same recorder — the root session id
    // doesn't change on the wire (the bus is per-root-session and the
    // TUI subscribes against the original id).
    const delegationLifecycleRecorder = synthesizeDelegationEvents({
      bus,
      rootSessionId: sessionIdInitial,
      agentRegistry: runtime.agents,
    });

    // Mid-turn steering (`sov run --steer-file`): a host thunk polled by the
    // SDK's turn loop at agent-loop boundaries. The announcement reads the
    // OUTER `sessionId` let at call time, so a mid-turn injection after a
    // compaction pivot is published under the id the turn is currently on —
    // same discipline as every other mid-turn event (additive event —
    // adapters that don't know the type ignore it).
    const pollSteering = createSteeringPoller(runtime.steerFile, (count) => {
      bus.publish({
        type: 'steer_injected',
        seq: bus.nextSeq(),
        sessionId,
        count,
      });
    });

    // Task 7.1 — the gateway runs each turn through `createAgent().run()`,
    // composed by the shared host composition (src/server/turnComposition.ts)
    // that the headless SDK host also uses. Created ONCE PER TURN from the
    // LIVE runtime refs, which is what preserves live-reload. The skill scope
    // (Feature B) narrows the pool + gate for THIS turn only. Persistence is
    // 'gateway-callbacks': createAgent gets no store ports and the relay
    // below writes every message via persistMessage.
    const composed = composeTurn({
      runtime,
      canUseTool: sessionCanUseTool,
      persistence,
      ...(skillScope !== undefined ? { skillScope } : {}),
      ...(perTurnModel !== undefined ? { model: perTurnModel } : {}),
      ...(perTurnEffort !== undefined ? { effort: perTurnEffort } : {}),
      ...(perTurnInstructions !== undefined ? { instructions: perTurnInstructions } : {}),
      ...(pollSteering !== undefined ? { pollSteering } : {}),
      traceRecorder,
      delegationLifecycleRecorder,
      signal: turnSignal,
      // Task 7.2 — opt OUT of createAgent's convert-throw-to-terminal default
      // so a pre-loop throw (memory injection, recall, UserPromptSubmit hook)
      // propagates to the outer catch → `turn_error`.
      rethrow: true,
    });

    // M6 T4 — overflow auto-recovery (M6-02 retry-once). Run the
    // iteration once; if the resulting Terminal carries a
    // context-overflow error, run runtime.compact(), publish
    // compaction_complete, then run the iteration ONCE more against the
    // post-compaction child session id. A second overflow on the retry
    // surfaces via the normal turn-error path below (we do NOT recurse).
    const runOnce = async (currentMessages: Message[]): Promise<Terminal | undefined> => {
      // Reads outer `sessionId` let — the recovery branch reassigns it between
      // calls. Do not shadow with a local `const sessionId = …` inside this
      // closure; doing so would silently break the recovery hop.
      //
      // Attestation host turn identity (spec §3.3): mint ONE fresh id per
      // drive — the compaction-retry hop calls runOnce again and mints its
      // own — registered under the sessionId THIS drive runs as. `vars`
      // mirror the ConductContext the hooks see (gateway turns are 'user';
      // model = the per-turn override else the standing model). Absent
      // coordinator ⇒ undefined ⇒ the PerTurn field stays ABSENT.
      const turnId = runtime.attestationEvidence?.beginTurn(sessionId, {
        surface: 'user',
        model: perTurnModel ?? runtime.model,
      });
      if (turnId !== undefined) mintedTurnIds.push(turnId);
      // PER-HOP slice: sessionId, turnId and the SessionContext-derived
      // fields (effort, memory, recall, tool context) are rebuilt for the
      // possibly-pivoted session; the bus/turn abort signal cancels the
      // provider stream + tool loop on cancel / disconnect / server.stop().
      const stream = composed.agent.run(
        currentMessages,
        composed.perTurn({
          sessionId,
          sessionCtx,
          ...(turnId !== undefined ? { turnId } : {}),
        }),
      );
      const relayed = await relayAgentRun(stream, {
        sink: bus,
        sessionId,
        sessionCtx,
        toolPool: runtime.toolPool,
        persist: composed.relayPersist,
        conductBound: runtime.conduct !== undefined,
        sawTextDelta,
        // Usage telemetry (T5) — fold EVERY StreamEvent into both
        // accumulators: `hopUsageAcc` sums THIS hop's calls (→ sessionDb),
        // `turnUsageAcc` sums ALL calls across the turn's hops (→ the wire).
        onStreamEvent: (streamEvent) => {
          hopUsageAcc = accumulateUsage(hopUsageAcc, streamEvent);
          turnUsageAcc = accumulateUsage(turnUsageAcc, streamEvent);
        },
      });
      sawTextDelta = relayed.sawTextDelta;
      hopResult = relayed.result;
      return relayed.result.terminal;
    };

    // Reset the PER-HOP accumulator before each runOnce so this hop's
    // sessionDb record carries only its own calls' usage. The recovery branch
    // below reassigns sessionId before the second runOnce — without this reset,
    // the first hop's usage would be re-recorded under the post-recovery child
    // id. `turnUsageAcc` is deliberately NOT reset here: it spans both hops to
    // produce the summed turn total for the wire.
    hopUsageAcc = createUsageAccumulator();
    let terminal = await runOnce(messages);
    // Record this hop's usage against the sessionId it ran under (still the
    // parent here; the recovery branch reassigns AFTER this).
    recordHopUsage(sessionId);

    // Overflow recovery path (retry-once). query() captures provider
    // exceptions into Terminal { reason: 'error', error } at
    // src/core/query.ts:156-164, so an overflow surfaces here as a
    // populated terminal.error rather than a thrown exception. If
    // runtime.compact() itself throws (recursive overflow case), the
    // outer try/catch publishes turn_error — symmetric to T3's safety
    // net for the proactive path. A second overflow on the retry's
    // Terminal falls through to the normal turn_complete path below
    // (mapTerminalReason maps reason: 'error' → finishReason: 'error',
    // which the TUI surfaces as a turn-level error to the user) — we
    // intentionally do NOT recurse into a second compact + retry.
    //
    // Per-turn compaction budget (Path A): this branch fires
    // INDEPENDENTLY of the proactive block above. If proactive ALREADY
    // compacted earlier in this turn, this recovery hop still runs —
    // the local `sessionId` at that point is the post-proactive child
    // id, so the recovery's `compaction_complete` carries that child
    // as the parent and a NEW grandchild as the activeSessionId. The
    // local `retriedAfterCompact` semantics guard ONLY this recovery
    // retry (not all per-turn compactions). The third test in
    // tests/server/turns.overflowRecovery.test.ts pins the two-event shape.
    if (terminal?.reason === 'error' && isContextOverflowError(terminal.error)) {
      const compactResult = await runtime.compact(messages, sessionId, turnSignal);
      // Backlog #36: a no-op result here means compaction couldn't free up
      // any headroom (entire history already fit in the tail budget — the
      // overflow was driven by the system prompt or a single oversized
      // tool result the tail keeper preserved). No new session id to pivot
      // onto, no wire event worth publishing. Falling straight through to
      // a same-session retry would just hit the same overflow, so skip the
      // retry entirely and surface the original overflow via the normal
      // turn_error path below — `terminal` already carries it.
      if (compactResult.noOp === true) {
        // Whole-branch review I2 — record terminal reason on the
        // SessionContext so disposal routes this trajectory into
        // failed.jsonl (the trajectory writer's COMPLETED_REASONS set at
        // src/trajectory/writer.ts:68 excludes 'error'). Without this,
        // error-terminal sessions silently bucket into samples.jsonl and
        // corrupt the corpus consumer's success/failure split.
        sessionCtx.trajectoryMetadata.terminalReason = 'error';
        bus.publish({
          type: 'turn_error',
          seq: bus.nextSeq(),
          sessionId,
          error:
            terminal.error?.message ?? 'context overflow with no compactable history to recover',
          recoverable: false,
        });
        return;
      }
      publishCompactionComplete(bus, sessionId, compactResult);
      sessionId = compactResult.newSessionId;
      // M7 T3 — re-fetch the SessionContext so the retried run's trace
      // events land in the child's trace file rather than the parent's.
      sessionCtx = runtime.getSessionContext(sessionId);
      messages = hydrate();
      // Reset the PER-HOP accumulator before the retry so the second runOnce
      // starts fresh. recordHopUsage already fired against the parent sessionId
      // above (the parent's row is safe); the retry's usage records below
      // against the post-compaction child sessionId. `turnUsageAcc` carries
      // over from hop1 so the wire total sums both hops.
      hopUsageAcc = createUsageAccumulator();
      terminal = await runOnce(messages);
      recordHopUsage(sessionId);
      // M6-02 retry-once: if the retry's terminal also carries an overflow
      // error, surface it as turn_error rather than turn_complete (the
      // post-recovery overflow is a distinct failure surface — "compaction
      // didn't yield enough headroom" — that the TUI should not gloss as a
      // normal turn end). Mirrors the second-overflow contract pinned by
      // the M6 T4 test.
      if (terminal?.reason === 'error' && isContextOverflowError(terminal.error)) {
        // Whole-branch review I2 — second overflow after compaction is a
        // terminal error: bucket the trajectory into failed.jsonl on
        // disposal (see compactResult.noOp branch above for the same fix).
        sessionCtx.trajectoryMetadata.terminalReason = 'error';
        bus.publish({
          type: 'turn_error',
          seq: bus.nextSeq(),
          sessionId,
          error: terminal.error?.message ?? 'context overflow after compaction',
          recoverable: false,
        });
        return;
      }
    }

    // Whole-branch review I2 — propagate the terminal's reason to the
    // SessionContext so disposal routes error/interrupted/max_tokens
    // terminals into failed.jsonl. Disposal reads
    // `trajectoryMetadata.terminalReason ?? 'completed'` for both the
    // trace `session_end` event and the trajectory writer. Without
    // this, a `terminal.reason === 'error'` that surfaced via query()'s
    // in-generator catch (src/core/query.ts:156-164) would NOT bucket
    // into failed.jsonl — the wire would emit
    // `turn_complete{finishReason: 'error'}` but the trajectory record
    // would mis-bucket as completed=true. `'completed'` and
    // `'max_turns'` (the COMPLETED_REASONS set at
    // src/trajectory/writer.ts:68) are left unset so the default
    // 'completed' fallback kicks in at disposal.
    if (terminal && terminal.reason !== 'completed' && terminal.reason !== 'max_turns') {
      sessionCtx.trajectoryMetadata.terminalReason = terminal.reason;
    }
    // M9 T10 + T5 — final status_update flushes the spinner off, plus a live
    // cost/tokens snapshot of the TURN TOTAL. The TUI reads `streaming: false`
    // as the stop signal. `turnUsageAcc` summed EVERY provider call across the
    // turn's hops (the F1 fix — the pre-T5 snapshot reported only the last
    // call). `finalizeUsage` returns undefined when the turn reported no usage
    // at all, so a no-usage turn stays byte-compatible (no tokens/cost fields).
    // Cost is estimated against the resolved provider so the final cost field
    // matches what disposeSessionContext's session_summary will report.
    const turnUsage = finalizeUsage(turnUsageAcc);
    // Sum immutable hop receipts; never reprice an override against the runtime default.
    const turnCost = turnUsage !== undefined && turnCostComplete ? knownTurnCost : undefined;
    const finalStatusEvent: {
      type: 'status_update';
      seq: number;
      sessionId: string;
      streaming: boolean;
      tokensIn?: number;
      tokensOut?: number;
      cost?: number;
      cacheHitRate?: number;
    } = {
      type: 'status_update',
      seq: bus.nextSeq(),
      sessionId,
      streaming: false,
    };
    if (turnUsage !== undefined) {
      if (turnUsage.inputTokens !== undefined) {
        finalStatusEvent.tokensIn = turnUsage.inputTokens;
      }
      if (turnUsage.outputTokens !== undefined) {
        finalStatusEvent.tokensOut = turnUsage.outputTokens;
      }
      // cacheHitRate = cacheRead / (input + cacheRead + cacheCreation), reported
      // ONLY when the provider surfaced cache phase fields and the denominator is
      // positive. Rounded to 4 decimals — the field was never set before T5, so
      // no consumer depends on a particular precision.
      const cacheRead = turnUsage.cacheReadInputTokens;
      const cacheCreation = turnUsage.cacheCreationInputTokens;
      if (cacheRead !== undefined || cacheCreation !== undefined) {
        const denom = (turnUsage.inputTokens ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
        if (denom > 0) {
          finalStatusEvent.cacheHitRate = Math.round(((cacheRead ?? 0) / denom) * 10000) / 10000;
        }
      }
    }
    if (turnCost !== undefined) {
      finalStatusEvent.cost = turnCost;
    }
    bus.publish(finalStatusEvent);
    // turn_complete carries the phase-broken turn total in the protocol's
    // snake_case shape (F3). input_tokens/output_tokens are REQUIRED by the
    // shape, so default to 0 when only partially reported; the two cache fields
    // ride a conditional spread so they stay absent unless the provider
    // reported them. The whole `usage` field is omitted when the turn reported
    // no usage (byte-compatible with the pre-T5 wire).
    const turnCompleteEvent: {
      type: 'turn_complete';
      seq: number;
      sessionId: string;
      finishReason: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    } = {
      type: 'turn_complete',
      seq: bus.nextSeq(),
      sessionId,
      finishReason: mapTerminalReason(terminal),
    };
    if (turnUsage !== undefined) {
      turnCompleteEvent.usage = {
        input_tokens: turnUsage.inputTokens ?? 0,
        output_tokens: turnUsage.outputTokens ?? 0,
        ...(turnUsage.cacheCreationInputTokens !== undefined
          ? { cache_creation_input_tokens: turnUsage.cacheCreationInputTokens }
          : {}),
        ...(turnUsage.cacheReadInputTokens !== undefined
          ? { cache_read_input_tokens: turnUsage.cacheReadInputTokens }
          : {}),
      };
    }
    bus.publish(turnCompleteEvent);
  } catch (err) {
    // Whole-branch review I2 — record terminal reason on the SessionContext
    // so disposal routes this trajectory into failed.jsonl (the trajectory
    // writer's COMPLETED_REASONS set at src/trajectory/writer.ts:68 excludes
    // 'error'). The local `sessionCtx` was re-fetched after any
    // compaction hops above, so this targets the current session id's
    // context. Without this, an exception in the proactive-compaction block
    // or in the main query() loop silently buckets the trajectory into
    // samples.jsonl — corrupting the corpus consumer's success/failure split.
    runtime.getSessionContext(sessionId).trajectoryMetadata.terminalReason = 'error';
    // M9 T10 — flush streaming spinner off on errors too. Without this the
    // TUI's spinner spins forever when the turn dies before turn_complete.
    bus.publish({
      type: 'status_update',
      seq: bus.nextSeq(),
      sessionId,
      streaming: false,
    });
    bus.publish({
      type: 'turn_error',
      seq: bus.nextSeq(),
      sessionId,
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  } finally {
    // Attestation §3.4 — settle EVERY minted turnId on every exit path. A
    // drive that reached terminal already wrote its io row through the
    // provider-mounted evidenceSink (endTurn is then a no-op); an abandoned /
    // rethrown drive gets its backfill row here (`delivered` OMITTED — never
    // ''), so no DecisionRecord of this request can ever be an orphan.
    // Evidence fails open: endTurn never throws.
    for (const id of mintedTurnIds) {
      runtime.attestationEvidence?.endTurn(id);
    }
    // ux-fixes round 4 — clear the per-turn abort registration so the
    // next POST /turns allocates a fresh controller. Idempotent; safe
    // even if cancelCurrentTurn never fired.
    bus.clearCurrentTurnAbort();
    // SOV-ASSAY WIRE v1 — seal + deliver THIS turn's usage span at the turn
    // boundary. The recorder's pending chat span otherwise seals only at the
    // NEXT boundary event, so a session's final turn (or an app killed between
    // turns) would never deliver. Fire-and-forget: flush() never throws and
    // never blocks turn teardown.
    void runtime.assayRecorder?.flush();
  }
}
