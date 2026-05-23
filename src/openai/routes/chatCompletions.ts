// Phase 18 T2 — POST /v1/chat/completions (non-streaming branch only).
//
// Validates the OpenAI ChatRequest against the Zod schema, resolves the
// requested model against the runtime, builds an ephemeral session, maps
// the request messages → internal Message[], appends any per-request
// system text to the runtime's bootstrapped systemPrompt, and drives the
// query() async generator to terminal. On completion, the last assistant
// message is projected back through blocksToOpenAI() and returned as an
// OpenAI chat.completion envelope.
//
// Permissions / tool gating mirrors cron's headless policy (D11 + D12):
//   - canUseTool: layered rule layers honored; `ask` callback auto-denies.
//   - tool pool: runtime.toolPool filtered against SUBAGENT_EXCLUDED_TOOLS.
//
// Stateless per request (D10) — the session row is minted on demand
// (metadata.kind = 'openai-api') so traces and per-session subsystems
// land in the harness state tree; no prior history is hydrated from the
// DB. The full conversation history comes from the request body.
//
// Streaming (`req.stream === true`) is not handled in T2 — that branch is
// rejected with a 501 until T5 wires SSE.

import { Hono } from 'hono';
import { ZodError } from 'zod';
import { SUBAGENT_EXCLUDED_TOOLS } from '../../agents/exclusions.js';
import { loadPermissionSettings } from '../../config/settings.js';
import { query } from '../../core/query.js';
import type {
  AssistantMessage,
  ContentBlock,
  SystemSegment,
  Terminal,
  TokenUsage,
} from '../../core/types.js';
import { buildCanUseTool } from '../../permissions/canUseTool.js';
import { wrapCanUseToolWithTransformers } from '../../permissions/inputTransformer.js';
import { redactSecretsTransformer } from '../../permissions/redactSecretsTransformer.js';
import type { AskResponse } from '../../permissions/types.js';
import { buildSessionToolContext } from '../../server/routes/turns.js';
import type { Runtime } from '../../server/runtime.js';
import { blocksToOpenAI } from '../mapping/blocksToOpenAI.js';
import { requestToMessages } from '../mapping/requestToMessages.js';
import { ChatRequestSchema } from '../mapping/schema.js';
import { InvalidModelError, resolveModelForRequest } from '../modelResolution.js';

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

    // 2) T2 only handles the non-streaming branch. Streaming lands in T5.
    if (parsed.stream === true) {
      return c.json(
        errorBody('streaming responses not yet implemented (T5)', 'not_implemented'),
        501,
      );
    }

    // 3) Resolve the requested model. T2: harness-default only; unknown
    // names throw InvalidModelError → 400 with the supported list per OQ2.
    let resolved: ReturnType<typeof resolveModelForRequest>;
    try {
      resolved = resolveModelForRequest(runtime, parsed.model);
    } catch (err) {
      if (err instanceof InvalidModelError) {
        return c.json(errorBody(err.message, 'invalid_request_error', 'model_not_found'), 400);
      }
      throw err;
    }

    // 4) Map the OpenAI messages[] onto internal Message[] + lift any
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

    // 5) Mint an ephemeral session row tagged metadata.kind='openai-api'.
    // The full session row keeps the trajectory + cost wiring in place
    // even though the wire surface is stateless. The session id flows
    // onto the chatcmpl-* response id and into the per-session ToolContext
    // / traceRecorder (T8 expands this to honor an X-Session-Id header).
    const sessionId = runtime.sessionDb.createSession({
      provider: runtime.resolvedProvider.transport.name,
      model: resolved.model,
      title: 'openai-api',
      systemPrompt,
      metadata: { kind: 'openai-api' },
    });

    try {
      // 6) Build a request-scoped canUseTool. Same shape as cron's
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

      // 7) Tool pool — filter the parent runtime pool against the
      // subagent exclusion set (D12). Matches cron's policy and ensures
      // recursive AgentTool / cron CRUD / task_stop never appear on the
      // request's tool surface.
      const requestToolPool = runtime.toolPool.filter(
        (tool) => !SUBAGENT_EXCLUDED_TOOLS.has(tool.name),
      );

      // 8) Drive the query() generator to terminal. We capture:
      //   - the final assistant message (last assistant_message event)
      //   - the final usage_delta (provider's last token-count update)
      //   - the Terminal value (generator return)
      // No SSE wiring — we just drain to terminal and project.
      const toolContext = buildSessionToolContext(runtime, sessionId, sessionCanUseTool);
      const gen = query({
        provider: resolved.transport,
        model: resolved.model,
        messages,
        systemPrompt,
        tools: requestToolPool,
        toolContext,
        canUseTool: sessionCanUseTool,
        maxTokens: parsed.max_tokens ?? runtime.maxTokens,
        ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
        sessionId,
        cwd: runtime.cwd,
        hookRunner: runtime.hookRunner,
        microcompactConfig: runtime.microcompactConfig,
      });

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

      // 9) Project the final assistant message back to OpenAI shape. If
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

      const id = `chatcmpl-${sessionId}`;
      const created = Math.floor(Date.now() / 1000);

      return c.json({
        id,
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
 *  D9: never `tool_calls` because the harness runs tools internally
 *  within the same request — the client never re-enters. */
function mapTerminalToFinishReason(terminal: Terminal): 'stop' | 'length' | 'error' {
  switch (terminal.reason) {
    case 'completed':
      return 'stop';
    case 'max_tokens':
    case 'max_turns':
      return 'length';
    default:
      return terminal.reason === 'error' ? 'error' : 'stop';
  }
}
