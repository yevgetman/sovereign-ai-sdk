// src/agent/createAgent.ts — the public `createAgent()` assembler (Phase 3 /
// Task 3.1). OPEN core: the SDK centerpiece.
//
// `createAgent` is the standing-config + per-turn-override front door to the
// turn loop. It composes ONLY open primitives — `query()`, `resolveProvider`,
// the `Tool`/`ToolContext` shapes, and the Phase-2 injected ports — and is held
// OPEN by the file-level boundary lint (scripts/boundary-manifest.json). It must
// never import `buildRuntime`, the gateway server, the scheduler-as-a-value, or
// any other proprietary/wrapper module.
//
// It is the SDK's turn-loop driver — the same query()-driving loop every
// surface ran inline before the SDK extraction — and adds the three
// responsibilities the spec (§5.2) calls net-new engine logic:
//   1. Per-turn override merging: standing `AgentConfig` supplies defaults; a
//      `PerTurn` slice (the per-turn parameters `query()` already accepts) wins.
//      This is how a host (the gateway, later) carries the compaction pivot and
//      live-reload WITHOUT the SDK absorbing any orchestration concept — the
//      host computes `PerTurn`, the SDK runs it.
//   2. Optional `SessionStore`/`TranscriptStore` persistence. Absent store →
//      NO disk (the embeddable default): nothing is created, saved, or recorded.
//      PERSISTENCE CONTRACT (Task 4.1): an input containing prior history is
//      treated as REHYDRATION for an existing session — when the store already
//      holds this sessionId's messages and the input's head matches that stored
//      history verbatim, only the messages BEYOND the stored prefix (a trailing
//      new user message + this run's generated messages) are persisted, so a
//      stable-sessionId embedder never gets duplicate rows. A fresh session
//      persists the full seed + generated messages (unchanged). A non-verbatim
//      seed on an existing session persists everything (append; never a guess
//      that drops content).
//   3. The `observe` adapter: a plain `(i: ObserveInput) => void` function is
//      wrapped into a `LearningObserverPort` object and placed on the
//      `ToolContext.learningObserver`, where the orchestrator calls it after
//      each tool dispatch.
//
// Design invariants (load-bearing):
//   - `query()` is UNCHANGED. `createAgent` is a composition over it, not a fork.
//   - Stream-passthrough: `run()` yields every `StreamEvent | Message` from
//     `query()` UNCHANGED and in order — no buffering, coalescing, or reordering.
//   - Immutability: the caller's `input` messages and `config` are never mutated.
//   - Defaults: no-disk, no-server, no-cron, no-learning unless a port is given.

import { randomUUID } from 'node:crypto';
import type { MicrocompactConfig } from '../compact/microcompact.js';
import type { Settings } from '../config/schema.js';
import type { ObserveInput } from '../core/observePort.js';
import { query } from '../core/query.js';
import type { StoredMessage } from '../core/sessionPort.js';
import type {
  AssistantMessage,
  Message,
  RecallTurn,
  StreamEvent,
  SystemSegment,
  Terminal,
  TokenUsage,
} from '../core/types.js';
import {
  accumulateUsage,
  createUsageAccumulator,
  finalizeUsage,
} from '../core/usageAccumulator.js';
import type { HookRunner } from '../hooks/types.js';
import type { MemoryRuntime } from '../memory/provider.js';
import type { CanUseTool } from '../permissions/types.js';
import type { SessionStore } from '../persistence/sessionStore.js';
import type { TranscriptStore } from '../persistence/transcriptStore.js';
import type { ReasoningEffort } from '../providers/effort.js';
import { estimateCostUsd } from '../providers/pricing.js';
import { resolveProvider } from '../providers/resolver.js';
import type { LLMProvider } from '../providers/types.js';
import type { LearningObserverPort } from '../tool/ports.js';
import type { Tool, ToolContext } from '../tool/types.js';
import type { TraceEvent } from '../trace/types.js';

/** Fallback per-request token budget when `AgentConfig.maxTokens` is omitted.
 *  Matches the harness wrapper default (src/main.ts / src/server/runtime.ts). */
const DEFAULT_MAX_TOKENS = 12000;

/** Standing DEFAULTS for an agent. Every per-turn parameter in `PerTurn` falls
 *  back to its counterpart here. The only required fields are `provider` and
 *  `model`; everything else opts into a capability (tools, persistence, ports). */
export type AgentConfig = {
  /** Provider name resolved via `resolveProvider`, or a concrete `LLMProvider`. */
  provider: string | LLMProvider;
  model: string;
  tools?: Tool<unknown, unknown>[];
  /** A string is wrapped into a single non-cacheable `SystemSegment`. */
  systemPrompt?: SystemSegment[] | string;
  cwd?: string;
  /** Resolved settings OBJECT (not a path) — threaded into `resolveProvider`. */
  settings?: Settings;
  /** Omit → no disk: nothing is persisted (the embeddable default).
   *  When supplied: an input containing prior history is treated as REHYDRATION
   *  for an existing session — if the store already holds this sessionId's
   *  messages and the input's head is a verbatim copy of that stored history,
   *  only the new tail (a trailing new user message + this run's generated
   *  messages) is persisted; re-running with rehydrated history never
   *  duplicates rows. A fresh session persists the seed too. Fallback: a
   *  NON-verbatim seed on an existing session re-appends everything (duplicates
   *  possible) — verbatim rehydration is required for dedup. */
  sessionStore?: SessionStore;
  /** Omit → no transcript writes. */
  transcripts?: TranscriptStore;
  recall?: RecallTurn;
  /** Adapted into a `LearningObserverPort` on the per-turn `ToolContext`. */
  observe?: (i: ObserveInput) => void;
  memoryManager?: MemoryRuntime;
  hookRunner?: HookRunner;
  traceRecorder?: (e: TraceEvent) => void;
  effort?: ReasoningEffort;
  /** Sampling temperature forwarded to the provider. Omit → query()/provider
   *  default (no temperature key sent). */
  temperature?: number;
  /** Provider prompt-cache markers. Omit → query()'s default (enabled). */
  cacheEnabled?: boolean;
  /** Pause the turn loop after this many cumulative tool calls, returning
   *  terminal reason 'checkin'. Omit → no check-in. */
  maxToolCallsBeforeCheckin?: number;
  microcompactConfig?: MicrocompactConfig;
  maxTokens?: number;
  maxTurns?: number;
  /** Error-propagation mode for a THROWN pre/in-loop op (memory injection,
   *  recall, the UserPromptSubmit hook — the async ops query() runs OUTSIDE its
   *  per-turn try/catch). Omit/`false` (the DEFAULT): a throw is CONVERTED to a
   *  returned `terminal{reason:'error'}` — byte-identical to today
   *  (cron/channels/sub-agents rely on this). `true`: the throw
   *  PROPAGATES out of `run()`'s generator (the consumer's `.next()` rejects),
   *  exactly like a direct `query()` drive — the gateway opts in so its outer
   *  catch maps it to `turn_error`. In-loop errors are unaffected either way
   *  (query() RETURNS those terminals; nothing is thrown). */
  rethrow?: boolean;
};

/** The per-turn override slice — exactly the subset of `QueryParams` that varies
 *  per turn/session. Standing `AgentConfig` supplies defaults; `PerTurn` wins. */
export type PerTurn = Partial<{
  signal: AbortSignal;
  canUseTool: CanUseTool;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  tools: Tool<unknown, unknown>[];
  systemPrompt: SystemSegment[];
  effort: ReasoningEffort;
  temperature: number;
  cacheEnabled: boolean;
  maxToolCallsBeforeCheckin: number;
  memoryManager: MemoryRuntime;
  recall: RecallTurn;
  observe: (i: ObserveInput) => void;
  traceRecorder: (e: TraceEvent) => void;
  microcompactConfig: MicrocompactConfig;
  /** A fully host-assembled tool context; used verbatim when supplied. */
  toolContext: ToolContext;
  /** Per-turn override of the standing `rethrow` mode (see AgentConfig). */
  rethrow: boolean;
}>;

/** The structured result of a `run()`, returned as the generator's return
 *  value once the turn loop reaches terminal. */
export type RunResult = {
  sessionId: string;
  terminal: Terminal;
  finalAssistant?: AssistantMessage;
  iterationsUsed: number;
  toolCallCount: number;
  distinctToolNames: string[];
  messages: Message[];
};

/** A configured agent. `run()` drives one turn loop to terminal, streaming
 *  `query()`'s events through unchanged and returning a `RunResult`. */
export type Agent = {
  run(
    input: string | Message[],
    perTurn?: PerTurn,
  ): AsyncGenerator<StreamEvent | Message, RunResult>;
};

/** Build an `Agent` from standing config. The returned agent is reusable: each
 *  `run()` re-merges the config with the call's `PerTurn` and runs an
 *  independent turn loop. */
export function createAgent(config: AgentConfig): Agent {
  async function* run(
    input: string | Message[],
    perTurn: PerTurn = {},
  ): AsyncGenerator<StreamEvent | Message, RunResult> {
    // 1. Provider + model: per-turn overrides win. A string config provider is
    //    resolved here; a concrete LLMProvider is used directly.
    const model = perTurn.model ?? config.model;
    const provider = resolveRunProvider(config.provider, perTurn.provider, model, config.settings);

    // 2. Input → seed messages. A string seeds one user message; a Message[] is
    //    copied (never mutated — query() owns the internal history copy too).
    const seedMessages: Message[] =
      typeof input === 'string'
        ? [{ role: 'user', content: [{ type: 'text', text: input }] }]
        : [...input];

    // 3. Session id: per-turn override, else a fresh UUID. Threaded to query()
    //    for hooks + used as the persistence key.
    const sessionId = perTurn.sessionId ?? randomUUID();

    // 4. System prompt: per-turn override, else config; a string wraps into one
    //    non-cacheable segment; absent → empty.
    const systemPrompt = toSystemSegments(perTurn.systemPrompt ?? config.systemPrompt);

    // 5. The observe adapter: wrap the `(i) => void` fn into a
    //    `LearningObserverPort` the orchestrator calls off the ToolContext.
    const observeFn = perTurn.observe ?? config.observe;
    const learningObserver: LearningObserverPort | undefined =
      observeFn !== undefined ? { observe: (i: ObserveInput) => observeFn(i) } : undefined;

    // 6. Tool pool + tool context. A host-supplied perTurn.toolContext is used
    //    verbatim; otherwise a MINIMAL context is built (cwd + sessionId + the
    //    observe adapter) when the turn needs one (tools present or observe set).
    const tools = perTurn.tools ?? config.tools;
    const cwd = config.cwd ?? process.cwd();
    const toolContext = resolveToolContext(
      perTurn.toolContext,
      tools,
      cwd,
      sessionId,
      learningObserver,
    );

    // 7. Merge the remaining ports for QueryParams (per-turn wins where allowed).
    const effort = perTurn.effort ?? config.effort;
    const memoryManager = perTurn.memoryManager ?? config.memoryManager;
    const recall = perTurn.recall ?? config.recall;
    const traceRecorder = perTurn.traceRecorder ?? config.traceRecorder;
    const microcompactConfig = perTurn.microcompactConfig ?? config.microcompactConfig;
    // The remaining per-turn slice of QueryParams. `??` falls back only on
    // nullish, so a per-turn `cacheEnabled: false` correctly wins over a
    // standing `true`. Each is threaded via the same conditional spread as
    // microcompactConfig below, so an absent value leaves query()'s default
    // (temperature: unset; cacheEnabled: true; no check-in) byte-identical.
    const temperature = perTurn.temperature ?? config.temperature;
    const cacheEnabled = perTurn.cacheEnabled ?? config.cacheEnabled;
    const maxToolCallsBeforeCheckin =
      perTurn.maxToolCallsBeforeCheckin ?? config.maxToolCallsBeforeCheckin;
    const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    // Error-propagation mode: per-turn override wins, else standing config,
    // else `false` (convert-to-terminal — byte-identical to today).
    const rethrow = perTurn.rethrow ?? config.rethrow ?? false;

    const gen = query({
      provider,
      model,
      messages: seedMessages,
      systemPrompt,
      maxTokens,
      sessionId,
      ...(effort !== undefined ? { effort } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(cacheEnabled !== undefined ? { cacheEnabled } : {}),
      ...(maxToolCallsBeforeCheckin !== undefined ? { maxToolCallsBeforeCheckin } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(toolContext !== undefined ? { toolContext } : {}),
      ...(perTurn.canUseTool !== undefined ? { canUseTool: perTurn.canUseTool } : {}),
      ...(memoryManager !== undefined ? { memoryManager } : {}),
      ...(recall !== undefined ? { recall } : {}),
      ...(config.hookRunner !== undefined ? { hookRunner: config.hookRunner } : {}),
      ...(traceRecorder !== undefined ? { traceRecorder } : {}),
      ...(microcompactConfig !== undefined ? { microcompactConfig } : {}),
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      ...(perTurn.signal !== undefined ? { signal: perTurn.signal } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    });

    // 8. Drive query(), yielding every event UNCHANGED + in order. Track the
    //    structured result fields exactly as the prior inline turn loop did,
    //    plus cross-call usage accumulation for cost accounting: a tool-loop
    //    run makes MULTIPLE provider calls, and each call's usage_delta events
    //    are cumulative-from-zero for THAT call only — the accumulator keeps
    //    the last-seen value per field within a call (flushed at each
    //    message_start) and sums the per-call finals, so recordTokenUsage
    //    receives the whole run's tokens, not just the last call's snapshot.
    let finalAssistant: AssistantMessage | undefined;
    let iterationsUsed = 0;
    let toolCallCount = 0;
    const distinctTools = new Set<string>();
    let usageAcc = createUsageAccumulator();
    let terminal: Terminal = {
      reason: 'error',
      error: new Error('createAgent: never terminated'),
    };
    const messages: Message[] = [...seedMessages];

    try {
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          terminal = step.value;
          break;
        }
        const ev = step.value;
        if (ev && typeof ev === 'object') {
          if ('type' in ev) {
            usageAcc = accumulateUsage(usageAcc, ev);
            if (ev.type === 'message_stop') iterationsUsed += 1;
            if (ev.type === 'assistant_message') {
              finalAssistant = ev.message;
              messages.push(ev.message);
              for (const block of ev.message.content) {
                if (block.type === 'tool_use') {
                  toolCallCount += 1;
                  distinctTools.add(block.name);
                }
              }
            }
          } else if ('role' in ev && ev.role === 'user') {
            messages.push(ev);
          }
        }
        yield ev;
      }
    } catch (err) {
      // `rethrow: true` — do NOT convert the throw to a terminal. Re-throw so it
      // propagates out of this generator (the consumer's `.next()` rejects),
      // skipping persistence + the structured return, exactly like a direct
      // query() drive. `false`/unset keeps the EXACT current behavior below.
      if (rethrow) throw err;
      terminal = { reason: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }

    // 9. Persistence — only when a port is supplied (no-disk default otherwise).
    //    `finalizeUsage` flushes the trailing provider call and returns the
    //    summed per-run total (undefined when the stream reported no usage —
    //    recordTokenUsage stays skipped). The accumulator saw only THIS run's
    //    live stream, so a rehydrated session never re-records prior runs'
    //    tokens; the store's own accumulate (`col = col + ?`) does the rest.
    if (config.sessionStore !== undefined || config.transcripts !== undefined) {
      persistTurn({
        sessionStore: config.sessionStore,
        transcripts: config.transcripts,
        sessionId,
        model,
        providerName: provider.name,
        systemPrompt,
        messages,
        seedCount: seedMessages.length,
        usage: finalizeUsage(usageAcc),
      });
    }

    return {
      sessionId,
      terminal,
      ...(finalAssistant !== undefined ? { finalAssistant } : {}),
      iterationsUsed,
      toolCallCount,
      distinctToolNames: Array.from(distinctTools).sort(),
      messages,
    };
  }

  return { run };
}

/** Resolve the effective provider: a per-turn LLMProvider wins; otherwise a
 *  concrete config provider is used directly, and a string config provider is
 *  resolved via `resolveProvider` (threading `settings` when present). */
function resolveRunProvider(
  configProvider: string | LLMProvider,
  perTurnProvider: LLMProvider | undefined,
  model: string,
  settings: Settings | undefined,
): LLMProvider {
  if (perTurnProvider !== undefined) return perTurnProvider;
  if (typeof configProvider !== 'string') return configProvider;
  const resolved = resolveProvider(
    configProvider,
    model,
    settings !== undefined ? { settings } : {},
  );
  // `transport` is a `Transport`, which extends `LLMProvider`; the cast mirrors
  // the createAgent call sites (scheduler/cron/channels).
  return resolved.transport as unknown as LLMProvider;
}

/** Normalize the system-prompt config into `SystemSegment[]`: a string wraps
 *  into one non-cacheable segment; an array passes through; absent → empty. */
function toSystemSegments(sp: SystemSegment[] | string | undefined): SystemSegment[] {
  if (sp === undefined) return [];
  if (typeof sp === 'string') return [{ text: sp, cacheable: false }];
  return sp;
}

/** Pick the tool context: a host-supplied one verbatim, else a MINIMAL context
 *  (cwd + sessionId + the observe adapter) when the turn needs one. Returns
 *  undefined when neither tools nor an observer are in play. */
function resolveToolContext(
  provided: ToolContext | undefined,
  tools: Tool<unknown, unknown>[] | undefined,
  cwd: string,
  sessionId: string,
  learningObserver: LearningObserverPort | undefined,
): ToolContext | undefined {
  if (provided !== undefined) return provided;
  const needsContext = (tools !== undefined && tools.length > 0) || learningObserver !== undefined;
  if (!needsContext) return undefined;
  return {
    cwd,
    sessionId,
    ...(learningObserver !== undefined ? { learningObserver } : {}),
  };
}

/** Persist one completed turn through the injected ports, mirroring the
 *  gateway's `persistMessage` + `recordTokenUsage` at SessionStore granularity:
 *  upsert the session, save the turn's messages, mirror each to the transcript,
 *  and accumulate usage/cost.
 *
 *  Dedup contract (Task 4.1): when the store already holds rows for this
 *  session AND the seed's head is a verbatim rehydration of that stored
 *  history, saving starts AFTER the stored prefix — only the new tail (a
 *  trailing new user message + this run's generated messages) is written, so a
 *  stable-sessionId embedder never gets duplicate rows. A fresh session (empty
 *  store) and a non-verbatim seed both save everything: the SDK never drops
 *  content on a guess. With no SessionStore (transcripts-only, e.g. cron) there
 *  is no history to consult — every message is mirrored, byte-identical to the
 *  pre-4.1 behavior. */
function persistTurn(opts: {
  sessionStore: SessionStore | undefined;
  transcripts: TranscriptStore | undefined;
  sessionId: string;
  model: string;
  providerName: string;
  systemPrompt: SystemSegment[];
  messages: Message[];
  /** Index where this run's NEW messages begin (the caller's seed length). */
  seedCount: number;
  usage: TokenUsage | undefined;
}): void {
  const {
    sessionStore,
    transcripts,
    sessionId,
    model,
    providerName,
    systemPrompt,
    messages,
    seedCount,
    usage,
  } = opts;

  if (sessionStore !== undefined) {
    sessionStore.upsertSession({
      sessionId,
      model,
      provider: providerName,
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    });
  }

  // The dedup boundary: one loadMessages call on the persist path only.
  let persistFrom = 0;
  if (sessionStore !== undefined) {
    const stored = sessionStore.loadMessages(sessionId);
    if (stored.length > 0 && isRehydratedPrefix(stored, messages, seedCount)) {
      persistFrom = stored.length;
    }
  }

  let seq = 0;
  for (const msg of messages.slice(persistFrom)) {
    const id =
      sessionStore !== undefined
        ? sessionStore.saveMessage(sessionId, { role: msg.role, content: msg.content })
        : seq;
    transcripts?.recordMessage(sessionId, msg.role, msg.content, id);
    seq += 1;
  }

  if (sessionStore !== undefined && usage !== undefined) {
    sessionStore.recordTokenUsage(sessionId, usage, estimateCostUsd(providerName, model, usage));
  }
}

/** True when the stored history is a VERBATIM prefix of this run's seed: every
 *  stored row matches the message at the same index by role + content (deep
 *  equality via JSON text — mirroring the store's own serialize/deserialize
 *  round-trip, so history rehydrated from `loadMessages` compares equal).
 *  Rehydration only makes sense within the SEED, so a stored history longer
 *  than the seed never matches — a short fresh input (e.g. a new string prompt
 *  under a reused sessionId) is new content to append, not a rehydration. */
function isRehydratedPrefix(
  stored: StoredMessage[],
  messages: Message[],
  seedCount: number,
): boolean {
  if (stored.length > seedCount) return false;
  return stored.every((row, i) => {
    const msg = messages[i];
    return (
      msg !== undefined &&
      msg.role === row.role &&
      JSON.stringify(msg.content) === JSON.stringify(row.content)
    );
  });
}
