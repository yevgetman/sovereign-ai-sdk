# Implement `ToolResult.newMessages` — design

**Date:** 2026-07-17
**Package:** `@yevgetman/sov-sdk` (`packages/sdk`)
**Status:** proposed; pending CEO green-light (SOP-12)

## Problem

`ToolResult.newMessages` is a **declared-but-unimplemented** field: the tool-result type
advertises it (`packages/sdk/src/tool/types.ts:159`, `newMessages?: Message[]`), but the
orchestrator silently discards it (`packages/sdk/src/core/orchestrator.ts:159-163`:
*"…will eventually splice into history here (Phase 9 …); for Phase 4 we ignore them."*).
Concretely, `executeOne`'s local result is typed `{ data; observation? }`
(`orchestrator.ts:524`), so `result.newMessages` is dropped at the type level and never
reaches the conversation.

This is a **silent-failure API footgun**: a tool author reads the type, returns
`newMessages` in good faith, and the SDK throws it away with no error, warning, or log.
It bit a downstream consumer (the Agent Casa studio ingest agent) hard — a `read_source`
tool delivered intake images via `newMessages`; the images were dropped; the model was
handed a filename with no picture and confabulated content. The failure was invisible
until the hallucinated output was traced back three layers.

## Goal

Implement `newMessages` so a tool can inject additional content into the conversation for
the next model turn — the canonical use case being **an image** (a vision block a tool
reads at runtime). Do it within the SDK's existing, load-bearing message-ordering
invariant, reusing the pattern the loop already uses for the same problem.

## The ordering invariant (the dominant constraint)

Anthropic requires that a `user` message containing `tool_result` blocks **immediately
follow** the `assistant` message that emitted the matching `tool_use` blocks — you cannot
insert a separate message between them (HTTP 400: *"tool_use ids were found without
tool_result blocks immediately after"*), and you cannot follow it with a second
consecutive `user` message (HTTP 400: *"roles must alternate"*). The loop documents this
at `query.ts:369-384` and has a postmortem on file
(`docs/07-history/postmortems/loop-detector-orphaned-tool-use.md`).

The SDK already solves this exact problem twice:
- **Loop-detector guidance** — `consumeGuidance` (`query.ts:376-384`) merges an injected
  text block **into the tool_result user message's `content[]`** rather than pushing a
  separate message.
- **Mid-turn steering** — the same merge technique (`query.ts:549-554`).

`newMessages` will follow this established pattern.

## Design decision: NARROW semantics (recommended, and what this spec commits to)

`newMessages` is typed `Message[]` (messages with a role), but the only ordering-safe
insertion is **merging content blocks into the tool_result user message**. Therefore:

- **Honored:** `newMessages` entries with `role: 'user'`. Their `content` blocks are
  appended to the aggregated tool_result user message, **after** all `tool_result` blocks,
  in tool order. (Anthropic permits additional content blocks after `tool_result` blocks
  in the same user turn — this is exactly what `consumeGuidance` does with text and is how
  a vision block rides along.)
- **Not honored (fail loud):** `newMessages` entries with `role: 'assistant'` cannot be
  merged into a user message without breaking the invariant. Rather than silently drop
  them (the very footgun we're fixing), the orchestrator **throws** a clear developer
  error (`"ToolResult.newMessages currently supports role:'user' only; got role:'assistant' from tool '<name>'"`).
  This keeps the contract honest; general assistant-role / post-tool_result splicing is a
  **non-goal** (below), and the error tells the author exactly why.

Rationale: the narrow design covers the real use cases (images, retrieved documents, a
follow-up user note), matches the existing `consumeGuidance` merge, is a small, contained,
ordering-safe change, and — critically — replaces a *silent* drop with either correct
behavior or a *loud* error.

### Batch semantics (reconciling the stale doc comment)

The type doc currently says *"Applied only between serial tools; ignored for parallel
batches"* (`tool/types.ts:158`). That predates the current `runTools` shape, which emits a
**single** aggregated tool_result user message for the whole batch (`orchestrator.ts:116-117`).
With the merge-into-that-message design, serial vs. parallel is irrelevant: **every** tool's
user-role `newMessages` (serial and concurrent partitions alike) are collected and appended
to the one tool_result message, in `tool_use` block order (deterministic — `results[]` is
index-ordered). The doc comment is updated to state this.

## Implementation sketch

All changes in `packages/sdk/src/core/orchestrator.ts` (plus a doc/comment update in
`tool/types.ts`). `query.ts` needs **no change** — it already merges guidance/steering into
the message `runTools` yields, and here `runTools` yields a message that already carries the
appended blocks.

1. **Capture `newMessages` in `executeOne`.** Widen the local `result` type
   (`orchestrator.ts:524`) from `{ data; observation? }` to
   `{ data; observation?; newMessages?: Message[] }` so `tool.call()`'s field survives.
   (The thrown-error path has no result, so no newMessages — fine.)
2. **Surface it from `executeOne`.** Change `executeOne`'s return from `ToolResultBlock`
   to `{ block: ToolResultBlock; newMessages?: Message[] }`. Validate role here: if any
   entry is `role:'assistant'`, throw the developer error above (with the tool name).
3. **Thread through the partition runners.** `runSerialPartition` / `runConcurrentPartition`
   write into `out`; change the slot type to the new `{ block, newMessages? }` shape (or add
   a parallel `newMessagesByIndex` array). Index-order is already preserved.
4. **Append in `runTools` before the yield.** After building `resolved: ToolResultBlock[]`
   (`orchestrator.ts:97-114`), collect the per-index `newMessages` in block order, flatten
   their `content` blocks, and build the yielded message as
   `{ role: 'user', content: [...resolved, ...extraBlocks] }` (`orchestrator.ts:116-117`).
   When there are no `newMessages`, output is byte-identical to today.
5. **Update the comments/docs:** replace the "we ignore them" comment
   (`orchestrator.ts:159-163`) and the stale `tool/types.ts:156-159` doc to describe the
   implemented semantics (user-role content merged into the tool_result message, in tool
   order, serial + parallel alike; assistant-role rejected).

## Non-goals

- Full-message splicing **after** the tool_result message (assistant-role injections,
  multi-message sequences). Deferred — it requires interleaving messages while preserving
  the tool_use↔tool_result adjacency and role alternation, a materially larger change.
- Skill-activation hints ("Phase 9") — the original motivation named in the comment. This
  spec delivers the general content-injection primitive; any skill-hint feature can build
  on it later.
- No change to `observation` (a separate, already-wired envelope).

## Testing (TDD; Bun test)

- **Producer — `tests/core/orchestrator.test.ts`:** a `buildTool()` fake whose `call`
  returns `{ data, newMessages: [{ role:'user', content:[{type:'image', source:{…}}] }] }`;
  drain `runTools`; assert the yielded user message's `content` is `[tool_result…, image]`
  (tool_result first, image appended). A second tool with no `newMessages` → message
  unchanged. A tool returning `role:'assistant'` newMessages → `runTools` throws the
  developer error. Multiple tools (serial + concurrent) → appended in block order.
- **Loop — `tests/core/query.test.ts`:** script `MockProvider.toolUseScript` so turn 1
  emits a `tool_use` for the image tool and turn 2 emits text; assert the history/message
  sent to the provider on turn 2 contains the image block appended to the tool_result
  message (mirrors the existing steering-merge test at `query.test.ts:672-705`).
- Gate: `bun run lint && bun run typecheck && bun run test` (+ `bun run boundary` — the
  change stays in open-core `orchestrator.ts`, no proprietary import).

## Ship / versioning

Per `PUBLISHING.md`: land in `packages/sdk/src` → gate green → bump `@yevgetman/sov-sdk`
`version` (minor: additive, non-breaking — a previously-ignored field now honored) →
`bun run build` → `npm pack` (tarball allow-list enforced by `packages/sdk/tests/tarball.test.ts`)
→ `bun run canary` (installs into a scratch project, runs under node + bun). npm publish is a
**human-only** step (CEO). A vendored consumer (the Agent Casa studio) can adopt the new
`.tgz` without a registry publish.

### Downstream follow-up (separate, not this spec)

Once the SDK honors `newMessages`, the Agent Casa studio's contained workaround
(pre-attaching intake images to the initial ingest message) can optionally be reverted to
the cleaner `read_source` → `newMessages` delivery. That is a studio-repo change, tracked
separately; this spec must not regress the studio, which is fine because the SDK change is
purely additive.
