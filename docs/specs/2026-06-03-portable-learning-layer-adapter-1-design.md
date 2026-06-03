# Portable Learning Layer — Four-Port Contract + Adapter #1 — Design Spec

**Date:** 2026-06-03
**Status:** Draft (pre-implementation)
**Scope:** Spike Phase 1 — close the loop on *this* harness behind the four-port contract, and prove via eval that a lesson changes behavior session-to-session with no human approval. Spike Phase 2 (a rented-engine adapter) is out of scope here.

**Canonical specs (authoritative; live in `sovereign-ai-docs`, do not copy):**

- The spike — what to build first: `~/code/sovereign-ai-docs/harness/docs/runtime/learning-loop-spike-spec.md`
- The design — the four-port portable seam: `~/code/sovereign-ai-docs/harness/docs/runtime/portable-learning-layer-spec.md`
- The decision: ADR H-0010 `~/code/sovereign-ai-docs/harness/decisions/0010-compose-l2-agent-core-own-differentiators.md`
- In-repo kickoff: `docs/plans/2026-06-03-learning-loop-spike-kickoff.md`

This repo owns the **implementation** docs (this spec + the Phase 1 plan). The roadmap and decision record stay canonical in `sovereign-ai-docs`.

---

## Goal

Make the learning layer a **sealed, portable module** that talks to any host harness through exactly four ports — **Observe, Recall, Reason, Persist** — and **close the open loop**: today instincts are synthesized to disk and never read back into the main agent. After Phase 1, a lesson available in session N is surfaced in front of the agent in session N+1, and an eval proves this measurably changes behavior with **no human in the loop**.

Two questions gate everything downstream. Phase 1 answers only the first:

- **Q1 — Does the loop work?** Does a lesson change later behavior on its own? *(Proved here, on adapter #1 = this harness.)*
- **Q2 — Does it port?** *(Deferred to spike Phase 2 — a second adapter onto a rented engine.)*

## Business context

Per H-0010, the agent-loop plumbing is a commodity to be *composed*; the **learning layer is the moat** — the one differentiator no off-the-shelf framework provides. The moat is portable *by construction* only if the layer never reaches into a host's internals and speaks solely through the four ports. The current harness has ~80% of the machinery but two defects make the moat **not yet real**:

1. **Recall is unwired.** The instinct corpus is write-only from the main agent's perspective (verified: `LEARNING_ONLY_TOOLS` are excluded from the main pool; zero reads of the corpus into `systemPrompt.ts` / `query.ts`).
2. **Synthesis yield is near-zero.** 185 trajectories → 2 instincts → 1 ever-approved memory. Root cause is structural (below), not a tuning nit.

Phase 1 fixes both behind the contract, then proves the result.

## Verified current state (the starting line)

| Port | Status today | Anchor |
|---|---|---|
| **Observe** | ✅ two fire-and-forget streams: per-tool-call observations → `learning/<projectId>/observations.jsonl`; per-session ShareGPT trajectories → `trajectories/{samples,failed}.jsonl`. Redacted at the boundary. | `src/learning/observer.ts` (fired from `src/core/orchestrator.ts`); `src/trajectory/writer.ts` (fired from `src/server/sessionContext.ts` + `src/runtime/scheduler.ts`) |
| **Recall** | ❌ **THE GAP — unwired into the main agent.** Instinct tools are `LEARNING_ONLY` and never in the main pool; no corpus read reaches context assembly or the turn loop. | `src/tool/registry.ts:95` (`LEARNING_ONLY_TOOLS`); negative grep over `src/context`/`src/core`/`src/memory` |
| **Reason** | ⚠️ exists but tightly coupled — synthesis is a full sub-agent dispatch through the harness provider stack; no minimal prompt-in/text-out seam. | `src/learning/synthesizer.ts` → `src/runtime/scheduler.ts` (`delegate` → `AgentRunner` → `resolveProvider`) |
| **Persist** | ✅ exists, FS-only, layout hard-coded. Instincts = YAML-frontmatter `.md`; observations/trajectories = JSONL. | `src/learning/paths.ts`; `src/learning/instinctStore.ts`; `src/server/runtime.ts` (`resolveSubagentArtifactsRoot`) |

**The working mirror to follow for Recall:** the MEMORY.md read-back loop. Disk read in `src/memory/bounded.ts` (`readAllMemory`) via `src/memory/provider.ts`; formatted into a fenced `<memory-context>` block in `src/memory/injection.ts` (`formatMemorySnapshot`); spliced into the latest user message by `injectMemoryIntoLatestUserMessage`, invoked from **`src/core/query.ts:72-74`**.

**Load-bearing defect found while mapping:** even the working memory loop does **not** close on the default surface. The server turns route builds `query({...})` at **`src/server/routes/turns.ts:557-591`** without passing `memoryManager`. Since the TUI/server is the default surface (Phase 16.1) and the semantic eval drives `sov drive` (→ the Hono server → that same route), Recall wired the obvious way would silently no-op in the eval. **Fixing that route is in Phase 1 scope** (decision D6).

**Synthesis yield — the three structural causes (verified):**

- **A — the confidence curve is broken.** `src/learning/confidence.ts` uses `reinforce(0, n)` with `k = 0.04`; real proposals land at 0.05–0.16, **below the 0.3 prune floor** (`src/cli/learningPrune.ts`) and far below the **0.7 promotion gate** (`src/learning/promotion.ts`). Clearing 0.7 in one pass needs ~40M observations in a cluster. Both surviving instincts (0.064, 0.078) are prune-eligible.
- **B — clustering fragments.** The cluster key `tool_name::tool_input_summary[:80]::status` (`src/learning/cluster.ts`) embeds verbatim args, so `ls ~/a` and `ls ~/b` never co-cluster. One 552-observation project → 470 clusters, only 14 with ≥3 (the propose bar).
- **C — synthesis is rare, zero-biased, and fails silently.** Counter cadence (20 user turns / 50 tool iterations, `src/review/manager.ts`), a prompt that prefers producing nothing (`src/learning/synthesizer.ts`, `bundle-default/agents/instinct-synthesizer.md`), `maxTurns: 8`, and a swallow-on-failure path.

---

## Locked design decisions

Settled through the 2026-06-03 brainstorming dialogue (three founder forks resolved + recommendations approved). Not relitigated downstream.

| ID | Decision | Choice |
|---|---|---|
| **D1** | Port rigor in spike Phase 1 | **Seam now, sealing later.** Define all four port interfaces + bind adapter #1, close the loop + run the eval. **Defer** the mock-host isolation suite, the full Persist/Reason *extraction*, and adapter #2 to Phase 2 (where portability is actually tested). Honors "behind the contract" without front-loading the cost the spike exists to defer. |
| **D2** | Port directions | **Observe + Recall are the layer's public API** (the host calls them). **Reason + Persist are host-provided dependencies** (the layer calls them). The layer is constructed via `createLearningLayer({ reason, persist })` and depends on *nothing else* from the host. |
| **D3** | Recall content | **Instincts only** in Phase 1 — the differentiator and the literal missing link. Memory keeps its own (now-fixed) injection path. Folding memory/skills into Recall is a later option, not Phase 1. |
| **D4** | Recall assembly | **Deterministic** — match instinct triggers against the latest user text + domain, sort by confidence, budget by token count. **No model call on the hot path** (Recall runs before every turn). Reason is not used by Recall. |
| **D5** | Recall injection point | **Mirror memory.** Splice a fenced lesson snapshot into the latest user message at `src/core/query.ts:72-74`, via a new optional `recallPort` QueryParam + a host-side `injectRecallIntoLatestUserMessage` helper. |
| **D6** | Server-route fix (load-bearing) | The `query({...})` call in `src/server/routes/turns.ts` **must pass `memoryManager`** (closing the existing memory gap) **and the new `recallPort`**. Without this the default surface + `sov drive` (and thus the eval) never inject. |
| **D7** | Persist scope (Phase 1) | Define `PersistPort`; adapter #1 binds it to FS using the existing `src/learning/paths.ts` layout. **Refactor `InstinctStore` to depend on `PersistPort`** — seal the moat-critical instinct corpus that Recall reads. Observations.jsonl + trajectory writers stay direct-FS; their sealing + a mock-host `PersistPort` are Phase 2. |
| **D8** | Reason scope (Phase 1) | Define `ReasonPort`; adapter #1 provides a thin provider-backed `complete()`; unit-test the seam. **Do not migrate** the existing synthesizer sub-agent onto Reason yet (Phase 3 extraction). Reason is defined-but-not-yet-load-bearing **by design** — placing the seam now keeps the layer's construction signature stable. |
| **D9** | Synthesis yield fix (in place, no Reason extraction) | (a) **Re-derive the confidence curve** so ~5–10 consistent observations clear the prune floor and ~15–25 clear the promotion gate, with contradiction still penalizing meaningfully; (b) **normalize the cluster key** so same-tool/different-arg observations co-cluster; (c) **add an end-of-session synthesis trigger**, soften the zero-bias prompt, and **surface synthesis failures** instead of swallowing them. |
| **D10** | Eval source | **Track A (curated, seeded instincts)** isolates Recall→behavior and is the **Q1 gate**. **Track B (real synthesis from the 185-corpus)** is the second, end-to-end signal that exercises the full loop including the fixed synthesizer. |
| **D11** | Eval metric | **Correctness flip** — with-learning succeeds where without-learning fails — on **≥3 of ~5** curated scenarios, holding across **3 repetitions**, with **no regression** on any scenario. Efficiency (steps / tool-calls) is a secondary metric where both arms already succeed. |
| **D12** | Eval autonomy | The eval sandbox forces `review.autoPromoteMemory/Skills = true` and `learning.recall.enabled = true`; instincts are read **directly from the corpus** (no promotion gate). **No human approval anywhere.** This is eval-local config and does **not** change product defaults. |
| **D13** | Product defaults unchanged | Phase 1 ships Recall behind **`learning.recall.enabled: false`** (opt-in, matching the cautious task-routing pattern). Flipping the default on is gated on **Q1 PASS + the founder go/no-go**. Auto-promote-by-default stays **founder-reserved**. |
| **D14** | Determinism | A **MockProvider integration test** proves the wiring (the recall snapshot reaches the provider request and changes the agent's tool calls) deterministically; the **semantic eval** proves real behavior change. Both ship in Phase 1. |
| **D15** | Module boundary | New **`src/learning-layer/`** box: `ports.ts` + `recall/` + `eval/` + `adapters/harness/`. Existing `src/learning`/`src/trajectory`/`src/review` stay in place as in-box machinery referenced by adapter #1; full relocation is deferred (Approach A). |

---

## The four-port contract

A single new file `src/learning-layer/ports.ts` defines the entire surface between the moat and any host. The isolation rule (portability gate #1, mechanically enforced in Phase 2): **in-box code may import other in-box code, but may touch the host only through the four ports.** "In-box" is the moat machinery — `src/learning-layer/` plus, in Phase 1, the existing `src/learning` / `src/trajectory` / `src/review` modules declared in-box per D15 (physically relocated under `src/learning-layer/` in Phase 2 so the gate is checkable by directory). So `recall/assemble.ts` (in-box) importing `InstinctStore` (in-box, depends on the host only via `PersistPort`) is allowed; importing anything from `src/server` / `src/core` is not. All shapes are `readonly` per the immutability rule.

```ts
// src/learning-layer/ports.ts — the four-port contract between the learning layer and any host harness.

/** Host-neutral transcript turn. The adapter maps the host's message shape onto this. */
export interface TranscriptTurn {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly text: string;
}

/** A completed session handed to the layer for ingestion (Observe). */
export interface CapturedSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly turns: readonly TranscriptTurn[];
  readonly terminalReason: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A single tool action, optionally streamed as it happens (Observe). */
export interface ToolEvent {
  readonly sessionId: string;
  readonly projectId: string;
  readonly toolName: string;
  readonly status: 'success' | 'error' | 'denied' | 'cancelled';
  readonly inputSummary: string;
  readonly durationMs: number;
}

/** What the host knows about the turn that is about to run (Recall input). */
export interface RecallContext {
  readonly projectId: string;
  readonly latestUserText: string | undefined;
  readonly tokenBudget: number;
  readonly maxLessons: number;
}

/** A single lesson the layer chose to surface (Recall output, for tracing/eval). */
export interface RecalledLesson {
  readonly id: string;
  readonly trigger: string;
  readonly action: string;
  readonly confidence: number;
}

/** What the layer hands back to inject in front of the agent (Recall output). */
export interface RecallResult {
  /** Fenced, ready-to-inject text; empty string when nothing is relevant. */
  readonly injectionText: string;
  /** Structured provenance; never required by the host to act. */
  readonly lessons: readonly RecalledLesson[];
}

/** Options for a single model call (Reason). */
export interface ReasonOptions {
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

// --- The layer's PUBLIC API (host calls these; the layer implements them) ---

/** Port 1 — Observe (host → layer). */
export interface ObserveApi {
  observeSession(session: CapturedSession): Promise<void>;
  observeToolEvent(event: ToolEvent): void; // fire-and-forget
}

/** Port 2 — Recall (layer → host). The missing link. */
export interface RecallApi {
  recall(ctx: RecallContext): Promise<RecallResult>;
}

// --- The layer's DEPENDENCIES (adapter implements these; the layer calls them) ---

/** Port 3 — Reason (layer → model). Minimal "prompt in, text out". */
export interface ReasonPort {
  complete(prompt: string, opts?: ReasonOptions): Promise<string>;
}

/** Port 4 — Persist (layer ↔ storage). Minimal named-blob store. */
export interface PersistPort {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  remove(key: string): Promise<void>;
}

/** What the adapter provides to construct the layer. */
export interface LearningHostDeps {
  readonly reason: ReasonPort;
  readonly persist: PersistPort;
}

/** The layer instance the host holds. */
export interface LearningLayer extends ObserveApi, RecallApi {}
```

`src/learning-layer/index.ts` exports `createLearningLayer(deps: LearningHostDeps): LearningLayer`. That factory + `ports.ts` are the only entry points a host touches.

### Port directions (D2), restated for clarity

| Port | Implemented by | Called by | Phase-1 reality |
|---|---|---|---|
| Observe | layer | host (end-of-session + per-tool hooks) | adapter wraps existing observer/writer hooks |
| Recall | layer | host (pre-turn splice in `query.ts`) | **new** — the missing link |
| Reason | **adapter** | layer | defined + thin bind + test; synthesis migration deferred (D8) |
| Persist | **adapter** | layer | FS-backed; `InstinctStore` sealed onto it (D7) |

---

## Adapter #1 — how each port binds to this harness

`src/learning-layer/adapters/harness/` is the **only** host-specific code. It is the thing that churns when the host changes; the layer never does.

- **Observe ← existing hooks.** The adapter exposes thin functions the existing capture sites call: the per-tool observation path (`src/core/orchestrator.ts` → `LearningObserver`) maps to `layer.observeToolEvent(...)`; the end-of-session trajectory path (`src/server/sessionContext.ts` / `src/runtime/scheduler.ts`) maps to `layer.observeSession(...)`. Phase 1 wraps these without rebuilding them.
- **Recall → new pre-turn splice.** The runtime constructs the layer once (adapter #1 wiring) and exposes its `RecallApi`. `query()` gains an optional `recallPort: RecallApi`; after the existing memory injection at `query.ts:72-74`, when present it calls `recall({ projectId, latestUserText, tokenBudget, maxLessons })` and splices `injectionText` into the latest user message via a new host-side helper `injectRecallIntoLatestUserMessage` (mirrors `src/memory/injection.ts`). **`src/server/routes/turns.ts` must forward both `memoryManager` and `recallPort`** (D6).
- **Reason ← thin provider wrapper.** `adapters/harness/reasonProvider.ts` implements `complete(prompt, opts)` over the harness provider (resolve once at boot, stream-collect to a string). Phase 1 binds + unit-tests it; the production synthesizer is **not** migrated onto it yet (D8).
- **Persist ← FS over harnessHome.** `adapters/harness/persistFs.ts` implements `read/write/list/remove` by mapping a key (e.g. `learning/<projectId>/instincts/<id>.md`) to a path under `$HARNESS_HOME` using the existing `src/learning/paths.ts` layout. `InstinctStore` is refactored to take a `PersistPort` so the moat-critical instinct corpus is sealed (D7); observations/trajectory writers stay direct-FS for now.

---

## Closing Recall (the missing link)

New `src/learning-layer/recall/`:

- **`assemble.ts`** — deterministic selection: read the project's instincts (+ `_global`) via the Persist-backed `InstinctStore`, score relevance of each instinct's `trigger`/`domain` against `latestUserText` (cheap lexical match — token overlap / substring on the trigger phrase), drop below a relevance floor, sort by `(relevance, confidence)`, take top `maxLessons`, then trim to `tokenBudget`. Pure function over an instinct list + context → `RecalledLesson[]`. Returns empty when nothing matches (fail-open).
- **`format.ts`** — render the selected lessons into a fenced snapshot mirroring `formatMemorySnapshot`: a preamble marking it as *recalled learned context, not new user input*, then a `<learned-context>` block of `trigger → action` lines. Produces `RecallResult.injectionText`.

Host-side splice: `src/core/recallInjection.ts` exports `injectRecallIntoLatestUserMessage(history, result)` — finds the latest user message's text block and prepends `result.injectionText` (returns a new array; never mutates). Invoked from `query.ts` after memory injection.

Budget accounting: add `'instinct'` to the `ComponentKind` union in `src/context/budget.ts` so recalled lessons are visible in the context-budget audit.

**Recall is best-effort.** Any failure (Persist read error, malformed instinct) yields an empty `RecallResult` and the turn proceeds uninjected — Recall never blocks or fails a user turn.

---

## Fixing synthesis yield (D9)

All three fixes are deterministic / prompt-level — none requires the Reason extraction deferred in D8.

1. **Confidence curve** (`src/learning/confidence.ts`). Re-derive `reinforce()` so confidence reflects evidence realistically: target ~0.35–0.45 at ~5–10 consistent observations (clears the 0.3 prune floor) and ~0.7 at ~15–25 (clears the promotion gate), saturating below 1.0; `contradict()` keeps a meaningful penalty. Exact constants pinned by unit tests asserting confidence at representative evidence counts. Existing on-disk instincts store `evidence_count`, so confidence is recomputable under the new curve (a one-time recompute, or forward-only — decided in the plan).
2. **Cluster key** (`src/learning/cluster.ts`). Normalize the input summary before keying: abstract concrete paths/values to placeholders so the key becomes `tool_name::<normalized-shape>::status`. Unit-tested against the real 552-observation project fixture; target a large drop in distinct clusters and many clusters reaching the ≥3 propose bar.
3. **Cadence + bias + visibility** (`src/review/manager.ts`, `src/learning/synthesizer.ts`, `bundle-default/agents/instinct-synthesizer.md`). Add an **end-of-session synthesis trigger** when ≥10 new observations (tunable) have accrued since the last run (so session N's lessons exist before session N+1); soften the "producing zero is preferred" framing to "propose any pattern with ≥3 consistent observations, precisely"; and **surface failures** (log + an assertable status) instead of swallowing them. Raise `maxTurns` if synthesis is truncating.

The yield fix feeds **Track B**. The **Q1 gate (Track A)** seeds instincts directly and therefore does not depend on yield being perfect.

---

## The eval — proving Q1

Built on the existing semantic framework (`tests/semantic/framework/driver.ts` drives `sov drive` headless; `prompt: string[]` gives the session-N / session-N+1 primitive). The eval lives **in-box** (`src/learning-layer/eval/`); the *driver* is adapter-specific test glue (a `SessionRunner` the harness adapter satisfies via `sov drive`), so Phase 2 can reuse the same scenarios + scorer with a different runner.

**Two arms, identical except one flag:** with-learning (`learning.recall.enabled = true`) vs without-learning (`false`). Same sandbox, same seeded corpus, same model, same scenario.

- **Track A — curated (the Q1 gate, D10).** Each scenario ships a self-contained sandbox (via the framework's `setup`) plus a **seeded instinct** standing in for a session-N lesson. The scenario's task is designed so the lesson is **load-bearing and non-derivable from ambient context** — the baseline arm fails (or is wrong), the with-learning arm succeeds. Categories:
  1. **Tool/command choice** — sandbox where the correct build/test command is unusual; instinct encodes it.
  2. **Repo convention** — instinct "always change X and Y together"; the task touches X.
  3. **Known pitfall** — instinct "doing X breaks Y; do Z"; baseline hits the pitfall.
  4. **Workflow ordering** — instinct "run lint before commit (hook rejects otherwise)".
  5. **Spare** — a fifth to keep the ≥3-of-5 bar robust.
- **Track B — real synthesis (second signal, D10).** Use the 185-corpus + per-project `observations.jsonl` with the **fixed** synthesizer: run a real session N that generates a learnable pattern, let synthesis produce the instinct, then run a dependent session N+1 and measure. Proves the full Observe→Reason→Persist→Recall loop end-to-end on a couple of scenarios.

**Metric (D11):** PASS = correctness flip on ≥3 of ~5 Track-A scenarios, across 3 repetitions, with no scenario regressing. A judge (the framework's pluggable judges) scores correctness against per-scenario `mustSatisfy`/`shouldNot`. Efficiency (tool-call count from the session summary) is reported as a secondary signal.

**Autonomy (D12):** eval sandbox config forces `review.autoPromote* = true` + `learning.recall.enabled = true`; instincts are recalled directly (no promotion gate); no human approval anywhere. Eval-local only.

**Determinism (D14):** alongside the semantic eval, a `tests/server/turns.recall.test.ts` using MockProvider asserts deterministically that, with a seeded corpus + recall on, the recall snapshot appears in the provider request and the scripted tool-call sequence differs from recall-off. This de-risks the wiring independent of LLM variance.

**Entry point:** `bun run eval:learning` (a `package.json` script over `src/learning-layer/eval/runner.ts`), reporting per-scenario arm results + the PASS/FAIL verdict.

---

## Components and file layout

### Create

| Path | Purpose |
|---|---|
| `src/learning-layer/ports.ts` | The four port interfaces + shared types (above). The *only* file host code imports. |
| `src/learning-layer/index.ts` | `createLearningLayer(deps)` factory; the `LearningLayer` implementation wiring Observe + Recall over the in-box machinery. |
| `src/learning-layer/recall/assemble.ts` | Deterministic lesson selection/ranking/budgeting (pure). |
| `src/learning-layer/recall/format.ts` | Fenced `<learned-context>` snapshot formatter. |
| `src/learning-layer/adapters/harness/index.ts` | Adapter #1 — constructs the layer with FS Persist + provider Reason; exposes Observe wrappers + the Recall API for the runtime. |
| `src/learning-layer/adapters/harness/persistFs.ts` | FS-backed `PersistPort` (key→path under `$HARNESS_HOME` via `paths.ts`). |
| `src/learning-layer/adapters/harness/reasonProvider.ts` | Thin provider-backed `ReasonPort.complete()`. |
| `src/learning-layer/eval/runner.ts` | Paired-arm eval runner over the semantic driver; emits the PASS/FAIL verdict. |
| `src/learning-layer/eval/score.ts` | Correctness-flip + efficiency scorer (pure). |
| `src/learning-layer/eval/scenarios/*.ts` | Track A curated scenarios (≥5) + Track B real-synthesis scenarios. |
| `src/core/recallInjection.ts` | Host-side `injectRecallIntoLatestUserMessage` (mirrors `src/memory/injection.ts`). |

### Modify

| Path | Change |
|---|---|
| `src/core/query.ts` | Add `recallPort?: RecallApi` to params; after memory injection (`:72-74`), when present, call recall + splice. |
| `src/core/types.ts` | Add `recallPort?: RecallApi` to `QueryParams`. |
| `src/server/routes/turns.ts` | **D6** — pass `memoryManager` (the fix) **and** `recallPort` into `query({...})` (`:557-591`). |
| `src/server/runtime.ts` | Construct the learning layer (adapter #1) at boot; stash its Recall API + Observe wrappers on `Runtime`. |
| `src/server/sessionContext.ts` | Expose the runtime's Recall API to the turns route; route Observe through the adapter. |
| `src/learning/instinctStore.ts` | **D7** — depend on `PersistPort` (swap direct `*FileSync` for `persist.*`). |
| `src/learning/confidence.ts` | **D9a** — re-derive the curve. |
| `src/learning/cluster.ts` | **D9b** — normalized cluster key. |
| `src/review/manager.ts` | **D9c** — end-of-session synthesis trigger + cadence. |
| `src/learning/synthesizer.ts` | **D9c** — surface failures; soften prompt. |
| `bundle-default/agents/instinct-synthesizer.md` | **D9c** — soften the zero-bias framing. |
| `src/context/budget.ts` | Add `'instinct'` `ComponentKind`. |
| `src/config/schema.ts` | Add `learning.recall` block (+ any synthesis knobs not already in `src/learning/tuning.ts`). |
| `package.json` | `eval:learning` script. |

### Tests (TDD — written first per task)

`tests/learning-layer/{ports,persistFs,reason,recall.assemble,recall.format,index}.test.ts`; `tests/core/recallInjection.test.ts`; `tests/server/turns.recall.test.ts` (MockProvider wiring, D14) + a server-route memory-fix test; extend `tests/learning/{confidence,cluster}.test.ts` (pin the new curve + the 552-obs normalization); extend `tests/review/manager.test.ts` (end-of-session trigger); `tests/learning-layer/eval/score.test.ts`; a new `tests/semantic/suites/<NN>-learning-recall.cases.ts` suite (next free number assigned in the plan — 21/22/23 are taken).

---

## Data flow

**Without-learning (baseline / `recall.enabled=false`):**
```
USER turn → query() → [no recall splice] → provider → tool calls → response
```

**With-learning (`recall.enabled=true`):**
```
USER turn → query()
  → recall({projectId, latestUserText, tokenBudget, maxLessons})
      → InstinctStore.list (via PersistPort) → assemble (match triggers · sort by confidence · budget) → format fenced snapshot
  → injectRecallIntoLatestUserMessage(history, result)
  → provider (now sees the lessons) → tool calls (changed) → response
```

**Full loop end-to-end (Track B):**
```
session N   : USER tasks → tool calls → observations.jsonl (Observe)
              → at session close, synthesis trigger → synthesizer reads observations
              → proposes instincts (fixed yield) → corpus (Persist)
session N+1 : USER dependent task → Recall surfaces the session-N instinct → behavior changes
```

## Configuration surface

```jsonc
{
  "learning": {
    "disabled": false,                // existing
    "recall": {
      "enabled": false,               // D13 — opt-in; eval flips it on
      "maxLessons": 8,
      "tokenBudget": 1200
    }
  }
}
```

Synthesis-tuning knobs (confidence constants, prune floor, promotion gate, cluster-normalization toggle, end-of-session threshold) extend the existing `src/learning/tuning.ts` surface. No new CLI primitives — `sov config get/set learning.recall.*`.

## Error handling

- **Recall** is best-effort and **fail-open**: any error → empty `RecallResult`, the turn proceeds uninjected. Never blocks or fails a user turn (carries the existing Invariant-#10 posture).
- **Synthesis** failures are now **surfaced** (logged + an assertable status) rather than swallowed (D9c), but remain non-blocking to the user's turn.
- **Persist** errors inside Recall are caught and treated as "no lessons". Reason errors surface to the synthesis path's status, not the user session.
- The **server-route memory fix** (D6) means memory now injects on the server surface where it previously didn't — covered by a dedicated test; it is, in effect, a latent bug fix and should be called out in the release notes.

## Out of scope (Phase 1) / founder-reserved

**Deferred to spike Phase 2:** the mock-host `PersistPort` + the portability isolation suite; full Persist extraction (observations.jsonl + trajectory writers behind Persist); migrating the synthesizer onto `ReasonPort`; adapter #2 (a rented engine) + the four portability acceptance gates.

**Founder-reserved (not decided here):** which rented engine for Phase 2; go/no-go after Phase 1; whether learned memory/skills auto-promote by default; whether `learning.recall.enabled` flips to `true` by default.

## Risks and open questions

| ID | Risk / question | Mitigation / resolution |
|---|---|---|
| R1 | LLM stochasticity makes the correctness-flip noisy. | Repetitions (D11) + a deterministic MockProvider wiring test (D14) + scenarios designed for clear, non-marginal flips. |
| R2 | A curated lesson is derivable from ambient sandbox context → baseline also passes → no flip. | The **non-derivability design constraint** (each scenario reviewed so the lesson is knowable only from the recalled instinct). |
| R3 | Re-deriving the confidence curve destabilizes existing behavior/tests. | Unit tests pin the curve at representative evidence counts; recompute confidence from stored `evidence_count` (one-time) or go forward-only — chosen in the plan. |
| R4 | Recall adds latency/tokens to every turn. | Deterministic, bounded by `maxLessons` + `tokenBudget`; off by default (D13). |
| R5 | The server-route memory fix changes behavior where memory previously didn't inject. | Gated on `memoryManager` presence as before; covered by a new test; documented as a bug fix in release notes. |
| R6 | Softening the zero-bias prompt over-produces low-quality instincts. | The ≥3-observation propose bar + confidence gating + prune remain; Recall budgets to top-N by confidence, so noise rarely surfaces. |
| R7 | `InstinctStore`-on-Persist refactor touches a load-bearing module. | Pure interface swap behind existing tests; the FS adapter maps to the same `paths.ts` layout (byte-compatible on disk). |

## Implementation guidance

1. Brainstorm — **done** (this document).
2. Plan — `superpowers:writing-plans` produces `docs/plans/2026-06-03-learning-loop-spike-phase-1.md` (checkbox tasks for `superpowers:subagent-driven-development`).
3. Subagent-driven implementation per `docs/conventions/subagent-policy.md`: **Opus default; Sonnet only for trivially mechanical, fully-specified tasks; never Haiku.**
4. TDD throughout (≥80% coverage). Pre-commit gate: `bun run lint && bun run typecheck && bun run test` — all green.
5. Atomic commits, autonomous push to `master`. `sov upgrade` + cut the next binary release in-session once runtime code changes (per `docs/conventions/cutting-releases.md`).
6. Repo conventions: every `.ts` has a one-line responsibility header; `.js` import extensions; every tool via `buildTool()`; no product-specific content under `src/` (the learning layer is harness machinery, not bundle content — `src/` is correct).
7. **Cross-repo record-keeping** (per the kickoff "Keeping the record straight"): when Phase 1 lands, update — or flag for a docs-repo session — the spike spec's Phase-1 `**Status:**`, the `learning-loop-closure-and-proof` open-question, and the dev status page, all in `sovereign-ai-docs`.

**Size:** ~5–7 subagent dispatches (ports + adapter; Recall + the server-route fix; yield fix; eval Track A; eval Track B; wiring/tests/release). Aligns with the spike spec's ~300K-token Phase-1 estimate — a focused multi-session effort at this repo's subagent pace.
