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

import { Hono } from 'hono';
import type { SessionDb } from '../../agent/sessionDb.js';
import { type CompactResult, shouldCompactProactively } from '../../compact/compactor.js';
import { loadPermissionSettings } from '../../config/settings.js';
import { query } from '../../core/query.js';
import type { AssistantMessage, Message, StreamEvent, Terminal } from '../../core/types.js';
import { buildCanUseTool } from '../../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../../permissions/redactSecretsTransformer.js';
import type { CanUseTool } from '../../permissions/types.js';
import { isContextOverflowError } from '../../providers/errors.js';
import type { RenderHint, Tool, ToolContext } from '../../tool/types.js';
import { type ServerEventBus, getOrCreateBus } from '../eventBus.js';
import { type Runtime, createServerAsk } from '../runtime.js';
import type { ServerEvent } from '../schema.js';
import { loadHistoryAsMessages } from '../sessionId.js';

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

export function turnsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/turns', async (c) => {
    const sessionId = c.req.param('id');
    const body = (await c.req.json()) as { text?: string };
    const text = typeof body.text === 'string' ? body.text : '';
    if (text === '') return c.json({ error: 'text is required' }, 400);

    const bus = getOrCreateBus(sessionId);
    // POST /turns is fire-and-forget: kick off the background turn loop
    // and return 202 immediately. The per-session bus buffers events
    // until the SSE subscriber attaches (see eventBus.ts) — that's what
    // keeps the "POST then GET /events" sequence race-free without
    // any in-route awaiting. The `void` discards the returned promise
    // intentionally; runTurnInBackground catches its own errors and
    // publishes them as turn_error events onto the bus.
    void runTurnInBackground(runtime, sessionId, text, bus);
    return c.json({ accepted: true }, 202);
  });

  return r;
}

/** Build the per-turn ToolContext for `runTurnInBackground`'s `query()`
 *  call. Mirrors terminalRepl.ts:958-973 — once buildRuntime constructs the
 *  scheduler + taskManager (T6 + T7), the turn-time context plumbs them
 *  onto the tool surface so AgentTool / task_create / task_list / task_get
 *  / task_output dispatch correctly. Without these four fields populated,
 *  every sub-agent and task tool throws "no scheduler / task manager in
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
): ToolContext {
  return {
    cwd: runtime.cwd,
    sessionId,
    harnessHome: runtime.harnessHome,
    agents: runtime.agents,
    ...(runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}),
    subagentScheduler: runtime.subagentScheduler,
    taskManager: runtime.taskManager,
    parentToolPool: runtime.toolPool,
    canUseTool: sessionCanUseTool,
  };
}

async function runTurnInBackground(
  runtime: Runtime,
  sessionIdInitial: string,
  text: string,
  bus: ServerEventBus,
): Promise<void> {
  // Mutable across the proactive-compaction hop below — once compactSession
  // returns, the rest of the turn (persistence, query(), serverAsk binding)
  // must target the new child session id, not the parent.
  // Declared OUTSIDE the try block so the catch can reference the current
  // sessionId for turn_error attribution (the value at the moment of throw —
  // pre-hop if compact() throws, post-hop if query() throws afterwards).
  let sessionId = sessionIdInitial;
  const userMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text }],
  };
  // Persist before the try block so a query() failure still preserves the user's prompt in the transcript.
  runtime.sessionDb.saveMessage(sessionId, {
    role: userMessage.role,
    content: userMessage.content,
  });
  // Hydrate the model's context with the full conversation history
  // (including the user message we just persisted). T9 hydrates the TUI
  // transcript visually on resume; this is the model-side companion.
  // Without it, the LLM sees only the new turn and responds as if every
  // resume is a fresh session, defeating the persistence work entirely.
  // Local closure binds the helper to the current sessionId — the value
  // changes when the proactive / recovery hops reassign it below, so each
  // hydrate() call picks up the post-hop child id automatically.
  const hydrate = (): Message[] => loadHistoryAsMessages(runtime.sessionDb, sessionId);
  let messages: Message[] = hydrate();

  try {
    // M6 T3 — proactive compaction. If the hydrated history (including the
    // freshly-persisted user message) is over the configured threshold,
    // compact BEFORE handing it to the model. compactSession mints a new
    // child session, persists the summary + retained tail onto it, and
    // records lineage (compactor.ts:145). The rest of the turn pivots onto
    // the child id — including the SSE permission bridge below.
    // Mirrors terminalRepl.ts:1332-1348.
    //
    // Wrapped in the try {} so a compact() failure (summarizer throws,
    // sessionDb write fails, auxiliary provider 429s, etc.) routes through
    // the existing turn_error catch instead of escaping as an unhandled
    // promise rejection — the route's invariant ("runTurnInBackground
    // catches its own errors and publishes them as turn_error events") must
    // hold for compaction failures too.
    //
    // Per-turn compaction budget: this proactive hop and the M6 T4 overflow
    // recovery branch below are INDEPENDENT — both can fire in the same turn
    // if proactive succeeds but the post-proactive query() still surfaces an
    // overflow (e.g., the freshly-compacted context plus a runaway tool loop
    // pushes back over the limit). Mirrors terminalRepl.ts: the `retriedAfter
    // Compact` flag at :1660 guards ONLY the recovery retry, not all
    // compactions per turn. TUI consumers must therefore handle TWO
    // `compaction_complete` events per turn (each with a distinct
    // `activeSessionId`) and pivot to the latest one.
    if (
      shouldCompactProactively({
        messages,
        systemPrompt: runtime.systemSegments,
        contextLength: runtime.resolvedProvider.contextLength,
        threshold: runtime.proactiveCompactThreshold,
      })
    ) {
      const result = await runtime.compact(messages, sessionId, bus.abortSignal);
      // Backlog #36: when the entire history fit within the tail budget,
      // compactSession returns a no-op (parentSessionId === newSessionId,
      // noOp: true) — there's no new child id to pivot onto and no SSE
      // event worth publishing. Skip both. The TUI never sees a phantom
      // marker, the local sessionId stays on the parent, and the next
      // query() call uses the unchanged hydrated messages.
      if (result.noOp !== true) {
        publishCompactionComplete(bus, sessionId, result);
        sessionId = result.newSessionId;
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
      // M5 keeps the session-scoped allow set empty and the persistence
      // hook a no-op (parity with the buildRuntime defaults). Project-local
      // "always" persistence is a deferred follow-up; for now an `always`
      // answer registers an in-memory rule for this turn only.
      alwaysAllow: new Set<string>(),
      ruleLayers: permissionSettings.layers,
      recordAlwaysAllow: () => {
        /* no-op: M5 server doesn't persist session-scoped allow rules. */
      },
    });
    // Defense-in-depth: secrets redactor wraps the resolved canUseTool
    // identically to the runtime-level chain in buildRuntime — catches
    // accidental secret writes in any tool input that gets allowed.
    const sessionCanUseTool = wrapCanUseToolWithTransformers(baseCanUseTool, [
      redactSecretsTransformer,
    ]);

    // M6 T4 — overflow auto-recovery (M6-02 retry-once). Run the iteration
    // once; if the resulting Terminal carries a context-overflow error, run
    // runtime.compact(), publish compaction_complete, then run the iteration
    // ONCE more against the post-compaction child session id. A second
    // overflow on the retry surfaces via the normal turn-error path below
    // (we do NOT recurse). Mirrors src/ui/terminalRepl.ts:1659-1675 — the
    // canonical shape — but adapted to the server's bus/SSE surface.
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
      // on close(); query() propagates the signal to the provider's
      // streaming http request and tool calls cooperatively, so a stopped
      // server doesn't leave background turns running.
      const stream = query({
        provider: runtime.resolvedProvider.transport,
        model: runtime.model,
        messages: currentMessages,
        systemPrompt: runtime.systemSegments,
        tools: runtime.toolPool,
        toolContext: buildSessionToolContext(runtime, sessionId, sessionCanUseTool),
        maxTokens: runtime.maxTokens,
        sessionId,
        cwd: runtime.cwd,
        signal: bus.abortSignal,
        // Session-scoped canUseTool: the `ask` callback emits a
        // permission_request event on this session's bus and awaits the
        // matching POST /approvals/:requestId. Replaces the runtime-level
        // deny placeholder (M3) with the live SSE bridge (M5 T5).
        canUseTool: sessionCanUseTool,
        // Forward the hook runner so UserPromptSubmit fires before turn 0,
        // PreToolUse/PostToolUse fire around each tool call, and Stop fires
        // at terminal. Constructed in buildRuntime (M5 T1); always present
        // — a no-op when no hooks are configured.
        hookRunner: runtime.hookRunner,
        // Microcompaction config — buildRuntime always populates this from
        // userSettings.microcompaction. Without it, query() would fall back
        // to DEFAULT_MICROCOMPACT_CONFIG and ignore the user's settings.
        microcompactConfig: runtime.microcompactConfig,
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
          return result.value;
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
            runtime.sessionDb,
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
            runtime.sessionDb,
          );
          continue;
        }
        const mapped = mapStreamEventToServerEvent(streamEvent, bus, sessionId, currentBlock);
        if (mapped !== null) bus.publish(mapped);
      }
    };

    let terminal = await runOnce(messages);

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
    // Per-turn compaction budget (Path A): this branch fires INDEPENDENTLY
    // of the proactive block above. If proactive ALREADY compacted earlier
    // in this turn, this recovery hop still runs — the local `sessionId` at
    // that point is the post-proactive child id, so the recovery's
    // `compaction_complete` carries that child as the parent and a NEW
    // grandchild as the activeSessionId. Mirrors terminalRepl.ts's
    // `retriedAfterCompact` flag at :1660, which guards ONLY this recovery
    // retry (not all per-turn compactions). The third test in
    // tests/server/turns.overflowRecovery.test.ts pins the two-event shape.
    if (terminal?.reason === 'error' && isContextOverflowError(terminal.error)) {
      const compactResult = await runtime.compact(messages, sessionId, bus.abortSignal);
      // Backlog #36: a no-op result here means compaction couldn't free up
      // any headroom (entire history already fit in the tail budget — the
      // overflow was driven by the system prompt or a single oversized
      // tool result the tail keeper preserved). No new session id to pivot
      // onto, no wire event worth publishing. Falling straight through to
      // a same-session retry would just hit the same overflow, so skip the
      // retry entirely and surface the original overflow via the normal
      // turn_error path below — `terminal` already carries it.
      if (compactResult.noOp === true) {
        if (!bus.isClosed()) {
          bus.publish({
            type: 'turn_error',
            seq: bus.nextSeq(),
            sessionId,
            error:
              terminal.error?.message ?? 'context overflow with no compactable history to recover',
            recoverable: false,
          });
        }
        return;
      }
      publishCompactionComplete(bus, sessionId, compactResult);
      sessionId = compactResult.newSessionId;
      messages = hydrate();
      terminal = await runOnce(messages);
      // M6-02 retry-once: if the retry's terminal also carries an overflow
      // error, surface it as turn_error rather than turn_complete (the
      // post-recovery overflow is a distinct failure surface — "compaction
      // didn't yield enough headroom" — that the TUI should not gloss as a
      // normal turn end). Mirrors the second-overflow contract pinned by
      // the M6 T4 test.
      if (terminal?.reason === 'error' && isContextOverflowError(terminal.error)) {
        if (!bus.isClosed()) {
          bus.publish({
            type: 'turn_error',
            seq: bus.nextSeq(),
            sessionId,
            error: terminal.error?.message ?? 'context overflow after compaction',
            recoverable: false,
          });
        }
        return;
      }
    }

    if (!bus.isClosed()) {
      bus.publish({
        type: 'turn_complete',
        seq: bus.nextSeq(),
        sessionId,
        finishReason: mapTerminalReason(terminal),
      });
    }
  } catch (err) {
    bus.publish({
      type: 'turn_error',
      seq: bus.nextSeq(),
      sessionId,
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  }
}

/** Emit `tool_use_start` + `tool_use_done` for each `tool_use` block in the
 *  assistant message and stash the call's `tool` / `input` / `renderHint` in
 *  `pending` so the matching `tool_result` wire event can echo them. */
function handleAssistantMessage(
  msg: AssistantMessage,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  toolPool: readonly Tool<unknown, unknown>[],
  sessionDb: SessionDb,
): void {
  // Persist before emitting wire events so resume can reconstruct the full turn even if the SSE subscriber disconnects.
  sessionDb.saveMessage(sessionId, {
    role: msg.role,
    content: msg.content,
  });
  for (const contentBlock of msg.content) {
    if (contentBlock.type !== 'tool_use') continue;
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
 *  not wire-meaningful in M3 and are ignored. */
function handleUserMessage(
  msg: Message,
  bus: ServerEventBus,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  sessionDb: SessionDb,
): void {
  if (msg.role !== 'user') return;
  // Persist all user-role messages (tool_result and guidance) so resume reconstructs exact prior context.
  sessionDb.saveMessage(sessionId, {
    role: msg.role,
    content: msg.content,
  });
  for (const contentBlock of msg.content) {
    if (contentBlock.type !== 'tool_result') continue;
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
