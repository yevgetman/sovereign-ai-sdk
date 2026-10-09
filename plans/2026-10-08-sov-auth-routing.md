# SOV auth routes and SDK headless host — implementation plan

**Spec:** [`specs/2026-10-08-sov-auth-routing-design.md`](../specs/2026-10-08-sov-auth-routing-design.md)
(approved by the Owner in Telegram, 2026-10-08). Research: [`specs/2026-10-08-sov-auth-routing-research.md`](../specs/2026-10-08-sov-auth-routing-research.md).
**Scope:** SOV code only (spec §4.1, §4.2, §5, §6, §7). Telekit consumer work is the Telekit node's.
**Branch:** `feat/sov-auth-routing`. **Progress artifact:** `handoffs/2026-10-08-sov-auth-routing-progress.md`.

Each task gets a fresh Opus implementer and a review before the next dependent task.

## T1 — Route and credential contract

- Direct xAI API-key provider `xai` (`XAI_API_KEY`, `providers.xai`, `https://api.x.ai/v1`).
  `grok` stays the subscription name.
- Built-in route registry: `openrouter-api`, `anthropic-api`, `openai-api`, `grok-api`,
  `chatgpt-subscription`, `grok-subscription`. Non-secret records with default model and
  model/effort compatibility. Default-model overrides through existing SOV config.
- Read-only `sov capabilities --json`, `sov routes --json`, `sov auth status --route <id> --json`,
  all with `schemaVersion: 1`. Status never refreshes, writes or calls the network.
- Cross-process credential lock per Keychain service: login write, refresh and logout.
  Reread under lock; refresh only when the rejected token generation is still current;
  stale-lock recovery for dead PIDs; bounded, cancellable waits; logout wins over a pending refresh.

## T2 — Factor shared host composition

- Extract the per-turn agent composition in `src/server/routes/turns.ts` into a shared module
  that the gateway and the SDK host both call. Behavior-preserving for the gateway.
- Let `buildRuntime` accept a route-resolved provider (subscription opt-in on the local owner
  path only) without changing its legacy defaults.

## T3 — Provider protocol audit

- ChatGPT Codex body, headers, effort and stream; native image input or explicit refusal.
- Grok subscription: resolve Chat Completions versus Responses mismatch against primary sources.
- Effort mapping on both subscription transports; explicit `effort_unsupported`.

## T4 — `sov run --sdk` host

- Route required; legacy provider flags refused; JSON envelope on stdin (`inputVersion: 1`,
  `text`, `instructions`, `images`), strict validation, bounded image reads.
- `createAgent().run()` once per turn, toolset passed in, headless permission deny,
  steering file, SIGINT/SIGTERM cancellation.
- One persistence writer: the Telekit DB through the SDK `SessionStore` port; save-before-tool;
  orphaned tool calls get explicit interrupted results on resume; no duplicate rows.
- Compatible JSONL: `session.started` (+ route metadata), existing server events, exactly one
  `turn.completed` or `turn.error` (+ stable `code`). Exit codes 0/1/2/130/143.

## T5 — Docs, testing log, gate, PR

- CLI reference, architecture atlas, testing log, CHANGELOG, progress artifact.
- Full gate: `bun run lint && bun run typecheck && bun run test`.
- PR to `master` with evidence. No merge, release, `sov upgrade` or live credential calls.
