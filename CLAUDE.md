# Instructions for Claude Code sessions developing this repo

You are working on the **Sovereign AI agent runtime** — TypeScript code, not documents. This repo is a Claude-Code-style harness (per ADR H-0003 in the sister `sovereign-ai-docs` repo) that reads a *harness bundle* (the docs repo, or a client's extracted bundle) and drives an LLM conversation against it.

If you need business context (what Sovereign AI is, what the harness does, why), read it in `~/code/sovereign-ai-docs/` — do not re-learn it here. This repo contains code and code conventions only.

## Session boot (minimal — this is a code repo)

1. This file.
2. `README.md`.
3. `docs/state-of-build-2026-05-07.md` — **most recent close-out snapshot.** Read this BEFORE the build plan to know what shipped, what's open in the backlog, and where to start. Replaced each session.
4. `docs/post-phase-13-4-backlog.md` — open backlog items not in the canonical build plan. Smaller follow-ups, polish, deferred trade-offs.
5. `~/code/sovereign-ai-docs/harness/docs/runtime/runtime-scaffold-plan.md` — the Phase-0/1 scaffold contract this repo was seeded against.
6. `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — the canonical remaining phased plan.
7. `~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md` — unifying design principles and Claude Code reference lessons.
8. `~/code/claude-code/src/` — the architectural reference. Look up specific patterns there when a design question comes up.

## Tech stack

- **Runtime:** Bun.
- **Language:** TypeScript, strict mode.
- **Testing:** Bun's built-in test runner.
- **Lint / format:** Biome.
- **Style:** structurally mirrors `~/code/claude-code/` where sensible — look up the reference when in doubt about a pattern.

## Design principles — don't relitigate

Per ADR H-0003 and the docs-repo planning/reference documents, these are locked:

1. **Async-generator turn loop.** `async function* query(): AsyncGenerator<StreamEvent | Message, Terminal>` from day one. Never collapse to Promise-returning.
2. **Content-block internal messages.** `Message` carries an array of `ContentBlock`s (text / thinking / tool_use / tool_result / image). Providers translate at the boundary.
3. **Fail-closed tool defaults.** `buildTool()` spreads defaults first, user overrides last. `isConcurrencySafe` and `isReadOnly` default to `false`.
4. **Per-invocation concurrency.** `isConcurrencySafe(input)` takes the actual arguments, not a class-level flag.
5. **Permissions are transformable.** `checkPermissions` returns `{ behavior, updatedInput?, reason? }` — rules can normalise input, not just gate it.
6. **Segmented cacheable system prompts.** Static to dynamic, ephemeral cache marker at the boundary.
7. **Uniform Tool interface.** MCP tools, sub-agents, native tools, skill invocations — all flow through the same pipe.
8. **Sub-agents are recursion.** An `AgentTool` calls `query()` with a filtered context. No parallel execution engine.
9. **Bundle-as-data contract.** Runtime reads `<bundle>/business/` + `<bundle>/harness/schemas/`, writes `<bundle>/state/`. Never writes to tier-1 or tier-2 content.

When in doubt, read the corresponding section in `~/code/sovereign-ai-docs/harness/docs/reference/agent-harness-design-lessons.md`.

## Repo conventions

- Every tool uses `buildTool()`. No ad-hoc `{ name, call, ... }` objects.
- Every provider implements the `LLMProvider` interface. Don't call provider SDKs from outside `src/providers/`.
- Every `.ts` file has a short header comment naming its one responsibility.
- `.js` extensions in import paths (Bun convention, matches Claude Code).
- Empty directories under `src/` are phase landing zones. Do not delete them.
- No product-specific hardcoding in `src/` — Sovereign-AI-specific content belongs in the bundle. The runtime is supposed to be deployable verbatim to any client.

## Phases — where we are

Phases 0 through 10 complete (2026-04-26). Phase 10.5b–e (REPL polish) complete (2026-05-03). Phase 11 (shell hooks) and Phase 12 (MCP client + deferred tool loading) complete (2026-05-03). Phase 9.6 (skill trigger rigor), Phase 12.5 (tool observation envelope), Phase 12.6 (context budget audit + `/context-budget`), Phase 13.1 (trajectory capture — the Sovereign moat), Phase 10.7 (profile system), Phase 10.5 part 1 (operational traces + `sov trace show` + multi-heuristic loop detection), and Phase 10.6 part 1 (local-model router) shipped 2026-05-04. Phase 10.5 part 2 (2a + 2b-i + 2b-ii + 2c), Phase 10.6 part 2a (router polish), Phase 10.6 part 2b interactive `ask` mode, eval-runner `--capture` / `--replay` CLI, and Phase 10.8 (default bundle + `sov init`) all shipped 2026-05-05. **Phase 10 lane fully closed (2026-05-05).** Defense-in-depth secret redactor + `/security-audit` skill shipped 2026-05-05. **Phase 13 (sub-agent runtime + AgentTool) shipped 2026-05-05** — agent definition loader (markdown + frontmatter, three search paths), three initial reference agents in `bundle-default/agents/` (explore / verify / plan), capability profile table for `role: <kind>` resolution, AgentRunner extraction, Semaphore + LaneSemaphores primitives, SubagentScheduler with per-parent child cap + per-lane caps + global write-path lock + cancellation chaining, AgentTool with `subagent_type` enum patched at tool-pool assembly time, global subagent exclusion set, and `on_delegation` hook firing after successful child completion. Per-lane semaphore + capability profile lookup (formerly Phase 10.6 part 2b deferred-because-premature) landed here as build items 4 and 10. **Phase 13.2 (task system for parallel workers) shipped 2026-05-06** — schema v4 `tasks` table colocated with `sessions`, `TaskStore` sharing the SessionDb handle, `TaskManager` wrapping `SubagentScheduler` with fire-and-forget delegation + terminal-reason → TaskState mapping (`interrupted` splits into `cancelled` vs `timed_out` on `userAborted`), five tools (`task_create` / `task_list` / `task_get` / `task_stop` / `task_output`) registered in the assembled pool with `subagent_type` enum patching now generalized across `AgentTool` + `task_create`, and a `/tasks [all|show <id>|stop <id>]` slash command. `task_stop` is in the global subagent exclusion set so children cannot interfere with parent control. Semantic test suite at 13.2 close was 43/43; unit suite was 1384/1384. See [`~/code/sovereign-ai-docs/harness/docs/runtime/phase-10x-status.md`](~/code/sovereign-ai-docs/harness/docs/runtime/phase-10x-status.md) for the full 10.x scoreboard.

**Phase 13.3 (background review daemon) shipped + closed 2026-05-06** — review-fork factory + ReviewManager with counter-driven triggers (memory every N user turns, skill every M tool iterations, plus on_delegation distillation), three reference agents (`review-memory`, `review-skill`, `review-consolidate`) in `bundle-default/agents/` with restricted toolsets, two new tools (`memory_propose` / `skill_propose`) writing to `$HARNESS_HOME/review/pending/{memory,skills}/` with full provenance frontmatter (sessionId, traceId, sourceHash, sourceExcerpt, message-range), `/review [list|show|approve|reject|consolidate|activity]` slash command for the propose-then-promote lifecycle, memory consolidation pass via `src/review/consolidate.ts` + `review-consolidate` agent, stall/no-op detection via `src/review/stall.ts` with 3-turn sliding window emitting `stall_detected` trace events, per-settings `review.{autoPromoteMemory,autoPromoteSkills,userTurnsForMemoryReview,toolIterationsForSkillReview,childReviewEveryN,minIntervalMs,disabled}` opt-ins (default human-gated). Recursion guard in scheduler skips `onChildCompletion` for review-* agents. REVIEW_ONLY_TOOLS pool-separation hard-enforces `memory_propose`/`skill_propose` exclusion from the main agent's pool (~530 tokens freed). Close-out items (commits ec21277–e516a43): A1 throttle on `onChildCompletion`, A2 REVIEW_ONLY_TOOLS hard pool-separation, A3 temporal lockout for back-to-back dispatches, B1 `childSessionId` injection into parent trace events, B2 stock-bundle trajectory routing to `harnessHome`, B3 review activity surfaced in goodbye + `/review activity` verb, B4 cancel in-flight reviews on `session_end`, round-2 follow-up fixes (TraceWriter parent sessionId, ReviewManager signal-aborted guards, `/review activity` phantom filter), phantom DB cleanup, C2 auto-promote provenance preservation. Semantic suite is 54/54; unit suite is 1490/1490.

**Phase 13.4 (continuous-learning observation stream + instinct corpus) shipped 2026-05-06** — `LearningObserver` writes per-tool-call observations to `$HARNESS_HOME/learning/<projectId>/observations.jsonl` async fire-and-forget; `instinct-synthesizer` sub-agent (bundled, restricted toolset) clusters observations into atomic confidence-weighted instincts; four instinct tools (`instinct_list / instinct_view / instinct_propose / instinct_update_confidence`) live in a separate `LEARNING_ONLY_TOOLS` pool — main agent never sees them; review fork now reads the instinct corpus as preferred input over raw trajectory slices; cross-project promotion logic gates global instincts behind Phase 13.3's `/review approve`; `harness learning {status / prune / export}` CLI subcommands for read-only inspection + sub-threshold aging-out via the pure `shouldPrune()` helper. Semantic suite is 58/58; unit suite is 1583/1583.

**Post-Phase-13.4 backlog burn (2026-05-06 → 2026-05-07).** 20 of 24 backlog items closed across seven batches via subagent-driven dispatch. All P0 / P1 / P2 closed. Highlights from 2026-05-07: Item 8 (per-child trace files, `1001237`), Item 10 (synthesizer fires on tool-iteration burst rhythm, `a8d4ce3`), Item 11 (multi-process observation append verified safe, `8e86e61`), Item 7 (skill-shaped child triage fires `review-skill` alongside `review-memory`, `2df9da7`), and Item 19 (two-tier MEMORY.md — global + per-project routed via `MemoryTool.scope` arg, 5 commits `db967ed` → `07cb263`). Suite at master `4789de7` is **1716/1716 unit + 58/58 semantic**. 4 backlog items remain open (12, 13, 17, 24) — all P3+, each warrants a focused session. See `docs/state-of-build-2026-05-07.md` for the full close-out snapshot and `docs/post-phase-13-4-backlog.md` for backlog detail.

**Next high-leverage targets** per the build plan: **Phase 13.5** (scheduled-mission sub-agents — file-contract + loader/writer + `--state-dir` flag for overnight autonomous missions) — independently shippable; doesn't depend on Phase 13.4. Phase 13.3 (background review daemon) and Phase 13.4 (instinct corpus) shipped 2026-05-06. Do not start any of these phases unless explicitly requested. See `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` for per-phase deliverables; `runtime-scaffold-plan.md` covers the Phase-0 layout that this repo was seeded against.

Each phase should:
- Add one new abstraction or capability.
- Keep the harness running end-to-end throughout (no broken-for-three-days refactors).
- Exercise the new thing in a real scenario before the phase closes.
- Record design choices in `DECISIONS.md` (add when first non-trivial choice comes up).

## Lint before committing

Run `bun run lint`, `bun run typecheck`, and `bun run test` before every commit. All three must pass. Commit atomically — one logical change per commit. This matches the rule in `sovereign-ai-docs/CLAUDE.md`.

(Why all three: `bun run lint` runs Biome which catches style/format issues but does NOT do TypeScript type-checking. `bun run typecheck` runs `tsc --noEmit` and catches things like wrong-scope identifiers and `exactOptionalPropertyTypes` violations that would slip through Biome + Bun's runtime test executor — Bun runs JS-style and doesn't enforce types at test time. Skipping typecheck is how the `settings is not defined` runtime bug in 2026-05-05's Phase 13 commits made it to master.)

## Semantic test suite — when to run, when to extend

`bun run test:semantic` is opt-in (~5 min wall, ~$0.87 informational on subscription). Apply this triage:

- **Doc-only / formatting:** skip
- **Touching one specific surface** (single tool, single slash command, single permission rule path, single context surface): run the matching filter — `bun run test:semantic -- --filter <id-or-substring>`
- **Touching `src/core/query.ts`, `src/providers/`, `src/agent/sessionDb.ts` schema, or `src/permissions/canUseTool.ts`:** run the full suite
- **Before pushing a substantive feature batch to master:** run the full suite
- **Phase completion gate:** run the full suite + log it in `docs/testing-log-2026-04-27.md`

When in doubt, run the full suite — five minutes and a dollar of subscription value is cheap insurance.

Add a new semantic test when shipping: a new tool, a new slash command, a new permission rule path, a new context surface, or fixing a bug that should never regress. At phase completion, audit user-visible behaviors and ensure each has at least one case.

**When you change `tests/semantic/suites/`, update [`docs/semantic-testing.md`](docs/semantic-testing.md) in the same commit** — coverage inventory, headline count, and the run-policy mapping table all must stay in sync with reality. If they drift, the triage policy lies.

Full mapping table (changed area → filter) and extension rules: [`docs/semantic-testing.md#when-to-run-and-when-to-extend`](docs/semantic-testing.md#when-to-run-and-when-to-extend).

## Testing log

Append an entry to `docs/testing-log-2026-04-27.md` whenever harness testing is performed, whether automated (`bun run test`, lint/typecheck gates, targeted unit tests) or semantic/manual (CLI checks, REPL smoke tests, provider/tool behavior checks). Record the scope, environment, commands, manual coverage, result, and any regressions or follow-ups.

## Commit and push

Same rule as the docs repo: autonomous add / commit / push after every working change. Push target is `origin/master` once the remote is configured.

## Keep the global `sov` binary in sync

After pushing changes that affect the runtime (anything under `src/` or `bundle-default/`), run `sov upgrade` so the global `sov` binary picks up the new master. The user's `sov` is a Path A install (`bun install -g git+ssh://…`) — a cached copy under `~/.bun/install/global/`, NOT a live symlink to this working tree. Without the upgrade step the user keeps running the previous SHA and any test the user runs against `sov` will hit stale code. As of 2026-05-05, `sov upgrade` defaults to wiping Bun's install cache, so it reliably installs latest master in one shot.

Skip the upgrade only when the changes are confined to `tests/`, `docs/`, or other non-runtime paths — those don't affect the binary.

When in doubt, run it. The cost is ~5–10 seconds; the cost of a stale binary is the user thinking they're testing your fix when they're actually testing the previous version.
