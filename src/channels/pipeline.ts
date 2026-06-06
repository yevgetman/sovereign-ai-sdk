// Phase F-T2 — the channel-agnostic inbound→turn→outbound pipeline.
//
// `runChannelTurn` is the core every channel adapter (Telegram / Slack /
// webhook, Phase F-T4/5/6) drives: it maps an InboundMessage to a
// per-(channel, sender) session OWNED by the channel's principal (Phase E
// isolation) and runs ONE headless turn under the safe channel permission
// posture (F-T1). It returns the model's user-facing reply, or a silent verdict
// when the model declined to respond.
//
// It mirrors the cron headless-turn pattern (src/cron/wiring.ts):
//   - find-or-create the session row (upsertSession) keyed by the deterministic
//     per-conversation session id (buildSessionKey) so a channel conversation
//     is CONTINUOUS — the second message reuses the same row and history grows;
//   - stamp `owner` = the channel principal so buildSessionContext derives
//     `userId` from the row (the single Phase E source) and scopes BOTH memory
//     and the learning corpus under users/{principal}/… ;
//   - filter the parent tool pool against SUBAGENT_EXCLUDED_TOOLS (a channel
//     turn is a non-interactive child, same ceiling as cron);
//   - run the turn under `buildChannelCanUseTool` — NEVER the local dev's
//     layered allow-rules, NEVER bypass: an untrusted remote message can't ride
//     a developer's `allow: Bash(*)` and any 'ask' fallthrough auto-denies;
//   - drain the AgentRunner to terminal, extract the final assistant text;
//   - dispose the in-memory session context in a finally (reclaims trace/
//     learning writers) WHILE the DB row persists for the next message.
//
// Delivery (writing the reply back out over the channel transport) is the
// adapter's job (ChannelAdapter.deliver); this pipeline only produces the
// reply text + the silent verdict.

import { SUBAGENT_EXCLUDED_TOOLS } from '../agents/exclusions.js';
import type { AssistantMessage } from '../core/types.js';
import type { LLMProvider } from '../providers/types.js';
import { AgentRunner } from '../runtime/agentRunner.js';
import { buildSessionToolContext } from '../server/routes/turns.js';
import type { Runtime } from '../server/runtime.js';
import { loadHistoryAsMessages } from '../server/sessionId.js';
import { assertChannelPermissionMode, buildChannelCanUseTool } from './permission.js';
import { capSeededHistory } from './seedHistory.js';
import { buildSessionKey } from './sessionKey.js';
import type { InboundMessage } from './types.js';

/** `[silent]` (case-insensitive, post-trimStart) short-circuits delivery —
 *  matches the convention in src/channels/delivery.ts so a model can decline to
 *  respond on a channel by prefixing its reply. */
const SILENT_PREFIX = '[silent]';

/** Default cap on per-channel-turn agent iterations. Matches the AgentRunner
 *  built-in default but is set explicitly so a future config knob has a single
 *  place to thread through (mirrors DEFAULT_CRON_MAX_TURNS). */
const DEFAULT_CHANNEL_MAX_TURNS = 10;

/** Fix 2(b) — user-facing fallback when a turn ends on a non-completed terminal
 *  (provider error, max_turns, interrupted, …) with no usable assistant text.
 *  Returning this instead of `{ silent: true }` means the user never gets pure
 *  silence on an error — they get a recoverable nudge to retry. Kept generic so
 *  it never leaks internal error detail over an untrusted channel. */
const ERROR_FALLBACK_TEXT = 'Sorry — I hit an error handling that. Please try again.';

/** Fix 3 — per-`sessionId` serialization chain. Two messages from one sender map
 *  to the SAME deterministic `sessionId`; Slack (fire-and-forget) + webhook
 *  (concurrent HTTP) can drive two `runChannelTurn` on that id at once. Both
 *  would share the cached SessionContext, and whichever's `finally` fires first
 *  would `disposeSession` (closing the trace writer + draining the observer +
 *  writing the trajectory) WHILE the other turn is still live — a context
 *  disposed under a running turn + a double/lost trajectory write. We serialize
 *  by chaining each turn onto a per-session promise so a second turn for the
 *  same session waits for the first to FULLY complete (including its
 *  finally/dispose) before starting. The map entry is reclaimed when its chain
 *  drains (see `serializePerSession`) so there's no unbounded growth. Module-
 *  level so it spans every adapter calling into this pipeline within a process. */
const sessionTurnChains = new Map<string, Promise<unknown>>();

/** Run `task` after any in-flight turn for `sessionId` completes, chaining the
 *  next caller behind this one. Cleans up the map entry once the chain it
 *  installed has fully drained (and no newer turn has replaced it), so the map
 *  never grows without bound. */
function serializePerSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const prior = sessionTurnChains.get(sessionId) ?? Promise.resolve();
  // Chain AFTER the prior turn settles (success OR failure) so a thrown turn
  // never wedges the queue. `.then(task, task)` runs `task` on both paths.
  const next = prior.then(task, task);
  sessionTurnChains.set(sessionId, next);
  // Reclaim the map slot once this chain drains — but only if nothing newer has
  // taken its place (a later turn may have already overwritten the entry).
  const cleanup = (): void => {
    if (sessionTurnChains.get(sessionId) === next) {
      sessionTurnChains.delete(sessionId);
    }
  };
  next.then(cleanup, cleanup);
  return next;
}

export type RunChannelTurnOpts = {
  runtime: Runtime;
  msg: InboundMessage;
  /** The authenticated channel principal that owns the session. Stamped as the
   *  row's `owner` and (via buildSessionContext) the per-turn ToolContext
   *  `userId`, so Phase E scopes memory + learning to this principal. */
  principalId: string;
  /** Channel permission posture. Defaults to 'default'. 'bypass' is rejected
   *  by assertChannelPermissionMode before any turn runs. */
  permissionMode?: 'default' | 'ask';
};

export type RunChannelTurnResult = {
  /** The model's user-facing reply. Absent when `silent` is true. */
  text?: string;
  /** True when the model declined to respond (empty reply or a `[SILENT]`
   *  prefix). The adapter delivers nothing in that case. */
  silent?: boolean;
};

/** Extract the final assistant text from an AgentRunner result: join all text
 *  blocks of the last assistant message, trim. Tool-use + thinking blocks are
 *  dropped — the channel recipient sees only the user-facing text. Mirrors the
 *  cron `extractFinalText` helper (src/cron/wiring.ts). */
function extractFinalText(assistant: AssistantMessage | undefined): string {
  if (!assistant) return '';
  return assistant.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Run one headless channel turn end-to-end: source the per-sender session,
 *  run the turn under the safe channel posture, return the reply (or a silent
 *  verdict). See the module header for the full contract.
 *
 *  Two guards run BEFORE the per-session serialization (they must reject fast
 *  and, for the empty-text guard, create NO row): the bypass-mode rejection and
 *  the empty/whitespace short-circuit (Fix 4). The actual turn — find-or-create,
 *  persist, run, dispose — is funneled through `serializePerSession` (Fix 3) so
 *  two concurrent messages from one sender can't race the shared SessionContext
 *  into a double-dispose. */
export async function runChannelTurn(opts: RunChannelTurnOpts): Promise<RunChannelTurnResult> {
  const mode = opts.permissionMode ?? 'default';
  // Reject 'bypass' (and any non-'default'/'ask' value) BEFORE creating a row
  // or calling the provider — a channel turn must never grant allow-on-
  // fallthrough from an untrusted source.
  assertChannelPermissionMode(mode);

  const { runtime, msg, principalId } = opts;

  // Fix 4 — empty/whitespace inbound text is a no-op. Guard centrally so all
  // three adapters (telegram / slack / webhook) are consistent: the webhook
  // currently accepts `""` and slack/telegram only reject length-0 (not a
  // whitespace-only payload). Short-circuit BEFORE upsert + persist + the
  // provider call so an empty message runs no billable turn and leaves no row.
  if (msg.text.trim() === '') {
    return { silent: true };
  }

  const sessionId = buildSessionKey(msg);
  // Fix 3 — serialize per sessionId so a second concurrent turn for the same
  // (channel, sender) waits for this one to FULLY complete (incl. dispose).
  return serializePerSession(sessionId, () =>
    runChannelTurnInner({ runtime, msg, principalId, mode, sessionId }),
  );
}

/** The serialized body of a channel turn. Assumes the caller already validated
 *  the permission mode + non-empty text and computed `sessionId`. */
async function runChannelTurnInner(args: {
  runtime: Runtime;
  msg: InboundMessage;
  principalId: string;
  mode: 'default' | 'ask';
  sessionId: string;
}): Promise<RunChannelTurnResult> {
  const { runtime, msg, principalId, mode, sessionId } = args;

  // Deterministic per-conversation session id. find-or-create (upsertSession):
  // the FIRST message seeds the row with its owner + platform + metadata; the
  // SECOND reuses the same row so the conversation is continuous (history is
  // never reset). The owner is the load-bearing Phase E stamp — buildSession
  // Context reads it back as `userId`.
  runtime.sessionDb.upsertSession({
    sessionId,
    owner: principalId,
    platform: msg.channel,
    model: runtime.model,
    provider: runtime.resolvedProvider.transport.name,
    systemPrompt: runtime.systemSegments,
    metadata: { kind: 'channel', channel: msg.channel, sender: msg.sender },
    title: `${msg.channel}:${msg.sender}`,
  });

  // Persist the inbound user message BEFORE the turn so a provider failure
  // still preserves it in the transcript (mirrors the turns route). Accruing
  // messages on the reused row is what makes a channel conversation
  // CONTINUOUS — the next message lands on the same session and the history
  // grows rather than resetting.
  runtime.sessionDb.saveMessage(sessionId, {
    role: 'user',
    content: [{ type: 'text', text: msg.text }],
  });

  try {
    // Safe channel posture (F-T1): no local-allow inheritance, ask auto-denies,
    // bypass already rejected above. Bash / Write / Edit are denied; read-only
    // tools still run.
    const canUseTool = buildChannelCanUseTool({ mode });

    // A channel turn is a non-interactive child: filter the parent pool against
    // the subagent exclusion set (same ceiling as cron — drops AgentTool,
    // task_stop, send_message, cron CRUD, etc.).
    const channelToolPool = runtime.toolPool.filter(
      (tool) => !SUBAGENT_EXCLUDED_TOOLS.has(tool.name),
    );

    // Canonical session-scoped ToolContext. It derives `userId` from the row's
    // ownerId (stamped above) so memory + learning route under the channel
    // principal's namespace (Phase E). No SSE bus / delegation recorder is
    // threaded — a channel turn has no live UI consumer (mirrors cron). This
    // also builds (and caches) the SessionContext we read memoryManager + recall
    // off of below.
    const toolContext = buildSessionToolContext(runtime, sessionId, canUseTool);
    // Fix 1 — the SAME per-session context the ToolContext above was built from.
    // It carries the owner-scoped memoryManager (always present) and the recall
    // thunk (present only when recall is enabled), which we thread into the
    // AgentRunner so a channel turn participates in the learning loop exactly
    // like the interactive turns route does. Without this, a channel turn never
    // injected MEMORY.md, never ran recall, and never wrote memory back.
    const sessionCtx = runtime.getSessionContext(sessionId);

    // Conversational coherence: hydrate the session's PRIOR history into the
    // turn so the model can follow up + remember what was just said. We just
    // upserted the row and persisted the new user message above, so
    // `loadHistoryAsMessages` returns exactly `[...priorMessages, newUserMessage]`
    // — the same projection the interactive turns route's `hydrate()` uses.
    //
    // Fix 2(a) — cap the seed to a bounded tail so a long-running conversation
    // never overflows the model's context window (compaction isn't viable here:
    // it would pivot to a new child session id and break the deterministic
    // `buildSessionKey` continuity). `capSeededHistory` takes the last N
    // messages, drops any leading orphan tool_result so the seed is provider-
    // valid, and runs `repairMissingToolResults` over the retained window (the
    // same M10-audit repair the turns route applies — e.g. a prior turn that
    // crashed mid-tool-call). AgentRunner never writes to the DB, so feeding the
    // seed back does NOT re-persist the new user message (the pipeline saved it
    // exactly once, above). Without `initialMessages`, AgentRunner would seed
    // ONLY the new user message and the model would cold-start every message.
    const rawHistory = loadHistoryAsMessages(runtime.sessionDb, sessionId);
    const { messages: hydratedMessages, insertedToolResults } = capSeededHistory(rawHistory);
    if (insertedToolResults > 0) {
      process.stderr.write(
        `[repair] synthesized ${insertedToolResults} missing tool_result block(s) for channel session ${sessionId}\n`,
      );
    }

    const runner = new AgentRunner({
      provider: runtime.resolvedProvider.transport as unknown as LLMProvider,
      model: runtime.model,
      systemPrompt: runtime.systemSegments,
      maxTokens: runtime.maxTokens,
      tools: channelToolPool,
      toolContext,
      canUseTool,
      maxTurns: DEFAULT_CHANNEL_MAX_TURNS,
      sessionId,
      cwd: runtime.cwd,
      // Fix 1 — thread memory + recall (mirrors the turns route). memoryManager
      // is always present; recall is conditionally spread so a recall-disabled
      // session stays inert (matches `...(recall ? { recall } : {})`).
      memoryManager: sessionCtx.memoryManager,
      ...(sessionCtx.recall !== undefined ? { recall: sessionCtx.recall } : {}),
      // Seed the bounded hydrated history (prior turns + the new user message)
      // instead of a single-message prompt seed.
      initialMessages: hydratedMessages,
    });

    // The prompt arg is ignored when `initialMessages` is set (the new user
    // message is already the tail of the hydrated seed); pass it for clarity.
    const gen = runner.run(msg.text);
    let step: Awaited<ReturnType<typeof gen.next>>;
    for (;;) {
      step = await gen.next();
      if (step.done) break;
      // StreamEvents + per-turn Messages are drained but not surfaced — a
      // channel turn has no streaming UI consumer; the terminal value is what
      // matters.
    }
    const result = step.value;

    // Persist the assistant turn so the conversation transcript accrues on the
    // reused row (the second half of conversation continuity). Saved verbatim —
    // the full assistant content, not just the extracted text — so a future
    // resume reconstructs the exact turn.
    if (result.finalAssistant) {
      runtime.sessionDb.saveMessage(sessionId, {
        role: 'assistant',
        content: result.finalAssistant.content,
      });
    }

    const text = extractFinalText(result.finalAssistant);

    // Fix 2(b) — surface a NON-silent error on a non-completed terminal. A
    // provider error / max_turns / interrupted terminal often leaves no usable
    // assistant text; pre-fix that fell through to `{ silent: true }`, so the
    // user got pure silence on an error (and, combined with the now-fixed
    // unbounded seed, a permanently bricked conversation). When the terminal is
    // not `completed` AND there's no usable text, return the user-facing
    // fallback so the user always gets *something* and can retry. Mirrors the
    // cron wiring's terminal-reason inspection (src/cron/wiring.ts:165-176).
    if (result.terminal.reason !== 'completed' && text === '') {
      return { text: ERROR_FALLBACK_TEXT };
    }

    // Silent verdict: empty reply or a `[SILENT]` prefix (case-insensitive,
    // post-trimStart — matches delivery.ts). The adapter delivers nothing.
    if (text === '' || text.trimStart().toLowerCase().startsWith(SILENT_PREFIX)) {
      return { silent: true };
    }
    return { text };
  } finally {
    // Always reclaim the in-memory session context (trace writer flush,
    // trajectory write, learning drain, review dispose) — even on agent error.
    // The DB row itself stays so the next channel message resumes the
    // conversation. Serialized by `serializePerSession` so no concurrent turn
    // for this session is mid-flight when this dispose runs.
    await runtime.disposeSession(sessionId);
  }
}
