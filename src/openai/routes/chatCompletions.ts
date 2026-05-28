// Phase 18 T2 + T5 — POST /v1/chat/completions.
//
// Validates the OpenAI ChatRequest against the Zod schema, resolves the
// requested model against the runtime, builds an ephemeral session, maps
// the request messages → internal Message[], appends any per-request
// system text to the runtime's bootstrapped systemPrompt, and drives the
// query() async generator to terminal.
//
// Two response shapes:
//   - `stream === true` (T5): Hono's streamSSE wraps the generator and
//     the T4 translator emits OpenAI-shaped SSE chunks via stream.write.
//   - otherwise (T2): drain the generator, project the last assistant
//     message through blocksToOpenAI(), return a chat.completion JSON
//     envelope.
//
// Permissions / tool gating mirrors cron's headless policy (D11 + D12):
//   - canUseTool: layered rule layers honored; `ask` callback auto-denies.
//   - tool pool: runtime.toolPool filtered against SUBAGENT_EXCLUDED_TOOLS.
//
// Stateless per request (D10) — the session row is minted on demand
// (metadata.kind = 'openai-api') so traces and per-session subsystems
// land in the harness state tree; no prior history is hydrated from the
// DB. The full conversation history comes from the request body.

import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { SUBAGENT_EXCLUDED_TOOLS } from '../../agents/exclusions.js';
import { loadPermissionSettings } from '../../config/settings.js';
import { query } from '../../core/query.js';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  SystemSegment,
  Terminal,
  TokenUsage,
} from '../../core/types.js';
import { buildCanUseTool } from '../../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../../permissions/redactSecretsTransformer.js';
import type { AskResponse } from '../../permissions/types.js';
import { isCredentialUnavailable } from '../../providers/errors.js';
import { disposeBus, getOrCreateBus } from '../../server/eventBus.js';
import { buildSessionToolContext } from '../../server/routes/turns.js';
import type { Runtime } from '../../server/runtime.js';
import { blocksToOpenAI } from '../mapping/blocksToOpenAI.js';
import { requestToMessages } from '../mapping/requestToMessages.js';
import { ChatRequestSchema } from '../mapping/schema.js';
import { InvalidModelError, resolveModelForRequest } from '../modelResolution.js';
import {
  DONE_MARKER,
  buildDelegatorProgressPayload,
  buildFinalChunk,
} from '../streaming/chunks.js';
import { translateStream } from '../streaming/sseTranslator.js';

/** OpenAI-shaped error envelope. The route returns 400/401/501 with this
 *  shape so SDK clients (Python/JS openai) surface the right exception
 *  classes (BadRequestError / AuthenticationError / APIError). */
function errorBody(
  message: string,
  type: string,
  code?: string,
): {
  error: { message: string; type: string; code?: string };
} {
  return {
    error: {
      message,
      type,
      ...(code !== undefined ? { code } : {}),
    },
  };
}

export function chatCompletionsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/v1/chat/completions', async (c) => {
    // 1) Parse + validate the JSON body. Both c.req.json() (on malformed
    // JSON) and ChatRequestSchema.parse (on invalid shape) throw — one
    // try/catch covers both with a 400 + invalid_request_error.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(errorBody(`malformed JSON body: ${msg}`, 'invalid_request_error'), 400);
    }
    let parsed: ReturnType<typeof ChatRequestSchema.parse>;
    try {
      parsed = ChatRequestSchema.parse(body);
    } catch (err) {
      const msg =
        err instanceof ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : err instanceof Error
            ? err.message
            : String(err);
      return c.json(errorBody(`invalid request: ${msg}`, 'invalid_request_error'), 400);
    }

    // 2) Resolve the requested model. T2 covers `harness-default` (runtime's
    // bootstrap transport) and unknown names (→ 400 with the supported list
    // per OQ2). T9 expands the explicit-name branch to call resolveProvider
    // for per-request provider/model overrides — the route hands the
    // resolver the runtime's harnessHome so it can locate credentials +
    // rate-guard state on disk. The result is used for THIS request only;
    // runtime state is untouched.
    let resolved: ReturnType<typeof resolveModelForRequest>;
    try {
      resolved = resolveModelForRequest(runtime, parsed.model, runtime.harnessHome);
    } catch (err) {
      if (err instanceof InvalidModelError) {
        return c.json(errorBody(err.message, 'invalid_request_error', 'model_not_found'), 400);
      }
      throw err;
    }

    // 3) Map the OpenAI messages[] onto internal Message[] + lift any
    // per-request system content. Invalid tool_call argument JSON throws
    // here (mapped to 400 via the try/catch).
    let mapped: ReturnType<typeof requestToMessages>;
    try {
      mapped = requestToMessages(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(errorBody(msg, 'invalid_request_error'), 400);
    }
    const { messages, extraSystemSegments } = mapped;
    // The harness's systemPrompt is built at runtime boot with the bundle
    // + base instructions + tool catalog. Per-request system messages
    // append as non-cacheable segments so they don't poison the prompt-cache
    // marker placement (the runtime's segments are pre-marked).
    const systemPrompt: SystemSegment[] = [
      ...runtime.systemSegments,
      ...extraSystemSegments.map((text) => ({ text, cacheable: false })),
    ];

    // 4) Mint (or reuse) the session row tagged metadata.kind='openai-api'.
    // The full session row keeps the trajectory + cost wiring in place
    // even though the wire surface is stateless. The session id flows
    // onto the chatcmpl-* response id and into the per-session ToolContext
    // / traceRecorder.
    //
    // T8: honor X-Session-Id. If the client supplies the header, that
    // value seeds the row's primary key AND drives the chatcmpl-<id>
    // wire id. Repeat invocations against the same id append messages to
    // the existing row (upsertSession is a no-op if the row exists).
    // Without the header, mint a fresh UUID per request (T2 behavior).
    //
    // H1 — namespace client-supplied ids with an `openai:` prefix before
    // using as the DB row's primary key. `upsertSession` returns the
    // existing row's session_id if the id is already present in the DB —
    // regardless of metadata.kind. Without a namespace, a client could
    // supply X-Session-Id matching an existing TUI/cron/drive session
    // UUID and have its messages appended to that session's transcript.
    // Prefixing on the server makes the openai-api session keyspace
    // structurally disjoint from any other surface's keyspace. The wire
    // response (chatcmpl-<id>) echoes the CLIENT's unprefixed id so the
    // public contract is unchanged.
    //
    // D10 invariant: history is NOT hydrated from the row. The query()
    // call below sees only the request's messages[]; the DB row exists
    // purely for trace + learning observability.
    //
    // Truncate to a defensive cap (256 chars) — the schema accepts any
    // TEXT but pathological client ids could break downstream tooling.
    const OPENAI_SESSION_PREFIX = 'openai:';
    const headerSessionId = c.req.header('x-session-id');
    const clientSessionId =
      headerSessionId !== undefined && headerSessionId.length > 0
        ? headerSessionId.slice(0, 256)
        : undefined;
    const internalSessionId =
      clientSessionId !== undefined
        ? `${OPENAI_SESSION_PREFIX}${clientSessionId}`
        : `${OPENAI_SESSION_PREFIX}${crypto.randomUUID()}`;
    const sessionId = runtime.sessionDb.upsertSession({
      sessionId: internalSessionId,
      provider: runtime.resolvedProvider.transport.name,
      model: resolved.model,
      title: 'openai-api',
      systemPrompt,
      metadata: {
        kind: 'openai-api',
        ...(clientSessionId !== undefined ? { clientSessionId } : {}),
      },
    });

    // 5) Build a request-scoped canUseTool. Same shape as cron's
    // headless policy: layered rules honored, `ask` callback auto-denies
    // (no interactive prompt surface). Wrapped with redactSecretsTransformer
    // for defense-in-depth (matches the M3 runtime canUseTool composition).
    const permissionSettings = loadPermissionSettings({
      cwd: runtime.cwd,
      harnessHome: runtime.harnessHome,
    });
    const ask = async (): Promise<AskResponse> => 'deny';
    const baseCanUseTool = buildCanUseTool({
      mode: 'default',
      ask,
      alwaysAllow: new Set<string>(),
      ruleLayers: permissionSettings.layers,
    });
    const sessionCanUseTool = wrapCanUseToolWithTransformers(baseCanUseTool, [
      redactSecretsTransformer,
    ]);

    // 6) Tool pool — filter the parent runtime pool against the
    // subagent exclusion set (D12). Matches cron's policy and ensures
    // recursive AgentTool / cron CRUD / task_stop never appear on the
    // request's tool surface.
    const requestToolPool = runtime.toolPool.filter(
      (tool) => !SUBAGENT_EXCLUDED_TOOLS.has(tool.name),
    );

    // 7) Construct the query() invocation. The same params drive both
    // branches; the difference is who drains the generator.
    //
    // T10 — client-disconnect propagation. `c.req.raw.signal` is the
    // Web Fetch AbortSignal that fires when the OpenAI client closes
    // its fetch() context (Ctrl-C, browser tab close, openai-python's
    // `with ... as response:` exiting on exception, etc.). We bridge
    // it to a request-scoped AbortController whose signal flows into
    // query(): the bridge insulates the inner pipeline from quirks in
    // Bun's Request.signal lifecycle (different runtime sources have
    // historically dispatched 'abort' at slightly different points;
    // owning our own controller makes the contract local and testable).
    //
    // `{ once: true }` ensures the listener is gc'd after firing. We
    // don't add a removeEventListener — the request-scoped signal goes
    // out of scope when the handler returns, taking the listener with
    // it. Fast-fail when the client already aborted before we got here
    // so we don't waste a turn on a definitely-cancelled request.
    const clientSignal: AbortSignal | undefined = c.req.raw.signal;
    const abortController = new AbortController();
    if (clientSignal?.aborted === true) {
      abortController.abort();
    } else {
      clientSignal?.addEventListener('abort', () => abortController.abort(), { once: true });
    }
    const toolContext = buildSessionToolContext(runtime, sessionId, sessionCanUseTool);
    const buildQuery = (): ReturnType<typeof query> =>
      query({
        provider: resolved.transport,
        model: resolved.model,
        messages,
        systemPrompt,
        tools: requestToolPool,
        toolContext,
        canUseTool: sessionCanUseTool,
        maxTokens: parsed.max_tokens ?? runtime.maxTokens,
        ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
        signal: abortController.signal,
        sessionId,
        cwd: runtime.cwd,
        hookRunner: runtime.hookRunner,
        microcompactConfig: runtime.microcompactConfig,
      });

    // 7.5) T8 — persist the latest user-role message from the request
    // (the prompt that drove this turn) BEFORE the model runs. Earlier
    // user messages in the request are treated as client-supplied
    // history — we don't re-persist them on every turn or the DB would
    // grow quadratically with conversation length. Only the most recent
    // user turn is observability-relevant.
    //
    // Defensive: if the request carries no user message at all (e.g.,
    // assistant-only continuation, exotic test fixtures), skip — the
    // assistant message persistence below still fires.
    const lastUserMessage = findLastUserMessage(messages);
    if (lastUserMessage !== undefined) {
      try {
        runtime.sessionDb.saveMessage(sessionId, {
          role: 'user',
          content: lastUserMessage.content,
        });
      } catch (err) {
        // Best-effort observability write (mirrors the assistant persistence
        // below). A DB-locked/disk-full failure here must NOT escape as a bare
        // 500 nor skip the per-request disposeSession in the finally block.
        console.error('[openai] user message persistence failed:', err);
      }
    }

    // H1 — strip the `openai:` namespace prefix before exposing the id on
    // the wire. The internal sessionId is the prefixed form (matching the
    // DB row's PK); the wire id (chatcmpl-<id>) echoes the CLIENT's view
    // — either their supplied X-Session-Id verbatim or the unprefixed
    // UUID the server minted on their behalf. Clients never see the
    // `openai:` namespace marker; it's a server-side detail.
    const wireSessionId =
      clientSessionId !== undefined
        ? clientSessionId
        : sessionId.slice(OPENAI_SESSION_PREFIX.length);
    const responseId = `chatcmpl-${wireSessionId}`;
    const created = Math.floor(Date.now() / 1000);

    // 8a) Streaming branch (T5). Hono's streamSSE owns the wire; the T4
    // translator owns the chunk shape. We pass `stream.write` directly
    // as the WriteFn — the translator already produces `data: …\n\n`
    // lines and the DONE terminator, so no extra wrapping is needed.
    //
    // Error handling: if query() throws mid-stream (provider error,
    // tool error not caught by query(), etc.), we catch inside the
    // streamSSE callback and emit a final-stop chunk + [DONE] so the
    // client sees a well-formed (if truncated) wire instead of a
    // half-finished stream. `runtime.disposeSession` always runs.
    if (parsed.stream === true) {
      return streamSSE(c, async (stream) => {
        // T8 — capture the final assistant_message as it passes through
        // the stream so we can persist after the wire flush. We wrap
        // the query() generator in a tee'ing async generator that
        // observes every yield without modifying it. The translator
        // sees the same shape; we just intercept assistant_message
        // events.
        let capturedAssistant: AssistantMessage | undefined;
        const tee = async function* (
          inner: ReturnType<typeof query>,
        ): AsyncGenerator<unknown, unknown, void> {
          for (;;) {
            const step = await inner.next();
            if (step.done) return step.value;
            const ev = step.value;
            if (
              ev !== null &&
              typeof ev === 'object' &&
              (ev as { type?: unknown }).type === 'assistant_message'
            ) {
              const maybe = (ev as { message?: AssistantMessage }).message;
              if (maybe !== undefined) capturedAssistant = maybe;
            }
            yield ev;
          }
        };

        // Phase 2 T7 — subscribe a side-channel writer to the per-session
        // event bus that emits the four delegator_* events as
        // `event: hermes.delegator.progress\ndata: <json>\n\n` SSE frames
        // interleaved with the OpenAI-shaped main stream. The synthesis
        // closure (router/progressEvents.ts) publishes onto the bus when
        // the scheduler dispatches a delegator + its atoms; this subscriber
        // is purely additive and forwards them to the wire.
        //
        // The bus drains its buffer immediately on subscribe, so any
        // delegator events published before this point (e.g., from a
        // recompaction hop's lifecycle) still flow out. Errors from
        // `stream.write` (closed client connection) are swallowed — the
        // main stream's error path owns recovery; the side-channel is
        // best-effort.
        const bus = getOrCreateBus(sessionId);
        const DELEGATOR_EVENT_TYPES = new Set<string>([
          'delegator_plan',
          'delegator_atom_started',
          'delegator_atom_complete',
          'delegator_complete',
        ]);
        const unsubscribe = bus.subscribe((event) => {
          if (!DELEGATOR_EVENT_TYPES.has(event.type)) return;
          const payload = buildDelegatorProgressPayload(
            event as Parameters<typeof buildDelegatorProgressPayload>[0],
          );
          // Fire-and-forget — stream.write returns Promise<void>; we void
          // it so the bus subscriber callback stays synchronous (publish
          // is synchronous on the bus side).
          void stream.write(`event: hermes.delegator.progress\ndata: ${payload}\n\n`);
        });

        try {
          const gen = buildQuery();
          await translateStream(
            tee(gen),
            { id: responseId, model: parsed.model, created },
            async (line) => {
              await stream.write(line);
            },
          );
        } catch (err) {
          // Best-effort: emit a final-stop chunk + DONE so the client
          // doesn't hang waiting for a terminator. We don't have a
          // structured way to surface the error inside the OpenAI
          // chunk shape (no `error` field on chat.completion.chunk),
          // so we close clean and log server-side.
          console.error('[openai] streaming /v1/chat/completions error:', err);
          try {
            const finalChunk = buildFinalChunk('stop', {
              id: responseId,
              model: parsed.model,
              created,
            });
            await stream.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            await stream.write(`data: ${DONE_MARKER}\n\n`);
          } catch {
            // The stream may already be closed (client disconnect, abort).
            // Nothing more to do.
          }
        } finally {
          // T7 — drop the bus subscriber FIRST so any delegator events
          // published during disposeSession (or a late publish from a
          // background hop) don't try to write to a closed stream.
          unsubscribe();
          // T8 — persist the final assistant message AFTER the wire
          // has flushed. Best-effort: a persistence failure should not
          // affect the response the client already received.
          if (capturedAssistant !== undefined) {
            try {
              runtime.sessionDb.saveMessage(sessionId, {
                role: 'assistant',
                content: capturedAssistant.content,
              });
            } catch (err) {
              console.error('[openai] streaming assistant persistence failed:', err);
            }
          }
          await runtime.disposeSession(sessionId);
          // This bus was created by getOrCreateBus() above. OpenAI-API sessions
          // never go through the /sessions/:id/events route, so nothing else
          // ever removes the entry — dispose it here or `sov serve` leaks one
          // ServerEventBus per streaming request, unbounded.
          disposeBus(sessionId);
        }
      });
    }

    // 8b) Non-streaming branch (T2). Drain query() to terminal and
    // capture the final assistant message + usage. Project both back
    // through blocksToOpenAI() into a chat.completion envelope.
    //
    // H2 — surface provider failures as a structured OpenAI error
    // envelope rather than a 200 OK with empty content. Two paths to
    // cover:
    //
    //  (a) Errors caught by query() itself — the orchestrator wraps
    //      provider.stream() in try/catch and returns
    //      `Terminal{reason: 'error', error}` rather than propagating.
    //      Without this fix the route would happily return 200 with an
    //      empty assistant message and `finish_reason: 'error'` (also
    //      non-spec; H3 fixes that too).
    //
    //  (b) Errors that escape query() — defense-in-depth. Without the
    //      try/catch, an exception would bubble to Hono's default 500
    //      with no body, leaving SDK clients with a generic APIError.
    //
    // Both paths funnel into the same classifier (`buildProviderErrorResponse`)
    // so SDK clients see consistent envelopes regardless of where the
    // failure surfaced.
    //
    // disposeSession runs in the `finally` block exactly once so we
    // never double-dispose. The session row stays in the DB so traces
    // and cost records are preserved.
    try {
      const gen = buildQuery();

      let finalAssistant: AssistantMessage | undefined;
      let latestUsage: TokenUsage | undefined;
      let terminal: Terminal = {
        reason: 'error',
        error: new Error('query() never terminated'),
      };
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          terminal = step.value;
          break;
        }
        const ev = step.value;
        if (ev && typeof ev === 'object' && 'type' in ev) {
          if (ev.type === 'assistant_message') {
            finalAssistant = ev.message;
          } else if (ev.type === 'usage_delta') {
            latestUsage = ev.usage;
          }
        }
      }

      // H2(a) — terminal-level error path. query() caught a provider
      // exception and surfaced a Terminal with reason='error'. Return
      // the structured envelope instead of 200 with an empty assistant
      // and `finish_reason: 'error'`.
      if (terminal.reason === 'error') {
        return buildProviderErrorResponse(c, terminal.error);
      }

      // T8 — persist the final assistant message before we project to
      // OpenAI shape. The DB row carries the canonical ContentBlock[]
      // (text + tool_use), not the OpenAI wire shape. Best-effort: a
      // persistence failure here should still let the client receive
      // the response.
      if (finalAssistant !== undefined) {
        try {
          runtime.sessionDb.saveMessage(sessionId, {
            role: 'assistant',
            content: finalAssistant.content,
          });
        } catch (err) {
          console.error('[openai] non-streaming assistant persistence failed:', err);
        }
      }

      // Project the final assistant message back to OpenAI shape. If
      // the run terminated without an assistant message (e.g. error
      // before the first model call), surface an empty content string so
      // the wire shape is still valid.
      const blocks: ContentBlock[] = finalAssistant?.content ?? [];
      const { content, tool_calls } = blocksToOpenAI(blocks);
      const finishReason = mapTerminalToFinishReason(terminal);

      // OpenAI's `usage` object uses prompt/completion/total tokens; our
      // internal TokenUsage uses input/output. Map directly; missing
      // fields default to 0 (some providers don't emit one or the other).
      const promptTokens = latestUsage?.inputTokens ?? 0;
      const completionTokens = latestUsage?.outputTokens ?? 0;

      return c.json({
        id: responseId,
        object: 'chat.completion',
        created,
        // Echo the requested model name verbatim (not the resolved one).
        // OpenAI clients use this field for display/cost-tracking; surfacing
        // `harness-default` here keeps the contract literal — if the user
        // asked for harness-default, that's what they got.
        model: parsed.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
              ...(tool_calls !== undefined ? { tool_calls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (err) {
      // H2(b) — defense-in-depth: catch anything that escapes query().
      // Same classifier as the terminal-level branch so the wire shape
      // is consistent regardless of where the failure surfaced.
      console.error('[openai] non-streaming /v1/chat/completions error:', err);
      return buildProviderErrorResponse(c, err);
    } finally {
      // Always tear down per-session subsystems (trace writer flush,
      // trajectory write) — even on error. The session row stays in the
      // DB so traces and cost records are preserved.
      await runtime.disposeSession(sessionId);
    }
  });

  return r;
}

/** Map the internal Terminal.reason → OpenAI's `finish_reason` string.
 *
 *  H3: OpenAI's spec only defines `'stop' | 'length' | 'content_filter'
 *  | 'tool_calls' | 'function_call'` for finish_reason. Previously this
 *  function returned `'error'` when terminal.reason was 'error',
 *  'interrupted', or 'checkin' — none of which are valid. SDK clients
 *  validation-error on a non-spec finish_reason and surface unhelpful
 *  parse failures instead of the model output.
 *
 *  D9: never `'tool_calls'` either — the harness runs tools internally
 *  within the same request, so the client never re-enters and would
 *  never observe a tool_calls terminal from us.
 *
 *  Result domain narrowed to `'stop' | 'length'` to make the wire
 *  contract enforceable at the type level. The streaming branch's
 *  `deriveFinishReason` already had this contract; H3 brings the
 *  non-streaming branch into parity.
 *
 *  Note: `terminal.reason === 'error'` is short-circuited upstream by
 *  H2's structured error envelope — but this function stays defensive
 *  so any future path that bypasses the H2 check still produces a
 *  spec-valid value.
 *
 *  Exported for unit testing — the pure function is easier to verify
 *  than driving non-standard terminals through the full route. */
export function mapTerminalToFinishReason(terminal: Terminal): 'stop' | 'length' {
  if (terminal.reason === 'max_tokens' || terminal.reason === 'max_turns') {
    return 'length';
  }
  return 'stop';
}

/** T8 — scan the request's messages[] for the most recent user-role
 *  message. Used to persist only the latest user prompt against the
 *  session row (earlier user messages in the request are client-supplied
 *  history). User-role messages may carry text OR tool_result blocks;
 *  the persistence layer doesn't care — it stores the ContentBlock[]
 *  verbatim. Returns undefined when the request has no user message
 *  (rare: assistant-only continuation, exotic test fixtures). */
function findLastUserMessage(msgs: Message[]): Extract<Message, { role: 'user' }> | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user') return m;
  }
  return undefined;
}

/** H2 — extract an upstream HTTP status from an error of unknown shape.
 *
 *  Different SDKs and our own ProviderHttpError use different field
 *  names — Anthropic SDK errors expose `.status`, some other libraries
 *  use `.statusCode`. We probe both. Returns undefined when the error
 *  is not an HTTP error (e.g. network failure, parse error).
 *
 *  Defensive against the `unknown` shape — we only treat the value as
 *  a status code when it's a positive integer in 100..599. */
function extractUpstreamStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const candidate =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof candidate !== 'number') return undefined;
  if (!Number.isInteger(candidate)) return undefined;
  if (candidate < 100 || candidate >= 600) return undefined;
  return candidate;
}

/** H2 — classify a provider error into one of three OpenAI-shaped
 *  envelopes and return the matching Hono response:
 *
 *   - 401 + `invalid_api_key` → credential / auth-related errors.
 *     The OpenAI Python/JS SDKs map this to AuthenticationError.
 *   - mirror upstream HTTP status + `upstream_error` → ProviderHttpError
 *     or SDK-shaped errors with a `.status` field. Surfaces as APIError
 *     with the right code (e.g. a real 429 stays 429, not 500).
 *   - 500 + `api_error` → generic fallback. Surfaces as APIError
 *     without further classification.
 *
 *  Used by both the terminal-error path (query() caught the failure and
 *  returned `Terminal{reason: 'error'}`) and the defense-in-depth catch
 *  (exception escaped query()) so the wire shape is identical regardless
 *  of where the failure originated.
 *
 *  `err` is typed `unknown` because both call sites observe it from a
 *  `catch` or a `Terminal.error?: Error` — we narrow defensively. */
function buildProviderErrorResponse(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);

  if (
    isCredentialUnavailable(err) ||
    /credential|api[\s_-]?key|unauthorized|forbidden/i.test(message)
  ) {
    return c.json(
      {
        error: {
          message,
          type: 'invalid_api_key',
        },
      },
      401,
    );
  }

  const upstreamStatus = extractUpstreamStatus(err);
  if (upstreamStatus !== undefined && upstreamStatus >= 400 && upstreamStatus < 600) {
    return c.json(
      {
        error: {
          message,
          type: 'upstream_error',
        },
      },
      upstreamStatus as ContentfulStatusCode,
    );
  }

  return c.json(
    {
      error: {
        message,
        type: 'api_error',
      },
    },
    500,
  );
}
