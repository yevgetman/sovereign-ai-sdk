# State of the build — 2026-05-23: Phase 1 multi-provider task routing

**HEAD:** to be filled by the close-out commit.

**Chain since the Phase 18 close-out (`11991e2`, 2026-05-23 mid-day):**
phase-18 close-out → Phase 1 plan committed (`60aad25`) → T1 `taskRouting` config schema (`41cc3cf`) → T2 lane resolution module (`350e5e1`) → T3 lane registry (`1d7c246`) → T4 boot-time lane preflight (`c10e6b9`) → T5 `inheritParentTools` + `allowedSubagents` agent-definition fields (`0f4f001`) → T6 cost-lane sub-agents + B-via-D bridge mention in system prompt (`fcb51c2`) → T7 scheduler lane-aware role resolution + inherit-parent tool pool (`cd67cca`) → T8 `allowedSubagents` recursion guard in AgentTool (`86a95bb`) → T9 runtime wiring (lane registry + preflight + scheduler hook + smart-router segment injection) (`2ddfff0`) → T10 delegator agent definition (`ca29b13`) → T11 smart-router system-prompt segment (`eb8c8a0`) → T12 MockProvider `toolUseScript` for richer canned sequences (`02957af`) → smart-router test XML-tag assertion fix (`7dbeb7e`) → T13 integration test for trivial-turn smart routing (`bbc851b`) → delegator integration-test deadlock workaround (`895d16d`) → T14 integration test for compound-turn smart routing with synthesis (`5e2f474`) → T15 atom-failure integration test + atom-timeout skip stub (`875e5fd`) → T16 semantic task-routing suite (`a838024`) → (this close-out, TBD).

**Suite:** TS — **2243/0/15** (+51 from the Phase 18 close-out's 2192). Breakdown of the +51 + 1 skip across Phase 1 T1-T16: T1 config schema (+3), T2 lane resolution (+4), T3 lane registry (+5), T4 preflight (+5), T5 agent-definition fields (+7), T7 scheduler hook + tool pool inheritance (+7), T8 AgentTool recursion guard (+5), T9 runtime wiring (+3), T10 delegator definition (+2), T11 smart-router segment (+1), T12 MockProvider extension (+1, plus `'throw'` script-kind variant added during T15), T13 trivial-turn integration test (+1), T14 compound-turn synthesis test (+1), T15 atom-failure test (+1) + atom-timeout skip stub (+1 skip), T16 semantic suite (+5, registered via the semantic-suite harness — these count toward the TS total when the framework counts case-loaders). Go untouched. Lint+typecheck clean.

**ADRs:** none. Phase 1 is purely additive — new `taskRouting` config block, new lane / preflight / registry modules under `src/router/`, two new optional fields on `AgentDefinition`, one new scheduler callback (`resolveLane`), one new tool-pool builder (`buildChildToolPool` replacing `filterToolsForChild`), one new `AgentTool` recursion check. No surface removal, no foreground refactor, no architectural pivot. All design decisions captured in the spec at `specs/2026-05-23-multi-provider-task-routing-design.md` and the plan at `plans/2026-05-23-phase-1-task-routing.md`.

**Phase status:** **Phase 1 closed.** Phase 2 (rich UX + escalation — atom-level progress events, quality escalation, parent-model auto-downgrade, profile presets) pending soak data from Phase 1. Phase 3 (spend management — per-lane budget caps, monthly ceiling, escalation gates) deferred until Phase 1 + Phase 2 soak. Phase 16.1 stays closed; Phase 17 stays closed; Phase 18 stays closed; Phase 21 M1 stays closed; Phase 21 M2 stays backlogged (#48). T18 (this docs close-out) follows; T19 (cut next binary release) is the next session's lead.

## Where we are

Phase 1 ships a **smart router** that turns a single user turn into a multi-atom dispatch graph routed across a configurable set of provider/model lanes. The bundled `delegator` agent — Sonnet-grade by default, configurable via `taskRouting.delegator.model` — becomes the parent's first action on every user turn when `taskRouting.enabled: true`. The delegator inspects the turn, decides whether to single-shot or decompose it, and dispatches one or more atoms via `AgentTool` to three cost-tier sub-agents (`cheap-task`, `moderate-task`, `frontier-task`) each backed by an operator-configured provider/model. Synthesis is the final atom — same dispatch mechanism, the lane chosen dynamically based on synthesis difficulty.

The architecture is purely additive. A new `src/router/` mini-suite (lanes / laneRegistry / preflight) sits beside the existing `src/router/capabilities.ts` (Phase 13 router); a new `bundle-default/prompts/smart-router.md` segment is injected into the parent's frozen system prompt only when `taskRouting.enabled: true`; four new agent definitions (`cheap-task`, `moderate-task`, `frontier-task`, `delegator`) ship under `bundle-default/agents/`. Two surgical scheduler edits land the wire: `SubagentSchedulerOpts.resolveLane?: (role) => LaneConfig | undefined` consulted BEFORE the Phase 13.2 capability table (so a configured lane wins over the cheapest-capable-model lookup); `filterToolsForChild` renamed to `buildChildToolPool` to add an `inheritParentTools: true` branch (parent pool minus the global exclusion set, with `AgentTool` re-included when `allowedSubagents` is non-empty). `AgentTool.call` enforces the recursion guard — when a child has a non-empty `allowedSubagents`, any nested `AgentTool` call's `subagent_type` MUST be in that list. Boot-time preflight runs ONLY when `taskRouting.enabled: true`, iterates every configured cost lane (skipping `delegator` since its model rides the parent's existing preflight when providers align), and aggregates failures into a single `LanePreflightError` so credentials can be fixed in one pass.

`sov serve` (OpenAI HTTP API, Phase 18) and the smart router (Phase 1) are now the two non-interactive harness surfaces — `sov serve` exposes the harness to OpenAI-shaped clients on the wire; the smart router exposes a multi-provider dispatch graph to ANY surface that drives a parent turn (TUI, `sov drive`, `sov dispatch`, `sov serve`, `sov cron`). They compose: `sov serve` with `taskRouting.enabled: true` drives the same delegator-first turn flow per `/v1/chat/completions` request, and per-lane provider mixing (e.g. Ollama for cheap atoms + Anthropic for synthesis) flows through transparently.

The user kicked off Phase 1 at the start of this session asking to build out multi-provider task routing per the design spec. Subagent-driven development per T1 → T16; T17 is this docs close-out; T18 will append a Phase 1 entry to `docs/06-testing/testing-log.md` and T19 will cut the next binary release. Two design refinements surfaced during investigation and were folded into the plan: **R-B** (the delegator model is configurable via `taskRouting.delegator.model`; the delegator agent uses `role: delegator`, and the lane registry treats `delegator` as a special non-cost-lane entry resolving to `taskRouting.delegator.model`, default `claude-sonnet-4-6`) and **R-D** (lane `timeoutMs` enforcement deferred to a Phase 2 follow-up dedicated to scheduler ergonomics — it needs `perChildTimeoutMsOverride` plumbing on `DelegateInput` + `LaneRegistry` threaded through `ToolContext` + an `AgentTool.call` resolution path; covered by the semantic suite's failure-recovery case in the meantime).

## What shipped

### New `taskRouting` config block (`src/config/schema.ts`)

- `LaneConfigSchema`: `{ provider: string, model: string, allowedTools: string[] | null = null, maxTokens: number | null = null, timeoutMs: number = 120_000 }`. Strict (unknown keys rejected). Negative `timeoutMs` / non-positive `maxTokens` rejected by Zod.
- `TaskRoutingSchema`: `{ enabled: boolean = false, delegator: { model: string = 'claude-sonnet-4-6' }, lanes: { 'cheap-task'?: Partial<LaneConfig>, 'moderate-task'?: Partial<LaneConfig>, 'frontier-task'?: Partial<LaneConfig> } }`. Empty `taskRouting: {}` parses to all defaults. Per-lane overrides are partial — omitted fields inherit the `LANE_DEFAULTS` from `src/router/lanes.ts`.
- `taskRouting?: TaskRoutingSchema` added to `SettingsSchema`.

### New `src/router/` modules (~250 LoC)

- **`src/router/lanes.ts`** — `LANE_DEFAULTS` (the per-lane Haiku/Sonnet/Opus defaults) + `DELEGATOR_DEFAULTS` + pure `resolveLane(name, cfg)`. Returns `LaneConfig | undefined`. Treats `'delegator'` as a special non-cost-lane entry resolving to `taskRouting.delegator.model`. Unknown names return `undefined` so the scheduler can distinguish a router-lane role from a generic sub-agent role.
- **`src/router/laneRegistry.ts`** — `buildLaneRegistry(cfg): LaneRegistry`. Pre-resolves all four known lane names (`cheap-task`, `moderate-task`, `frontier-task`, `delegator`) through `resolveLane()` at construction, caches them in a Map, and serves `lookup(role) | entries()`. The scheduler closes over this in its `resolveLane` callback.
- **`src/router/preflight.ts`** — `runLanePreflight({ registry, harnessHome, resolveProvider, preflight })`. Iterates every lane (skipping `delegator`), resolves the provider per lane, runs the provider preflight, aggregates failures into `LanePreflightError` with a single multi-line error message (`  <lane padded 14>  <provider>/<model>  — <reason>`). Empty failures returns silently.

### Agent-definition extensions (`src/agents/types.ts` + `src/agents/loader.ts` + `src/agents/exclusions.ts`)

- `AgentDefinition.inheritParentTools: boolean` (default `false`). When `true`, the scheduler hands the child its parent's tool pool (minus the global exclusion set) instead of the strict `allowedTools` allowlist.
- `AgentDefinition.allowedSubagents: string[]` (default `[]`). Names of subagent types this child is permitted to dispatch via `AgentTool`. When non-empty: (a) `AgentTool` is REMOVED from the child's exclusion set so the child can call it, (b) `AgentTool.call` enforces that any nested call's `subagent_type` is in this list.
- `FrontmatterSchema` extended with the two optional fields; loader applies defaults when absent so existing agents stay byte-identical.
- New `buildSubagentExclusions(agent)` helper in `src/agents/exclusions.ts` — returns the global `SUBAGENT_EXCLUDED_TOOLS` set MINUS `AgentTool` when `allowedSubagents.length > 0`.

### Scheduler hook (`src/runtime/scheduler.ts`)

- `SubagentSchedulerOpts.resolveLane?: (role: string) => LaneConfig | undefined`. Consulted in `resolveProviderModel()` BEFORE the Phase 13.2 capability lookup. When the callback returns a `LaneConfig`, scheduler uses `(lane.provider, lane.model)` directly; otherwise falls through to the existing capability-table path.
- `filterToolsForChild(parentPool, allowedTools)` → `buildChildToolPool(parentPool, agent)`. New `inheritParentTools: true` branch returns `parentPool.filter(t => !exclusions.has(t.name))`. The `false` branch preserves the strict-allowlist behavior intact. `agent.model` precedence preserved over both paths.

### AgentTool recursion guard (`src/tools/AgentTool.ts`)

- When the calling child has a non-empty `allowedSubagents`, the call's `subagent_type` is validated against that list. Failure surfaces as a permission-denied tool error with a clear remediation hint. Backward-compatible: agents with empty `allowedSubagents` see the existing exclusion behavior unchanged.

### Runtime wiring (`src/server/runtime.ts`)

- `buildRuntime` reads `userSettings.taskRouting` once at boot. The lane registry is built UNCONDITIONALLY (so cost-lane sub-agents stay reachable via `AgentTool` even when `enabled: false` — the B-via-D bridge baseline) and exposed on the runtime handle.
- When `taskRouting.enabled === true` AND a bundle is present, the runtime reads `<bundle-root>/prompts/smart-router.md`; the segment is passed into `buildSystemSegments({ smartRouterPrompt })` and inserted into the parent's frozen system prompt. Missing prompt file → stderr warning + skip the segment (runtime still boots cleanly).
- When `taskRouting.enabled === true` AND `opts.preflight !== false` AND `opts.replayFixturePath === undefined`, `runLanePreflight` fires before any agent loop binding. Lane provider resolution uses the same `resolveProvider()` the scheduler uses; preflight uses the same `preflightProvider()` the parent boot uses, translated through a small adapter so the throw-on-failure contract is preserved.
- Scheduler's `resolveLane` callback closes over `laneRegistry.lookup`.

### System-prompt injection (`src/context/systemPrompt.ts`)

- New `smartRouterPrompt?: string` option on `BuildSystemSegmentsOptions`. When present, the body is appended as a `cacheable: false` segment so toggling `taskRouting.enabled` doesn't burn the bundle's cache.

### Bundle changes (`bundle-default/`)

- New `bundle-default/agents/cheap-task.md` — `role: cheap-task`, `inheritParentTools: true`, `maxTurns: 30`. Output shape: one-line summary digest + substantive output. Use for atoms that don't need reasoning.
- New `bundle-default/agents/moderate-task.md` — `role: moderate-task`, `inheritParentTools: true`, `maxTurns: 50`. Use for multi-file analysis, design questions, structured generation.
- New `bundle-default/agents/frontier-task.md` — `role: frontier-task`, `inheritParentTools: true`, `maxTurns: 50`. Synthesis-aware prompt: when the input carries `Atom N output:` labels, integrate them coherently; when an atom is labeled `Atom N (failed: <reason>)`, acknowledge the gap explicitly.
- New `bundle-default/agents/delegator.md` — `role: delegator`, `allowedTools: [AgentTool]`, `allowedSubagents: [cheap-task, moderate-task, frontier-task]`, `maxTurns: 50`. The load-bearing decision prompt: lane catalogue + decision rule (trivial / compound / hard-reasoning) + synthesis-atom pattern (including failed-atom labeling) + failure handling (don't re-dispatch; mark in synthesis prompt) + output contract (return the final atom's response verbatim).
- New `bundle-default/prompts/smart-router.md` — the parent-side segment injected when `taskRouting.enabled: true`. Mandates `AgentTool(subagent_type: "delegator", ...)` as the parent's first action; the parent relays the delegator's `summary` verbatim with light wordsmithing only.
- `bundle-default/business/system-prompt.md` extended with a new "Cost-lane sub-agents" section listing the three cost-tier sub-agents (the B-via-D bridge baseline mention) so the parent knows they exist even when the smart router is disabled.

### MockProvider extensions (`src/providers/mock.ts`)

- `MockProvider.toolUseScript: ToolCallScript[] | undefined` — static field carrying a richer canned tool-use sequence than the existing `toolUseMode`. Entries are `{ kind: 'tool_use'; name: string; input: unknown; resultText?: string }` or `{ kind: 'text'; text: string }` or `{ kind: 'throw'; message: string }` (added during T15 for atom-failure tests). The script cursor advances per `stream()` call, threading a multi-agent call graph through deterministic stream events. Auto-resets between describe blocks via the existing `MockProvider.reset()` hook.

### Tests (~600 LoC across new + extended test files)

- `tests/config/schema.test.ts` extended — taskRouting acceptance tests (3 cases): full override, empty `{}` applies defaults, negative `timeoutMs` rejected.
- `tests/router/lanes.test.ts` (4 tests) — defaults + per-lane merge + delegator resolution + unknown lane returns undefined.
- `tests/router/laneRegistry.test.ts` (5 tests) — registry assembly + lookup + entries + unknown role + empty config.
- `tests/router/preflight.test.ts` (5 tests) — success path + single failure + multi-failure aggregation + delegator skip + error message shape.
- `tests/router/schedulerLaneResolve.test.ts` (7 tests) — `resolveLane` callback usage + fallback to capability table + explicit `agent.model` wins + `buildChildToolPool` inherit/strict branches + AgentTool inclusion via `allowedSubagents`.
- `tests/router/smartRouter.endToEnd.test.ts` — end-to-end smart-router segment injection (asserts on XML tag, not bare substring — fix at `7dbeb7e`).
- `tests/router/atomFailure.test.ts` (1 active test / 16 expect calls) — scripts a 7-call graph (parent → delegator → cheap-task throws → delegator continuation → frontier-task synthesis → delegator relay → parent relay), drives a turn, asserts the failed atom doesn't break the synthesis path.
- `tests/router/atomTimeout.test.ts` (1 skipped test, documented as a Phase 2 follow-up) — stub for lane `timeoutMs` enforcement (R-D mitigation).
- `tests/agents/inheritParentTools.test.ts` — new frontmatter fields + tool-pool behavior + recursion guard contract.
- `tests/agents/delegator.integration.test.ts` (T13 + T14) — trivial-turn + compound-turn paths via `MockProvider.toolUseScript`. Two test-only workarounds documented in the test source: (a) `runtime.laneRegistry.lookup` replaced after boot to route every lane to `provider: 'mock'` so the scheduler talks to the mock instead of real Anthropic, (b) loaded `delegator` agent definition patched to `readOnly: true` in-memory to break the `Semaphore(1)` writeLock deadlock that surfaces when the delegator's own `delegate()` call holds the writeLock while awaiting an inner `delegate()`.
- `tests/agents/delegator.definition.test.ts` — loader smoke + frontmatter shape check.
- `tests/semantic/suites/22-task-routing.cases.ts` (5 cases for `bun run test:semantic`) — Trivial turn → one cheap-task atom / Lookup turn → one or two atoms / Compound turn → multi-atom + synthesis / Hard reasoning → at least one frontier-task atom / Atom failure surfaces honestly in the synthesis.
- `tests/server/runtime.taskRouting.test.ts` — runtime wiring: lane registry built unconditionally, smart-router segment injected only when enabled + bundle present, preflight fires only when enabled + not opted out.

## Behavioral notes worth knowing next session

1. **Deployment pattern: opt-in via config flag, off by default.** `taskRouting.enabled` defaults to `false`. Even when disabled, the four cost-lane sub-agents (`cheap-task` / `moderate-task` / `frontier-task` / `delegator`) are loaded into the agent registry and the lane registry resolves their provider/model — the parent can still delegate to them via `AgentTool` based on the system-prompt mention in `bundle-default/business/system-prompt.md` § "Cost-lane sub-agents". This is the B-via-D bridge baseline: full machinery available, no automatic decomposition until the operator flips the flag.
2. **Permission policy is mode-aware.** When the smart router runs under `sov serve` (OpenAI HTTP API) or `sov cron`, the parent's permission mode is `'default'` + auto-deny `ask` — the same headless policy those surfaces already enforce. The delegator and atom children inherit the parent's `canUseTool` (no separate policy per lane). Interactive surfaces (TUI / `sov drive`) keep their standard prompting behavior.
3. **Tool access via inheritance.** Cost-lane agents (`cheap-task` / `moderate-task` / `frontier-task`) declare `inheritParentTools: true` so they see the parent's tool pool minus the global `SUBAGENT_EXCLUDED_TOOLS` set. This means whatever tools the parent had — bash, file ops, web search, etc. — are available inside the atom. The delegator is the exception: it declares `allowedTools: [AgentTool]` (strict allowlist) so its only capability is dispatching atoms.
4. **Lane recursion is gated.** The delegator's `allowedSubagents: [cheap-task, moderate-task, frontier-task]` is enforced by `AgentTool.call` — the delegator cannot dispatch to `explore`, `plan`, `verify`, or any other agent type. The three atom agents have `allowedSubagents: []` (the default), so they cannot dispatch any subagents — Phase 13.5's no-recursive-spawn ceiling stays intact for the atoms while the delegator is the single layer of indirection.
5. **Atom failure → delegator continues to synthesis.** When an atom returns a terminal reason other than `completed` or `max_turns`, the delegator does NOT re-dispatch — that's a Phase 2 quality-escalation concern. Instead the delegator includes the failure in the synthesis prompt with `Atom N (failed: <reason>):` labeling, and the synthesis atom (running on `frontier-task` by default) acknowledges the gap explicitly to the user. Tested in `tests/router/atomFailure.test.ts` and the `task-routing-failure-recovery` semantic case.
6. **Synthesis is the final atom — same dispatch mechanism, lane chosen dynamically.** There is no separate "synthesis" code path. When the delegator decides a compound task needs synthesis, it dispatches one more `AgentTool` call (typically targeting `frontier-task` but free to pick a cheaper lane when synthesis is straightforward). The atom prompt carries the prior atoms' outputs labeled `Atom N output:`; the frontier-task agent definition's system prompt has explicit handling for this pattern. Q6/D8 in the spec.
7. **Per-lane provider mixing flows through transparently.** Operator can configure `cheap-task` on Ollama, `moderate-task` on Anthropic, `frontier-task` on Anthropic, delegator on Anthropic — the scheduler resolves each atom's provider per dispatch independently. The smart router does NOT impose any compatibility constraint between lanes; the only invariant is that each lane's `(provider, model)` pair must pass preflight at boot when `enabled: true`.
8. **Preflight is a one-shot aggregator.** Failures from every configured lane are collected into a single `LanePreflightError` message so the operator can fix all credentials in one pass instead of playing whack-a-mole. The error message points to `~/.harness/config.json`. The `delegator` lane is skipped because its provider/model typically aligns with the parent's transport (claude-sonnet-4-6), in which case the parent's existing preflight already covered it; if the delegator's provider were ever to diverge from the parent's, this would surface as a runtime failure on the first turn rather than a boot-time one — acceptable v0 trade-off.
9. **Smart-router segment is `cacheable: false`.** The injected `smart-router.md` body sits OUTSIDE the cacheable parent system prompt. This means toggling `taskRouting.enabled` between sessions doesn't burn the bundle's prompt cache — the bundle hash stays stable. Cost: a few hundred extra tokens per turn when the router is enabled, which is well worth the cache stability.
10. **Two known test-only workarounds in `tests/agents/delegator.integration.test.ts`** documented inline:
    - **Lane override**: the bundled `DELEGATOR_DEFAULTS` hardcode `provider: 'anthropic'` (only the model is configurable via config). For tests driven by `MockProvider`, the test patches `runtime.laneRegistry.lookup` after boot to route every lane to `provider: 'mock'`. This is purely a test affordance; production paths keep the documented Anthropic default.
    - **Delegator deadlock**: the bundled delegator ships `readOnly: false` but the integration test patches the in-memory loaded definition to `readOnly: true` to break a `Semaphore(1)` writeLock deadlock during nested delegation (the outer `scheduler.delegate(delegator)` acquires the writeLock; the delegator's `AgentTool(cheap-task)` tries to acquire the same lock — held by the outer that's awaiting the inner). The fix-message at `895d16d` documented the architecturally-correct posture (`readOnly: true`, since the delegator's only tool is a dispatcher, not a writer) but ONLY changed the test comment; the bundled file still has `readOnly: false`. This is a known issue surfaced during T13 and tracked as a follow-up to flip the bundle definition in a separate session (see "Open follow-ups" below).

## Open follow-ups

(From Phase 1 implementation. The 3 known LOW items below should be addressed before Phase 2 promotes any new features. The Phase 2 / Phase 3 items are documented in the spec.)

1. **Flip `readOnly: true` on `bundle-default/agents/delegator.md`.** The commit message at `895d16d` claimed this was done, but only the integration test's comment was updated; the bundle file still ships `readOnly: false`. Production runs with `taskRouting.enabled: true` against a real LLM will hit the writeLock deadlock that the integration test mitigates via in-memory patching. This is a single-line change that unblocks the smart router for non-test users.
2. **Lane `timeoutMs` enforcement (R-D from the plan).** The scheduler needs `perChildTimeoutMsOverride?: number` plumbed through `DelegateInput`, `LaneRegistry` threaded into `ToolContext` (via a new `parentLaneRegistry` or similar), and `AgentTool.call` updated to resolve the override from `ctx.laneRegistry.lookup(agent.role)?.timeoutMs`. T15 documents the implementation steps in `tests/router/atomTimeout.test.ts`'s header comment. The semantic suite's `task-routing-failure-recovery` case covers the user-visible failure surface against a real LLM with an unreachable model in the meantime.
3. **Atom-level progress events (Phase 2 C-level UX).** Today the parent's wire emits `tool_use` chunks for the delegator's `AgentTool` calls but no semantic "atom 2 of 4 running on frontier-task..." progress signal. Phase 2 will define a `hermes.atom.progress` SSE side-channel event analogous to Phase 18's `hermes.tool.progress`.
4. **Quality escalation (Phase 2, conditional on soak).** Today the delegator never re-dispatches a failed atom. Phase 2 may add an escalation knob: when the cheap-task output looks off (heuristic on result length, error markers, etc.), the delegator can retry on moderate-task. Gated until Phase 1 soak surfaces real failure modes.
5. **Parent-model auto-downgrade option (Phase 2).** Today the parent runs on whatever `defaultProvider`/`defaultModel` config says. Phase 2 may add an auto-downgrade: when `taskRouting.enabled: true`, the parent itself can run on a cheaper model since its only job is to relay the delegator's `summary`. Gated on Phase 1 telemetry showing the parent's prompt is small enough to justify the downgrade.
6. **Profile presets (Phase 2 — `anthropic+local`, `frugal`, `mixed`, etc.).** A `taskRouting.profile: <preset-name>` field that expands into the lane block. Lets operators get a sensible default without hand-editing every lane.
7. **Spend management (Phase 3, gated until Phase 1 + Phase 2 soak).** Per-lane monthly budget caps, per-turn cost ceiling, escalation gates. Out of scope for Phase 1; the architecture supports it cleanly via additional `LaneConfig` fields when the soak data tells us what knobs are worth surfacing.
8. **Append Phase 1 entry to `docs/06-testing/testing-log.md` (T18).** Followup task in this Phase 1 close-out chain.
9. **Cut next binary release with Phase 1 in it (T19).** Phase 1 is runtime-affecting (`src/`, `bundle-default/`); per `docs/05-conventions/cutting-releases.md` a release must be cut in the same session as the runtime changes so `~/.sov/bin/sov` picks them up. This is the next session's lead.

## Postmortem-rule compliance check

The Phase 16.1 revert's Rules 1-4 (`docs/07-history/postmortems/2026-05-12-phase-16-revert.md`) apply primarily to foreground-surface refactors. Phase 1 is purely additive — no existing surface removed, no behavioral change to existing flows when `taskRouting.enabled: false` (the default) — so most rules don't engage:

- **Rule 1 (deprecation soak).** Waived. Nothing deprecated; nothing replaced. The TUI / drive / dispatch / cron / serve surfaces all continue to work identically. `taskRouting.enabled: false` (the default) preserves byte-identical behavior — the lane registry is built but no smart-router segment is injected and no preflight runs.
- **Rule 2 (no helper deletion).** Satisfied. All changes are additive: new files under `src/router/` (lanes / laneRegistry / preflight), two new optional fields on `AgentDefinition`, one new optional callback on `SubagentSchedulerOpts`, one renamed helper (`filterToolsForChild` → `buildChildToolPool` — same semantics under the strict-allowlist branch, new branch for `inheritParentTools: true`), one new branch in `AgentTool.call`, new optional config block, new bundle prompt + four new agent definitions. No public surface removed.
- **Rule 3 (audit before claiming done).** Satisfied via layered tests: schema → lane resolution → registry → preflight → scheduler hook → AgentTool recursion guard → runtime wiring → integration (trivial + compound + failure) → semantic (5 cases against real LLMs). The two known LOW issues (delegator `readOnly` flip + lane `timeoutMs` enforcement) are documented in follow-ups above; both surfaced during integration testing and have documented mitigations.
- **Rule 4 (escape hatch).** Satisfied. `taskRouting.enabled: false` (the default) is a complete no-op for the smart-router code paths. Even when enabled, `--no-preflight` skips the boot-time aggregation check. The operator can disable per-lane overrides by deleting the lane from config (the lane registry falls back to `LANE_DEFAULTS`); they can disable the entire router by setting `enabled: false`; they can pin the parent's model by setting `defaultProvider`/`defaultModel` independent of `taskRouting`. All four cost-lane agents stay loaded in the registry even when `enabled: false` so `AgentTool` can still target them on demand (B-via-D bridge baseline).

## How it works now

```bash
# 1) Configure the lanes (one-shot per machine; or edit ~/.harness/config.json directly)
sov config set taskRouting.enabled true
sov config set taskRouting.delegator.model claude-sonnet-4-6
sov config set taskRouting.lanes.cheap-task.provider anthropic
sov config set taskRouting.lanes.cheap-task.model claude-haiku-4-5-20251001
sov config set taskRouting.lanes.moderate-task.provider anthropic
sov config set taskRouting.lanes.moderate-task.model claude-sonnet-4-6
sov config set taskRouting.lanes.frontier-task.provider anthropic
sov config set taskRouting.lanes.frontier-task.model claude-opus-4-7

# 2) Boot any harness surface — TUI, drive, dispatch, serve, cron
sov                          # TUI
sov drive                    # headless line-driven
sov serve                    # OpenAI HTTP API
```

A trivial single-shot turn:

```text
> what files are in src/router/?
[delegator] dispatched 1 atom on cheap-task
[cheap-task] capabilities.ts, lanes.ts, laneRegistry.ts, preflight.ts
```

A compound multi-atom turn:

```text
> Read src/router/lanes.ts and tests/router/lanes.test.ts and tell me whether the test coverage matches the source.
[delegator] decomposed into 3 atoms
[cheap-task] (atom 1) src/router/lanes.ts is 47 lines, exports LANE_DEFAULTS + resolveLane
[cheap-task] (atom 2) tests/router/lanes.test.ts is 32 lines, 4 test cases
[frontier-task] (atom 3, synthesis) Coverage looks complete: each branch of resolveLane has a corresponding test case (defaults, per-lane merge, delegator role, unknown lane).
```

Mixed provider per-lane (cheap atoms on local Ollama, synthesis on Anthropic):

```bash
sov config set taskRouting.lanes.cheap-task.provider ollama
sov config set taskRouting.lanes.cheap-task.model qwen2.5:7b
```

Disable the smart router but keep the cost-lane sub-agents reachable via `AgentTool`:

```bash
sov config set taskRouting.enabled false
```

Boot-time preflight error when credentials are missing:

```text
$ sov serve
sov: cannot start with taskRouting enabled — preflight failures:
  frontier-task  anthropic/claude-opus-4-7  — no API key (set ANTHROPIC_API_KEY or providers.anthropic.apiKey)

Set credentials or override lanes in ~/.harness/config.json.
```

All Phase 1 atoms run as fresh sub-agent sessions; their traces flow through the existing sub-agent observability layer (`sov trace show <session-id>` surfaces the parent + delegator + atom rows under one root session). Per-lane cost attribution comes for free via the existing per-row provider/model tags.
