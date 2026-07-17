# Implement `ToolResult.newMessages` — Implementation Plan

> Execute subagent-driven (this repo's SOP-12): fresh implementer per task, task review after each, final whole-branch review. Steps use `- [ ]` checkboxes.

**Goal:** Honor `ToolResult.newMessages` — a tool returning `role:'user'` messages whose content blocks are merged into the tool_result user message (ordering-safe), so a tool can deliver an image/vision block to the next model turn. Assistant-role newMessages throw a loud developer error (never silently drop).

**Spec:** `specs/2026-07-17-tool-newmessages-design.md`.

**Architecture:** All code in `packages/sdk/src/core/orchestrator.ts`. `executeOne` captures the tool's `newMessages`, the partition runners thread them, and `runTools` appends their content blocks to the single tool_result user message it yields — reusing the exact ordering-safe merge the loop already uses for `consumeGuidance`/steering. `query.ts` needs NO change. Purely additive → minor version bump.

## Global Constraints

- **Bun toolchain.** Tests: `bun test --timeout 20000`. Gate: `bun run lint && bun run typecheck && bun run test` (`lint` includes `bun run boundary`). Run these, not npm.
- **Open-core boundary:** the change stays in `orchestrator.ts` (already open) — introduce NO import from proprietary modules (`bun run boundary` enforces).
- **Ordering invariant (load-bearing):** the tool_result user message must remain the message immediately after the assistant tool_use. `newMessages` content is APPENDED to that message's `content[]` AFTER the `tool_result` blocks — never a separate message. (Mirror `query.ts:376-384` `consumeGuidance`.)
- **Byte-identical when unused:** when no tool returns `newMessages`, `runTools`' yielded message is unchanged from today (existing tests must stay green untouched).
- **Semantics (from the spec):** honor `role:'user'` newMessages (merge content blocks, in tool_use block order, serial + concurrent alike); on any `role:'assistant'` entry, THROW `Error("ToolResult.newMessages currently supports role:'user' only; got role:'assistant' from tool '<name>'")`.
- Conventional commits (scoped, e.g. `feat(sdk): …`), no attribution trailers (match `git log`).

## Current anchors (verify by reading; lines may shift)

- `executeOne` (`orchestrator.ts:327`, returns `Promise<ToolResultBlock>` at `:334`) — the tool's `result` local is typed `{ data; observation? }` at `:524`, dropping `newMessages`. ~10 `return { type:'tool_result', … }` sites (early guards + success).
- `runSerialPartition` (`:165`) / `runConcurrentPartition` (`:192`) — both take `out: (ToolResultBlock | undefined)[]` and write `out[item.index] = <executeOne result>` (`:175`, `:215`).
- `runTools` (`:58-117`) — builds `resolved: ToolResultBlock[]` (`:97-114`) from `results[]`, yields `{ role:'user', content: resolved }` (`:116-117`).
- `Message`/`UserMessage`/`ContentBlock` in `packages/sdk/src/core/types.ts` (`ContentBlock` includes `image`); `ToolResult.newMessages?: Message[]` in `packages/sdk/src/tool/types.ts:159`.

---

## Task 1: Capture + thread + append `newMessages` in the orchestrator (+ producer tests)

**Files:**
- Modify: `packages/sdk/src/core/orchestrator.ts`
- Modify (comments/docs): `packages/sdk/src/tool/types.ts` (the stale `newMessages` doc, `:156-159`)
- Test: `tests/core/orchestrator.test.ts`

**Interfaces:**
- `executeOne` return type changes: `Promise<ToolResultBlock>` → `Promise<{ block: ToolResultBlock; newMessages?: Message[] }>`.
- `runTools` yields `{ role:'user', content: [...tool_result blocks, ...appended user-role newMessages content] }`.

- [ ] **Step 1: Write failing producer tests** — `tests/core/orchestrator.test.ts`, inside/near `describe('runTools')`. Use the existing `buildTool()` fakes + `collectResults`/drain helpers. Add:
  - a fake tool whose `call` returns `{ data: 'ok', newMessages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] }] }`; drain `runTools([toolUse])`; assert the single yielded user message `content` is `[<tool_result for that call>, <image block>]` — tool_result FIRST, image appended, image `source.data === 'QUJD'`.
  - a tool with NO `newMessages` → yielded message content is exactly `[tool_result]` (unchanged).
  - two tools (mix of with/without newMessages, and covering a concurrent partition if the harness makes that easy) → appended in tool_use block order, after all tool_result blocks.
  - a tool returning `newMessages: [{ role: 'assistant', content: [...] }]` → draining `runTools` **throws** the exact developer error message including the tool name.
  Write these to fail first.

- [ ] **Step 2: Run — expect FAIL** — `bun test tests/core/orchestrator.test.ts` (the new cases fail: no appended content / no throw).

- [ ] **Step 3: Implement** — `packages/sdk/src/core/orchestrator.ts`:
  - Widen the `result` local (`:524`) to `{ data: unknown; observation?: ToolObservation; newMessages?: Message[] }` so `tool.call()`'s field survives.
  - Add a small helper that validates + returns the user-role newMessages, throwing on assistant-role:
    ```ts
    function userNewMessages(newMessages: Message[] | undefined, toolName: string): Message[] | undefined {
      if (newMessages === undefined || newMessages.length === 0) return undefined;
      for (const m of newMessages) {
        if (m.role !== 'user') {
          throw new Error(
            `ToolResult.newMessages currently supports role:'user' only; got role:'${m.role}' from tool '${toolName}'`,
          );
        }
      }
      return newMessages;
    }
    ```
  - Change `executeOne`'s return type to `Promise<{ block: ToolResultBlock; newMessages?: Message[] }>`. Wrap every `return { type: 'tool_result', … }` as `return { block: { type: 'tool_result', … } }` (the early-guard/error paths have no newMessages). At the SUCCESS return (after the PostToolUse `final` block is computed), return `{ block: final, newMessages: userNewMessages(result.newMessages, tool.name) }`. (Compute `userNewMessages` only on the success path; the throw surfaces a real assistant-role misuse.)
  - Thread through the partition runners: add a parallel out array `nmOut: (Message[] | undefined)[]` to `runSerialPartition` / `runConcurrentPartition`, and change the write sites to `const r = await executeOne(...); out[idx] = r.block; nmOut[idx] = r.newMessages;` (serial `:175`, concurrent `:212-215`). `runTools` owns both arrays (`results` + a new `newMessagesByIndex`), passing them down.
  - In `runTools`, after building `resolved` (`:97-114`), collect the appended blocks in block order:
    ```ts
    const appended: ContentBlock[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const nm = newMessagesByIndex[i];
      if (nm) for (const m of nm) appended.push(...m.content);
    }
    const userMessage: UserMessage = { role: 'user', content: [...resolved, ...appended] };
    ```
    (When `appended` is empty this is byte-identical to today.)
  - Replace the stale comment (`:159-163`, "we ignore them") with a description of the implemented behavior (user-role content merged into the tool_result message, in block order, serial + parallel alike; assistant-role rejected). Update the `tool/types.ts:156-159` doc likewise (drop "applied only between serial tools; ignored for parallel batches").
  - Import `ContentBlock`/`Message`/`UserMessage` types as needed (already imported in this file — confirm).

- [ ] **Step 4: Run — expect PASS** — `bun test tests/core/orchestrator.test.ts`, then `bun run typecheck`, then the FULL `bun test` (existing orchestrator/query/etc. tests must stay green — the no-newMessages path is unchanged).

- [ ] **Step 5: Lint** — `bun run lint` (biome + boundary) clean.

- [ ] **Step 6: Commit** —
```bash
git add packages/sdk/src/core/orchestrator.ts packages/sdk/src/tool/types.ts tests/core/orchestrator.test.ts
git commit -m "feat(sdk): honor ToolResult.newMessages — merge user-role content into the tool_result message"
```

---

## Task 2: Loop integration test (end-to-end through `query()`)

**Files:** Test only — `tests/core/query.test.ts`.

**Interfaces:** Consumes Task 1. No `query.ts` code change (the merge already happens in the message `runTools` yields, which the loop pushes to history).

- [ ] **Step 1: Write the test** — mirror the steering-merge test (`tests/core/query.test.ts:672-705`) and the existing tool_use→tool_result assembly test (`:379-386`). Script `MockProvider.toolUseScript` so:
  - turn 1: a `tool_use` for a tool whose `call` returns `{ data:'read', newMessages:[{ role:'user', content:[{ type:'image', source:{ type:'base64', media_type:'image/png', data:'QUJD' } }] }] }`;
  - turn 2: a `text` turn (ends the run).
  Drive `query(...)`, collect the yielded messages / inspect `history`, and assert the user message carrying the `tool_result` (between the two assistant turns) ALSO contains the image block appended after the tool_result — i.e. the content the model receives on turn 2 includes the picture.

- [ ] **Step 2: Run — expect PASS** (Task 1 already makes this pass; if it fails, the loop isn't propagating the merged message — investigate before proceeding). `bun test tests/core/query.test.ts`.

- [ ] **Step 3: Full gate** — `bun run lint && bun run typecheck && bun test` all green.

- [ ] **Step 4: Commit** —
```bash
git add tests/core/query.test.ts
git commit -m "test(sdk): newMessages image reaches the model through the turn loop"
```

---

## Task 3: Extension docs (if present)

**Files:** `docs/04-extending/` (tool-authoring recipe), if one documents tool results.

- [ ] **Step 1:** grep `docs/04-extending/` (and any tool-authoring doc) for `newMessages` / `ToolResult`. If a recipe documents tool return values, add a short note: a tool may return `newMessages: [{ role:'user', content:[…] }]` to inject content (e.g. an image) into the next turn; it's merged into the tool_result message; assistant-role is not supported (throws). If no such doc exists, skip (note it in the report) — do NOT invent a new doc.

- [ ] **Step 2: Commit** (only if a doc changed) —
```bash
git add docs/04-extending/*
git commit -m "docs(sdk): note ToolResult.newMessages in the tool-authoring recipe"
```

---

## Ship (after all tasks + final review — human-gated publish)

Not a task (done by the controller / CEO): bump `@yevgetman/sov-sdk` `version` (minor) in `packages/sdk/package.json` → `bun run build` → `bun run canary` (node + bun consumer) → `npm pack`. `npm publish` is human-only (CEO). The vendored Agent Casa studio can adopt the new `.tgz`; reverting the studio's pre-attach workaround to the `newMessages` path is a separate downstream change.

## Self-review (completed)

- **Spec coverage:** narrow user-role merge + fail-loud on assistant-role → Task 1; batch (serial+parallel) order + byte-identical-when-unused → Task 1 tests; end-to-end through the loop → Task 2; doc reconciliation → Task 1 (comments) + Task 3 (recipe).
- **Type consistency:** `executeOne → { block; newMessages? }`; parallel `newMessagesByIndex`/`nmOut: (Message[]|undefined)[]`; `runTools` appends `ContentBlock[]` from user-role `.content`. `userNewMessages(newMessages, toolName)` is the single validation path.
- **No `query.ts` change** — the merge is inside the message `runTools` yields; the loop already pushes it.
