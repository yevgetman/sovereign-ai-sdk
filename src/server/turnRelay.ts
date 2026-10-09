// Turn event relay — projects one `createAgent().run()` stream onto
// `ServerEvent`s (text/thinking deltas, tool_use_start/_done, tool_result)
// and, when the host owns persistence, writes each message through
// `persistMessage`. Moved from src/server/routes/turns.ts so the gateway route
// and the headless SDK host share one projection.
//
// Single-writer switch: `persist` is the PersistMessageHost for the gateway
// (legacy callbacks write every message), or `undefined` when createAgent was
// given SessionStore/TranscriptStore ports — then the SDK is the only writer
// and the relay never persists, so no message is written twice.

import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { RenderHint, Tool } from '@yevgetman/sov-sdk/tool/types';
import { type PersistMessageHost, persistMessage } from '../agent/persistMessage.js';
import type { ServerEventBus } from './eventBus.js';
import type { ServerEvent } from './schema.js';
import type { SessionContext } from './sessionContext.js';

/** The part of a ServerEventBus the relay writes to. An in-memory sink with
 *  the same two methods works for a host with no SSE listener. */
export type TurnEventSink = Pick<ServerEventBus, 'publish' | 'nextSeq'>;

/** State captured at `tool_use_start` emission, drained when the matching
 *  `tool_result` arrives so the tool_result wire event can echo the same
 *  `tool` / `input` / `renderHint` without re-deriving them. Keyed by the
 *  Anthropic `tool_use_id` produced by the model. */
type PendingToolUse = {
  tool: string;
  input: unknown;
  renderHint: RenderHint;
};

/** Item 3 — process-level guard so the buffered-delivery diagnostic warns
 *  exactly once. The condition (conduct bound + a text-bearing final message
 *  that never streamed a delta) is a configuration footgun worth announcing,
 *  but repeating it on every buffered turn would flood the gateway log. */
let bufferedDeliveryWarned = false;

/** Emit `tool_use_start` + `tool_use_done` for each `tool_use` block in the
 *  assistant message and stash the call's `tool` / `input` / `renderHint` in
 *  `pending` so the matching `tool_result` wire event can echo them.
 *
 *  Whole-branch review I1 — increments `sessionCtx.trajectoryMetadata
 *  .toolCallCount` exactly once per `tool_use` block so the trajectory
 *  record flushed on disposal carries the actual count. Without this,
 *  every trajectory would ship with `toolCallCount: 0` — the corpus
 *  consumer's per-session activity signal would be dead.
 *
 *  Item 3 — buffered-mode delivery. In buffered (non-streaming) mode the
 *  provider emits ZERO `text_delta` events; the whole answer arrives here on
 *  the final (POST-governor) `assistant_message`. When nothing streamed this
 *  turn (`sawTextDelta === false`), each `type:'text'` block is projected onto
 *  the wire as a `text_delta` server event (reusing the existing shape — zero
 *  client change) so the live UI shows the answer. When ANY delta streamed the
 *  branch is skipped, keeping the streaming path byte-identical (the wire keeps
 *  the original streamed text, never the possibly-substituted accumulated
 *  message). `thinking` blocks are NEVER projected — only assistant text. */
function handleAssistantMessage(
  msg: AssistantMessage,
  bus: TurnEventSink,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  toolPool: readonly Tool<unknown, unknown>[],
  persist: PersistMessageHost | undefined,
  sessionCtx: SessionContext,
  sawTextDelta: boolean,
  conductBound: boolean,
): void {
  // Persist before emitting wire events so resume can reconstruct the full turn even if the SSE subscriber disconnects.
  // Skipped when the SDK store ports own persistence (single writer).
  if (persist !== undefined) {
    persistMessage(persist, sessionId, {
      role: msg.role,
      content: msg.content,
    });
  }
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

  // Item 3 — buffered-mode delivery. Streaming already put the text on the
  // wire (delta-by-delta), so only project when NOTHING streamed this turn.
  if (sawTextDelta) return;
  let deliveredText = false;
  for (const contentBlock of msg.content) {
    if (contentBlock.type !== 'text') continue;
    deliveredText = true;
    bus.publish({
      type: 'text_delta',
      seq: bus.nextSeq(),
      sessionId,
      block,
      text: contentBlock.text,
    });
  }
  // The footgun announces itself: a bound conduct pack + a text-bearing final
  // message that never streamed a delta means the provider ran buffered and
  // the live UI would have shown nothing without this branch. Warn once.
  if (deliveredText && conductBound && !bufferedDeliveryWarned) {
    bufferedDeliveryWarned = true;
    console.warn(
      '[gateway] buffered-mode delivery: a conduct pack is bound and a turn produced a text-bearing final message with zero streamed text_delta — delivering the final text to the live SSE. The provider ran in buffered (non-streaming) mode; live output arrives only at turn end.',
    );
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
  bus: TurnEventSink,
  sessionId: string,
  block: number,
  pending: Map<string, PendingToolUse>,
  persist: PersistMessageHost | undefined,
  sessionCtx: SessionContext,
): void {
  if (msg.role !== 'user') return;
  // Persist all user-role messages (tool_result and guidance) so resume reconstructs exact prior context.
  // Skipped when the SDK store ports own persistence (single writer).
  if (persist !== undefined) {
    persistMessage(persist, sessionId, {
      role: msg.role,
      content: msg.content,
    });
  }
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
export function mapTerminalReason(terminal: Terminal | undefined): string {
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
  bus: TurnEventSink,
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

export type RelayTurnOptions = {
  sink: TurnEventSink;
  /** The session id THIS drive runs as (post any compaction pivot). */
  sessionId: string;
  sessionCtx: SessionContext;
  /** Pool used to look up a tool's renderHint for the wire. */
  toolPool: readonly Tool<unknown, unknown>[];
  /** PersistMessageHost when the host owns persistence; undefined when the
   *  createAgent store ports do (see the module header). */
  persist: PersistMessageHost | undefined;
  /** A conduct provider is bound (drives the buffered-delivery warning). */
  conductBound: boolean;
  /** True once any text_delta streamed earlier in this user turn (a prior
   *  hop); suppresses the buffered-delivery projection. */
  sawTextDelta: boolean;
  /** Called with every StreamEvent before it is projected (usage
   *  accumulation). Messages are not passed. */
  onStreamEvent?: (event: StreamEvent) => void;
};

export type RelayTurnResult = {
  result: RunResult;
  /** `sawTextDelta` after this drive — thread it into the next hop. */
  sawTextDelta: boolean;
};

/**
 * Drive one `agent.run()` stream to its RunResult, projecting events onto the
 * sink. Manual iteration — `for await...of` would discard the generator's
 * return value, which carries the Terminal (the real end-of-turn signal; one
 * `message_stop` fires per internal model call and must not end the turn).
 */
export async function relayAgentRun(
  stream: AsyncGenerator<StreamEvent | Message, RunResult>,
  opts: RelayTurnOptions,
): Promise<RelayTurnResult> {
  const { sink, sessionId, sessionCtx, toolPool, persist, conductBound } = opts;
  let sawTextDelta = opts.sawTextDelta;
  // M3 collapses all assistant output onto block 0. Per-block indexing
  // would require tracking the position of each tool_use within its
  // assistant message — deferred until the TUI needs it for richer
  // multi-call rendering (M4+).
  const currentBlock = 0;
  const pendingToolUses = new Map<string, PendingToolUse>();
  while (true) {
    const step = await stream.next();
    if (step.done) return { result: step.value, sawTextDelta };
    const event = step.value;

    // User-role Messages flow out of query() for tool-result and
    // guidance batches (see core/orchestrator.ts and core/query.ts).
    // Assistant Messages flow out as `assistant_message` StreamEvents,
    // not as bare Message objects — they're handled below.
    if (typeof event === 'object' && event !== null && 'role' in event) {
      handleUserMessage(event, sink, sessionId, currentBlock, pendingToolUses, persist, sessionCtx);
      continue;
    }

    opts.onStreamEvent?.(event);
    if (event.type === 'assistant_message') {
      handleAssistantMessage(
        event.message,
        sink,
        sessionId,
        currentBlock,
        pendingToolUses,
        toolPool,
        persist,
        sessionCtx,
        sawTextDelta,
        conductBound,
      );
      continue;
    }
    const mapped = mapStreamEventToServerEvent(event, sink, sessionId, currentBlock);
    if (mapped !== null) {
      // Item 3 — record that live text streamed this turn. Guards the
      // buffered-delivery branch in handleAssistantMessage so a streaming
      // turn never double-delivers its final (post-governor) text.
      if (mapped.type === 'text_delta') sawTextDelta = true;
      sink.publish(mapped);
    }
  }
}
