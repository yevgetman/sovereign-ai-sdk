// Shared per-turn host composition — the ONE place SOV turns a Runtime +
// session + turn request into a `createAgent()` agent and its per-drive
// `PerTurn` slice. Called by the gateway turns route (src/server/routes/
// turns.ts) and by the headless SDK host (`sov run --sdk`), so both reuse the
// same bundle/system prompt, cwd, tool pool, skills scope, hooks, MCP tools,
// permission cascade, memory, recall/learning and steering wiring instead of
// a duplicated stripped-down loop (spec 2026-10-08-sov-auth-routing §7.1).
//
// What the CALLER still owns (host-specific, not composed here):
//   - the event sink (SSE bus vs JSONL) and the relay (src/server/turnRelay.ts)
//   - compaction and the session-id pivot (gateway only; SDK mode adds none)
//   - attestation turn-id minting (passed in per drive as `TurnHop.turnId`)
//   - abort wiring (pass the combined `signal`)
//
// Single persistence writer (§7.2): `persistence.mode` decides who writes.
//   'gateway-callbacks' — createAgent gets NO store ports; the relay writes
//                         every message through persistMessage (legacy path).
//   'sdk-store'         — createAgent gets SessionStore/TranscriptStore; the
//                         SDK saves each assistant tool call BEFORE the tool
//                         runs (a failed save prevents execution) and the
//                         relay must be given `persist: undefined`.

import { type Agent, type PerTurn, createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  appendProjectLocalPermissionRule,
  loadPermissionSettings,
} from '@yevgetman/sov-sdk/config/settings';
import { repairMissingToolResults } from '@yevgetman/sov-sdk/core/transcriptRepair';
import type { Message, SystemSegment } from '@yevgetman/sov-sdk/core/types';
import { buildCanUseTool } from '@yevgetman/sov-sdk/permissions/canUseTool';
import { wrapCanUseToolWithTransformers } from '@yevgetman/sov-sdk/permissions/inputTransformer';
import { redactSecretsTransformer } from '@yevgetman/sov-sdk/permissions/redactSecretsTransformer';
import type {
  AskResponse,
  AskUser,
  CanUseTool,
  PermissionMode,
} from '@yevgetman/sov-sdk/permissions/types';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';
import type { TranscriptStore } from '@yevgetman/sov-sdk/persistence/transcriptStore';
import type { ReasoningEffort } from '@yevgetman/sov-sdk/providers/effort';
import { UnknownToolsetError } from '@yevgetman/sov-sdk/providers/errors';
import type { ModelRecord } from '@yevgetman/sov-sdk/providers/models/index';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { buildToolScope } from '@yevgetman/sov-sdk/tool/toolScope';
import {
  type ToolsetName,
  filterToolsForToolset,
  isToolsetName,
} from '@yevgetman/sov-sdk/tool/toolset';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';
import { type PersistMessageHost, persistMessage } from '../agent/persistMessage.js';
import type { DelegationLifecycleEvent } from '../router/progressEvents.js';
import { modelSystemPrompt, selectedTurnModel } from './modelMetadata.js';
import type { Runtime } from './runtime.js';
import type { SessionContext } from './sessionContext.js';
import { buildSessionToolContext } from './sessionToolContext.js';
import { consumeSteerFile, frameSteers } from './steerFile.js';

/** Who writes this turn's messages. Exactly one writer per turn. */
export type TurnPersistence =
  | { mode: 'gateway-callbacks'; host: PersistMessageHost }
  | { mode: 'sdk-store'; sessionStore: SessionStore; transcripts?: TranscriptStore };

/** Answers every `ask` fall-through with an immediate deny. A headless host has
 *  no TTY and no approval UI, so a prompt must never wait. */
export const headlessDenyAsk: AskUser = async (): Promise<AskResponse> => 'deny';

/**
 * The session-scoped permission gate: layered permission settings + the mode,
 * `ask` for fall-through decisions, an `always` answer recorded to the
 * project-local settings, and the secrets redactor. Gateway: `ask` is the SSE
 * approval bridge (createServerAsk). Headless: `headlessDenyAsk`.
 */
export function buildTurnCanUseTool(
  runtime: Pick<Runtime, 'cwd' | 'harnessHome' | 'permissionMode'>,
  opts: { ask: AskUser; permissionMode?: PermissionMode },
): CanUseTool {
  const permissionSettings = loadPermissionSettings({
    cwd: runtime.cwd,
    harnessHome: runtime.harnessHome,
  });
  const baseCanUseTool = buildCanUseTool({
    mode: opts.permissionMode ?? runtime.permissionMode,
    ask: opts.ask,
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
  return wrapCanUseToolWithTransformers(baseCanUseTool, [redactSecretsTransformer]);
}

/**
 * Conduct gate (D23) for trusted per-turn instructions: a bound provider may
 * veto them (a regulated pack disables client-appended system segments).
 * Returns the instructions when allowed, else undefined. No provider (or no
 * `allowPerTurnInstructions` capability) → allowed.
 */
export function gateTurnInstructions(
  runtime: Pick<Runtime, 'conduct' | 'model' | 'resolvedProvider' | 'cwd'>,
  sessionId: string,
  instructions: string | undefined,
): string | undefined {
  const conduct = runtime.conduct;
  const allowed =
    conduct?.allowPerTurnInstructions === undefined ||
    conduct.allowPerTurnInstructions({
      sessionId,
      surface: 'user',
      model: runtime.model,
      providerName: runtime.resolvedProvider.transport.name,
      ...(runtime.cwd !== undefined ? { cwd: runtime.cwd } : {}),
    });
  return allowed ? instructions : undefined;
}

/** Base system segments with trusted instructions APPENDED LAST as one
 *  non-cacheable segment. Never replaces the base (bundle/persona/skills)
 *  prompt, and keeps the cacheable prefix intact. A fresh array. */
export function appendInstructions(
  base: readonly SystemSegment[],
  instructions: string,
): SystemSegment[] {
  return [...base, { text: instructions, cacheable: false }];
}

/**
 * Mid-turn steering (`--steer-file`): a thunk the SDK polls at agent-loop
 * boundaries. Consumes the file atomically and frames the operator messages;
 * `onInjected` announces the injection (the gateway publishes
 * `steer_injected`). Steering failures never break a turn — consumeSteerFile
 * swallows IO errors. Undefined path → undefined (steering off).
 */
export function createSteeringPoller(
  steerFile: string | undefined,
  onInjected: (count: number) => void,
): (() => Promise<string | null>) | undefined {
  if (steerFile === undefined) return undefined;
  return async (): Promise<string | null> => {
    const texts = await consumeSteerFile(steerFile);
    if (texts.length === 0) return null;
    onInjected(texts.length);
    return frameSteers(texts);
  };
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

/**
 * The model-facing view of stored history on resume. Orphaned tool_use blocks
 * (a turn that died after its tool call was saved) get explicit error
 * tool_result blocks — the call is NEVER re-executed — and legacy same-role
 * plain rows are coalesced. The stored rows are not rewritten: in 'sdk-store'
 * mode pass `storedPrefixLength: view.length` so the SDK saves only new rows.
 */
export function hydrateSessionHistory(rows: readonly Message[], sessionId: string): Message[] {
  const { messages: repaired, insertedToolResults } = repairMissingToolResults(rows);
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
}

/** Load a session's stored rows through the active writer's store. */
export function loadStoredMessages(persistence: TurnPersistence, sessionId: string): Message[] {
  const rows =
    persistence.mode === 'gateway-callbacks'
      ? persistence.host.sessionDb.loadMessages(sessionId)
      : persistence.sessionStore.loadMessages(sessionId);
  return rows.map((m): Message => ({ role: m.role as Message['role'], content: m.content }));
}

/**
 * Persist one host-originated message (the turn's user prompt, saved BEFORE
 * the model runs so a failed turn keeps it) through the active writer. In
 * 'sdk-store' mode a store failure throws, so no model or tool call starts.
 */
export function persistTurnMessage(
  persistence: TurnPersistence,
  sessionId: string,
  msg: Message,
): void {
  if (persistence.mode === 'gateway-callbacks') {
    persistMessage(persistence.host, sessionId, { role: msg.role, content: msg.content });
    return;
  }
  const id = persistence.sessionStore.saveMessage(sessionId, {
    role: msg.role,
    content: msg.content,
  });
  persistence.transcripts?.recordMessage(sessionId, msg.role, msg.content, id);
}

/** Inputs for one user turn's composition. Only `runtime`, `canUseTool` and
 *  `persistence` are required; every override is optional and an absent one
 *  leaves the gateway's behavior byte-identical. */
export type ComposeTurnOptions = {
  runtime: Runtime;
  /** Session-scoped permission gate (see buildTurnCanUseTool). */
  canUseTool: CanUseTool;
  persistence: TurnPersistence;
  /** `/skill` allowedTools for THIS turn (already parse-filtered). Narrows only. */
  skillScope?: readonly string[];
  /** `chat` | `web` | `ops` | `coding`. Narrows the pool sent to the model,
   *  executed, and inherited by sub-agents. Unknown → UnknownToolsetError. */
  toolset?: string;
  /** A concrete (route-resolved) provider. Absent → runtime.resolvedProvider. */
  provider?: LLMProvider;
  /** Per-turn model override. Absent → runtime.model. */
  model?: string;
  /** Frozen exact-model evidence, shared with route validation/proactive compaction. */
  modelMetadata?: ModelRecord;
  /** Per-turn effort. Absent → the session's own level (sessionCtx.effort). */
  effort?: ReasoningEffort;
  /** Trusted instructions appended to the base system prompt for this turn
   *  only. Never persisted to history. Apply gateTurnInstructions first. */
  instructions?: string;
  pollSteering?: () => Promise<string | null>;
  traceRecorder?: (event: TraceEvent) => void;
  delegationLifecycleRecorder?: (event: DelegationLifecycleEvent) => void;
  signal?: AbortSignal;
  /** createAgent `rethrow` mode. Default true (the gateway's turn_error path). */
  rethrow?: boolean;
};

/** The per-drive values that vary across a compaction pivot within a turn. */
export type TurnHop = {
  sessionId: string;
  sessionCtx: SessionContext;
  /** Host-minted attestation turn id for this drive, when attestation is on. */
  turnId?: string;
  /** 'sdk-store' mode: how many leading input messages are already stored
   *  (the hydrated view's length). Ignored in 'gateway-callbacks' mode. */
  storedPrefixLength?: number;
};

export type ComposedTurn = {
  agent: Agent;
  /** The pool this turn runs against: runtime pool ∩ skill scope ∩ toolset. */
  tools: Tool<unknown, unknown>[];
  /** The gate after the skill scope wrapper (the SDK adds the toolset wrapper). */
  canUseTool: CanUseTool;
  /** The relay's `persist` argument: the host for 'gateway-callbacks', else
   *  undefined so the SDK store ports are the only writer. */
  relayPersist: PersistMessageHost | undefined;
  /** Build the PerTurn slice for one drive (call again after a pivot). */
  perTurn(hop: TurnHop): PerTurn;
};

/** Compose one user turn. Call once per turn: the agent reads the LIVE
 *  runtime refs, so a between-turn reload is picked up by the next turn. */
export function composeTurn(opts: ComposeTurnOptions): ComposedTurn {
  const { runtime, persistence } = opts;
  const modelSnapshot = selectedTurnModel(
    (opts.provider ?? runtime.resolvedProvider.transport).name,
    opts.model ?? runtime.model,
    {
      maxTokens: runtime.maxTokens,
      harnessHome: runtime.harnessHome,
      settings: runtime.injectedSettings,
      ...(opts.modelMetadata ? { modelMetadata: opts.modelMetadata } : {}),
    },
  );
  if (opts.toolset !== undefined && !isToolsetName(opts.toolset)) {
    throw new UnknownToolsetError(opts.toolset);
  }
  const toolset: ToolsetName | undefined = opts.toolset;

  // Feature B — turn-scoped skill tool restriction. `buildToolScope` READS
  // the shared pool and returns a FRESH filtered copy when scoped —
  // runtime.toolPool is never mutated (the reload contract mutates it in
  // place, so aliasing/narrowing it would corrupt every other session).
  // Undefined/empty scope → identity (scope.tools === runtime.toolPool,
  // scope.canUseTool === the session gate). The scope gate denies
  // out-of-scope calls BEFORE the session gate runs (only ever removes).
  const scope = buildToolScope({
    allowedTools: opts.skillScope,
    tools: runtime.toolPool,
    canUseTool: opts.canUseTool,
  });
  // Toolset narrows further (never adds). Applied here as well as inside
  // createAgent so the sub-agent parent pool and skill visibility (both built
  // from the tool context's effective pool) match the schemas the model sees.
  const tools = toolset === undefined ? scope.tools : filterToolsForToolset(scope.tools, toolset);

  const systemPrompt = modelSystemPrompt(runtime.systemSegments, tools, modelSnapshot?.metadata);

  // STANDING config = the turn's LIVE values. Live-reload mutates
  // runtime.{provider,model,systemSegments,hookRunner,toolPool,…} BETWEEN
  // turns, never within one, so these are stable for the whole turn.
  const agent = createAgent({
    provider: opts.provider ?? runtime.resolvedProvider.transport,
    model: runtime.model,
    ...(modelSnapshot
      ? { modelMetadata: modelSnapshot.metadata, pricingSnapshot: modelSnapshot.pricing }
      : {}),
    systemPrompt,
    tools,
    hookRunner: runtime.hookRunner,
    microcompactConfig: runtime.microcompactConfig,
    maxTokens: runtime.maxTokens,
    cwd: runtime.cwd,
    ...(toolset !== undefined ? { toolset } : {}),
    // Conduct Port (1b) — the boot-bound governance provider. Absent →
    // createAgent's null provider (byte-identical, exactOptional).
    ...(runtime.conduct !== undefined ? { conduct: runtime.conduct } : {}),
    // Loop guard — absent block ⇒ the detector's own defaults.
    ...(runtime.loop !== undefined ? { loop: runtime.loop } : {}),
    // Single writer: store ports only in 'sdk-store' mode. The gateway owns
    // persistence out-of-band via persistMessage, so passing a store there
    // would double-write.
    ...(persistence.mode === 'sdk-store'
      ? {
          sessionStore: persistence.sessionStore,
          ...(persistence.transcripts !== undefined
            ? { transcripts: persistence.transcripts }
            : {}),
        }
      : {}),
  });

  const perTurn = (hop: TurnHop): PerTurn => ({
    // Persistence key + hooks/trace target (post-pivot id on a retry hop).
    sessionId: hop.sessionId,
    ...(hop.turnId !== undefined ? { turnId: hop.turnId } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(modelSnapshot
      ? { modelMetadata: modelSnapshot.metadata, pricingSnapshot: modelSnapshot.pricing }
      : {}),
    // Instructions AUGMENT the base prompt (createAgent resolves
    // `perTurn.systemPrompt ?? config.systemPrompt`, so passing only the
    // instruction would drop the bundle prompt). Ephemeral: the provider
    // `system:` field is never written to the messages table.
    ...(opts.instructions !== undefined
      ? { systemPrompt: appendInstructions(systemPrompt, opts.instructions) }
      : {}),
    // Always set: the session level is the meaningful default.
    effort: opts.effort ?? hop.sessionCtx.effort,
    memoryManager: hop.sessionCtx.memoryManager,
    ...(hop.sessionCtx.recall !== undefined ? { recall: hop.sessionCtx.recall } : {}),
    ...(opts.pollSteering !== undefined ? { pollSteering: opts.pollSteering } : {}),
    // Rebuilt per hop: re-reads the (possibly pivoted) SessionContext, and
    // sub-agents forked mid-turn inherit the narrowed pool.
    toolContext: buildSessionToolContext(runtime, hop.sessionId, scope.canUseTool, {
      ...(opts.delegationLifecycleRecorder !== undefined
        ? { delegationLifecycleRecorder: opts.delegationLifecycleRecorder }
        : {}),
      effectivePool: tools,
    }),
    canUseTool: scope.canUseTool,
    ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    rethrow: opts.rethrow ?? true,
    ...(persistence.mode === 'sdk-store' && hop.storedPrefixLength !== undefined
      ? { storedPrefixLength: hop.storedPrefixLength }
      : {}),
  });

  return {
    agent,
    tools,
    canUseTool: scope.canUseTool,
    relayPersist: persistence.mode === 'gateway-callbacks' ? persistence.host : undefined,
    perTurn,
  };
}
