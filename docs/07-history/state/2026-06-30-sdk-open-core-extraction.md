# State snapshot — 2026-06-30 — SDK open-core extraction (the harness now runs on `createAgent`)

**Canonical current-state snapshot.** Captured on the `sdk-extraction` branch at package version **v0.6.47** (pre-merge). This is the finale (Phase 9) of the SDK open-core extraction — the strangler arc (§17 of the design spec) that turned the harness into a **thin composition over an importable open-core SDK** plus the proprietary packages. Behavior-preserving throughout: `query()` and every surface's turn behavior are unchanged; the inversion only moved *where* the turn loop lives and *which* dependencies an open consumer may reach.

Spec: [`specs/2026-06-29-sdk-open-core-extraction-design.md`](specs/2026-06-29-sdk-open-core-extraction-design.md).

## Headline — there is now an importable agent core, and the harness is one of its consumers

Before this arc, each surface (gateway turns, cron, channels, sub-agents, mission) drove the `query()` turn loop its own way — some inline, some through a `runtime/agentRunner.ts` wrapper class — and the open/proprietary line was conceptual, not enforced. After it:

- **`createAgent()` is the open SDK front door (`src/agent/createAgent.ts`).** It composes only open primitives (`query()`, `resolveProvider`, the `Tool`/`ToolContext` shapes, the injected ports) and is the standing-config + per-turn-override (`PerTurn`) driver of the turn loop. It adds the three net-new engine responsibilities the spec (§5.2) calls out: per-turn override merging, optional `SessionStore`/`TranscriptStore` persistence (absent store → **no disk**, the embeddable default), and the `observe`→`LearningObserverPort` adapter. Its `run()` yields `query()`'s `StreamEvent | Message` stream **unchanged and in order** (the stream-passthrough invariant).
- **Five injected ports** keep the proprietary impls behind narrow open interfaces: **`SessionStore`** (+ `createInMemorySessionStore()` default; the `bun:sqlite` `SessionDb` stays a closed impl), **`TranscriptStore`**, **recall** (`RecallTurn`/`RecallResult`), **observe** (`LearningObserverPort`/`ObserveInput`), and **trace** (`TraceEvent`). `buildToolContext()` is promoted to an open assembler that takes those ports rather than reaching into the proprietary runtime.
- **`sdk.ts` is the open barrel** (package `exports` map: `.`, `./sdk`, `./protocol`). It **self-gates** — re-exporting anything proprietary fails the boundary lint.
- **Contract #2** (the gateway wire protocol) ships as a pure `.d.ts` `sov-protocol` surface (no zod in the protocol package; a zod-conformance test guards it), and the gateway client + handlers are typed by it.
- **The file-level boundary lint** (`bun run boundary`, dependency-cruiser + `scripts/boundary-manifest.json`) enforces **zero open→proprietary imports**, against an explicit exception manifest (`principals.ts`, `capabilities.ts`, `stall.ts`, `subprocessExecutor.ts`, the `commands/*Ops.ts` set). It is part of `bun run lint`.
- **Every (B) in-process surface now runs on `createAgent()`** — the OpenAI/gateway turn-exec, `sov mission run`, cron, channels, and the sub-agent scheduler — each migrated behind its own field-level parity test. Two CEO-ratified parity *fixes* rode along: cron + channels now gain microcompaction (and cron, transcripts) via the new ports, closing a gap the old wrapper structurally could not carry.

## This task (Phase 9.1) — make the harness genuinely thin

- **Removed the dead `AgentRunner` class** and its `AgentRunnerOpts`/`AgentRunnerResult` types (`src/runtime/agentRunner.ts`, now deleted) plus its orphaned test (`tests/runtime/agentRunner.test.ts`). Verified truly dead first: no surface constructed it after the Phase 4–7 re-seats — only its own definition + comments referenced it. The generic stream-drain helper **`drainRunner` was kept** (it lives in `src/runtime/scheduler.ts`, not the deleted file, and still drives the scheduler's `createAgent` native path; its result shape is pinned by `src/runtime/executorPort.ts` + `tests/runtime/subprocessExecutor.test.ts`).
- **Tidied the stale "was `new AgentRunner(...)`" / dead-symbol comments** across the surfaces (`scheduler.ts`, `cron/wiring.ts`, `channels/pipeline.ts`, `subprocessExecutor.ts`, `createAgent.ts`) to reflect the `createAgent` reality, keeping the substantive 1:1 parity rationale. Fixed a pre-existing stray NUL byte in `src/hooks/runner.ts` (a `skipKey` delimiter).
- **Confirmed the §15 acceptance gate** with a coverage map (criterion → existing test); every enumerated Go-TUI/gateway E2E scenario (tool turn, recall, workflow, approval round-trip, micro + overflow compaction, skill-scoped turn, one channel + one cron turn) is already covered across the suite — no new test needed, nothing duplicated.

## Gate (this build)

- `bun run typecheck` — clean. `bun run lint` (biome + boundary) — clean; **boundary 0 open→proprietary** (379 modules, 1467 deps).
- `bun run test` — **4343 pass / 0 fail / 16 skip** across 443 files (was 4351 across 444; the −8 / −1-file delta is exactly the removed dead-AgentRunner tests). `grep "class AgentRunner" src` → empty.

## Deferred / out of scope (documented)

- The physical `packages/` monorepo split is represented by the `exports` map + surface-snapshot tests + the no-disk example-consumer canary; a literal package publish is a later distribution step. Node compatibility (Bun-only today) is deferred to v1. The remaining "prior AgentRunner opts" history references in the parity-doc comment blocks are accurate rationale and were intentionally kept.

Predecessor: `docs/07-history/state/2026-06-15-session-transcripts.md` (user-level session transcripts + subscription-executor visibility, v0.6.46). Find the latest via `ls docs/07-history/state/*.md | sort -r | head -1`.
