# Spec — Assay integration: the SDK's official token-accounting wire

- **Date:** 2026-07-05
- **Author:** Julie (Gene's AI assistant), from source analysis of sov master (`11102b4`) and assay master (`64be2d9`)
- **Status:** CEO green-lit spec+build in one directive (2026-07-05 session): "write the spec, do a quick review pass … proceed autonomously through the build." This spec records the design; no further gate.
- **Driver:** the CEO directive that **Assay becomes the official token auditing and valuation solution for the SDK** — wired together, absorbed by neither. Builds directly on `2026-07-03-usage-telemetry-design.md` (which made the SDK's usage truth billing-grade *so that* a meter could consume it) and on assay's harness-agnostic ingest door (`~/code/assay` spec §5.1).

## 1. Summary

Wire the SDK to Assay **at the wire, not the code**: the SDK gains a zero-dependency
**usage exporter** — a `traceRecorder` implementation that converts the trace events
the SDK already emits (`provider_response`, `tool_start`/`tool_end`, `turn_start`,
`session_start/end`) into OpenTelemetry **`gen_ai` spans** and POSTs them as
OTLP/JSON to a local `assay serve` endpoint. Assay ingests them through its existing
gen_ai door: priced by its waterfall, classified inline (tool-attributed spans hit
the deterministic classifier), attributed to session + per-turn task.

Neither product imports the other. The integration artifact is a **span contract**
(§4) plus a **shared golden fixture** tested independently in both repos (§7). The
SDK works with any OTel backend; Assay works with any producer; the *official*
pairing is this contract, the reciprocal docs, and the conformance tests.

One sentence: *after this feature, any sov agent run can stream exact, phase-broken,
tool-attributed, per-model-call usage into a local Assay store in real time — no
content, no scraping, no shared code — and every Assay analytic (pricing, work-type,
waste, per-turn task ROI, judge valuation) operates natively on SDK data.*

## 2. Current state (verified)

- **SDK (post usage-telemetry, `8709a36`):** `traceRecorder?: (e: TraceEvent) => void`
  on `AgentConfig`/per-turn receives `session_start` (sessionId, provider, model),
  `turn_start` (turn), `provider_response` (provider, model, purpose, **usage:
  TokenUsage** — five fields incl. `reasoningTokens`, latencyMs, stopReason, iso),
  `tool_start`/`tool_end`/`tool_error` (tool, toolUseId, durationMs, outputBytes),
  `session_end`. Thrown handlers are swallowed (best-effort by contract). Public
  pricing surface (`PRICE_TABLE`, `PRICING_VERSION`) is barrel-exported. **Nothing
  exports usage off-process today** except the gateway wire.
- **Assay (`64be2d9`):** `assay serve` (default port 4318, the OTLP/HTTP convention)
  ingests OTLP/JSON `gen_ai.*` spans with per-tenant bearer auth. The normalizer
  maps: five token phases (incl. `gen_ai.usage.reasoning_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`), `gen_ai.provider.name`,
  `gen_ai.request.model`, `gen_ai.conversation.id` → sessionId, `gen_ai.agent.id` →
  principal (tenant-namespaced), per-tenant `taskIdAttribute` override → taskId,
  `gen_ai.usage.cost` → foreign price (waterfall step 1; absent ⇒ assay's own
  table prices it). Idempotent on `otel:<traceId>:<spanId>`.
- **Gap A (assay):** `gen_ai.tool.name` maps to `span.tool` **only when
  `gen_ai.operation.name === 'execute_tool'`** — a chat span cannot carry the tool
  attribution that assay's own file-capture analysis (the `turns@1` tier) proved is
  the load-bearing efficiency signal.
- **Gap B (assay):** trace-root taskId resolution is **batch-local**
  (`rootSpanIdByTrace` sees one POST at a time), so a turn split across two batches
  would resolve two different "roots" — task attribution must not rely on it.
- **Gap C (SDK):** no exporter exists; `traceRecorder` consumers are all in-process.

## 3. Scope

**In:** the span contract (§4); the SDK exporter module + barrel export + docs
recipe (§5); the assay normalizer extension for chat-span tool attribution (§6);
the shared golden fixture + conformance tests in both repos (§7); a live dogfood
run on this machine (§8).

**Out (explicit non-goals):**
- **Content.** This wire carries **usage only** — token counts, identities, tool
  names, timings. No prompts, no completions, no tool arguments/results. Assay's
  transcript/goal features remain fed by its own capture paths. (Sovereignty: even
  a misconfigured off-box endpoint could leak no text.)
- **A code dependency in either direction.** No npm edge between the repos, ever.
  The contract + fixture are the coupling.
- **The gateway (`src/server/routes/turns.ts`).** v1 targets `createAgent`
  embedders via `traceRecorder`; the gateway installs the same recorder per-session
  in a follow-up (it already holds sessionId + the event stream).
- **OTLP/protobuf, gRPC, OTel SDK adoption.** Assay's door speaks OTLP/JSON;
  hand-rolled JSON keeps the exporter at zero dependencies.
- **Budgets/routing/valuation logic** — downstream Assay concerns.

## 4. The span contract (SOV-ASSAY WIRE v1)

Every span carries `sov.telemetry.version: 1` (an integer attr; lands in assay
`meta` — provenance for future contract bumps).

**Identity (every span):**

| Attribute | Value | Assay lands it as |
|---|---|---|
| `gen_ai.provider.name` | the SDK provider id (`anthropic`, `openai`, `ollama`…) | `provider` |
| `gen_ai.conversation.id` | the SDK sessionId | `session_id` |
| `gen_ai.agent.id` | configured identity (default `sov`) | `principal` (tenant-namespaced) |
| `sov.turn.id` | `<sessionId>#<turn>` | `task_id` — via tenant `taskIdAttribute: "sov.turn.id"` (Gap B bypassed) |

IDs: `traceId` = sha256(`sessionId#turn`) → 32 hex; `spanId` = sha256(`sessionId#seq`)
→ 16 hex (`seq` = a per-recorder monotonic counter). **Deterministic**, so a
re-POST of the same events dedupes on assay's `producer_ref` — replay-safe.

**Chat span** — one per `provider_response` (the priced unit):
`name: "chat <model>"`, `gen_ai.operation.name: "chat"`, `gen_ai.request.model`,
token phases from `TokenUsage` (`inputTokens→gen_ai.usage.input_tokens`,
`outputTokens→output_tokens`, `cacheReadInputTokens→cache_read_tokens`,
`cacheCreationInputTokens→cache_creation_tokens`, `reasoningTokens→reasoning_tokens`;
absent fields omitted), **`gen_ai.tool.name` = the dominant tool this response's
completion invoked** (deferred emission, §5; absent when none),
`sov.purpose` (`main`|`compact`), `sov.stop_reason`, `sov.latency_ms` (→ meta).
`startTimeUnixNano`/`endTimeUnixNano` from `iso` − `latencyMs` / `iso`.
`parentSpanId` = the turn's first chat span (absent on that first span). **No
`gen_ai.usage.cost`** — assay's own versioned table prices the span (one pricing
authority; the SDK's `PRICE_TABLE` remains its own in-process estimate).

**Tool span** — one per `tool_end`/`tool_error` (option `emitToolSpans`, default on):
`name: "execute_tool <tool>"`, `gen_ai.operation.name: "execute_tool"`,
`gen_ai.tool.name`, `sov.duration_ms`, `sov.output_bytes` | `sov.error` (→ meta),
`parentSpanId` = the chat span that requested it. **No token attrs** — assay
records it honestly as unpriced (unknown ≠ $0); it carries identity + timing for
the tool census and future duration detectors.

## 5. SDK work items

- **S1 — `createAssayUsageRecorder(config)`** in
  `packages/sdk/src/telemetry/assayUsageRecorder.ts` (new dir), returning
  `{ record: (e: TraceEvent) => void; flush(): Promise<void>; stats(): AssayExportStats }`.
  `record` is the `traceRecorder` sink. Config:
  `{ endpoint?: string ('http://127.0.0.1:4318'), token: string, identity?: string ('sov'), emitToolSpans?: boolean (true), batchSize?: number (64), flushIntervalMs?: number (5000), maxBuffered?: number (2048), fetch?: typeof fetch, onError?: (msg: string) => void }`.
- **S2 — event → span state machine.** Track `sessionId` (from `session_start`;
  a new sessionId flushes prior state; before any `session_start`, a per-recorder
  UUID stands in), `turn` (from `turn_start`; **0 before the first one**), a
  monotonic `seq`. A `provider_response` becomes a **pending** chat span;
  `tool_end`s AND `tool_error`s observed while it is pending record tool
  invocations against it (an errored tool was still invoked; parent = its spanId);
  the NEXT `provider_response` / `turn_start` / `session_end` / `flush()` seals it
  with `gen_ai.tool.name` = the most frequent tool observed (first-seen
  tie-break) and queues it. (One-response lag ⇒ dominant-tool attribution without
  guessing — the same rule assay's `turns@1` tier pinned.)
- **S3 — transport.** Queue → OTLP/JSON `POST <endpoint>/v1/traces`
  (`authorization: Bearer <token>`, `redirect: 'error'`) on batchSize/interval/
  flush. **Never throws into the agent loop**; failures retry once (next flush),
  then drop-count. Bounded queue (`maxBuffered`, drop-oldest, counted).
  `stats(): { exported, buffered, dropped, failed }`. The interval timer is
  `unref()`d — the exporter never keeps the process alive.
- **S4 — barrel + docs.** Export `createAssayUsageRecorder` + types from
  `sdk.ts`. Docs recipe: *"Metering with Assay (official)"* — the recorder setup
  (`traceRecorder: recorder.record` + endpoint/token), the assay side deferred to
  assay's own serve docs (tenants file with a sha256 `tokenHash` +
  `taskIdAttribute: "sov.turn.id"`), what lands, and what never leaves the box.
  Surface test extended (additive; sdk 0.2.0 → 0.3.0, publish still held).
- **S5 — fixture generation test.** A scripted event sequence (2 turns: 2 calls +
  Read/Edit/Edit tools, then 1 call no tools; fixed ISO times) must serialize to
  `fixtures/assay-wire-v1.json` **byte-identically** (the golden fixture, §7).
  Serialization pinned: `JSON.stringify(body, null, 2)` + trailing newline.

## 6. Assay work items

- **A1 — chat-span tool attribution.** `normalizeGenAiSpan`: map
  `gen_ai.tool.name` → `span.tool` on ANY span that carries it (keep the
  `execute_tool` fallback naming). Rationale: producer-declared tool attribution
  is exactly the signal the deterministic classifier keys on; the file-capture
  corpus needed `turns@1` to reconstruct it — a first-class producer declares it.
  Regression: an execute_tool span without a name still gets `tool: 'execute_tool'`.
- **A2 — conformance test.** Vendor `tests/fixtures/sov-wire-v1.json` (byte-equal
  to the SDK's copy; sha256 pinned below). Drive it through a REAL
  `createIngestServer` with the official tenant shape
  (`{ principalPrefix, taskIdAttribute: "sov.turn.id" }`); assert: span count,
  producer_refs, principal namespacing, sessionId, per-turn taskIds, chat spans
  priced by the assay table, tool spans unpriced, `span.tool` set (Edit-dominant
  chat span classifies `mechanical` inline), replay dedupes 100%.
- **A3 — docs.** README/serve help: sov-sdk listed as a first-class producer with
  the tenant recipe.

## 7. The coupling artifact (what "official" means, mechanically)

- `fixtures/assay-wire-v1.json` — one OTLP/JSON body, generated by S5, vendored
  byte-identically into both repos. Each repo's CI proves its own side against its
  own copy: the SDK proves it *emits* the fixture; assay proves it *ingests* it
  correctly. Drift in either repo fails that repo's tests.
- The fixture's sha256 (pinned): `fdf58dda64927033b6ec822e69b77657aee0e7e37c606e63e08143806ebc1696`.
  The update procedure is:
  regenerate in the SDK → copy to assay → re-pin → bump `sov.telemetry.version`
  if attribute semantics changed (additive attrs don't bump).
- No CI edge, no shared package, no submodule. The contract is versioned prose +
  a versioned artifact.

## 8. Dogfood (proof, this machine)

Run a scripted `createAgent` session (mock provider) with the recorder pointed at a
real local `assay serve --db <temp>`; then `assay show`/`top`/`waste` over the
result: spans priced, per-turn tasks, tool-attributed work types, detectors fed at
native grain — the contrast with the retroactive `turns@1` path, demonstrated.

## 9. Compatibility & posture

- **SDK:** additive only (new module + exports). Zero new dependencies. The
  recorder is opt-in; agents without it are byte-identical in behavior. One
  recorder instance per run/session (documented; a new `session_start` defensively
  flushes prior state).
- **Assay:** A1 widens one mapping (attribute → first-class field, previously →
  meta); no schema change; existing producers unaffected (none emit
  `gen_ai.tool.name` on chat spans today).
- **Licensing/posture:** the whole seam is MIT territory (SDK package ↔ open wire ↔
  assay substrate + ingest door). The SDK never references the value layer; assay
  never privileges the SDK in code — only in docs and conformance coverage. Each
  ships alone; together they are the official pairing.

## 10. Testing

TDD per item: S2 state-machine unit tests (dominant tool, tie-break, pending-seal
boundaries, new-session flush); S3 transport tests (batching, retry-once, bounded
drop, never-throws, unref'd timer) against a scripted fetch; S5 golden emission;
A1 normalizer regression; A2 end-to-end conformance + replay idempotency. Gates:
SDK `bun run lint && bun run typecheck && bun test` · assay
`npm run lint && npm run typecheck && npm test` (both backends) — green at every
commit.

## 11. References

- `specs/2026-07-03-usage-telemetry-design.md` (the metering substrate this rides)
- `~/code/assay` — `src/ingest/normalize/genai.ts`, `src/ingest/server.ts`,
  `src/ingest/tenants.ts` (the door this feeds)
- OTel GenAI semconv (Development status) — attribute names mirrored where they
  exist; `sov.*` and the cache/reasoning usage attrs are producer extensions the
  contract pins.
- `sovereign-ai-docs/business/architecture/token-value-accounting.md` (B-0013)
