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
import { repairMissingToolResults } from '../core/transcriptRepair.js';
import type { AssistantMessage } from '../core/types.js';
import type { LLMProvider } from '../providers/types.js';
import { AgentRunner } from '../runtime/agentRunner.js';
import { buildSessionToolContext } from '../server/routes/turns.js';
import type { Runtime } from '../server/runtime.js';
import { loadHistoryAsMessages } from '../server/sessionId.js';
import { assertChannelPermissionMode, buildChannelCanUseTool } from './permission.js';
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
 *  verdict). See the module header for the full contract. */
export async function runChannelTurn(opts: RunChannelTurnOpts): Promise<RunChannelTurnResult> {
  const mode = opts.permissionMode ?? 'default';
  // Reject 'bypass' (and any non-'default'/'ask' value) BEFORE creating a row
  // or calling the provider — a channel turn must never grant allow-on-
  // fallthrough from an untrusted source.
  assertChannelPermissionMode(mode);

  const { runtime, msg, principalId } = opts;

  // Deterministic per-conversation session id. find-or-create (upsertSession):
  // the FIRST message seeds the row with its owner + platform + metadata; the
  // SECOND reuses the same row so the conversation is continuous (history is
  // never reset). The owner is the load-bearing Phase E stamp — buildSession
  // Context reads it back as `userId`.
  const sessionId = buildSessionKey(msg);
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
    // threaded — a channel turn has no live UI consumer (mirrors cron).
    const toolContext = buildSessionToolContext(runtime, sessionId, canUseTool);

    // Conversational coherence: hydrate the session's PRIOR history into the
    // turn so the model can follow up + remember what was just said. We just
    // upserted the row and persisted the new user message above, so
    // `loadHistoryAsMessages` returns exactly `[...priorMessages, newUserMessage]`
    // — the same projection the interactive turns route's `hydrate()` uses.
    // `repairMissingToolResults` synthesizes any missing tool_result for an
    // orphaned tool_use in the persisted history (e.g. a prior turn that
    // crashed mid-tool-call) so the next turn doesn't reject as invalid — the
    // same M10-audit repair the turns route applies. AgentRunner never writes
    // to the DB, so feeding the persisted history back as the seed does NOT
    // re-persist the new user message (the pipeline saved it exactly once,
    // above). Without `initialMessages`, AgentRunner would seed ONLY the new
    // user message and the model would cold-start every channel message.
    const rawHistory = loadHistoryAsMessages(runtime.sessionDb, sessionId);
    const { messages: hydratedMessages, insertedToolResults } =
      repairMissingToolResults(rawHistory);
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
      // Seed the full hydrated history (prior turns + the new user message)
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
    // conversation.
    await runtime.disposeSession(sessionId);
  }
}
