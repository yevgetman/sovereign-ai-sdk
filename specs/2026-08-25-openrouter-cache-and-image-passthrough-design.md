# OpenRouter lane: Anthropic prompt caching + MCP image passthrough — design

**Status:** DRAFT — awaiting CEO green-light (SOP-12: spec → green-light → autonomous build)
**Date:** 2026-08-25
**Author:** agent session (appleo node), handing off to a sovereign-ai-sdk session
**Origin:** two production gaps found in the `appleo` node (`~/code/resume-as-code-platform`,
app.appleo.ai). Both live in THIS repo's provider/MCP layer. Neither is fixable downstream.

---

## 0. TL;DR for the session picking this up

Two independent defects, same layer, both measured against production traffic:

| # | Gap | Effect | Fix site |
|---|-----|--------|----------|
| 1 | The OpenAI-format transport never emits `cache_control` | Anthropic models on the openrouter lane pay **full input price on every turn**. Measured **~10x** overspend. | `packages/sdk/src/providers/openai.ts` |
| 2 | `flattenCallResult` replaces MCP image blocks with `[mcp:image content omitted]` | **Vision through MCP tools is impossible.** A tool that returns a screenshot delivers a placeholder string. | `packages/sdk/src/mcp/client.ts` |

Gap 1 is a cost bug. Gap 2 is a capability hole that currently blocks a shipped
downstream feature. They are specced together because both are "the OpenAI-format
lane drops something the Anthropic lane handles," and a session in this code will
want both in view.

**Do gap 1 first** — it is smaller, lower-risk, and independently valuable.
**Gap 2 contains a one-way-door type decision** (§3.3) that is founder-reserved.

---

## 1. Evidence

### 1.1 Caching is absent, and it is our doing

Production usage spans from the appleo node, all through this SDK's `openrouter` lane:

| model | input tokens | cache read | cache write | cached share |
|---|---|---|---|---|
| `anthropic/claude-sonnet-5` | 6,404,928 | 71,296 | *(none recorded)* | **1.1%** |
| `z-ai/glm-5.2` | 2,447,079 | 11,521,944 | 0 | 82.5% |
| `moonshotai/kimi-k2.7-code` | 1,368,554 | 7,369,904 | *(none)* | 84.3% |

GLM and Kimi cache heavily because **their providers cache implicitly**, regardless of
request format. Anthropic requires **explicit `cache_control` breakpoints**. We send none
on this lane, so Anthropic models are effectively uncached.

Corroborating: spans from the earlier direct-Anthropic era (`claude-sonnet-4-6`, July 2026)
show 5,203 input against 10,998,667 cache reads — caching worked fine when traffic went
through the **Anthropic** transport, which does emit breakpoints.

### 1.2 OpenRouter honours cache_control — measured, both formats

Live probes against `anthropic/claude-sonnet-5`, ~18k-token system prompt.

**OpenAI format** (`POST /v1/chat/completions`) — *the format this lane actually uses*:

| request | `prompt_tokens` | `cached_tokens` | cost |
|---|---|---|---|
| no `cache_control` | 18,030 | 0 | **$0.03614** |
| with `cache_control` | 18,030 | 18,021 | **$0.0037022** |
| repeat | 18,030 | 18,021 | **$0.0036722** |

**≈10x cheaper on an identical request.** The marker went on a system message whose
`content` was an **array of content parts**:

```jsonc
{ "role": "system",
  "content": [ { "type": "text", "text": "...", "cache_control": { "type": "ephemeral" } } ] }
```

Anthropic format (`POST /v1/messages`) was verified too — `cache_creation_input_tokens:
18021` on the write, `cache_read_input_tokens: 18021` on the read — but that path is not
what this lane sends, and is recorded only to show the passthrough is general.

### 1.3 MCP images are discarded

`packages/sdk/src/mcp/client.ts` → `flattenCallResult()`:

```ts
} else if (block.type === 'image') {
  parts.push('[mcp:image content omitted]');
}
```

Verified present in the deployed `sov` v0.6.53 binary, not just in source.

Downstream consequence, already shipped and currently inert: the appleo Theme Studio's
`theme_render` verb now rasterises the rendered résumé and returns a well-formed MCP image
block. The screenshot is produced correctly (confirmed: real PNG, ~13 KB, inside the
production container). The harness then throws it away. The theme agent is still blind, and
the appleo node had to add explicit instructions telling its agent **not** to claim it saw a
render — otherwise the `image` metadata invites confabulation.

---

## 2. Gap 1 — Anthropic prompt caching on the OpenAI-format transport

### 2.1 Current behaviour

`packages/sdk/src/providers/openai.ts`:

- `messagesToOpenAI(messages, system)` (~line 422) builds the wire messages.
- `flattenSystem(system)` (~line 507) joins every `SystemSegment` into **one plain string**:
  `out.push({ role: 'system', content: systemText })`.
- A plain string `content` **cannot carry `cache_control`** — the marker only exists on
  content-part objects. So the shape itself forecloses caching.
- `SystemSegment` already carries the signal we need: `{ text: string; cacheable: boolean }`
  (`packages/sdk/src/core/types.ts:102`).

The Anthropic provider already implements exactly this policy and is the reference:

- `systemToSdk()` (`providers/anthropic.ts:309`) marks the **last cacheable system segment**
  via `findLastCacheableSegment()`.
- `messagesToSdk()` (`:333`) marks the last cacheable block within the **last 3 messages**
  (`cacheFrom = max(0, len - 3)`), via `withOptionalCacheMarker()` /
  `isCacheableMessageBlock()` (text and tool_result only).

### 2.2 Proposed design

Mirror the Anthropic policy on the OpenAI-format path, **gated to the openrouter lane and to
models that support Anthropic-style caching.**

1. **Gate.** Add `protected supportsPromptCaching(model: string): boolean`. Default `false`.
   True only when `this.name === 'openrouter'` **and** the model id is a caching-capable
   vendor prefix. Start with `anthropic/`. There is precedent for exactly this lane-scoped
   model gate: `reasoningEnabled()` (`openai.ts:194`) already special-cases
   `this.name === 'openrouter'` with `openrouterModelSupportsReasoning(req.model)`. Follow
   that shape — a curated list in the same module, not a scattered regex.

   Do **not** enable for OpenAI proper: it caches automatically and rejects nothing, but the
   marker is meaningless there and would be noise on the wire.

2. **System message.** When caching is on and any segment is `cacheable`, emit the system
   message as content parts instead of a string, marking the **last cacheable segment**:

   ```ts
   { role: 'system', content: [ { type: 'text', text: seg.text }, ... ] }
   ```
   with `cache_control: { type: 'ephemeral' }` on the chosen part. When caching is off, or no
   segment is cacheable, keep emitting the **byte-identical plain string** — see §2.4.

3. **Recent messages.** Apply the same `cacheFrom = max(0, len - 3)` rule as
   `messagesToSdk`, marking the last cacheable part of those messages. This is what makes a
   long tool-calling turn cache its own growing prefix rather than only the system prompt.
   Anthropic allows **at most 4 breakpoints per request** — the Anthropic path's policy
   already respects that; do not exceed it.

4. **Reuse, do not fork, the policy.** `findLastCacheableSegment` and the "last 3 messages"
   constant are currently private to `providers/anthropic.ts`. Lift them into a shared module
   (suggest `providers/promptCache.ts`) and have both providers import it, so the two lanes
   cannot drift into different caching behaviour. This is the main refactor in gap 1.

### 2.3 Usage accounting — already correct, verify only

`openai.ts` (~lines 380–398) already reads `prompt_tokens_details.cached_tokens` into
`cacheReadInputTokens` and `cache_write_tokens` into the write phase, and subtracts cached
from `prompt_tokens` so the four phases stay disjoint and additive. No change expected.
**Add a test** that a cached response meters as read-not-input, since this is the number the
downstream node bills from.

### 2.4 Non-negotiable: unchanged bodies when caching is off

Every non-openrouter lane, and every openrouter request for a non-caching model, must produce
a **byte-identical** request body to today. `sov`'s local engine, vLLM/SGLang, Ollama and
OpenAI proper all share this transport, and some are strict about message shape. Pin this
with a test that asserts the exact serialised body for a non-caching model.

---

## 3. Gap 2 — MCP image passthrough

### 3.1 Current behaviour

Three places drop image content, and all three must change for a screenshot to reach a model:

1. **`packages/sdk/src/mcp/client.ts` → `flattenCallResult()`** — returns
   `McpCallResult { text: string; isError: boolean }`. Image blocks become
   `[mcp:image content omitted]`.
2. **`packages/sdk/src/core/types.ts:16`** — `tool_result` is typed
   `{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }`.
   `content` is a **plain string**, so there is nowhere for an image to live even if the MCP
   client preserved it.
3. **`packages/sdk/src/providers/openai.ts:435`** — user-message image blocks are rendered as
   `[image omitted: ${media_type}]`. Even a correctly-typed image would be dropped on this
   lane. (`providers/anthropic.ts:405` handles images properly.)

### 3.2 What each wire format needs

- **Anthropic** — `tool_result.content` accepts an array of `text` and `image` blocks
  (`{ type: 'image', source: { type: 'base64', media_type, data } }`).
- **OpenAI format** — tool-role messages are text-only. The established pattern (and what
  Claude Code does) is to emit the tool result as text, then a **companion `user` message**
  carrying `image_url` parts with a data URL:
  `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`.
  OpenRouter accepts this for vision-capable models.

### 3.3 FOUNDER-RESERVED DECISION — do not choose this unilaterally

`core/types.ts` opens with: *"One-way door — changing these after they're adopted is a
cross-cutting refactor."* Widening `tool_result.content` is exactly that door.

**Option A — widen the type.** `content: string | ContentBlock[]`.
*For:* models the domain correctly; matches Anthropic's own API; images stay attached to the
tool call that produced them, which is what the model needs to reason about.
*Against:* touches every `tool_result` construction and consumer — `core/query.ts:761`,
`core/orchestrator.ts:112,397`, `core/transcriptRepair.ts`, trajectory export, transcripts,
compaction. Genuinely cross-cutting.

**Option B — companion image message.** Leave `tool_result.content` a string; when a tool
returns images, follow it with a synthetic user message carrying image blocks.
*For:* no type change; contained; works on both wire formats.
*Against:* a synthetic message in the transcript that the user never sent — which the repo has
been careful about elsewhere; ordering/compaction must keep it adjacent to its tool result.

**Recommendation: Option A**, because it is the honest model and the type is still young
enough to move — but this is the founder's call, and the build should not start until it is
made.

### 3.4 Guardrails whichever option wins

- **Size cap.** Base64 images are enormous. Cap per-image bytes and per-turn image count, and
  drop with an explicit `[mcp:image too large: N bytes]` rather than silently.
- **Say what was dropped.** A dropped image must produce a message the MODEL can act on, so it
  reports blindness instead of inventing a description. The current placeholder is right in
  spirit; keep that property everywhere.
- **Gate on capability.** Do not send images to a model that cannot accept them. Route through
  the same curated per-lane model gate as §2.2.
- **Compaction/transcripts.** Image payloads must not bloat `sessions.db`, JSONL transcripts,
  or the compaction window. Store a reference or elide payloads at rest; this is a real risk,
  not a footnote.

---

## 4. Test plan

**Gap 1**
- `messagesToOpenAI` marks the last cacheable system segment for `anthropic/*` on openrouter.
- No `cacheable` segment ⇒ plain-string system content (byte-identical body).
- Non-openrouter lane ⇒ byte-identical body, no content-part array, for the same input.
- Non-Anthropic openrouter model (`z-ai/glm-5.2`) ⇒ unchanged (their caching is implicit).
- At most 4 breakpoints per request.
- Recent-message marking follows the same last-3 rule as `messagesToSdk`.
- Shared-policy module: anthropic and openai paths choose the **same** boundary for the same
  input (the anti-drift test).
- Usage: a response with `cached_tokens` meters as `cacheReadInputTokens`, not input.

**Gap 2**
- An MCP result with an image block survives to the provider request (both formats).
- Oversized image ⇒ dropped with an explicit, model-readable notice.
- Non-vision model ⇒ image dropped, notice present, request still valid.
- Text-only MCP results produce byte-identical results to today.
- Round-trip through transcript persistence and compaction without payload bloat.

**Live verification** (this is the one that actually proves gap 1): run a real
`anthropic/claude-sonnet-5` request twice through the built binary and assert
`cached_tokens > 0` on the second. The unit tests prove shape; only this proves caching.

---

## 5. Rollout

1. Land gap 1 in this repo; gate green (`lint + typecheck + bun test`, Go green).
2. Cut a `sov` release (`v0.6.54+`).
3. In the **appleo** node (`~/code/resume-as-code-platform`): vendor the new binary under
   `vendor/sov/`, update `vendor/sov/SOURCE.txt`, rebuild the image, redeploy, then confirm
   from `usage_span` that `anthropic/*` rows show non-zero `tok_cache_read`.
4. Gap 2 unlocks the appleo Theme Studio's screenshot, already shipped and waiting. When it
   lands, that node should revert the defensive "you may not receive the image" wording in
   `deploy/agent-skills/theme-context.md` to plain "judge the render from the image."

**Cross-node note:** the appleo node cannot fix either gap. Its broker
(`src/agent/gateway/wire/openrouter.ts`) is deliberately a transparent
authenticate-swap-pipe proxy; injecting `cache_control` by rewriting request bodies in flight
would put policy in the wrong layer and risk the pipe. That option was considered and
rejected — the fix belongs here.

---

## 6. Value and non-goals

**Value.** ~10x on Anthropic input tokens on this lane. Absolute saving is currently small
(appleo's Anthropic spend to date is ~$13, which would have been ~$1.30) because volume is
low — but it is the onboarding path every new user hits, and it scales linearly with users.
Gap 2's value is categorical rather than incremental: it is the difference between an agent
that can see its work and one that cannot.

**Non-goals.** Not changing which models any lane uses. Not touching the Anthropic transport's
existing caching. Not adding implicit caching for providers that already do it. Not a cache
TTL/1h-vs-5m strategy — start with `ephemeral` (5m) and revisit with data.

**Open question for the build session.** Whether the recent-message marking (§2.2 item 3) is
worth its complexity on day one, or whether system-prompt-only caching captures most of the
win. The system prompt is the large stable prefix; measure before building the second half.
