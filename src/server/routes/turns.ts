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
import { query } from '../../core/query.js';
import type { AssistantMessage, Message, StreamEvent, Terminal } from '../../core/types.js';
import type { RenderHint, Tool } from '../../tool/types.js';
import { type ServerEventBus, getOrCreateBus } from '../eventBus.js';
import type { Runtime } from '../runtime.js';
import type { ServerEvent } from '../schema.js';

/** State captured at `tool_use_start` emission, drained when the matching
 *  `tool_result` arrives so the tool_result wire event can echo the same
 *  `tool` / `input` / `renderHint` without re-deriving them. Keyed by the
 *  Anthropic `tool_use_id` produced by the model. */
type PendingToolUse = {
  tool: string;
  input: unknown;
  renderHint: RenderHint;
};

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

async function runTurnInBackground(
  runtime: Runtime,
  sessionId: string,
  text: string,
  bus: ServerEventBus,
): Promise<void> {
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
  const messages: Message[] = runtime.sessionDb.loadMessages(sessionId).map(
    (m): Message => ({
      role: m.role as Message['role'],
      content: m.content,
    }),
  );

  try {
    // Cancel the in-flight provider stream + tool loop when the bus is
    // disposed (SSE client disconnect or server.stop()). The bus aborts
    // on close(); query() propagates the signal to the provider's
    // streaming http request and tool calls cooperatively, so a stopped
    // server doesn't leave background turns running.
    const stream = query({
      provider: runtime.resolvedProvider.transport,
      model: runtime.model,
      messages,
      systemPrompt: runtime.systemSegments,
      tools: runtime.toolPool,
      toolContext: {
        cwd: runtime.cwd,
        sessionId,
        harnessHome: runtime.harnessHome,
        agents: runtime.agents,
        ...(runtime.bundle ? { bundleRoot: runtime.bundle.root } : {}),
      },
      maxTokens: runtime.maxTokens,
      sessionId,
      cwd: runtime.cwd,
      signal: bus.abortSignal,
      // Without this the orchestrator falls back to runtime-default
      // `ask` mode on any non-read-only tool — the server-side ask
      // path has no interactive surface and the TUI hangs. See the
      // permission cascade in src/server/runtime.ts.
      canUseTool: runtime.canUseTool,
      // Forward the hook runner so UserPromptSubmit fires before turn 0,
      // PreToolUse/PostToolUse fire around each tool call, and Stop fires
      // at terminal. Constructed in buildRuntime (M5 T1); always present
      // — a no-op when no hooks are configured.
      hookRunner: runtime.hookRunner,
    });

    // M3 collapses all assistant output onto block 0. Per-block indexing
    // would require tracking the position of each tool_use within its
    // assistant message — deferred until the TUI needs it for richer
    // multi-call rendering (M4+).
    const currentBlock = 0;
    const pendingToolUses = new Map<string, PendingToolUse>();
    let terminalEmitted = false;

    // Manual iteration — `for await...of` discards the generator's
    // return value, which is the `Terminal` (the real end-of-turn
    // signal). We need that to emit exactly one wire `turn_complete`
    // per user turn regardless of how many internal model calls
    // query() made.
    while (true) {
      const result = await stream.next();
      if (result.done) {
        if (!bus.isClosed() && !terminalEmitted) {
          const terminal: Terminal | undefined = result.value;
          bus.publish({
            type: 'turn_complete',
            seq: bus.nextSeq(),
            sessionId,
            finishReason: mapTerminalReason(terminal),
          });
          terminalEmitted = true;
        }
        break;
      }
      const event = result.value;

      // User-role Messages flow out of query() for tool-result and
      // guidance batches (see core/orchestrator.ts and core/query.ts).
      // Assistant Messages flow out as `assistant_message` StreamEvents,
      // not as bare Message objects — they're handled below.
      if (typeof event === 'object' && event !== null && 'role' in event) {
        handleUserMessage(event, bus, sessionId, currentBlock, pendingToolUses, runtime.sessionDb);
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
