# Phase 18 — Optional OpenAI-compatible HTTP API server · Implementation Plan

**Goal:** Drop-in OpenAI backend at `http://localhost:8765/v1`. Any tool speaking OpenAI's API (Open WebUI, LibreChat, AnythingLLM, raw `openai` SDK with custom `base_url`) can drive the harness without code changes.

**Architecture:** New `sov serve` subcommand boots a runtime + a Hono app on a stable port (default 8765). New `src/openai/` module owns the OpenAI translation surface. The existing TUI/drive/dispatch Hono server is untouched. Stateless per request; `query()` is driven directly (not `AgentRunner`) because the wire shape carries full message history natively. Tool execution happens internally inside the harness — clients see `tool_calls` in the assistant chunks for observability but never need to call back.

**Tech Stack:** TypeScript on Bun. Hono for HTTP + SSE. Zod for OpenAI request/response schemas. No new deps.

---

## Locked design decisions

| Decision | Choice |
|---|---|
| **D1 module location** | New `src/openai/` top-level subsystem, sibling of `src/cron/` |
| **D2 file layout** | `server.ts`, `app.ts`, `auth.ts`, `routes/{health,chatCompletions,models}.ts`, `mapping/{schema,requestToMessages,blocksToOpenAI}.ts`, `streaming/{chunks,sseTranslator}.ts`, `modelResolution.ts` |
| **D3 CLI surface** | New `sov serve` subcommand; SIGINT/SIGTERM → server.stop() → runtime.dispose() → exit 0 |
| **D4 port** | Default `8765`, env `SOV_OPENAI_PORT`, `--port` flag. **Fail loudly on busy port** — no auto-fallback (external UIs configure once) |
| **D5 auth** | Bearer token. `SOV_OPENAI_API_KEY` env > `openaiServer.apiKey` config > **refuse to boot**. 401 with OpenAI error shape on mismatch. Timing-safe compare. `/health` exempt; all `/v1/*` require auth |
| **D6 provider resolution** | `req.model = 'harness-default'` (or empty) → runtime's bootstrapped provider/model. Explicit model name → `resolveProvider(provider, model)`. Unknown → **400 with model list (strict, no aliasing)** |
| **D7 stream driver** | Drive `query()` directly (accepts `messages: Message[]`), NOT `AgentRunner.run(prompt)` |
| **D8 tool-use rendering** | Emit `tool_calls` in the same assistant chunk; whole-arg JSON (no partial streaming). Tool execution mirrored via `event: hermes.tool.progress` SSE events |
| **D9 multi-turn** | Harness runs tools internally within a single `/v1/chat/completions` call. `finish_reason` is always `"stop"` or `"length"`, never `"tool_calls"` (we don't ask the client to execute) |
| **D10 session continuity** | Fully stateless. `X-Session-Id` header is observability-only — mints a SessionDb row tagged `metadata.kind='openai-api'` for traces, does NOT hydrate history from DB |
| **D11 tool permission policy** | Auto-deny `ask` fall-through (same as cron). Rule layers honored. No interactive prompts |
| **D12 tool pool filter** | `runtime.toolPool` filtered against `SUBAGENT_EXCLUDED_TOOLS` (same as cron + subagent surfaces) |
| **D13 test strategy** | Pure unit tests for mapping/chunks; integration tests against real Hono + mock provider via `fetch`. Python `openai` smoke recorded in testing-log, not in CI |
| **D14 SSE format** | Hono `streamSSE`. Default-event chunks (`data: {...}\n\n`) for OpenAI consumers; `event: hermes.tool.progress\ndata: {...}` for the progress side-channel. `data: [DONE]\n\n` terminates |
| **OQ1 API key default** | Required (env or config) — refuse to boot otherwise |
| **OQ2 unknown model** | Strict 400 with model list — no silent aliasing |
| **OQ3 bundle scope** | Single bundle per server in v0 — `runtime.cwd` fixed at boot |
| **OQ4 client disconnect** | Abort in-flight turn via `AbortSignal` (matches OpenAI behavior) |
| **OQ5 cron under serve** | On by default; `--no-cron` flag opts out (long-lived server is natural cron host) |

## What's intentionally out of scope

- `/v1/responses` (stateful Responses API) — defer.
- `Idempotency-Key` cache — defer.
- `/v1/threads`, `/v1/images`, `/v1/embeddings` — permanent skip.
- Per-request `X-Bundle-Root` header — future.
- Interactive permission prompts via SSE — wire has no concept.
- HTTPS / TLS — localhost only; reverse proxy if remote.
- Multi-user / per-key scoping.
- Server-side rate limiting (provider rate-limits already apply).
- Streaming partial `tool_call` arguments.
- Function-call delegation to the client.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | OpenAI client compatibility quirks (LibreChat over-validates chunks) | Manual smoke against curl + Python `openai` + Open WebUI in T11; document quirks in state file |
| R2 | `assistant_message` event re-emits text already streamed | Translator must IGNORE text content of `assistant_message` and only extract `tool_use` blocks. Test pins this in T4 |
| R3 | Bun.serve idle-timeout aborting long streams | Set `idleTimeout: 0` (TUI server already does this) |
| R4 | First-time-user friction with required API key | Error message includes exact `sov config set openaiServer.apiKey <key>` command |
| R5 | Per-request `resolveProvider` cost | Cheap (ms-scale, file-cached pools). Add server-side LRU only if profiling shows otherwise |

---

## T1 — Bearer auth + module skeleton (~45 min)

**Files:**
- Create: `src/openai/auth.ts`, `src/openai/app.ts`, `src/openai/server.ts`, `src/openai/routes/health.ts`, `tests/openai/auth.test.ts`, `tests/openai/health.test.ts`.
- Modify: `src/config/schema.ts` (add optional `openaiServer: { apiKey?: string; port?: number; host?: string }` block).

**Steps:**

- [ ] **Step 1** — Read `src/server/index.ts` for the existing Hono-on-Bun pattern; `src/server/routes/health.ts` for the health-route shape; `src/config/schema.ts` for the Zod root.

- [ ] **Step 2** — Write failing tests in `tests/openai/auth.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { bearerAuth } from '../../src/openai/auth.js';

describe('bearerAuth', () => {
  test('returns 401 when Authorization header is missing', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x');
    expect(res.status).toBe(401);
  });

  test('returns 401 on header mismatch', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  test('calls next on match', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: { authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
  });

  test('returns OpenAI error shape on 401', async () => {
    const app = new Hono().use('*', bearerAuth('secret')).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x');
    const body = await res.json();
    expect(body.error?.type).toBe('invalid_api_key');
  });
});
```

And `tests/openai/health.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { buildOpenAIApp } from '../../src/openai/app.js';

describe('GET /health', () => {
  test('returns 200 with ok and version', async () => {
    const app = buildOpenAIApp({ runtime: null as any, apiKey: 'k' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
  });

  test('health does NOT require auth', async () => {
    const app = buildOpenAIApp({ runtime: null as any, apiKey: 'k' });
    const res = await app.request('/health'); // no Authorization header
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3** — RED.

- [ ] **Step 4** — Implement `src/openai/auth.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';

export function bearerAuth(expectedKey: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    const presented = match?.[1] ?? '';
    if (presented.length !== expectedKey.length || !timingSafeEqual(presented, expectedKey)) {
      return c.json(
        { error: { message: 'Unauthorized', type: 'invalid_api_key', code: 401 } },
        401,
      );
    }
    await next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```

- [ ] **Step 5** — Implement `src/openai/routes/health.ts`:

```typescript
import { Hono } from 'hono';
import { harnessVersion } from '../../version.js';

export function healthRoute(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, version: harnessVersion() }));
  return app;
}
```

- [ ] **Step 6** — Implement `src/openai/app.ts`:

```typescript
import { Hono } from 'hono';
import type { Runtime } from '../server/runtime.js';
import { bearerAuth } from './auth.js';
import { healthRoute } from './routes/health.js';

export type OpenAIAppOpts = {
  runtime: Runtime;
  apiKey: string;
};

export function buildOpenAIApp(opts: OpenAIAppOpts): Hono {
  const app = new Hono();
  app.route('/', healthRoute());
  // /v1/* (auth-gated) — added in T2.
  return app;
}
```

- [ ] **Step 7** — Implement `src/openai/server.ts`:

```typescript
import { serve, type ServerType } from '@hono/node-server';
import type { Runtime } from '../server/runtime.js';
import { buildOpenAIApp } from './app.js';

export type OpenAIServerOpts = {
  runtime: Runtime;
  apiKey: string;
  port: number;
  host?: string;
};

export type OpenAIServerHandle = {
  port: number;
  stop: () => Promise<void>;
};

export function createOpenAIServer(opts: OpenAIServerOpts): OpenAIServerHandle {
  const app = buildOpenAIApp({ runtime: opts.runtime, apiKey: opts.apiKey });
  // Use Bun.serve directly (same as src/server/index.ts) — confirm during impl.
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host ?? '127.0.0.1',
    idleTimeout: 0,
    fetch: app.fetch,
  });
  return {
    port: server.port,
    stop: async () => { server.stop(); },
  };
}
```

(If `src/server/index.ts` uses `@hono/node-server`'s `serve` instead of `Bun.serve`, mirror that. Read the file first.)

- [ ] **Step 8** — Update `src/config/schema.ts` to add the optional config block.

- [ ] **Step 9** — GREEN. Pre-commit gate.

- [ ] **Step 10** — Commit + push.

```bash
git add src/openai/ src/config/schema.ts tests/openai/
git commit -m "feat(openai): bearer auth middleware and server skeleton"
git push origin master
```

---

## T2 — Stub `POST /v1/chat/completions` non-streaming (~75 min)

**Files:**
- Create: `src/openai/routes/chatCompletions.ts`, `src/openai/mapping/schema.ts`, `src/openai/mapping/requestToMessages.ts`, `src/openai/mapping/blocksToOpenAI.ts`, `src/openai/modelResolution.ts`, plus matching test files under `tests/openai/`.
- Modify: `src/openai/app.ts` (mount `/v1/chat/completions` behind auth).

**Steps:**

- [ ] **Step 1** — Read `src/core/query.ts` to confirm signature (expected: `query(opts: { messages: Message[], provider, model, tools, canUseTool, toolContext, ... }): AsyncGenerator<StreamEvent | Message, Terminal>`). Read `src/core/types.ts` for `Message`, `ContentBlock`, `Terminal`, `StreamEvent`. Read `src/cron/wiring.ts:80-150` for how cron drives `query()`-equivalent — it uses `AgentRunner` so this differs; use `query()` directly.

- [ ] **Step 2** — Write failing tests for the mapping helpers and the route. Start with the pure-function tests since they're cheapest:

```typescript
// tests/openai/mapping/requestToMessages.test.ts
import { describe, expect, test } from 'bun:test';
import { requestToMessages } from '../../../src/openai/mapping/requestToMessages.js';

describe('requestToMessages', () => {
  test('maps a simple user message', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.extraSystemSegments).toEqual([]);
  });

  test('lifts system messages into systemSegments', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(result.extraSystemSegments).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
  });

  test('maps assistant message with tool_calls into tool_use content blocks', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        { role: 'assistant', content: 'I will call', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'FileRead', arguments: '{"path":"/x"}' } },
        ] },
      ],
    });
    const msg = result.messages[0];
    expect(msg.role).toBe('assistant');
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test('maps tool role into user-role tool_result block', () => {
    const result = requestToMessages({
      model: 'harness-default',
      messages: [
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'FileRead', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      ],
    });
    // Internal model: tool_result blocks live in a user-role message
    expect(result.messages[1].role).toBe('user');
  });
});
```

(Continue with `blocksToOpenAI`, `modelResolution`, and the integration test for `chatCompletions.nonstreaming.test.ts` per the plan agent's draft.)

- [ ] **Step 3** — RED.

- [ ] **Step 4** — Implement the Zod schemas (`mapping/schema.ts`) for OpenAI's ChatRequest / ChatResponse shapes. Use the OpenAI public spec — `messages[]` is required, `model` is required, `stream` defaults false, `tools[]` is optional. The schema enforces shape; downstream code trusts parsed types.

- [ ] **Step 5** — Implement `requestToMessages` and `blocksToOpenAI`. Lift `system` messages out (the harness's `systemPrompt` segments are constructed at runtime boot; per-request system text appends).

- [ ] **Step 6** — Implement `modelResolution.resolveModelForRequest(runtime, requestedModel)` per D6. Magic `harness-default` returns the bootstrapped provider/model; explicit names call `resolveProvider`. Unknown throws `InvalidModelError` (caught by the route → 400).

- [ ] **Step 7** — Implement `chatCompletions.ts`. Non-streaming path: drive `query()` to terminal, build the OpenAI response object. Return JSON.

- [ ] **Step 8** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): chat completions non-streaming with mock provider"
```

---

## T3 — `sov serve` CLI subcommand (~45 min)

**Files:**
- Modify: `src/main.ts` (add `program.command('serve')` after `serve-dev` line ~280).
- Create: `tests/openai/serve.cli.test.ts`.

**Steps:**

- [ ] **Step 1** — Read the existing `daemon` block (around `src/main.ts:718`) for the long-running-process pattern: buildRuntime → startServer → console.log boot lines → register SIGINT/SIGTERM handlers → `await new Promise<never>(() => {})`.

- [ ] **Step 2** — Write a failing test that spawns the CLI:

```typescript
// tests/openai/serve.cli.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

describe('sov serve CLI', () => {
  test('boots, responds to /health, exits cleanly on SIGTERM', async () => {
    const proc = spawn('bun', ['src/main.ts', 'serve', '--port', '8766'], {
      env: {
        ...process.env,
        SOV_TEST_MOCK_PROVIDER: '1',
        SOV_OPENAI_API_KEY: 'test',
        HARNESS_HOME: `/tmp/sov-serve-test-${Date.now()}`,
      },
      stdio: 'pipe',
    });
    // Wait for boot — server prints "Listening on http://127.0.0.1:8766" or similar.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('boot timeout')), 5000);
      proc.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('8766')) { clearTimeout(t); resolve(); }
      });
    });
    const res = await fetch('http://127.0.0.1:8766/health');
    expect(res.status).toBe(200);
    proc.kill('SIGTERM');
    const exitCode = await new Promise<number | null>((r) => proc.on('exit', r));
    expect(exitCode).toBe(0);
  }, 15000);
});
```

- [ ] **Step 3** — Implement the `serve` command in `src/main.ts`:

```typescript
program
  .command('serve')
  .description('Run the OpenAI-compatible HTTP API server')
  .option('--port <n>', 'port (default 8765)', (v) => Number.parseInt(v, 10))
  .option('--host <addr>', 'host (default 127.0.0.1)')
  .option('--provider <name>', 'provider override')
  .option('--model <name>', 'model override')
  .option('--max-tokens <n>', 'max-tokens override', (v) => Number.parseInt(v, 10))
  .option('--permission-mode <mode>', 'permissions mode', parsePermissionMode)
  .option('--no-cron', 'disable the cron tick loop')
  .option('--bundle <path>', 'harness bundle path')
  .option('--no-preflight', 'skip provider preflight')
  .action(async (opts) => {
    const { resolveHarnessHome } = await import('./config/paths.js');
    const { loadEffectiveConfig } = await import('./config/store.js');
    const { buildRuntime } = await import('./server/runtime.js');
    const { createOpenAIServer } = await import('./openai/server.js');

    const harnessHome = resolveHarnessHome();
    const config = loadEffectiveConfig(harnessHome);
    const apiKey = process.env.SOV_OPENAI_API_KEY ?? config.openaiServer?.apiKey;
    if (!apiKey) {
      console.error(
        'sov serve: API key required.\n' +
          'Set SOV_OPENAI_API_KEY=<key> or run: sov config set openaiServer.apiKey <key>',
      );
      process.exit(1);
    }
    const port = opts.port ?? Number.parseInt(process.env.SOV_OPENAI_PORT ?? '', 10) || 8765;
    const host = opts.host ?? process.env.SOV_OPENAI_HOST ?? '127.0.0.1';

    const runtime = await buildRuntime({
      cwd: process.cwd(),
      cronEnabled: opts.cron !== false,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.bundle !== undefined ? { bundleRoot: opts.bundle } : {}),
      ...(opts.preflight === false ? { skipPreflight: true } : {}),
    });
    const server = createOpenAIServer({ runtime, apiKey, port, host });

    console.log(`sov serve: listening on http://${host}:${server.port}`);
    console.log(`  provider=${runtime.resolvedProvider?.transport.name ?? 'unknown'}  model=${runtime.model ?? 'unknown'}`);
    console.log(`  cron=${opts.cron !== false ? 'on' : 'off'}  harnessHome=${harnessHome}`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`sov serve: ${signal} received, shutting down...`);
      await server.stop();
      await runtime.dispose();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await new Promise<never>(() => {});
  });
```

- [ ] **Step 4** — GREEN. Gate. Commit + push.

```bash
git commit -m "feat(openai): add sov serve subcommand"
```

This task closes the **non-streaming half of the spec's `Check`** — `curl -H "Authorization: Bearer test" -X POST http://localhost:8765/v1/chat/completions -d '{"model":"harness-default","messages":[{"role":"user","content":"hi"}]}'` returns a sensible OpenAI-shaped response.

---

## T4 — Streaming translator: text deltas (~60 min)

**Files:**
- Create: `src/openai/streaming/chunks.ts`, `src/openai/streaming/sseTranslator.ts`, `tests/openai/streaming/chunks.test.ts`, `tests/openai/streaming/sseTranslator.test.ts`.

**Steps:**

- [ ] **Step 1** — Tests in `chunks.test.ts`:
   - `buildDeltaChunk(text, ctx)` returns `{id, object:"chat.completion.chunk", created, model, choices:[{index:0, delta:{content:text}, finish_reason:null}]}`.
   - `buildFinalChunk("stop", ctx)` returns the same shape with empty delta and `finish_reason:"stop"`.
   - `buildDoneMarker()` returns the literal string `"[DONE]"`.

- [ ] **Step 2** — Tests in `sseTranslator.test.ts`. Feed a fake `AsyncGenerator` yielding text_delta + message_stop, return-value `{reason:'completed'}`. Assert the translator emits the expected SSE wire (two text chunks, one final stop chunk, one `[DONE]`).

- [ ] **Step 3** — RED.

- [ ] **Step 4** — Implement `chunks.ts` (pure functions) and `sseTranslator.ts`:

```typescript
import type { Terminal } from '../../core/types.js'; // adjust path as needed
import { buildDeltaChunk, buildFinalChunk } from './chunks.js';

export type TranslatorCtx = {
  id: string;
  model: string;
  created: number;
};

export async function translateStream(
  gen: AsyncGenerator<unknown, Terminal>,
  ctx: TranslatorCtx,
  write: (line: string) => Promise<void> | void,
): Promise<Terminal> {
  let terminal: Terminal | undefined;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      terminal = step.value;
      break;
    }
    const ev = step.value as { type?: string; text?: string; stop_reason?: string };
    if (ev?.type === 'text_delta' && typeof ev.text === 'string') {
      await write(`data: ${JSON.stringify(buildDeltaChunk(ev.text, ctx))}\n\n`);
    }
    // Suppress assistant_message text (already streamed via deltas) — see R2.
    // Tool-use blocks handled in T6.
    // message_stop with stop_reason !== 'tool_use' triggers the final chunk.
  }
  const reason = terminal?.reason === 'completed' ? 'stop' : 'stop'; // refine in T6
  await write(`data: ${JSON.stringify(buildFinalChunk(reason, ctx))}\n\n`);
  await write(`data: [DONE]\n\n`);
  return terminal!;
}
```

- [ ] **Step 5** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): text-delta streaming translator"
```

---

## T5 — Wire streaming into `POST /v1/chat/completions` (~45 min)

**Files:**
- Modify: `src/openai/routes/chatCompletions.ts`.
- Create: `tests/openai/chatCompletions.streaming.test.ts`.

**Steps:**

- [ ] **Step 1** — Integration test: with `stream: true` and the mock provider, drain the SSE body and assert chunk sequence + `[DONE]` terminator.

- [ ] **Step 2** — RED.

- [ ] **Step 3** — In the handler, branch on `req.stream`. When true, use Hono's `streamSSE` (import from `hono/streaming`) and pass a `write` adapter to the translator:

```typescript
import { streamSSE } from 'hono/streaming';

// inside the handler...
if (parsed.stream === true) {
  return streamSSE(c, async (stream) => {
    const ctx = { id: `chatcmpl-${sessionId}`, model: parsed.model, created: Math.floor(Date.now() / 1000) };
    const gen = query({ messages, provider, model, tools, canUseTool, toolContext, ... });
    await translateStream(gen, ctx, (line) => stream.writeRaw(line));
  });
}
```

- [ ] **Step 4** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): SSE streaming on chat completions"
```

---

## T6 — Tool-use chunks + `hermes.tool.progress` events (~75 min)

**Files:**
- Modify: `src/openai/streaming/chunks.ts`, `src/openai/streaming/sseTranslator.ts`, `src/openai/routes/chatCompletions.ts` (toolContext + canUseTool + tool pool wiring).
- Create: `tests/openai/streaming/toolUse.test.ts`, `tests/openai/chatCompletions.tools.test.ts`.

**Steps:**

- [ ] **Step 1** — Test `chunks.test.ts` extension: `buildToolCallsChunk([{id, name, args}], ctx)` produces the right `tool_calls` delta shape.

- [ ] **Step 2** — Test `toolUse.test.ts`: feed a generator yielding `text_delta` + `assistant_message` containing `tool_use` blocks + a `user`-role message containing `tool_result` + final `message_stop`. Assert: text chunks, tool_calls chunk, `event: hermes.tool.progress` line for the tool_result, more text, final stop, DONE.

- [ ] **Step 3** — Integration test `chatCompletions.tools.test.ts`: with `MockProvider.toolUseMode = true`, a streaming request produces the canonical sequence. Confirms multi-turn-within-one-request works.

- [ ] **Step 4** — RED.

- [ ] **Step 5** — Extend `chunks.ts` with `buildToolCallsChunk(toolCalls, ctx)` and `buildProgressEvent(progress)`. Extend `sseTranslator.ts` to detect `tool_use` blocks in `assistant_message` and emit them as one `tool_calls` chunk, and to detect `user`-role messages with `tool_result` blocks and emit them as `event: hermes.tool.progress`.

- [ ] **Step 6** — In `chatCompletions.ts`, plumb the request-scoped `toolContext` and `canUseTool` (auto-deny ask, layered rules, `SUBAGENT_EXCLUDED_TOOLS` filter on `runtime.toolPool`). Look at `src/cron/wiring.ts:115-145` for the exact pattern — it constructs `toolContext` for cron's headless mode.

- [ ] **Step 7** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): tool-use chunks and hermes.tool.progress events"
```

---

## T7 — `GET /v1/models` (~30 min)

**Files:**
- Create: `src/openai/routes/models.ts`, `tests/openai/models.test.ts`.
- Modify: `src/openai/app.ts` (mount `/v1/models`).

**Steps:**

- [ ] **Step 1** — Test: `GET /v1/models` (with auth) returns `{object:"list", data:[{id:"harness-default",object:"model",owned_by:"sovereign-ai",created:<unix>}, ...]}`. Includes the current runtime model and a small static list of explicitly-supported models.

- [ ] **Step 2** — RED.

- [ ] **Step 3** — Implement. The static list is read from `src/providers/registry.ts` (or equivalent — find during impl). `harness-default` is always present.

- [ ] **Step 4** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): GET /v1/models"
```

---

## T8 — `X-Session-Id` header + DB persistence (~45 min)

**Files:**
- Modify: `src/openai/routes/chatCompletions.ts`.
- Create: `tests/openai/session.test.ts`.

**Steps:**

- [ ] **Step 1** — Tests:
   - Without `X-Session-Id`: a session row exists in `runtime.sessionDb` with `metadata.kind='openai-api'` and a freshly-minted id; the response's `id` field is `chatcmpl-<sessionId>`.
   - With `X-Session-Id: my-conv-1`: the row's session_id matches; `metadata.kind='openai-api'`; messages from the request are persisted (read-back via `sessionDb.getMessages(sid)`).
   - History is NOT hydrated from prior runs — even if `X-Session-Id` was used before, the request's transcript is what drives `query()`.

- [ ] **Step 2** — RED.

- [ ] **Step 3** — Implement: read `X-Session-Id` header; if absent, mint a UUID; call `sessionDb.createSession({ provider, model, title:'openai-api', metadata:{kind:'openai-api', clientSessionId}, ... })`. After the stream completes (or non-streaming response is built), persist user + assistant messages.

- [ ] **Step 4** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): X-Session-Id header + DB persistence"
```

---

## T9 — Per-request provider routing (`req.model` → `resolveProvider`) (~60 min)

**Files:**
- Modify: `src/openai/modelResolution.ts`, `src/openai/routes/chatCompletions.ts`.
- Create: `tests/openai/modelResolution.real.test.ts`.

**Steps:**

- [ ] **Step 1** — Test: `req.model: 'claude-haiku-4-5-20251001'` causes `resolveProvider('anthropic', 'claude-haiku-4-5-20251001')` to be called; the returned transport is used for THIS request (not the runtime's bootstrap transport).

- [ ] **Step 2** — RED.

- [ ] **Step 3** — In `modelResolution.ts`, expand `resolveModelForRequest` to call `resolveProvider` for non-`harness-default` names. Map `gpt-*` to `openai`, `claude-*` to `anthropic`. Unknown → throw `InvalidModelError` with the available list.

- [ ] **Step 4** — In the handler, after resolving the model, build the per-request transport and pass to `query()` as the provider arg. Don't mutate runtime state.

- [ ] **Step 5** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): per-request provider resolution from req.model"
```

---

## T10 — Abort on client disconnect (~30 min)

**Files:**
- Modify: `src/openai/routes/chatCompletions.ts`.
- Create: `tests/openai/abort.test.ts`.

**Steps:**

- [ ] **Step 1** — Test: start streaming, abort the fetch mid-stream, assert the mock provider observed an aborted signal (the mock tracks `lastSignal.aborted`).

- [ ] **Step 2** — RED.

- [ ] **Step 3** — In the handler, create an `AbortController`, listen on `c.req.raw.signal` (or Hono's equivalent), abort the controller on signal. Pass `controller.signal` into `query()` opts. Mirror the pattern in `src/server/routes/events.ts` (if present).

- [ ] **Step 4** — GREEN. Gate. Commit.

```bash
git commit -m "feat(openai): abort in-flight turn on client disconnect"
```

---

## T11 — Docs, smoke, state snapshot (~45 min)

**Files:**
- Create: `docs/07-history/state/2026-05-23-phase-18-openai-api-server.md`, `scripts/openai-smoke.py` (manual smoke, not CI).
- Modify: `CLAUDE.md` + `AGENTS.md` (byte-identical), `docs/06-testing/testing-log.md`, `DECISIONS.md` (record relevant Ds).

**Steps:**

- [ ] **Step 1** — Write the state snapshot mirroring the Phase 17 close-out structure.
- [ ] **Step 2** — Update CLAUDE/AGENTS index to point at the new state file. `diff` confirms identical.
- [ ] **Step 3** — Append testing-log entry.
- [ ] **Step 4** — Smoke: real Anthropic Haiku via `sov serve`, Python `openai` client, capture the streaming response. Log into testing-log.
- [ ] **Step 5** — Commit + push.

```bash
git commit -m "docs(state): Phase 18 OpenAI API server close-out"
```

---

## T12 — Cut binary release v0.4.0 (~15 min)

**Steps:**

- [ ] Bump `package.json` to `0.4.0` (minor bump — new feature surface).
- [ ] Commit `chore(release): bump version 0.3.3 -> 0.4.0`.
- [ ] `unset GH_TOKEN; SOV_RELEASES_PATH=/Users/julie/code/sov-releases bun run release v0.4.0`.
- [ ] Smoke: `~/.sov/bin/sov upgrade && ~/.sov/bin/sov --version` → `0.4.0`. `~/.sov/bin/sov serve --help` shows the new subcommand.

---

## Execution

Subagent-driven. T1 → T2 → T3 unlocks vertical-slice non-streaming. T4 → T5 adds streaming. T6 adds tool-use. T7-T10 add the remaining surfaces. T11-T12 land docs + release. Each task is its own atomic commit, pushed before the next.
