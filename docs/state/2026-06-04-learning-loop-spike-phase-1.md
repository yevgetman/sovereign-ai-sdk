# State of the build — Learning-Loop Spike, Phase 1 (loop closed; Q1 PASS)

**HEAD:** `bb0cb78` (`test(learning-layer): harden eval proof — recall as sole Track-A axis + non-derivable scenario 1`). **Interim release:** v0.6.14 (cut mid-build; carries the D6 memory fix + inert recall scaffolding). **Pending:** the completed feature releases separately as the next patch — NOT cut in this close-out.

**Predecessor:** [`docs/state/2026-05-31-post-m2-hardening.md`](2026-05-31-post-m2-hardening.md) (post-M2 hardening run, v0.6.1 → v0.6.13).

## Post-Phase-1 update — recall flipped ON by default (v0.6.16, 2026-06-04)

> This block records decisions/results taken **after** Phase 1 closed. It does **not** rewrite the Phase-1 historical record below (D13 shipping recall off by default was accurate for Phase 1).

1. **Recall is now ON by default** as of **v0.6.16** — a **founder decision (2026-06-04)** taken after the spike's Q1 cleared its bar. The schema default flipped `false → true` (`src/config/schema.ts`), and — because Zod's `.default(true)` only fires when a `recall` block is present — the runtime gate in `src/server/sessionContext.ts` now reads `recallCfg?.enabled !== false` so that **absent** config also means ON. It stays **fail-open** and is a **no-op on an empty instinct corpus**, and remains wired on the **turns route** only (TUI / `sov serve` / `sov drive`). Opt out with `learning.recall.enabled: false`. (Supersedes the "Founder-reserved → whether `learning.recall.enabled` flips to true by default" item and the "(default FALSE)" note below — both were accurate as of Phase-1 close-out.)

2. **#1 hardening — curated eval re-run at 3 repetitions.** Each Track-A scenario's OFF/ON arms now run 3× (`src/learning-layer/eval/runner.ts`; a scenario counts as a robust flip only if it flips in EVERY rep, and the verdict fails on any regression in any rep). Live 3-rep run: **all 5 Track-A scenarios scored 3/3 robust flips, 0 regressions, 0 variance** (15/15 rep-flips); Track-B full loop closed. Dev/eval tooling only — no binary impact.

3. **#2 hardening — real-corpus synthesis-quality audit** (`bun run eval:synthesis-audit`; `src/learning-layer/eval/synthesisAudit.ts`). Running the fixed synthesizer over a COPY of the user's real observation corpus (live corpus read-only) found that **where real data exists, synthesis yields useful instincts**: the one deep project (552 obs) produced **7 instincts at confidence 0.185–0.691, ~6/7 genuinely useful**, versus the broken baseline where real proposals were all prune-eligible (the old `0.04·ln(1+n)` curve cleared the 0.3 floor only at n≈2048). Two caveats: **(a) corpus depth gates the payoff** — only one project currently has real depth (the rest are thin eval/soak scratch dirs); **(b) the deterministic cluster keys are coarse** — the synthesizer LLM, not the keys, carries the specificity. Dev tooling only — no binary impact.

## What this snapshot is

The **first phase of the learning-loop spike** — a real phase, not a hardening run. It **closes the open learning loop** on this harness behind a portable four-port contract (per ADR H-0010 in `sovereign-ai-docs`), and proves via an eval that a lesson available in session N changes behavior in session N+1 with **no human in the loop**.

Authoritative implementation docs in this repo:
- **Spec:** [`docs/specs/2026-06-03-portable-learning-layer-adapter-1-design.md`](../specs/2026-06-03-portable-learning-layer-adapter-1-design.md) (decisions D1–D15)
- **Plan:** [`docs/plans/2026-06-03-learning-loop-spike-phase-1.md`](../plans/2026-06-03-learning-loop-spike-phase-1.md) (T1–T19)
- **Kickoff:** [`docs/plans/2026-06-03-learning-loop-spike-kickoff.md`](../plans/2026-06-03-learning-loop-spike-kickoff.md)

The roadmap + decision record stay canonical in `sovereign-ai-docs`; this repo owns the code and the implementation docs.

## What shipped

1. **New sealed module `src/learning-layer/`** depending only on its own four-port contract:
   - `ports.ts` — the four ports (**Observe** / **Recall** / **Reason** / **Persist**) + shared `readonly` types. The only file host code imports from the layer.
   - `index.ts` — `createLearningLayer(deps)` wiring Recall over the host-provided ports.
   - `recall/` — pure machinery: `assemble.ts` (trigger-overlap match → confidence sort → token budget), `format.ts` (the fenced `<learned-context>` snapshot), `readInstincts.ts` (Persist-backed reader sharing a pure serde — `src/learning/instinctSerde.ts` — with the synchronous `InstinctStore`).
   - `adapters/harness/` — the only host-specific code (adapter #1): `persistFs.ts` (FS `PersistPort` over `$HARNESS_HOME` using `src/learning/paths.ts` layout) + `reasonProvider.ts` (thin provider-backed `ReasonPort`; defined + unit-tested, **not** yet load-bearing).
   - `eval/` — `score.ts` (pure flip + efficiency scorer), `runner.ts` (paired-arm runner over the semantic driver), `scenarios/index.ts` + `trackB.ts` + `trackBCorpus.ts`.
   - Portability is by construction (the adapter is the only host-coupled file); the full isolation gates are Phase 2.

2. **Recall closed — the missing link.** Deterministic instinct assembly (trigger-overlap match → confidence sort → token budget) → fenced `<learned-context>` snapshot → spliced into the latest user message in `src/core/query.ts` immediately after the MEMORY.md injection (same pattern, via `src/core/recallInjection.ts`). `query()` stays project-agnostic: recall is a bound thunk (`RecallTurn` on `QueryParams`) built per session in `src/server/sessionContext.ts`. Gated by `learning.recall.enabled` (default FALSE). The turns route (`src/server/routes/turns.ts`) passes the recall thunk + `memoryManager` into `query()`.

3. **D6 latent-bug fix.** The server turns route previously omitted `memoryManager`, so MEMORY.md never injected on the server/TUI surface (only CLI paths). Now fixed — memory injects on the default surface too. Side-effect-safe: the builtin memory provider's `syncTurn` is a no-op, so only the read/injection path activates.

4. **Synthesis-yield fix** (was 185 trajectories → 2 instincts):
   - **Saturating confidence curve** `confidenceFromEvidence(n)` = `cap · (1 − e^(−n/τ))`, τ default 13 (`src/learning/confidence.ts`). ~6 obs clears the 0.3 prune floor; ~20 clears the 0.7 promotion gate (the old log curve needed ~40M). Routed through propose/update.
   - **Normalized cluster keys** (`src/learning/cluster.ts`) — paths/numbers/quoted strings → placeholders so same-tool/different-arg observations co-cluster.
   - **End-of-session synthesis** trigger (`learning.synthesizeOnSessionEndAfter`, default 10) in `ReviewManager`; fail-loud synthesizer (`src/learning/synthesizer.ts` surfaces an assertable status instead of swallowing); softened the "producing zero is valid" framing + raised the `instinct-synthesizer` agent `maxTurns` 8 → 16.

5. **Project-id fix.** Recall reads `getProjectId(cwd).id` (matching the observer/synthesizer WRITE path) instead of the memory-scoper's id, so project-scoped synthesized instincts are recallable under any bundle (the same id also reaches the `_global` corpus).

6. **The eval (`bun run eval:learning`)** — with-vs-without correctness-flip eval. **Track A:** 5 curated, non-derivable scenarios with seeded instincts (the Q1 gate). **Track B:** the full loop end-to-end (session N observations → real synthesis → instinct → session N+1 recall). Plus a deterministic MockProvider wiring proof (`tests/server/turns.recall.test.ts`) and a CI-visible semantic suite (`tests/semantic/suites/24-learning-recall.cases.ts`).

7. **Config additions** — `learning.recall.{enabled,maxLessons,tokenBudget}` (defaults `false` / `8` / `1200`), `learning.evidenceSaturation`, `learning.synthesizeOnSessionEndAfter`; new `'instinct'` context-budget `ComponentKind`.

8. **Test counts** — see below.

## Q1 verdict — PASS

**Q1: does the loop work — does a lesson change later behavior on its own?** **PASS — 6 flips / 0 regressions, live, with no human in the loop** (`bun run eval:learning`; binary `sov` 0.6.14; judge `claude` CLI; agent `claude-sonnet-4-6`).

```
Scenario                         without  with   flip  regression  Δtools
-------------------------------- -------  ----   ----  ----------  ------
unusual-test-command             fail    PASS   yes   no          +2
handler-directory-convention     fail    PASS   yes   no          -2
migrate-safe-flag                fail    PASS   yes   no          +2
build-no-cache-flag              fail    PASS   yes   no          +1
deploy-target-region             fail    PASS   yes   no          +2
project-check-strict-flag        fail    PASS   yes   no          +2

summary: 6 scenarios, 6 flips, 0 regressions (need >= 3 flips, 0 regressions).
RESULT: PASS
```

Track B (full loop) closes end-to-end: 13 observations → real synthesis → 2 instincts → N+1 recall flip YES. The deterministic wiring proof (`tests/server/turns.recall.test.ts`) confirms the recall snapshot reaches the provider request and changes scripted tool calls vs. recall-off — independent of LLM variance.

## Tests

- **TS suite ~2708 pass / 14 skip / 3 fail.** The 3 failures are the known **env-only** learning-observer integration tests (`turns.learning` M7 T5 / `m7Full` / `m8Full`) that trip on this machine's ambient `~/.harness/config.json` (`learning.disabled`); they pass in CI and on a clean `HARNESS_HOME`. Documented in `CLAUDE.md`/MEMORY. Gate criterion: "no new failures beyond that known set." (Grew from the post-M2 ~2660 baseline, from the learning-layer port/recall/serde/cluster/confidence/eval-scorer unit tests + the deterministic wiring test.)
- **Eval** — `bun run eval:learning` → **Q1 PASS** (table above).
- **Go suite** — unchanged by this phase (no `packages/tui/` change).

## New module layout

```
src/learning-layer/
  ports.ts                         four-port contract + shared readonly types
  index.ts                         createLearningLayer (Observe + Recall)
  recall/
    assemble.ts                    relevance match · confidence sort · budget
    format.ts                      fenced <learned-context> snapshot
    readInstincts.ts               Persist-backed instinct reader
  adapters/harness/                adapter #1 (the only host-coupled code)
    persistFs.ts                   FS PersistPort over $HARNESS_HOME
    reasonProvider.ts              thin provider-backed ReasonPort (seam)
  eval/
    score.ts                       correctness-flip + efficiency scorer
    runner.ts                      paired-arm (with/without) runner
    scenarios/index.ts             Track-A curated scenarios
    trackB.ts                      Track-B full-loop synthesis→recall
    trackBCorpus.ts                Track-B observation corpus
```

Host-side additions: `src/core/recallInjection.ts` (the splice), `src/learning/instinctSerde.ts` (pure serde extracted from `InstinctStore`), `confidenceFromEvidence` in `src/learning/confidence.ts`.

## Deferred to Phase 2 (NOT done, by design)

- The **mock-host isolation suite** + the **four portability acceptance gates** (portability is currently by construction, not mechanically enforced).
- **Full Persist extraction** — `observations.jsonl` + the trajectory writers behind `PersistPort` (Phase 1 added only a Persist-backed *reader* for Recall; `InstinctStore` stays synchronous, sharing the pure serde).
- **Migrating the synthesizer onto the Reason port** (the seam is defined + tested but not yet load-bearing — D8).
- **Adapter #2** — a rented-engine binding.
- **Recall on the other surfaces** — `agentRunner` / `missionRun` / the OpenAI HTTP route. Phase 1 wired the turns route only.

## Founder-reserved (NOT decided)

- Which **rented engine** for Phase 2.
- The **go/no-go** after Phase 1.
- Whether learned memory/skills **auto-promote** by default.
- Whether **`learning.recall.enabled`** flips to true by default (gated on Q1 PASS + go/no-go).

## Releases

- **v0.6.14** was cut mid-build — it carries the D6 memory fix + the inert recall scaffolding (recall off by default, so behavior unchanged on the shipped binary).
- The **completed feature** (closed loop + yield fix + eval) releases as the next patch in a separate close-out step — deliberately NOT cut here.

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. Per the kickoff "Keeping the record straight" and spec §7, a docs-repo session should update, to reflect **Q1 PASS**:

- the **canonical spike spec's Phase-1 `Status:`** line;
- the **`learning-loop-closure-and-proof` open-question** (Q1 answered: the loop works on adapter #1);
- the **dev status page** in `sovereign-ai-docs`.

## Notes

- **No new ADRs in this repo** — the layer is built per ADR H-0010 (canonical in `sovereign-ai-docs`); all implementation decisions are captured in the spec (D1–D15) + the plan (T1–T19) + commit messages.
- **No bundle changes** beyond `bundle-default/agents/instinct-synthesizer.md` (softened zero-bias framing + `maxTurns` 8 → 16) — the synthesis-yield fix.
- The 24 spike commits run `ecf6859..bb0cb78`.
