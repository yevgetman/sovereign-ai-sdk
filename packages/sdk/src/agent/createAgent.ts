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
import { substituteAssistantText } from '../core/conductOutput.js';
import {
  type ConductContext,
  type ConductProvider,
  type ConductSurface,
  DEFAULT_CONDUCT_REFUSAL,
  wrapConductAuditSink,
} from '../core/conductPort.js';
import { insertPersonaSegments } from '../core/conductSegments.js';
import { composeConductCanUseTool } from '../core/conductToolPolicy.js';
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
import { validateSessionId } from '../util/sessionId.js';

/** Fallback per-request token budget when `AgentConfig.maxTokens` is omitted.
 *  Matches the harness wrapper default (src/main.ts / src/server/runtime.ts). */
const DEFAULT_MAX_TOKENS = 12000;

/** Bounded retry budget for an output-gate `regenerate` verdict (1d): the turn
 *  may be re-run AT MOST once. A `regenerate` verdict on the retry attempt is
 *  handled as `block`. Double-bounded design — decorum only emits `regenerate`
 *  on the first attempt — so this is a defense-in-depth ceiling, not a loop. */
const CONDUCT_REGENERATE_MAX = 1;

/** The steering system segment appended when re-running a turn after a
 *  `regenerate` verdict. Non-cacheable (per-attempt tail) and derived from the
 *  CONTENT-FREE reason label only — never message text. */
function regenerateSteeringSegment(reason: string | undefined): SystemSegment {
  const suffix = reason ? `: ${reason}` : '';
  return {
    text: `Your previous reply was rejected by the output governor${suffix}. Produce a corrected reply that does not repeat the violation.`,
    cacheable: false,
  };
}

/** Standing DEFAULTS for an agent. Every per-turn parameter in `PerTurn` falls
 *  back to its counterpart here. The only required fields are `provider` and
 *  `model`; everything else opts into a capability (tools, persistence, ports). */
export type AgentConfig = {
  /** Provider name resolved via `resolveProvider`, or a concrete `LLMProvider`. */
  provider: string | LLMProvider;
  model: string;
  // `Tool<any, any>[]` lets a specifically-typed buildTool() compose without an
  // `as unknown as Tool<unknown, unknown>` cast (audit F8): `unknown` is
  // contravariantly rejected under strictFunctionTypes, while `any` is bivariant
  // — the same looseness the old unknown+double-cast had, but cast-free for the
  // embedder. Threaded as `Tool<any, any>[]` through the whole tool surface.
  // biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8).
  tools?: Tool<any, any>[];
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
  /** Mid-turn steering thunk — polled at agent-loop boundaries; returns
   *  ready-to-inject framed text or null. See QueryParams.pollSteering. */
  pollSteering?: () => Promise<string | null>;
  /** Adapted into a `LearningObserverPort` on the per-turn `ToolContext`. */
  observe?: (i: ObserveInput) => void;
  memoryManager?: MemoryRuntime;
  hookRunner?: HookRunner;
  traceRecorder?: (e: TraceEvent) => void;
  /** Conduct Port (1b) — optional agent-behavior governance provider. Absent →
   *  null provider: byte-identical behavior on every seam. */
  conduct?: ConductProvider;
  /** Which surface this agent's turns are (D23): 'user' (default) runs the
   *  full seam set; 'internal' (harness-driven sub-turns) keeps only the
   *  floors — toolPolicy + outputGuard; persona/preGate/triage are skipped. */
  conductSurface?: ConductSurface;
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
  // biome-ignore lint/suspicious/noExplicitAny: cast-free tool composition (F8) — see AgentConfig.tools.
  tools: Tool<any, any>[];
  systemPrompt: SystemSegment[];
  effort: ReasoningEffort;
  temperature: number;
  cacheEnabled: boolean;
  maxToolCallsBeforeCheckin: number;
  memoryManager: MemoryRuntime;
  recall: RecallTurn;
  pollSteering: () => Promise<string | null>;
  observe: (i: ObserveInput) => void;
  traceRecorder: (e: TraceEvent) => void;
  microcompactConfig: MicrocompactConfig;
  /** A fully host-assembled tool context; used verbatim when supplied. */
  toolContext: ToolContext;
  /** Per-turn override of the standing `rethrow` mode (see AgentConfig). */
  rethrow: boolean;
  /** Per-turn override of the standing conduct provider (see AgentConfig). */
  conduct: ConductProvider;
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
  /** The run's summed, phase-broken token usage. Accumulator semantics: the
   *  per-call finals (last-seen value per field within each provider call) are
   *  SUMMED across the whole tool loop — a multi-call turn reports the total,
   *  not just the last call. `reasoningTokens` inside `usage` is INFORMATIONAL
   *  (a subset of `outputTokens`) and is never part of the cost. ABSENT (not
   *  `undefined`) when the stream reported no usage at all — mirroring
   *  `finalizeUsage`'s `undefined`. Shares one `finalizeUsage` result with the
   *  persistence path, so it is byte-identical to what `recordTokenUsage`
   *  received. */
  usage?: TokenUsage;
  /** The `usage` total priced via the SDK pricing table against the
   *  provider/model this run used (`estimateCostUsd(provider.name, model,
   *  usage)`) — the SAME figure the persistence path records. `reasoningTokens`
   *  is excluded from this cost. ABSENT (not `undefined`) whenever `usage` is
   *  absent. */
  estimatedCostUsd?: number;
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
    //    for hooks + used as the persistence key AND substituted into skill
    //    prompts (${HARNESS_SESSION_ID}). A caller-supplied id is UNTRUSTED, so
    //    validate it against the safe charset at this boundary (F27); the minted
    //    UUID needs no check (it is generated here and always matches).
    const sessionId =
      perTurn.sessionId !== undefined ? validateSessionId(perTurn.sessionId) : randomUUID();

    // 4. System prompt: per-turn override, else config; a string wraps into one
    //    non-cacheable segment; absent → empty.
    const systemPrompt = toSystemSegments(perTurn.systemPrompt ?? config.systemPrompt);

    // 4b. Conduct (1b): resolve provider + build the per-turn ConductContext.
    //     personaSegments compose into the system prompt here — after the
    //     cacheable prefix, before the dynamic tail (see insertPersonaSegments)
    //     — so EVERY turn driver gets persona projection through this one
    //     assembler. 'user' surface only; a throw fails OPEN (base prompt).
    const conduct = perTurn.conduct ?? config.conduct;
    const conductSurface: ConductSurface = config.conductSurface ?? 'user';
    const conductCtx: ConductContext = {
      sessionId,
      surface: conductSurface,
      model,
      providerName: provider.name,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    };
    const emitConductAudit = wrapConductAuditSink(conduct?.auditSink?.bind(conduct));
    let effectiveSystemPrompt = systemPrompt;
    if (conduct?.personaSegments && conductSurface === 'user') {
      const startedAt = Date.now();
      try {
        const persona = await conduct.personaSegments(conductCtx);
        effectiveSystemPrompt = insertPersonaSegments(systemPrompt, persona);
        emitConductAudit({
          stage: 'persona',
          sessionId,
          surface: conductSurface,
          verdict: `segments:${persona.length}`,
          latencyMs: Date.now() - startedAt,
          iso: new Date().toISOString(),
        });
      } catch {
        emitConductAudit({
          stage: 'persona',
          sessionId,
          surface: conductSurface,
          verdict: 'error',
          latencyMs: Date.now() - startedAt,
          iso: new Date().toISOString(),
        });
      }
    }

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
    const pollSteering = perTurn.pollSteering ?? config.pollSteering;
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

    // 7b. Conduct tool policy (floors — every surface): deny-first wrapper
    //     around the per-turn canUseTool. Identity passthrough when the
    //     provider has no toolPolicy capability.
    const canUseTool = composeConductCanUseTool(conduct, conductCtx, perTurn.canUseTool);

    // Restartable turn (1d): the query() invocation is hoisted into `startTurn`
    // so an output-gate `regenerate` verdict can re-run it with an extra
    // steering system segment. `extraSegments` is EMPTY on the first attempt —
    // the systemPrompt is then `effectiveSystemPrompt` verbatim, byte-identical
    // to the pre-1d single call.
    const startTurn = (extraSegments: SystemSegment[]) =>
      query({
        provider,
        model,
        messages: seedMessages,
        systemPrompt:
          extraSegments.length > 0
            ? [...effectiveSystemPrompt, ...extraSegments]
            : effectiveSystemPrompt,
        maxTokens,
        sessionId,
        ...(conduct !== undefined ? { conduct, conductCtx } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(cacheEnabled !== undefined ? { cacheEnabled } : {}),
        ...(maxToolCallsBeforeCheckin !== undefined ? { maxToolCallsBeforeCheckin } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(toolContext !== undefined ? { toolContext } : {}),
        ...(canUseTool !== undefined ? { canUseTool } : {}),
        ...(memoryManager !== undefined ? { memoryManager } : {}),
        ...(recall !== undefined ? { recall } : {}),
        ...(pollSteering !== undefined ? { pollSteering } : {}),
        ...(config.hookRunner !== undefined ? { hookRunner: config.hookRunner } : {}),
        ...(traceRecorder !== undefined ? { traceRecorder } : {}),
        ...(microcompactConfig !== undefined ? { microcompactConfig } : {}),
        ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
        ...(perTurn.signal !== undefined ? { signal: perTurn.signal } : {}),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      });
    let gen = startTurn([]);

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
    let messages: Message[] = [...seedMessages];

    try {
      // Attempt loop (1d): the single-pass drive, wrapped in a bounded retry on
      // an output-gate `regenerate` verdict (CONDUCT_REGENERATE_MAX). Without
      // an `outputGuard.onFinal` returning `regenerate` (the null provider, or
      // any pass/replace/block verdict) `regenerated` stays false and this
      // collapses to ONE pass — byte-identical to the pre-1d single drive.
      // `usageAcc` and the result-tracking vars persist ACROSS attempts so cost
      // is honest (both provider calls counted); the discarded attempt-0
      // message is never pushed to `messages[]`, yielded to the consumer, or
      // counted toward tools/finalAssistant.
      for (let attempt = 0; ; attempt += 1) {
        // Per-attempt turn-state reset (1d review fix). A `regenerate` verdict
        // restarts query() from `seedMessages`, so every accumulator that feeds
        // persistence/counting MUST be reset before the retry — otherwise a
        // `regenerate` on the FINAL message of a TOOL-USING turn leaves the
        // discarded attempt's tool_use assistant + tool_result user messages in
        // `messages[]` (double-persisted, breaking provenance) and inflates
        // toolCallCount / distinctTools / iterationsUsed / finalAssistant.
        // `usageAcc` is the SOLE exception: honest cost sums ALL attempts (the
        // documented design), so it is deliberately RETAINED across the retry.
        if (attempt > 0) {
          messages = [...seedMessages];
          toolCallCount = 0;
          distinctTools.clear();
          iterationsUsed = 0;
          finalAssistant = undefined;
        }
        let regenerated = false;
        let regenerateReason: string | undefined;
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            terminal = step.value;
            break;
          }
          let ev = step.value;
          if (ev && typeof ev === 'object') {
            if ('type' in ev) {
              // Conduct output gate (1b/1d — floors on every surface). Deltas
              // route through onDelta ('' = held → event dropped); a provider
              // call's stream-end fires onStreamEnd (the 1d held-tail flush)
              // then onFinal (pass/replace/block/regenerate). The SUBSTITUTED
              // message is what is yielded, counted, and persisted — the
              // history-scrub-before-persistence guarantee. Throws fail OPEN.
              //
              // SSE reconciliation (1d Task 12 — the 1b caveat, CLOSED BY
              // CONTRACT). With a HOLD-BY-DEFAULT governor bound (decorum's
              // streaming contract: never release a span until the sentence
              // containing it is screened), every released delta is verified
              // text, so on the PASS path the concatenation of the released
              // deltas + the onStreamEnd flush is EXACTLY the final delivered
              // message — the streamed text and the persisted text converge.
              // The 1b "deltas may show pre-substitution text" divergence only
              // ever existed for a leak-then-check governor; a holding governor
              // has nothing to substitute after the fact on a clean turn.
              //
              // The BOUNDED, HONEST residue that survives (D21): a block/replace
              // — or a `regenerate` — that fires AFTER text was already released.
              // Streamed bytes cannot be retracted, so the client keeps the
              // released PREFIX OF THE ORIGINAL model text while the final
              // delivered + persisted message is the substituted refusal (never
              // a prefix of that refusal). decorum's Task-9 policy only emits
              // `regenerate` when NOTHING was released, shrinking this window to
              // block/replace-after-release. Note also the 1d retry re-fires the
              // onStreamEnd flush on the retry attempt — with hold-by-default
              // that flush is held/empty text. The SDK does not retract
              // already-yielded events. Property test:
              // tests/conduct/streamConvergence.test.ts.
              const guard = conduct?.outputGuard;
              if (guard?.onDelta && ev.type === 'text_delta') {
                let released = ev.text;
                try {
                  released = guard.onDelta(ev.text, conductCtx);
                } catch {
                  // fail open — original delta flows
                }
                if (released.length === 0) continue;
                if (released !== ev.text) ev = { type: 'text_delta', text: released };
              }
              // Held-tail flush (1d): the provider call's text stream has ended
              // (its assistant_message is here) — give the engine one seam to
              // release any tail it held via onDelta, emitted as a final
              // text_delta BEFORE the message is gated. Fail-open (nothing
              // flushed on a throw). Fires independent of onFinal.
              if (guard?.onStreamEnd && ev.type === 'assistant_message') {
                let flushed = '';
                try {
                  flushed = guard.onStreamEnd(conductCtx);
                } catch {
                  // fail open — nothing flushed
                }
                if (flushed.length > 0) yield { type: 'text_delta', text: flushed };
              }
              if (guard?.onFinal && ev.type === 'assistant_message') {
                const startedAt = Date.now();
                let verdictLabel = 'pass';
                let doRegenerate = false;
                try {
                  const verdict = await guard.onFinal(ev.message, conductCtx);
                  verdictLabel = verdict.action;
                  if (verdict.action === 'replace') {
                    ev = {
                      type: 'assistant_message',
                      message: substituteAssistantText(ev.message, verdict.text),
                    };
                  } else if (verdict.action === 'block') {
                    ev = {
                      type: 'assistant_message',
                      message: substituteAssistantText(
                        ev.message,
                        verdict.template ?? DEFAULT_CONDUCT_REFUSAL,
                      ),
                    };
                  } else if (verdict.action === 'regenerate') {
                    if (attempt < CONDUCT_REGENERATE_MAX) {
                      // Attempt 0: reject + re-run. Handled AFTER the audit,
                      // below — the message is NOT substituted, yielded,
                      // counted, or persisted.
                      doRegenerate = true;
                      regenerateReason = verdict.reason;
                    } else {
                      // Bounded (CONDUCT_REGENERATE_MAX): a repeat regenerate is
                      // handled as `block` — substitute the default refusal.
                      verdictLabel = 'block';
                      ev = {
                        type: 'assistant_message',
                        message: substituteAssistantText(ev.message, DEFAULT_CONDUCT_REFUSAL),
                      };
                    }
                  }
                } catch {
                  verdictLabel = 'error'; // fail open
                }
                emitConductAudit({
                  stage: 'output',
                  sessionId,
                  surface: conductSurface,
                  verdict: verdictLabel,
                  latencyMs: Date.now() - startedAt,
                  iso: new Date().toISOString(),
                });
                if (doRegenerate) {
                  // Discard attempt 0 entirely: break the drive loop WITHOUT
                  // yielding/counting/persisting this message. usageAcc is
                  // retained; attempt-1's first message_start flushes this
                  // call's usage into the total (honest cost).
                  regenerated = true;
                  break;
                }
              }
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
        if (!regenerated) break;
        // Re-run the turn ONCE with the content-free steering segment. Tear
        // down the discarded attempt's provider stream first (close its socket,
        // as the finally block does), then restart.
        await gen.return(undefined as unknown as Terminal);
        gen = startTurn([regenerateSteeringSegment(regenerateReason)]);
      }
    } catch (err) {
      // `rethrow: true` — do NOT convert the throw to a terminal. Re-throw so it
      // propagates out of this generator (the consumer's `.next()` rejects),
      // skipping persistence + the structured return, exactly like a direct
      // query() drive. `false`/unset keeps the EXACT current behavior below.
      if (rethrow) throw err;
      terminal = { reason: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      // Early-abandon teardown (audit F7). A consumer may abandon the stream
      // early — `for await (const ev of agent.run(...)) { if (cond) break; }`
      // WITHOUT firing an abort signal — which `.return()`s this generator while
      // it is suspended at `yield ev`. Because we drive query() MANUALLY (not
      // `yield*`), teardown does NOT auto-propagate, so query()'s
      // `for await (const event of provider.stream(...))` is left suspended and
      // the upstream provider fetch/ReadableStream socket leaks until GC.
      // Forward finalization so provider.stream() is closed promptly. On normal
      // completion and the error/rethrow paths this targets an ALREADY-DONE
      // generator — a harmless no-op — so events, the post-loop persistence, and
      // the RunResult are byte-identical. Persistence stays AFTER this block, so
      // an abandoned turn (which unwinds through the finally without reaching it)
      // is never persisted. The `Terminal` cast is inert: `.return()` requires an
      // arg of the generator's TReturn, but the finalization value is DISCARDED
      // (never read) — we only need query()'s finalizers to run.
      await gen.return(undefined as unknown as Terminal);
    }

    // 9. Finalize usage ONCE and share it between persistence and the returned
    //    RunResult so both figures are IDENTICAL. `finalizeUsage` flushes the
    //    trailing provider call and returns the summed per-run total — a FRESH
    //    object, never aliasing the accumulator's mutable-looking internals — or
    //    `undefined` when the stream reported no usage (recordTokenUsage stays
    //    skipped; RunResult.usage/estimatedCostUsd stay absent). The accumulator
    //    saw only THIS run's live stream, so a rehydrated session never
    //    re-records prior runs' tokens; the store's own accumulate
    //    (`col = col + ?`) does the rest. Cost prices the summed total against
    //    the provider/model this run used — the same `provider.name` the persist
    //    path records under, so the recorded and returned costs match exactly.
    const usage = finalizeUsage(usageAcc);
    const estimatedCostUsd =
      usage !== undefined ? estimateCostUsd(provider.name, model, usage) : undefined;

    // Persistence — only when a port is supplied (no-disk default otherwise).
    if (config.sessionStore !== undefined || config.transcripts !== undefined) {
      persistTurn({
        sessionStore: config.sessionStore,
        transcripts: config.transcripts,
        sessionId,
        model,
        providerName: provider.name,
        systemPrompt: effectiveSystemPrompt,
        messages,
        seedCount: seedMessages.length,
        usage,
        estimatedCostUsd,
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
      ...(usage !== undefined ? { usage } : {}),
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
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
  // No-disk contract (audit F6 + D2): three disk seams live on the
  // string-provider path and ALL must be opted out for a genuinely disk-free
  // embed turn:
  //   1. `loadSettings(...)` mkdir's + reads ~/.harness — closed by passing an
  //      explicit (non-nullish) settings object, which short-circuits the `??`.
  //   2. the CredentialPool defaults its state path to resolveHarnessHome()
  //      (mkdir HARNESS_HOME) and persists credentials.json in its constructor.
  //   3. the RateLimitGuard defaults its root to resolveHarnessHome() and
  //      writes <home>/rate_limits on a 429.
  // `credentialState: 'memory'` opts (2) + (3) into memory-only state, matching
  // the object-provider path and the README "no disk" default. The CLI/gateway
  // keep disk-backed state — they call resolveProvider directly with an explicit
  // harnessHome and never pass 'memory'.
  const resolved = resolveProvider(configProvider, model, {
    settings: settings ?? {},
    credentialState: 'memory',
  });
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
  // biome-ignore lint/suspicious/noExplicitAny: threads the cast-free tool array (F8).
  tools: Tool<any, any>[] | undefined,
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
  /** The run's finalized usage total (undefined → no usage reported). */
  usage: TokenUsage | undefined;
  /** The pre-computed cost for `usage` (undefined ⟺ `usage` is undefined),
   *  passed in so the recorded cost is IDENTICAL to `RunResult.estimatedCostUsd`
   *  — a single `estimateCostUsd` call in `run()`, not a second one here. */
  estimatedCostUsd: number | undefined;
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
    estimatedCostUsd,
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

  if (sessionStore !== undefined && usage !== undefined && estimatedCostUsd !== undefined) {
    sessionStore.recordTokenUsage(sessionId, usage, estimatedCostUsd);
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
