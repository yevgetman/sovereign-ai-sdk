# Anthropic prompt caching on the OpenRouter lane — implementation plan

Spec: `specs/2026-08-25-openrouter-cache-and-image-passthrough-design.md` **§2 (gap 1 only)**.
Green-lit by the CEO 2026-08-25 ("add proper cache management for Anthropic models to the SDK").
Gap 2 (MCP image passthrough, §3) is NOT green-lit — it holds a founder-reserved type decision (§3.3).
Do not touch `flattenCallResult`, `tool_result.content`, or the image paths in this plan.

Gate: `bun run typecheck && bun test && bun run lint` (sov). **No release cut** — the CEO paused
releases; commit + push to `master` only. Version bump staged in the changelog.

## Design decisions (resolving the spec's open points)

- **Both halves ship** (system prompt AND recent-message marking, §2.2 items 2–3). The
  system prompt is the big stable prefix; the last-3 rule is what lets a long tool-calling
  turn cache its own growing history. Same policy on both lanes, from one shared module, so
  they cannot drift.
- **Gate = `this.name === 'openrouter'` AND `openrouterModelSupportsPromptCaching(model)`**,
  a curated function in `providers/effort.ts` next to `openrouterModelSupportsReasoning`
  (same shape, same file). Initial allow-list: `anthropic/` prefix only. Every other lane and
  model ⇒ **byte-identical** body (§2.4). `req.cacheEnabled === false` (the `--no-cache` flag,
  the preflight probe) ⇒ byte-identical too, exactly as on the Anthropic lane.
- **Breakpoint budget ≤ 4**: 1 on the system message + at most 3 on the last 3 internal
  messages. One internal `Message` may fan out to several wire messages (a user message with
  N `tool_result`s becomes N `role: 'tool'` messages) — mark at most ONE wire message per
  internal message: the last cacheable one it produced.
- **Wire shape when marking**: the marked message switches from string `content` to a
  content-parts array with `cache_control: { type: 'ephemeral' }` on the last text part. This
  is the shape live-verified in the spec §1.2 for the system role. For `tool` role, verify
  live in Task 4 before relying on it; if OpenRouter rejects array content on a tool
  message, fall back to marking only `user`-role text and note it in the changelog.
- **TTL**: `ephemeral` (5 min) only. No 1h strategy (spec non-goal).

## Tasks

**Status: complete (2026-08-25)** — shipped to `master` in commits `62be417`, `c44e4a2`, `2b2ec4e`, `aa24a38`. Release **v0.6.72 cut and published** 2026-08-25 on the CEO's later instruction (sov-releases, 5 targets + SHA256SUMS); platform pinned (`511ed0c`) and live on app.appleo.ai. Task 4 result: tool-role parts array and assistant text-parts+tool_calls both accepted by OpenRouter; e2e through `buildKwargs` = 4 breakpoints, 7,125-token cache write then read.

- [x] **1 — shared policy module** (`packages/sdk/src/providers/promptCache.ts`, new;
  `providers/anthropic.ts`; new `tests/providers/promptCache.test.ts`).
  Lift `findLastCacheableSegment`, the last-3 window (`RECENT_MESSAGE_CACHE_WINDOW = 3`,
  `recentMessageCacheFrom(len)`), and a generic `lastCacheableIndex<T>(items, isCacheable)`
  into the module. `anthropic.ts` imports them; **zero behaviour change** there
  (`tests/providers/anthropic.test.ts` stays green untouched). Unit-test the module directly.
- [x] **2 — openrouter gate + system-message breakpoint** (`providers/effort.ts`,
  `providers/openai.ts`, `tests/providers/openai.test.ts`).
  `openrouterModelSupportsPromptCaching(model)` in effort.ts (curated, `anthropic/` only).
  `protected supportsPromptCaching(req)` on `OpenAIProvider`: name gate ∧ model gate ∧
  `req.cacheEnabled !== false`. `messagesToOpenAI(messages, system, opts?)` gains
  `{ promptCache?: boolean }` (default false ⇒ today's output). When on and a cacheable
  segment exists, the system message is emitted as text parts with the marker on the last
  cacheable segment (per module policy); otherwise the flat string. `OpenAIContentPart`
  text part gains optional `cache_control`. Tests: marks last cacheable segment for
  `anthropic/claude-sonnet-5` on openrouter; no cacheable segment ⇒ plain string; openai
  proper ⇒ **`JSON.stringify` byte-identical** to today for the same input; `z-ai/glm-5.2`
  on openrouter ⇒ byte-identical; `cacheEnabled: false` ⇒ byte-identical.
- [x] **3 — recent-message breakpoints + anti-drift + usage** (`providers/openai.ts`,
  `tests/providers/openai.test.ts`, `tests/providers/promptCache.test.ts`).
  Apply `recentMessageCacheFrom` to the internal message list; for each internal message in
  the window, mark the last cacheable wire message it produced (user text ⇒ parts array with
  marker; `tool` message ⇒ parts array with marker; assistant text ⇒ parts array with
  marker; assistant with `tool_calls` and null content ⇒ skip). Tests: last-3 rule matches
  `messagesToSdk` boundary choice for the same input (anti-drift); total markers ≤ 4 on a
  long tool loop; a user message with 3 tool_results gets exactly one marker; usage: a
  response with `prompt_tokens_details.cached_tokens` meters as `cacheReadInputTokens`, not
  input (may already exist — verify, add if missing).
- [x] **4 — live verification** (no code): run one real `anthropic/claude-sonnet-5` request
  twice through `buildKwargs` + the openrouter endpoint with a >1024-token cacheable system
  prompt and a short tool loop; assert `cached_tokens > 0` on the second and that the
  `tool`-role parts array is accepted. Record the numbers in the changelog entry. If no
  OpenRouter credential is reachable, say so — do not fake the result.
- [x] **5 — docs + changelog + version** (`CHANGELOG.md`,
  `docs/02-architecture/runtime-architecture.md` §segment cacheable marker,
  `docs/04-extending/metering-an-agent.md` if the write-phase note needs the marker context,
  `package.json` 0.6.71 → 0.6.72, `packages/sdk/package.json` 0.10.1 → 0.10.2 (additive:
  `messagesToOpenAI` options, new `promptCache` module — check the barrel/surface tests).
  Changelog entry states the release is **staged, not cut**.
- [x] **6 — gate + ship**: full gate green; one commit per task; push `master`. Do NOT tag,
  do NOT publish to sov-releases. Report to the CEO: the lane is fixed in source; the platform
  picks it up on the next release cut (staged) or via the local-binary override.
