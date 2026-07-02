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
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  appendProjectLocalPermissionRule,
  loadPermissionSettings,
} from '@yevgetman/sov-sdk/config/settings';
import { readConfig } from '@yevgetman/sov-sdk/config/store';
import { expandContextReferences } from '@yevgetman/sov-sdk/context/references';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
  TokenUsage,
} from '@yevgetman/sov-sdk/core/types';
import { buildCanUseTool } from '@yevgetman/sov-sdk/permissions/canUseTool';
import { wrapCanUseToolWithTransformers } from '@yevgetman/sov-sdk/permissions/inputTransformer';
import { redactSecretsTransformer } from '@yevgetman/sov-sdk/permissions/redactSecretsTransformer';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import { isContextOverflowError } from '@yevgetman/sov-sdk/providers/errors';
import { estimateCostUsd } from '@yevgetman/sov-sdk/providers/pricing';
import { expandSkillPrompt } from '@yevgetman/sov-sdk/skills/loader';
import { buildToolContext } from '@yevgetman/sov-sdk/tool/buildToolContext';
import { buildToolScope, filterParseableRules } from '@yevgetman/sov-sdk/tool/toolScope';
import type { RenderHint, Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { Hono } from 'hono';
import { type PersistMessageHost, persistMessage } from '../../agent/persistMessage.js';
import { type CompactResult, shouldCompactProactively } from '../../compact/compactor.js';
import {
  type DelegationLifecycleEvent,
  synthesizeDelegationEvents,
} from '../../router/progressEvents.js';
import type { AppVariables } from '../auth.js';
import { type ServerEventBus, getOrCreateBus } from '../eventBus.js';
import { type Runtime, createServerAsk } from '../runtime.js';
import type { ServerEvent } from '../schema.js';
import type { SessionContext } from '../sessionContext.js';
import { isValidSessionId, loadHistoryAsMessages } from '../sessionId.js';
import { loadOwnedSession } from './ownership.js';

/** State captured at `tool_use_start` emission, drained when the matching
 *  `tool_result` arrives so the tool_result wire event can echo the same
 *  `tool` / `input` / `renderHint` without re-deriving them. Keyed by the
 *  Anthropic `tool_use_id` produced by the model. */
type PendingToolUse = {
  tool: string;
  input: unknown;
  renderHint: RenderHint;
};

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

/** A message carries no tool_use/tool_result block — i.e. plain text/thinking
 *  content only. The pre-H7 corruption (a standalone loop-detector guidance
 *  message) is always such a plain user message. */
function isPlainMessage(msg: Message): boolean {
  return !msg.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
}

/**
 * Coalesce adjacent same-role messages into one (concatenating their content
 * blocks in order) — but ONLY when both are plain (no tool_use/tool_result),
 * which is exactly the pre-H7 corruption signature. Anthropic requires strictly
 * alternating user/assistant roles; a session corrupted by the pre-H7 bug — a
 * standalone trailing guidance user message left the timeline ending on
 * (assistant, user, user) — would 400 with "roles must alternate" on resume.
 * `repairMissingToolResults` only synthesizes missing tool_result blocks; it has
 * no same-role coalescing, so legacy-corrupted histories need this heal.
 *
 * Scoping to plain messages is deliberate: a legitimate trailing tool_result
 * user message (e.g. an interrupted tool turn) must NOT be folded into the next
 * user prompt — that would glue a stale tool_result onto the new question and
 * disturb the tool_use/tool_result pairing the rest of the turn loop relies on.
 *
 * Purely additive + immutable: returns a fresh array, never mutates the input
 * messages, and is a no-op when no mergeable plain same-role pair exists.
 */
export function mergeConsecutiveSameRoleMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.role === msg.role &&
      isPlainMessage(prev) &&
      isPlainMessage(msg)
    ) {
      out[out.length - 1] = {
        role: prev.role,
        content: [...prev.content, ...msg.content],
      } as Message;
      continue;
    }
    out.push(msg);
  }
  return out;
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

    const bus = getOrCreateBus(sessionId);
    // POST /turns is fire-and-forget: kick off the background turn loop
    // and return 202 immediately. The per-session bus buffers events
    // until the SSE subscriber attaches (see eventBus.ts) — that's what
    // keeps the "POST then GET /events" sequence race-free without
    // any in-route awaiting. The `void` discards the returned promise
    // intentionally; runTurnInBackground catches its own errors and
    // publishes them as turn_error events onto the bus.
    void runTurnInBackground(runtime, sessionId, text, bus, skillScope).catch((err) => {
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

/** Build the per-turn ToolContext for `runTurnInBackground`'s `query()`
 *  call. Once buildRuntime constructs the scheduler + taskManager
 *  (T6 + T7), the turn-time context plumbs them onto the tool surface
 *  so AgentTool / task_create / task_list / task_get / task_output
 *  dispatch correctly. Without these four fields populated, every
 *  sub-agent and task tool throws "no scheduler / task manager in
 *  ToolContext" the moment the model invokes it.
 *
 *  The `parentToolPool` is the runtime's own pool. AgentTool reads it via
 *  ctx.parentToolPool when it forks a child session so the child inherits
 *  the parent's filtered tool surface rather than re-assembling from
 *  scratch. `canUseTool` is the session-scoped gate built in
 *  runTurnInBackground around serverAsk + the bus — the scheduler hands
 *  it through to the child AgentRunner so the same permission policy
 *  applies (parent rule layers, secrets redactor, the live SSE bridge).
 *
 *  Exported so tests/server/turns.subagent.test.ts can pin the contract
 *  without spinning up the full POST /turns + SSE drain.
 */
export function buildSessionToolContext(
  runtime: Runtime,
  sessionId: string,
  sessionCanUseTool: CanUseTool,
  opts: {
    /** Phase 2 T4 — per-turn delegation lifecycle recorder. The runtime's
     *  /turns route builds this via `synthesizeDelegationEvents(...)` and
     *  threads it down to AgentTool so the scheduler fires lifecycle
     *  events that the closure maps onto the four delegator_* SSE events.
     *  Cron + OpenAI callers pass undefined (no SSE bus to publish to). */
    delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void;
    /** Feature B — the effective tool pool for THIS turn. Defaults to the
     *  shared `runtime.toolPool` so every existing caller is byte-unchanged.
     *  The `/skill` path passes a fresh SCOPED copy (`buildToolScope(...).tools`)
     *  when the skill declares `allowedTools`, so a forked sub-agent inherits
     *  the same narrowed pool (`parentToolPool === effectivePool`) and the
     *  skill-visibility derivation tracks the tools the turn can actually use.
     *  IMPORTANT vs the shared pool: `runtime.toolPool` is a shared array
     *  mutated in place on reload; the scope is a FRESH filtered copy
     *  (`buildToolScope` always returns a new array), never a mutation of —
     *  nor an alias to — the shared pool. */
    effectivePool?: Tool<unknown, unknown>[];
  } = {},
): ToolContext {
  // Task 5.1 — the PROPRIETARY per-session resolution half. Resolve the inputs
  // off the Runtime god-object + the per-session SessionContext, then delegate
  // the pure assembly to the OPEN `buildToolContext`. The external signature +
  // returned ToolContext are byte-identical to the pre-split version — every
  // caller (gateway turns, openai, cron, channels, workflows) is unchanged.

  // M7 T5/T6 — pull the per-session subsystems off the SessionContext so
  // the orchestrator can call `ctx.learningObserver?.observe(...)` after
  // every tool call and (T6) `ctx.reviewManager` can guard review forks.
  // The context is lazily built (or cached) by Runtime.getSessionContext.
  const sessionCtx = runtime.getSessionContext(sessionId);
  // Feature B — the pool this turn actually runs against. Defaults to the
  // shared runtime pool (every existing caller); the `/skill` path overrides
  // it with the skill-scoped copy. Read-only — never mutate runtime.toolPool.
  // The open assembler derives skill visibility (activeToolNames /
  // activeToolsets / filtered skills) from this same effective pool.
  const effectivePool = opts.effectivePool ?? runtime.toolPool;
  // Task 2.3 — source WebSearchTool's provider config for `ctx.webSearch` (the
  // tool no longer reads config ambiently). An injected Settings (SDK seam,
  // config-file-free) is used verbatim; otherwise re-read config.json per turn
  // so live `webSearch.*` edits stay read-on-demand (byte-identical to the
  // tool's prior invoke-time read, now relocated to the per-turn assembler).
  const webSearch =
    runtime.injectedSettings?.webSearch ??
    readConfig({ harnessHome: runtime.harnessHome }).webSearch;
  return buildToolContext({
    cwd: runtime.cwd,
    sessionId,
    harnessHome: runtime.harnessHome,
    agents: runtime.agents,
    // Conditional in the assembler (absent when no bundle is loaded): the
    // optional `bundleRoot` field is `string | undefined`, so passing
    // `runtime.bundle?.root` directly is byte-identical to the prior
    // `runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}` spread.
    bundleRoot: runtime.bundle?.root,
    subagentScheduler: runtime.subagentScheduler,
    taskManager: runtime.taskManager,
    // Phase 2 T3 — the assembled lane registry (always present on Runtime).
    laneRegistry: runtime.laneRegistry,
    effectivePool,
    // The UNFILTERED registry — the assembler filters it against the effective
    // pool. Keeping the runtime registry unfiltered preserves the T5
    // `/skillname` dispatch + the GET /skills route's own per-request view.
    skills: runtime.skills,
    canUseTool: sessionCanUseTool,
    // M8 T3 — per-session subdirectory-hint dedup state (passed by reference so
    // the dedup Set persists across the session's turn loop).
    subdirectoryHintState: sessionCtx.subdirectoryHintState,
    // Backlog #43 — per-session memory manager + project scope.
    memoryManager: sessionCtx.memoryManager,
    projectScope: sessionCtx.projectScope,
    // Task 2.3 — WebSearchTool reads its provider config off `ctx.webSearch`.
    webSearch,
    // M7 T5 — per-session learning observer (undefined when learning disabled).
    learningObserver: sessionCtx.learningObserver,
    // M7 T6 — per-session review manager (undefined when review disabled).
    reviewManager: sessionCtx.reviewManager,
    // Phase E T6 — owning principal (undefined for the implicit single principal).
    userId: sessionCtx.userId,
    // Phase 2 T4 — per-turn delegation lifecycle recorder (undefined for callers
    // with no SSE bus, e.g. cron + OpenAI).
    delegationLifecycleRecorder: opts.delegationLifecycleRecorder,
  });
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
  // M7 T3 — per-session trace writer. The context is fetched (and lazily
  // built) up-front and re-fetched after each compaction pivot below so
  // the post-pivot trace events land in the child's trace file. The
  // `traceRecorder` closure dereferences `sessionCtx` dynamically so a
  // single bound function survives both compaction sites without needing
  // to re-thread itself into the query() call.
  let sessionCtx = runtime.getSessionContext(sessionId);
  const traceRecorder = (event: TraceEvent): void => {
    sessionCtx.traceWriter.record(event);
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
  // Persist before the try block so a query() failure still preserves the user's prompt in the transcript.
  persistMessage(runtime, sessionId, {
    role: userMessage.role,
    content: userMessage.content,
  });
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
  const hydrate = (): Message[] => {
    const raw = loadHistoryAsMessages(runtime.sessionDb, sessionId);
    const { messages: repaired, insertedToolResults } = repairMissingToolResults(raw);
    if (insertedToolResults > 0) {
      process.stderr.write(
        `[repair] synthesized ${insertedToolResults} missing tool_result block(s) for session ${sessionId}\n`,
      );
    }
    // Heal legacy-corrupted histories (pre-H7 standalone trailing guidance user
    // message → two consecutive user messages) so Anthropic's strict
    // user/assistant alternation holds on resume. Runs AFTER repair so any
    // synthesized tool_result user message is folded in too. No-op for an
    // already-alternating timeline.
    return mergeConsecutiveSameRoleMessages(repaired);
  };
  let messages: Message[] = hydrate();

  // M7 follow-up — track the most recent `usage_delta` emitted by the
  // provider stream across runOnce invocations so the final assistant
  // response's token counts get recorded against the CURRENT sessionId
  // after each model run. This is the only wiring that populates the
  // sessionDb cost table. Without this, sessionDb.getSessionCost (read
  // at disposal time by disposeSessionContext) always returns zero and
  // every trajectory ships with estimatedCostUsd: 0 — caught by the
  // autonomous smoke test against real Anthropic Haiku 4.5.
  //
  // Declared OUTSIDE runOnce because the recovery branch creates a SECOND
  // runOnce invocation (after the overflow-driven compaction hop) — the
  // outer scope keeps the helper closure-stable across both calls. Each
  // runOnce resets it to undefined before iterating so a stale parent-turn
  // usage never gets re-recorded against the post-recovery child session.
  let latestUsage: TokenUsage | undefined;
  const recordUsageIfPresent = (currentSessionId: string): void => {
    if (latestUsage !== undefined) {
      const cost = estimateCostUsd(
        runtime.resolvedProvider.transport.name,
        runtime.model,
        latestUsage,
      );
      runtime.sessionDb.recordTokenUsage(currentSessionId, latestUsage, cost);
    }
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
    const permissionSettings = loadPermissionSettings({
      cwd: runtime.cwd,
      harnessHome: runtime.harnessHome,
    });
    const sessionAsk = createServerAsk(runtime.approvalQueue, bus, sessionId);
    const baseCanUseTool = buildCanUseTool({
      mode: runtime.permissionMode,
      ask: sessionAsk,
      // Session-scoped allow set is fresh per turn — the per-turn
      // canUseTool's lifecycle ends with the turn. Persistence across
      // turns happens via project-local settings.local.json: an
      // `always` answer is appended there, and the next turn's
      // loadPermissionSettings call (above) picks it up as a rule
      // layer. Backlog #44 (closed 2026-05-19) wired the persistence
      // path.
      alwaysAllow: new Set<string>(),
      ruleLayers: permissionSettings.layers,
      recordAlwaysAllow: (rule) => {
        appendProjectLocalPermissionRule({
          cwd: runtime.cwd,
          rule,
          behavior: 'allow',
        });
      },
    });
    // Defense-in-depth: secrets redactor wraps the resolved canUseTool
    // identically to the runtime-level chain in buildRuntime — catches
    // accidental secret writes in any tool input that gets allowed.
    const sessionCanUseTool = wrapCanUseToolWithTransformers(baseCanUseTool, [
      redactSecretsTransformer,
    ]);

    // Feature B — turn-scoped skill tool restriction. When this turn consumes
    // a `/skill` whose frontmatter declares `allowedTools`, narrow the live
    // tool pool (and the gate) to that allow-list for THIS turn only.
    //   - `tools: runtime.toolPool` READS the shared pool; `buildToolScope`
    //     returns a FRESH filtered copy — runtime.toolPool is never mutated
    //     (the reload contract mutates it in place, so aliasing/narrowing it
    //     would corrupt every other session).
    //   - `skillScope` undefined/empty → identity: scope.tools === the pool
    //     and scope.canUseTool === sessionCanUseTool, so non-skill / unscoped
    //     turns are byte-identical to today.
    //   - `scope.canUseTool` denies out-of-scope calls with
    //     'tool is outside slash-command scope' as an OUTER allow-list that
    //     only ever removes capability (composes with the permission cascade).
    const scope = buildToolScope({
      allowedTools: skillScope,
      tools: runtime.toolPool,
      canUseTool: sessionCanUseTool,
    });

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

    // Task 7.1 — re-seat the turn driver onto the open SDK. The gateway now
    // runs each turn through `createAgent().run()` instead of calling `query()`
    // directly; the orchestration around it (SSE bus, persistMessage,
    // compaction pivot, approval bridge, delegation recorder, the consumption
    // loop) is byte-unchanged.
    //
    // STANDING config = the turn's LIVE values. Live-reload mutates
    // runtime.{provider,model,systemSegments,hookRunner,toolPool,…} BETWEEN
    // turns, never within one, so these are stable for the whole turn. Creating
    // the agent ONCE PER TURN is exactly what preserves live-reload: a `/model`
    // or `/hooks` change between turns is picked up by the next turn's fresh
    // createAgent() (it reads the reloaded runtime refs here). `tools` is the
    // SKILL-SCOPED pool (scope.tools) — a fresh filtered copy, never the shared
    // runtime.toolPool. NOTE: createAgent has no sessionStore/transcripts ports
    // wired here — the gateway owns persistence out-of-band via persistMessage,
    // so passing a store would double-write (mirrors the scheduler re-seat).
    const agent = createAgent({
      provider: runtime.resolvedProvider.transport,
      model: runtime.model,
      systemPrompt: runtime.systemSegments,
      tools: scope.tools,
      hookRunner: runtime.hookRunner,
      microcompactConfig: runtime.microcompactConfig,
      maxTokens: runtime.maxTokens,
      cwd: runtime.cwd,
    });

    // M6 T4 — overflow auto-recovery (M6-02 retry-once). Run the
    // iteration once; if the resulting Terminal carries a
    // context-overflow error, run runtime.compact(), publish
    // compaction_complete, then run the iteration ONCE more against the
    // post-compaction child session id. A second overflow on the retry
    // surfaces via the normal turn-error path below (we do NOT recurse).
    //
    // The iteration is extracted into an inner runOnce() closure so the
    // retry doesn't need to re-derive permission/canUseTool plumbing or
    // rebuild the QueryParams. canUseTool is captured by reference and
    // remains valid across the hop (the session id it was bound to is the
    // OUTER `sessionId` let, which the recovery branch reassigns before the
    // retry — the bound serverAsk continues to publish permission_request
    // events under whatever the current sessionId is at the moment of the
    // ask, which is the POST-COMPACTION id post-retry).
    const runOnce = async (currentMessages: Message[]): Promise<Terminal | undefined> => {
      // Reads outer `sessionId` let — the recovery branch reassigns it between
      // calls. Do not shadow with a local `const sessionId = …` inside this
      // closure; doing so would silently break the recovery hop (the second
      // runOnce would still target the parent session id instead of the
      // post-compaction child).
      // Cancel the in-flight provider stream + tool loop when the bus is
      // disposed (SSE client disconnect or server.stop()). The bus aborts
      // on close(); agent.run() forwards the signal to query(), which
      // propagates it to the provider's streaming http request and tool
      // calls cooperatively, so a stopped server doesn't leave background
      // turns running.
      //
      // PER-HOP override = the values that vary across the compaction pivot
      // WITHIN this turn (the recovery branch reassigns the outer `sessionId`
      // let + re-fetches `sessionCtx`, then calls runOnce again). The standing
      // agent (created once per turn above) carries provider/model/systemPrompt/
      // tools/hookRunner/microcompactConfig/maxTokens/cwd; everything below is
      // rebuilt fresh per hop and wins via PerTurn. `messages` is the run()
      // input (first positional arg), not a PerTurn field.
      const stream = agent.run(currentMessages, {
        // Outer `sessionId` let — reassigned to the post-compaction child id
        // across the recovery hop. The persistence key + hooks/trace target.
        sessionId,
        // Reasoning-depth for THIS session, mutated live by `/effort`
        // (backlog #57 — per-session on the SessionContext). 'off' (the
        // default) → createAgent omits the key → query() byte-identical
        // request. sessionCtx is re-fetched across the compaction-retry hop,
        // so this stays correct.
        effort: sessionCtx.effort,
        // Backlog #43 (D6 fix) — MEMORY.md injection on the server surface.
        // `sessionCtx.memoryManager` is always present (built unconditionally
        // in buildSessionContext).
        memoryManager: sessionCtx.memoryManager,
        // Learning-loop spike Phase 1 — per-session recall thunk. Present only
        // when `learning.recall.enabled`; the conditional spread keeps the
        // field absent otherwise (exactOptionalPropertyTypes + default-off).
        ...(sessionCtx.recall !== undefined ? { recall: sessionCtx.recall } : {}),
        // PER-HOP because it's rebuilt with the pivoted `sessionId` (and the
        // scoped pool sub-agents inherit). buildSessionToolContext re-reads the
        // child SessionContext, so post-compaction tool calls target the child.
        toolContext: buildSessionToolContext(runtime, sessionId, scope.canUseTool, {
          delegationLifecycleRecorder,
          // Sub-agents forked mid-turn inherit the scoped pool.
          effectivePool: scope.tools,
        }),
        // Session-scoped canUseTool: the `ask` callback emits a
        // permission_request event on this session's bus and awaits the
        // matching POST /approvals/:requestId. Feature B wraps it as
        // `scope.canUseTool` so an out-of-scope tool call on a scoped `/skill`
        // turn is denied BEFORE the session gate runs (identity-wrapped — i.e.
        // === sessionCanUseTool — when unscoped). PerTurn-only on createAgent
        // (no standing canUseTool field), so it MUST ride the per-hop slice.
        canUseTool: scope.canUseTool,
        // M7 T3 — server-side trace recorder. Forwards every TraceEvent into
        // the per-session TraceWriter. The closure dereferences sessionCtx
        // dynamically, so post-compaction events land in the child's file.
        traceRecorder,
        signal: turnSignal,
        // Task 7.2 — opt OUT of createAgent's convert-throw-to-terminal default.
        // The three pre-loop async ops query() runs OUTSIDE its per-turn
        // try/catch (memory injection `prefetchSnapshot`, the recall thunk, the
        // UserPromptSubmit hook) can THROW. With `rethrow: true` that throw
        // propagates out of runOnce → the outer catch below → `turn_error`,
        // byte-identical to the pre-7.1 direct-query() drive. Without it the
        // SDK would swallow the throw into `terminal{reason:'error'}` →
        // `turn_complete{finishReason:'error'}` (the 7.1 wire regression).
        // In-loop errors are unaffected (query() RETURNS those terminals).
        rethrow: true,
      });

      // M3 collapses all assistant output onto block 0. Per-block indexing
      // would require tracking the position of each tool_use within its
      // assistant message — deferred until the TUI needs it for richer
      // multi-call rendering (M4+).
      const currentBlock = 0;
      const pendingToolUses = new Map<string, PendingToolUse>();

      // Manual iteration — `for await...of` discards the generator's
      // return value, which is the `Terminal` (the real end-of-turn
      // signal). We need that to inspect Terminal.error for overflow
      // recovery and to emit exactly one wire `turn_complete` per user
      // turn regardless of how many internal model calls query() made.
      while (true) {
        const result = await stream.next();
        if (result.done) {
          // Task 7.1 — agent.run()'s generator-return is a `RunResult`, not a
          // bare `Terminal`. Unwrap `.terminal` so runOnce keeps returning
          // `Terminal | undefined` (the overflow-recovery branch + the
          // turn_complete path below read it unchanged). The yielded
          // `StreamEvent | Message` stream is byte-identical to query()'s by
          // the createAgent stream-passthrough invariant, so the consumption
          // loop is otherwise untouched.
          return result.value.terminal;
        }
        const event = result.value;

        // User-role Messages flow out of query() for tool-result and
        // guidance batches (see core/orchestrator.ts and core/query.ts).
        // Assistant Messages flow out as `assistant_message` StreamEvents,
        // not as bare Message objects — they're handled below.
        if (typeof event === 'object' && event !== null && 'role' in event) {
          handleUserMessage(
            event,
            bus,
            sessionId,
            currentBlock,
            pendingToolUses,
            runtime,
            sessionCtx,
          );
          continue;
        }

        // StreamEvent. Special-case `assistant_message`: it carries the
        // full assistant Message whose `tool_use` content blocks need to
        // be projected onto the wire as `tool_use_start` / `tool_use_done`
        // pairs. Everything else flows through mapStreamEventToServerEvent.
        const streamEvent = event;
        if (streamEvent.type === 'assistant_message') {
          handleAssistantMessage(
            streamEvent.message,
            bus,
            sessionId,
            currentBlock,
            pendingToolUses,
            runtime.toolPool,
            runtime,
            sessionCtx,
          );
          continue;
        }
        // M7 follow-up — capture the most recent usage_delta so
        // recordUsageIfPresent below can populate the sessionDb cost
        // table against the current sessionId. Last writer wins: only
        // the final model response's usage matters for the per-turn
        // cost record (the stream-loop usage-capture half of the
        // recordTokenUsage call site).
        if (streamEvent.type === 'usage_delta') {
          latestUsage = streamEvent.usage;
        }
        const mapped = mapStreamEventToServerEvent(streamEvent, bus, sessionId, currentBlock);
        if (mapped !== null) bus.publish(mapped);
      }
    };

    // Reset latestUsage before each runOnce so a stale usage from a prior
    // model call never gets re-attributed. The mock provider's tool-use
    // path only emits one usage_delta per call so this is belt-and-suspenders
    // on the test surface; the real Anthropic transport emits one per response
    // and the recovery branch below reassigns sessionId before the second
    // runOnce — without this reset, the first call's usage would silently
    // get re-recorded under the post-recovery child id.
    latestUsage = undefined;
    let terminal = await runOnce(messages);
    // Persist this runOnce's usage against the sessionId it ran under
    // (still the parent here; the recovery branch reassigns AFTER this).
    recordUsageIfPresent(sessionId);

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
      // M7 follow-up — clear the first runOnce's usage before the retry so
      // the second runOnce starts fresh. recordUsageIfPresent already fired
      // against the parent sessionId above, so the parent's row is safe;
      // the retry's usage will record below against the post-compaction
      // child sessionId.
      latestUsage = undefined;
      terminal = await runOnce(messages);
      recordUsageIfPresent(sessionId);
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
    // M9 T10 — final status_update flushes the spinner off, plus a live
    // cost/tokens snapshot if usage_delta captured something during the
    // stream. The TUI reads `streaming: false` as the stop signal. Cost is
    // estimated against the resolved provider so the final cost field
    // matches what disposeSessionContext's session_summary will report.
    const finalUsage = latestUsage as TokenUsage | undefined;
    const finalCost =
      finalUsage !== undefined
        ? estimateCostUsd(runtime.resolvedProvider.transport.name, runtime.model, finalUsage)
        : undefined;
    const finalStatusEvent: {
      type: 'status_update';
      seq: number;
      sessionId: string;
      streaming: boolean;
      tokensIn?: number;
      tokensOut?: number;
      cost?: number;
    } = {
      type: 'status_update',
      seq: bus.nextSeq(),
      sessionId,
      streaming: false,
    };
    if (finalUsage !== undefined) {
      if (finalUsage.inputTokens !== undefined) {
        finalStatusEvent.tokensIn = finalUsage.inputTokens;
      }
      if (finalUsage.outputTokens !== undefined) {
        finalStatusEvent.tokensOut = finalUsage.outputTokens;
      }
    }
    if (finalCost !== undefined) {
      finalStatusEvent.cost = finalCost;
    }
    bus.publish(finalStatusEvent);
    bus.publish({
      type: 'turn_complete',
      seq: bus.nextSeq(),
      sessionId,
      finishReason: mapTerminalReason(terminal),
    });
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
    // ux-fixes round 4 — clear the per-turn abort registration so the
    // next POST /turns allocates a fresh controller. Idempotent; safe
    // even if cancelCurrentTurn never fired.
    bus.clearCurrentTurnAbort();
  }
}

/** Emit `tool_use_start` + `tool_use_done` for each `tool_use` block in the
 *  assistant message and stash the call's `tool` / `input` / `renderHint` in
 *  `pending` so the matching `tool_result` wire event can echo them.
 *
 *  Whole-branch review I1 — increments `sessionCtx.trajectoryMetadata
 *  .toolCallCount` exactly once per `tool_use` block so the trajectory
 *  record flushed on disposal carries the actual count. Without this,
 *  every trajectory would ship with `toolCallCount: 0` — the corpus
 *  consumer's per-session activity signal would be dead. */
function handleAssistantMessage(
  msg: AssistantMessage,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  toolPool: readonly Tool<unknown, unknown>[],
  host: PersistMessageHost,
  sessionCtx: SessionContext,
): void {
  // Persist before emitting wire events so resume can reconstruct the full turn even if the SSE subscriber disconnects.
  persistMessage(host, sessionId, {
    role: msg.role,
    content: msg.content,
  });
  for (const contentBlock of msg.content) {
    if (contentBlock.type !== 'tool_use') continue;
    sessionCtx.trajectoryMetadata.toolCallCount += 1;
    const tool = toolPool.find((t) => t.name === contentBlock.name);
    const renderHint: RenderHint = tool?.renderHint ?? { kind: 'text' };
    pending.set(contentBlock.id, {
      tool: contentBlock.name,
      input: contentBlock.input,
      renderHint,
    });
    bus.publish({
      type: 'tool_use_start',
      seq: bus.nextSeq(),
      sessionId,
      block,
      tool: contentBlock.name,
      inputPartial: contentBlock.input,
    });
    bus.publish({
      type: 'tool_use_done',
      seq: bus.nextSeq(),
      sessionId,
      block,
      input: contentBlock.input,
    });
  }
}

/** Drain pending tool_use entries against the user-role message's
 *  `tool_result` content blocks. Non-tool-result user messages
 *  (e.g. loop-detector guidance text injected back into history) are
 *  not wire-meaningful in M3 and are ignored.
 *
 *  Whole-branch review I1 — increments `sessionCtx.trajectoryMetadata
 *  .iterationsUsed` exactly once per `tool_result` block so the
 *  trajectory record flushed on disposal carries the actual iteration
 *  count. Every tool_result that lands is one iteration through the
 *  tool loop, regardless of error state. */
function handleUserMessage(
  msg: Message,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  host: PersistMessageHost,
  sessionCtx: SessionContext,
): void {
  if (msg.role !== 'user') return;
  // Persist all user-role messages (tool_result and guidance) so resume reconstructs exact prior context.
  persistMessage(host, sessionId, {
    role: msg.role,
    content: msg.content,
  });
  for (const contentBlock of msg.content) {
    if (contentBlock.type !== 'tool_result') continue;
    sessionCtx.trajectoryMetadata.iterationsUsed += 1;
    const pendingEntry = pending.get(contentBlock.tool_use_id);
    const tool = pendingEntry?.tool ?? 'unknown';
    const input = pendingEntry?.input ?? null;
    const renderHint = pendingEntry?.renderHint ?? { kind: 'text' };
    const event: ServerEvent = {
      type: 'tool_result',
      seq: bus.nextSeq(),
      sessionId,
      block,
      tool,
      input,
      output: contentBlock.content,
      renderHint: renderHint.kind,
      ...('language' in renderHint && renderHint.language !== undefined
        ? { language: renderHint.language }
        : {}),
    };
    bus.publish(event);
    pending.delete(contentBlock.tool_use_id);
  }
}

/** Translate core/types.Terminal.reason → the wire `finishReason` string.
 *  Keep the model-facing vocabulary (`end_turn`, `max_tokens`, …) on the
 *  wire so the Go TUI doesn't have to know the runtime's internal terms. */
function mapTerminalReason(terminal: Terminal | undefined): string {
  if (!terminal) return 'end_turn';
  switch (terminal.reason) {
    case 'completed':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'max_turns':
      return 'max_turns';
    case 'interrupted':
      return 'interrupted';
    case 'checkin':
      return 'checkin';
    case 'error':
      return 'error';
    default:
      return 'end_turn';
  }
}

/** Pure mapping for the StreamEvent shapes that have a 1:1 wire counterpart.
 *  `assistant_message` is handled separately (it carries the tool_use blocks
 *  the wire needs to project as tool_use_start/_done pairs). `message_stop`
 *  is intentionally NOT mapped — the AsyncGenerator's return value carries
 *  the turn boundary; mapping `message_stop` would emit one `turn_complete`
 *  per internal model call, truncating tool-using turns. See the header. */
function mapStreamEventToServerEvent(
  event: StreamEvent,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
): ServerEvent | null {
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        seq: bus.nextSeq(),
        sessionId,
        block,
        text: event.text,
      };
    case 'thinking_delta':
      return {
        type: 'thinking_delta',
        seq: bus.nextSeq(),
        sessionId,
        block,
        text: event.thinking,
      };
    // message_stop intentionally NOT mapped — see header.
    // assistant_message handled separately in runTurnInBackground.
    // M3 deliberately omits tool_use_delta, usage_delta, message_start,
    // microcompact, loop_detected, route_decision — those wire onto
    // richer ServerEvent types in M4+.
    default:
      return null;
  }
}
