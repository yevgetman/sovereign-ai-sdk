# Changelog

## sdk 0.6.2 — Conduct Port (1f): the gateway binds + enforces a decorum pack via config (released in sov v0.6.58) - 2026-07-14

The `sov gateway` can now load a **decorum conduct/persona pack** at boot and
enforce it through the Conduct Port seam that shipped threaded-but-unpopulated in
1b. This is the upstream unblocker for dogfooding decorum into a gateway-based
deployment (Appleo). All opt-in and **null-provider byte-identical** when
unconfigured.

- **Config surface.** An OPTIONAL, strict `conduct { configPath?, packDir? }`
  block on the SDK Settings schema. `configPath` is a deployment-binding
  `conduct.yaml`; `packDir` is a directory holding one (`<packDir>/conduct.yaml`,
  used only when `configPath` is unset). **Absent block ⇒ today's behavior
  exactly** — no provider is constructed and every seam runs as the null provider.
- **Real adapter.** `createDecorumAdapter` now imports `@yevgetman/decorum`
  (added as a `file:` dependency of the root `@yevgetman/sov` package; the open
  SDK core still never depends on the engine — only this wrapper does) and returns
  a real `ConductProvider` bound to the resolved binding. It **FAILS CLOSED at
  boot** — a missing/invalid pack throws and the gateway exits non-zero rather
  than booting into a no-governance state. Triage's host reasoner is wired
  `undefined` for this first release (floors + persona + input-gate + tool-policy
  + output-governor all enforce without it; TODO seam documented); the audit sink
  is likewise a documented TODO.
- **Boot wiring.** `runGateway` reads `config.conduct` and, when present, builds
  the adapter and passes it as `conduct` into `buildRuntime`, which threads it to
  every surface verbatim.
- Tests: an end-to-end suite through `buildRuntime` with the shipped decorum
  assistant-core binding proves a bound runtime enforces (clean turn passes,
  a directive-extraction input is gated, a directive-leak output is
  blocked/substituted); a missing path fails closed at boot; and no conduct
  config leaves `runtime.conduct` undefined with a byte-identical turn.

## sdk 0.6.1 — Conduct Port (1d): regenerate-once + onStreamEnd flush + SSE convergence closed - 2026-07-10

Additive extensions to the 1b Conduct Port, driven by decorum's OutputGovernor
build. Three parts, all opt-in and null-provider byte-identical:

- **`regenerate` output verdict — bounded-once retry.** `outputGuard.onFinal` may
  now return `{ action: 'regenerate', reason }`; the `createAgent` drive loop
  re-runs the turn **exactly once**, folding the content-free `reason` into a
  steering segment, and treats a second `regenerate` as `block` (`CONDUCT_REGENERATE_MAX=1`).
  Per-attempt turn state is reset before the retry, so a discarded first attempt —
  including a tool-using one — **never double-persists** its tool calls or double-counts
  usage (caught in live-verify; `tests/agent/createAgent.conduct.test.ts` — "regenerate
  on a tool-using turn discards the tool call…", "second regenerate verdict is treated
  as block").
- **`onStreamEnd` seam — held-tail flush.** A new optional `outputGuard.onStreamEnd`
  lets a hold-by-default governor flush its verified held tail as a final `text_delta`
  before the assistant message is sealed (`createAgent.conduct.test.ts` — "onStreamEnd
  flush is emitted as a final text_delta before the assistant message"). Absent the
  capability, nothing changes.
- **SSE reconciliation — the 1b divergence caveat is CLOSED BY CONTRACT.** With a
  hold-by-default governor bound, every released delta is verified text, so on the
  pass path `concat(released deltas + onStreamEnd flush) === the final delivered +
  persisted message` — proven by a new property test
  (`tests/conduct/streamConvergence.test.ts`). The only residue is the honest,
  documented one: a `block`/`replace`/`regenerate` that fires *after* bytes were
  already streamed leaves the client holding a **prefix of the ORIGINAL** text while
  the delivered/persisted message is the substitution (never a prefix of the
  substitution — read as an explicit correction). decorum emits `regenerate` only when
  nothing was released, narrowing this to block/replace-after-release.

Docs: `docs/02-architecture/conduct-port.md` — "Boundaries & known caveats" rewritten
(SSE convergence; the Zone-2 depth channel assessed in 1d and **deferred to 1f** with
full rationale). **Additive only** — every existing lane and the null-provider invariant
byte-identical (full suite + contract tests); npm publish remains **held**.

## sdk 0.6.0 / harness 0.6.58 — Conduct Port (1b): vendor-neutral agent-behavior seams - 2026-07-10

The SDK now carries the **Conduct Port** — the choke points for an
agent-behavior governance engine (first consumer: decorum, the Conduct &
Persona Engine). `ConductProvider` (all capabilities optional; barrel-exported)
+ five seams: persona-segment composition (cache-preserving placement),
preGate over the FINAL post-rewrite input, pre-model triage (fail-open,
refuse short-circuit), deny-first toolPolicy over the canUseTool cascade, and
the output-delivery gate in the createAgent drive loop (delta hold, final
replace/block with text-substitution that preserves tool_use adjacency,
scrub-before-persistence). Typed content-free audit events at every stage.
Gateway binds per-runtime (`RuntimeOptions.conduct`) and gates
`PostTurnRequest.instructions` (D23); channels/cron/openai-compat/missionRun
thread the same provider. Sub-agent subprocesses are a NAMED trust boundary
(a provider object doesn't cross processes; children bind at boot). WITHOUT a
bound provider, behavior is byte-identical — the null-provider invariant is
pinned by the full suite plus dedicated contract tests.

## harness 0.6.57 — `sov run --steer-file` mid-turn steering - 2026-07-09

A machine adapter can now inject operator messages into a **running** `sov run`
turn. `--steer-file <path>` names a JSONL file (`{"text": "..."}` per line) that
the turn loop polls at agent-loop boundaries and consumes atomically: at a tool
boundary the framed message merges into the tool batch's user message (the
loop-guidance mechanism — role alternation, tool_use/tool_result adjacency, and
transcript persistence all preserved); at turn end a pending steer becomes a
standalone user message and the turn CONTINUES to address it (`maxTurns`
bounds). A `steer_injected` event (additive) announces each injection on the
wire. SDK surface: `QueryParams`/`AgentConfig`/`PerTurn.pollSteering` — a host
thunk mirroring `recall`. Without `--steer-file`, behavior is byte-identical.
First consumer: telekit's Telegram bridge (mid-turn steering on the SOV lane).

## sdk 0.5.0 — Model-router lane (Manifest = the current router solution) - 2026-07-06

New provider lane: a **generic model-router transport** plus its current binding.
**`RouterProvider`** (apiMode `'router'`; new barrel exports `RouterProvider` /
`RouterProviderConfig` / `ResolvedRoute`) speaks to any OpenAI-compatible routing
proxy — the caller asks for model `auto` and the router picks the upstream. Two
seams over the inherited OpenAI transport: a static `headers` map for routing
hints (the real auth/content-type are never maskable), and an opt-in
`onRouteResolved` callback fed by one new protected no-op `onResponse` hook on
`OpenAIProvider` (parses the `X-Manifest-*` route-report headers; a throwing
callback is swallowed — best-effort). The **`manifest` registry lane** binds it
to a self-hosted [Manifest](https://github.com/mnfst/manifest) instance: model
`auto`, loopback `http://localhost:2099/v1`, env `MANIFEST_API_KEY`, config
`providers.manifest` incl. the router-only `headers` block; `/effort` is gated
off on the lane (unknown upstream). Nothing from Manifest is imported — the
router stays swappable (a `baseUrl` override or a new registry entry). Wrapper:
the lane is exposed in `/config` (Providers → Manifest). Docs: new recipe
`docs/04-extending/routing-an-agent.md` + a cli-reference provider entry; an
env-gated live conformance probe (`tests/providers/router.live.test.ts`,
`MANIFEST_LIVE=1`). **Additive only** — every existing lane byte-identical;
`@yevgetman/sov-sdk` 0.4.0 → 0.5.0 (protocol package untouched); npm publish
remains **held** (unchanged posture). Spec:
`specs/2026-07-06-model-router-adapter-design.md`.

## sdk 0.4.0 — Turn-log recorder - 2026-07-06

_(SDK-package release only; entry backfilled at the 0.5.0 merge.)_ New barrel
export **`createTurnLogRecorder`**: canonical full-content turn records over the
SSE wire shape, handed per-turn to a pluggable `TurnLogSink` (fail-open, zero
dependencies). A follow-up fix — **open-turn accumulation** (the real gateway
wire carries per-EVENT seqs, not per-turn; everything since the last
`turn_complete` belongs to that turn, sealed under its seq; live-verify
finding) — was authored as 0.4.1 and ships folded into **0.5.0** (its version
bump was superseded by the router lane's additive minor).

## sdk 0.3.0 — Assay usage wire (the official token-accounting export) - 2026-07-05

_(SDK-package release only — no root-wrapper behavior change.)_ New barrel export
**`createAssayUsageRecorder`** (+ `ASSAY_WIRE_VERSION`, types): a zero-dependency
`traceRecorder` that streams **usage-only** OpenTelemetry `gen_ai` spans (token
phases, identities, tool names, timings — never content) as OTLP/JSON to a local
`assay serve` endpoint. One priced **chat span per model call** carrying the
dominant tool its completion invoked; one **execute_tool span** per tool run
(unpriced, optional); one trace per turn (`sov.turn.id` → assay task).
Deterministic ids (replay dedupes); fire-and-forget transport (retry-once,
bounded drop-oldest queue, `record` never throws, unref'd timer). Contract +
posture ("protocol marriage, not code marriage"): `specs/2026-07-05-assay-integration-design.md`;
golden fixture `fixtures/assay-wire-v1.json` conformance-tested in both repos.
Docs: `docs/04-extending/metering-an-agent.md` §"Metering with Assay".

## 0.6.49 — Billing-grade usage telemetry - 2026-07-03

_(Appended out of band — this file froze at Phase 13.3, per the note below; this feature warranted a versioned callout because it changes an externally-observed figure. The canonical state record remains the snapshot series + the testing log.)_

**BUG FIX — multi-call tool-loop turns previously under-reported usage and cost.** The gateway tracked usage last-writer-wins, so a turn that made N provider calls recorded and reported only the **final** call's tokens — every consumer of per-turn cost (`status_update` `tokensIn`/`tokensOut`/`cost`, `sessionDb.recordTokenUsage`, and the `session_summary` totals fed from it) under-billed multi-call turns. Now fed from the SDK's summed usage accumulator, so per-turn figures are the true sum across all hops. Separately, `provider_response` trace events could drop input/cache fields on providers that split usage across deltas (Anthropic: input+cache on `message_start`, output on `message_delta`) — usage is now merged **per field within a call**, so the recorded trace carries the call's complete usage.

Additions (all additive — new optional fields + new barrel exports; the 0.1.0 frozen SDK surface is extended, not broken):

- **`RunResult.usage` + `RunResult.estimatedCostUsd`** — per-run summed, phase-broken token usage and its estimated cost, byte-identical to what the persistence path records.
- **Public metering primitives** — `createUsageAccumulator` / `accumulateUsage` / `finalizeUsage` (+ type `UsageAccumulator`) and `estimateCostUsd` / `formatUsd` / `PRICE_TABLE` (readonly) / **`PRICING_VERSION`** (+ type `TokenPricesPerMillion`) are now barrel-exported from `@yevgetman/sov-sdk`, so external meters reuse the exact per-call/summed semantics instead of re-deriving them.
- **`reasoningTokens` phase field** on `TokenUsage` — an informational subset of `outputTokens` (never priced; the four phase fields stay disjoint + additive).
- **OpenAI cache/reasoning mapping** — `prompt_tokens_details.cached_tokens → cacheReadInputTokens` with `inputTokens = prompt_tokens − cached_tokens` (preserving the disjoint-phase invariant), and `completion_tokens_details.reasoning_tokens → reasoningTokens`; `cacheReadInput` prices added for the OpenAI table entries.
- **`turn_complete.usage` populated** (the protocol's snake_case phase shape) and **`status_update.cacheHitRate`** assigned (`cacheRead / (input + cacheRead + cacheCreation)` when cache fields are present) — both previously defined-but-never-set.

Packages: `@yevgetman/sov-sdk` 0.1.0 → 0.2.0 (additive surface); root wrapper 0.6.48 → 0.6.49. `@yevgetman/sov-protocol` untouched (no wire-type changes — the fields were already defined). Spec: `specs/2026-07-03-usage-telemetry-design.md`. Docs: `docs/04-extending/metering-an-agent.md`.

> **NOTE — frozen at Phase 13.3 (2026-05-06).** This file is no longer the
> canonical phase history. For shipped state since Phase 13.4, see
> `docs/07-history/state/2026-05-12.md` (canonical current snapshot) and the archived
> snapshots under `docs/07-history/state/archive/`. The `CLAUDE.md` "Phases — where we
> are" section also carries a current-state summary. This file is preserved
> for historical phase-by-phase narrative through 13.3 — the format never
> got migrated forward when the state-of-build snapshot pattern took over
> in Phase 13.4.

## Phase 13.3 — Background review daemon + close-out - 2026-05-06

The Hermes-pattern propose-then-promote learning loop ships as a background daemon. The main body (T1–T14) landed earlier in the day; the close-out batch (commits ec21277–e516a43) follows.

**Main body (T1–T14):**

- **Proposal data model + paths** (`src/review/proposal.ts`, `src/review/paths.ts`). YAML-frontmatter proposal files written to `$HARNESS_HOME/review/pending/{memory,skills}/` with provenance fields: `sessionId`, `traceId`, `sourceHash`, `sourceExcerpt`, `message-range`.
- **`memory_propose` + `skill_propose` tools** (`src/tools/MemoryProposeTool.ts`, `src/tools/SkillProposeTool.ts`). Review-fork-only tools that file proposals to the pending queue. Full provenance frontmatter on write.
- **Three review reference agents** in `bundle-default/agents/`: `review-memory` (reads trajectories + memory, files memory proposals), `review-skill` (reads trajectories + skills, files skill proposals), `review-consolidate` (reads pending proposals, files a merged entry). All three carry restricted `allowedTools`.
- **ReviewManager + runReviewFork** (`src/review/manager.ts`, `src/review/fork.ts`). Counter-driven triggers: memory review every `userTurnsForMemoryReview` turns (default 10), skill review every `toolIterationsForSkillReview` tool iterations (default 50), distillation review every `childReviewEveryN` child completions (default 5). `runReviewFork` augments the parent pool with `REVIEW_ONLY_TOOLS` before delegating to the scheduler.
- **Turn-loop + REPL wiring** — ReviewManager instantiated per session; session-id guard prevents dispatch before session is established; counters increment in the query loop.
- **`/review` slash command** (`src/commands/reviewOps.ts`) — `list`, `show <id>`, `approve <id>`, `reject <id>`, `consolidate`, `activity` verbs.
- **`on_delegation` distillation hook + recursion guard** — scheduler's `onChildCompletion` feeds ReviewManager; recursion guard skips `onChildCompletion` for review-* agents so they don't trigger their own follow-up reviews.
- **Stall/no-op detection** (`src/review/stall.ts`) — 3-turn sliding window over child output; `stall_detected` trace event emitted when window is clear of decisions or tool calls.
- **Memory consolidation pass** (`src/review/consolidate.ts` + `review-consolidate` agent) — dispatched by `/review consolidate`; reads pending memory proposals, merges related ones, writes a single combined `memory_propose`.
- **Per-settings auto-promote opt-in** — `review.autoPromoteMemory`, `review.autoPromoteSkills` in `src/config/schema.ts`. Default: human-gated.
- **End-to-end integration test** + **semantic tests** (51/51 at T13 close).

**Close-out batch (A1–A3, B1–B4, follow-ups, phantom cleanup, C2):**

- **A1** (5bd9541): throttle `onChildCompletion` — skip trivial children (0 tool calls + 0 user turns).
- **A2** (ec21277): hard REVIEW_ONLY_TOOLS pool-separation — `memory_propose` / `skill_propose` moved to a separate export, excluded from `REGISTERED_TOOLS`. ~530 tokens freed from main agent context. New semantic case `tools.main-agent-excludes-propose-tools`.
- **A3** (ebaaa55): temporal lockout — back-to-back dispatches within `minIntervalMs` (default 30s) dropped.
- **B1** (e08566d): inject `childSessionId` into child trace events via TraceWriter.
- **B2** (9d08cf6): stock-bundle trajectory routing to `harnessHome` via `isDefaultBundlePath()`.
- **B3** (f4676a9): surface review activity in goodbye summary + `/review activity` verb.
- **B4** (235130b): cancel in-flight reviews on `session_end` via `ReviewManager.cancelAll()`.
- **Round-2 follow-ups** (cc334cc): Fix #1 TraceWriter parent sessionId injection on parent events; Fix #2 ReviewManager signal-aborted guards; Fix #3 `/review activity` phantom filter (completed sessions only).
- **Semantic additions** (c0d6533): 3 new cases — `review-activity-empty-on-fresh-bundle`, `review-consolidate-dispatches-or-degrades`, `main-agent-excludes-propose-tools`. Suite 51 → 54.
- **Close-out** (e516a43): phantom DB cleanup sweep on startup; C2 auto-promote provenance preservation (approved files carry full `sessionId` + `traceId` + `sourceHash` chain of custody).

Tests: semantic suite 54/54; unit suite 1490/1490. Lint clean.

Design choices (see `DECISIONS.md` Phase 13.3 section): REVIEW_ONLY_TOOLS hard enforcement, throttle strategy, soft vs. hard allowedTools enforcement, phantom row defense-in-depth, trajectory location split.

## Phase 13.2 — Task system for parallel workers - 2026-05-06

Fire-and-forget sub-agent dispatch with persistence and lifecycle control. The model invokes `task_create` (returns a task id immediately), observes via `task_list` / `task_get` / `task_output`, and cancels via `task_stop`. The `/tasks [all|show <id>|stop <id>]` slash command renders the same lifecycle from the user's perspective.

- **Schema v4** — `tasks` table added to `sessions.db` alongside `sessions`. `TaskStore` shares the `SessionDb` handle (no second DB file).
- **`TaskManager`** (`src/tasks/manager.ts`) — wraps `SubagentScheduler` with fire-and-forget delegation. Terminal-reason → `TaskState` mapping: `interrupted` splits into `cancelled` (when `userAborted`) vs `timed_out`; `completed` and `max_turns` both map to `completed`. Controllers map tracks abort controllers per task.
- **Five tools**: `task_create`, `task_list`, `task_get`, `task_stop`, `task_output`. All registered in `assembleToolPool()`; `subagent_type` enum patching generalized across `AgentTool` + `task_create`.
- **`task_stop`** added to `SUBAGENT_EXCLUDED_TOOLS` so children cannot cancel the parent's tasks.
- **`/tasks` slash command** (`src/commands/taskOps.ts`) — `all`, `show <id>`, `stop <id>` verbs.

Tests: 4 new semantic cases (create/list/get/stop lifecycle); unit suite 1384/1384 at close.

## Phase 13 — Sub-agent runtime + AgentTool - 2026-05-05

The model can now delegate focused work to bounded specialized agents that run as their own sessions, return concise summaries, and feed the parent's memory via the `on_delegation` hook. Three reference agents ship in `bundle-default/agents/`: `explore` (read-only codebase mapping), `verify` (independent claim checking), `plan` (implementation planning).

Seven landed pieces, ordered by build sequence:

1. **Agent definition format + loader** (`src/agents/loader.ts`, `src/agents/types.ts`). Markdown + YAML frontmatter, same shape and search paths as skills (`<cwd>/.harness/agents/`, `<harness-home>/agents/`, `<bundle>/agents/`) with project-precedence dedupe and realpath-based symlink collapse. Frontmatter fields: `name`, `description`, `whenToUse?`, `systemPrompt?` (frontmatter or markdown body), `allowedTools[]`, `model?` xor `role?`, `maxTurns` (default 50), `readOnly` (default false). `ToolContext.agents` registry mirrors the skills wiring.

2. **Capability profile lookup** (`src/router/capabilities.ts`, deferred from Phase 10.6 part 2b). Hand-curated v0 table of `(provider, model)` records carrying `contextLength`, coarse `costTier`, tool-call + JSON reliability, and `recommendedRoles[]`. Two consumers: the router classifier reads `contextLength` (existing wiring); the sub-agent scheduler reads `recommendedRoles` to resolve `role: explore` to the cheapest capable model. Cross-consistency test pins the table against `src/providers/models.ts::contextLengthFor()` so the two cannot drift.

3. **AgentRunner extraction** (`src/runtime/agentRunner.ts`). Focused wrapper around `query()` that owns the non-UI plumbing every agent execution needs — building the user message from a string prompt, wiring query() params, tracking the final assistant message, iteration count, tool-call count, and parent-child lineage carry. `query()` itself is unchanged (Invariant #1). The REPL keeps its inline `query()` call because UI is woven into the per-event loop and isn't pure plumbing; AgentRunner exists for sub-agents and future surfaces (background review, scheduled missions, daemon).

4. **Scheduler primitives** (`src/runtime/semaphore.ts`, `src/runtime/laneSemaphores.ts`, deferred from Phase 10.6 part 2b). AbortSignal-aware FIFO Semaphore with idempotent release; `LaneSemaphores` per-lane wrapper holding one Semaphore per lane (local / frontier). RouterConfig + settings schema gain `maxConcurrentLocal` / `maxConcurrentFrontier`. `AbortSignal.any()` and `AbortSignal.timeout()` (Bun-native) compose for cancellation chaining + per-child timeouts in the scheduler.

5. **AgentTool + scheduler + global exclusion set** (`src/agents/exclusions.ts`, `src/runtime/scheduler.ts`, `src/tools/AgentTool.ts`). `SUBAGENT_EXCLUDED_TOOLS` is a code-owned ReadonlySet covering recursive spawning (`AgentTool`), session-scoped scheduling (`cron_*`), and parent-side control plane (`task_stop`, `send_message`). The `SubagentScheduler` owns per-parent child cap (default 4), lane semaphore acquisition, write-lock acquisition for write-capable children, per-child wall-clock timeout, parent-child session lineage via the caller's `createChildSession` callback (the REPL passes `db.createSession` with `parentSessionId` set), tool filtering (parent pool ∩ `agent.allowedTools` name-only − exclusion set), and provider/model resolution (literal `model:` form or capability-profile lookup via `role:`). `AgentTool` is a thin `buildTool()` wrapper. `patchSchemasAgainstAvailable()` (in `src/tool/registry.ts`, formerly a no-op pass) now rewrites AgentTool's `subagent_type` field from open string to a closed enum from the loaded agents — and drops AgentTool entirely from the pool when no agents are loaded.

6. **on_delegation hook + DB lineage verification** (`src/runtime/scheduler.ts`). After successful child completion (terminal `completed` or `max_turns`), the scheduler calls `parent.memoryManager.onDelegation(prompt, summary)`. Errors and interrupts skip the hook. Hook errors route to `traceRecorder` rather than failing the scheduler return (preserves the parent turn even when the memory backend hiccups). Two integration tests use a real (in-memory) `SessionDb` to confirm `parent_session_id` flows through the live write path: one child correctly links via `getSession(childId).parentSessionId`; two delegations from the same parent both link.

7. **Phase close + doc sweep** — README + CHANGELOG + CLAUDE.md + AGENTS.md status; `phase-10x-status.md` reflects 10.6 part 2b items as landed in Phase 13 (with shipped headlines updated); `docs/02-architecture/runtime-architecture.md` gains a Sub-Agent Runtime section + extension surfaces row for `src/agents/` + `src/runtime/`; `docs/04-extending/extending.md` gains an "Add An Agent Definition" section; `docs/03-cli-reference/usage.md` capability-profile language flips from "re-scoped to" to "landed in"; two semantic tests (`16-agents.cases.ts`): `agents-bundle-default-discoverable` (registry discoverability + AgentTool surface presence) and `agents-explore-live-delegation` (end-to-end smoke through the full chain — AgentTool → scheduler → child session → AgentRunner → renderResult → parent consumption); `DECISIONS.md` retroactive entries for the in-memory v0 path lock, hand-curated v0 capability profiles, AgentRunner-not-in-REPL scope, name-only `allowedTools` filtering with deferred pattern enforcement, and the schema-patch fallback that drops AgentTool when no agents are loaded; testing-log entry.

Tests: 50 new unit cases across the phase (12 loader, 1 bundle-default smoke, 12 capability profile, 6 AgentRunner, 6 Semaphore, 4 LaneSemaphores, 4 exclusion set, 9 scheduler scenarios, 6 AgentTool surfaces, 2 registry schema patches, 5 on_delegation + DB lineage) + 2 new semantic cases (registry discoverability + live end-to-end delegation). Unit suite: 1267/1267. Semantic suite: 43/43 expected (live-delegation case adds ~30-60 s + ~$0.05 per run). Lint clean.

Known v0 gaps with follow-up notes in `DECISIONS.md`:
- Pattern constraints inside `allowedTools` entries (e.g. `Bash(git log *)`) are not enforced at the scheduler layer; the parent's `canUseTool` still applies. Tightening this is a follow-up.
- `subagent_progress` StreamEvents are not surfaced to the parent UI in v0 — children show up as a single tool-result block. Live progress streaming requires orchestrator `onProgress` plumbing; trace + trajectory still capture full child detail for post-hoc analysis.
- Path lock is a single in-memory `Semaphore(1)` (the v0 path-lock primitive). Per-path locking and cross-process coordination land later (Phase 16 daemon).
- Capability profile entries are hand-curated; Phase 13.4 (continuous-learning observation stream) will graduate refined entries to `source: 'eval'` from real-world usage.

## Defense-in-depth secret redactor + `/security-audit` skill - 2026-05-05

Two harness-level changes that address a failure mode caught in real use: an agent doing a security audit reads a real credential while exploring, then accidentally reproduces that credential verbatim in the report it writes to disk. The fix is structural, not prompt-engineered.

**Secret redactor (Write/Edit/NotebookEdit InputTransformer).** New `src/permissions/secretRedactor.ts` — pure detector for prefix-+-length-class patterns: GitHub OAuth (`gho_/ghp_/ghu_/ghs_/ghr_` + 36+ chars), GitHub fine-grained (`github_pat_` + 82), AWS access keys (`AKIA` + 16), Stripe live/test secret/restricted/publishable, Slack `xox[abprs]-`, Google `AIza` + 35, JWTs (`eyJ.eyJ.x`), and PEM `-----BEGIN [...] PRIVATE KEY-----` blocks. Returns `{ redacted, hits[] }`. Overlap-resolved left-to-right. `HARNESS_REDACTION=off` bypasses globally (testing only). New `src/permissions/inputTransformer.ts` — generic `wrapCanUseToolWithTransformers(base, [...])` higher-order layer over `CanUseTool` that runs transformers after permission resolves to allow; `updatedInput` composes; reasons concat with `'; '`; thrown transformers silently skip. New `src/permissions/redactSecretsTransformer.ts` — bridges the two for `Write.content` / `Edit.new_string` / `NotebookEdit.new_source`. `Edit.old_string` is intentionally NOT redacted (the legitimate workflow for *removing* a secret from a file passes the live value as `old_string` so Edit's match succeeds). Bash isn't covered (would require shell parsing) — the original failure mode went through Write, which this catches. Wired in `terminalRepl.ts` via `wrapCanUseToolWithTransformers(buildCanUseTool({...}), [redactSecretsTransformer])`.

**`/security-audit` skill.** New `bundle-default/skills/security-audit.md`, the third shipped default skill alongside `/review` and `/summarize`. Designed to make a weaker model produce a defensible audit by replacing "generate plausible findings" with structured process scaffolding: (1) establish platform context (`uname -s`, `sw_vers`, `/etc/os-release`) before recommending platform-specific commands — blocks the Linux-`auditctl`-on-macOS failure mode; (2) threat-model scaffolding (actors T1–T6, assets, exposure paths) used for prioritization, not as report padding; (3) enumerate actual surface with concrete commands per platform branch (creds on disk, system security state, network exposure via `lsof -nP -iTCP -sTCP:LISTEN`, persistence surface, token-scope checks); (4) per-finding verification gate — every claim must answer "what command did I run, what was the output, why does this mean exposure"; (5) threat-chain analysis pruning scenarios that don't fit observed state; (6) three-file output (audit / attack-vectors / remediation) with hard rules: no fan-fiction, no platform mismatch, no live secrets in artifacts (refer by type+location), cite the verification command. `allowedTools` restricts to `Bash/Read/Glob/Grep/Write`.

Tests: +44 unit cases (secretRedactor pattern coverage + boundary cases + false-positive guards + env-var bypass; inputTransformer compose semantics + thrown-transformer skip + reason concat; redactSecretsTransformer field gating per tool name + singular/plural reason grammar). Two new semantic cases: `redaction.redactor-rewrites-write-content-on-disk` (drives Write-then-Read of a fake `gho_` token; verifies on-disk content shows `<REDACTED:github-oauth>` not the original token shape — proves the rewrite happened at the canUseTool boundary), and `security.security-audit-skill-triggers-and-verifies` (drives the agent at a directory containing one fake-shaped GitHub token, verifies the agent invokes a real read/search tool and identifies the credential without inlining the literal token in chat narration). New `redaction` and `security` `TestCategory` values.

Suite total: **1181/1181 unit + 41/41 semantic**. Lint clean.

## docs: re-scope Phase 10.6 part 2b leftovers into Phase 13 - 2026-05-05

Two items previously tracked as "Phase 10.6 part 2b deferred-because-premature" — per-model capability profile lookup and per-lane concurrency guards — are now Phase 13 deliverables. The router config has declared `maxConcurrentLocal` / `maxConcurrentFrontier` since Phase 10.6 part 1 but the harness has no parallel provider calls today; sub-agents (Phase 13) are the first surface that produces them, which makes Phase 13's scheduler the natural home for the per-lane semaphore primitive. Capability profiles get a second consumer in Phase 13: agent definitions can declare `role: explore` and have the runtime resolve to a real provider/model via the table, instead of every definition pinning a literal model id.

Updates `harness-build-plan.md` (Phase 13 build items 4 and 10 now claim the deliverables; Phase 10.6 status line drops the deferred-leftover claim), `phase-10x-status.md` (drops the two deferred rows; replaces the "Deferred" subsection with a "Re-scoped to later phases" forwarding pointer; closes the 10.x lane with no remaining deferrals), CLAUDE.md / AGENTS.md / docs/03-cli-reference/usage.md (drop the deferred-because-premature framing). No code changes; this is purely a re-homing of two backlog items into the phase that has a real consumer for them.

## Phase 10.8 — Default bundle + bundleless invocation + `sov init` - 2026-05-05

`sov` no longer requires a bundle on disk. Bundle resolution becomes a four-step fallthrough: explicit `--bundle <path>` → `HARNESS_BUNDLE` env → upward `index.yaml` walk from CWD → **default bundle**. The default bundle resolves itself in two steps: `<harness-home>/default-bundle/` (user override location, takes precedence) → shipped `bundle-default/` next to the runtime source (resolved via `realpathSync` of the entry script). "No bundle found" stops being a possible outcome in normal operation.

The shipped default bundle is vendor-neutral: a coding-assistant system prompt, two starter skills (`/review`, `/summarize`), no schemas, an empty state directory. Per the design note ([`phase-10.8-default-bundle-design.md`](https://github.com/yevgetman/sovereign-ai-docs/blob/master/harness/docs/runtime/phase-10.8-default-bundle-design.md)), nothing Sovereign-AI-specific ships in the default — that identity lives only in real bundles authored by users.

`sov init` graduates a directory into a real bundle. v1 contract: writes a minimal `index.yaml` + `business/README.md` (seeded from `<cwd>/README.md` when present, else a stub) + empty `harness/schemas/` + empty `state/` + empty `skills/`. Refuses to overwrite an existing `index.yaml` unless `--force` is passed. Full corpus generator design (what files `sov init` actually generates when reading a non-trivial repo) is deferred to a separate follow-up session.

Adds: `bundle-default/` (committed in the runtime repo), `src/bundle/defaultBundle.ts` (resolver: user override → shipped fallback), `src/cli/init.ts`, `bundle-default/skills/{review,summarize}.md` (with `whenToUse` frontmatter for Phase 9.6 compliance). Modifies `resolveBundlePath()` in `src/main.ts` to fall through to the default bundle.

14 new unit tests (init 9, defaultBundle 5). Suite: **1124/1124**. Lint + typecheck clean. End-to-end smoke: `sov chat` from `/tmp` (no bundle anywhere upward) picks up the shipped default cleanly; `sov init` in a fresh dir produces a working bundle that `sov chat` then auto-discovers via the upward walk.

**Phase 10 lane fully closed** — every 10.x sub-phase that's worth building today is shipped.

## Phase 10.6 part 2b — Interactive escalation prompt - 2026-05-05

When `escalationMode: 'ask'` and the classifier produces `local-with-escalation`, the router now prompts the user for a yes/no on the escalation. Returning `y` routes the turn to frontier; anything else stays on the default lane. Without a TTY (piped/CI sessions), the prompt yields empty and is treated as "no" — matches the pre-2b behavior for non-interactive runs.

The asker wiring is two-sided: `RouterProvider` exposes `setEscalationAsker(fn)` (mirroring `setSessionId`) so the REPL can install the asker once the readline `question` source is ready (later than router construction). The asker is built around the same source used by the permission prompt, so the UX is consistent. A thrown asker is swallowed and falls through to the default lane — keeps a misbehaving TTY from crashing the run.

Adds: `escalationAsker?` on `RouterProviderOpts`; `setEscalationAsker()` on `RouterProvider`; wiring in `terminalRepl.ts`. 6 new unit tests covering the no-asker / yes / no / no-prompt-on-plain-local / no-prompt-on-auto / thrown-asker paths. Suite total: **1110/1110**. Lint + typecheck clean.

**Phase 10.6 explicitly closed.** The two remaining 10.6 part 2b items — capability profiles and per-lane concurrency — were judged premature: capability profiles need eval data we don't have yet (per-model TTFT, tool reliability, etc.), and per-lane concurrency would only matter once sub-agents (Phase 13) introduce parallel provider calls. Both are tracked as deferred-because-premature in the status doc.

## Eval runner — `--capture <dir>` / `--replay <dir>` CLI - 2026-05-05

The promised follow-up to the Phase 10.5 part 2 capture/replay primitives. Both `sov chat` and `sov eval run` now expose first-class capture/replay surfaces:

**`sov chat --capture-fixture <path>`** wraps the resolved provider with `CapturingProvider` and the assembled tool pool with `wrapToolsForCapture`, then writes a `ReplayFixture` to `<path>` (atomic temp + rename) at session end. Every StreamEvent and every tool result are recorded with full fidelity.

**`sov chat --replay-fixture <path>`** skips `resolveProvider` entirely and builds a synthetic `ResolvedProvider` whose transport is a `ReplayProvider`. The tool pool gets wrapped with `wrapToolsForReplay` so every `tool.call()` returns its captured result. No LLM calls are made; no API keys are needed; the agent loop runs against canned events deterministically. The two flags are mutually exclusive.

**`sov eval run --capture <dir>`** — runs each golden live with the spawn injecting `--capture-fixture <dir>/<id>.fixture.json`. **`sov eval run --replay <dir>`** runs each golden against the matching fixture; goldens whose fixture is missing are reported as aborted with a clear message. The two flags are mutually exclusive.

Smoke test: capturing the `create-from-spec` golden took 1.4s + $0.006; replaying the same fixture took 0.1s + $0 (reuses captured cost metadata). The replay's pass/fail outcome and assertion details are byte-identical to the live capture.

Adds: `captureFixturePath` / `replayFixturePath` on `ReplOpts`; `buildReplayResolvedProvider()` helper in terminalRepl; capture-sink wiring at session start; fixture-write at session end. `captureDir` / `replayDir` on `EvalRunOpts`; per-golden fixture-path injection via `extraArgs`.

No new unit tests added — the wiring is straightforward CLI-flag plumbing on top of already-tested primitives, and the manual smoke verifies the round-trip end-to-end. Suite still 1104/1104. Lint + typecheck clean.

## Phase 10.6 part 2 — Router polish (banner + recent-error tracking + splash) - 2026-05-05

Three router-side improvements that make Phase 10.6 part 1's foundation pleasant to use:

**Recent-error tracking.** `RouterProvider` now scans `req.messages` newest-first for the last 20 `tool_result` blocks, counting `is_error: true` entries (and the subset whose content matches a schema-failure regex like `input validation failed`). The counts feed into the classifier's `recentToolErrors` / `recentSchemaFailures` triggers — so when a local model starts erroring, the router actually escalates instead of just nominally being able to.

**REPL banner for `route_decision`.** Each per-turn routing decision now renders as a one-line gray status banner — `[router · local (anthropic/claude-haiku-4-5) — default lane: local]` — so the user can see which lane every turn used. Frontier escalations get a `↗` arrow instead of a `·`. The audit log at `<harness-home>/router/audit.jsonl` still has the full record; this is the just-in-time UX signal.

**Splash auth-type honesty.** The splash card's auth-type slot used to read `router | API Key`, which was a small lie (the router itself doesn't authenticate; its children do). It now reads `router | router-managed`. Cosmetic but accurate.

Adds: 5 new unit tests in `tests/router/recentErrors.test.ts` covering the no-error / above-threshold / below-threshold / schema-failure / 'never'-stays-local paths. Tightened `router.router-completes-turn` semantic case to verify the banner is observable in the transcript. Suite total: **1104/1104 unit + 38/38 semantic**. Lint + typecheck clean.

**Still deferred (Phase 10.6 part 2b):** capability-profile lookup table, per-lane concurrency guards (semaphores), interactive `ask` prompt UX. The router is now functional and observable — these are polish for later.

## Phase 10.5 part 2b-ii + 2c — Capture mode + provider comparison - 2026-05-05

**2b-ii: capture primitives.** `CapturingProvider` wraps a real `LLMProvider` and mirrors every StreamEvent into a `CaptureSink` while forwarding them unchanged to the caller. `wrapToolsForCapture` wraps tools to record each call's result (or thrown error) keyed by `(toolName, callIndex)` — same key shape as the replay-side wrapper so capture + replay round-trip cleanly. The companion round-trip integration test drives a scripted "live" provider + real tool through `query()` with capture wrappers, snapshots the resulting fixture, then re-runs the fixture through `ReplayProvider` + `wrapToolsForReplay` and asserts the second run's StreamEvents match the first byte-for-byte.

Adds: `src/eval/replay/capture.ts` (`createCaptureSink`, `CapturingProvider`, `wrapToolsForCapture`).

**2c: provider comparison mode.** `sov eval run --compare anthropic,ollama` runs each golden once per provider in sequence, injecting `--provider <name>` into the spawned `sov chat` args. Per-provider model selection falls through to each provider's configured default. The summary table is a grid (rows = goldens, cols = providers) showing pass/fail + duration per cell; the budget applies to the cross-product totals. `formatCompareGrid()` exported pure for testability.

Adds: `compareProviders?: string[]` on `EvalRunOpts`; `--compare <providers>` CLI flag; `provider?: string` on `GoldenResult`; `formatCompareGrid()` pure renderer.

16 new unit tests (capture 10, capture round-trip 2, compareGrid 4). Suite total: **1099/1099**. Lint + typecheck clean. No semantic test added — capture/replay/comparison are internal test infrastructure, not agent-prompt-driven surfaces (same posture as 2a + 2b-i).

With 2a + 2b-i + 2b-ii + 2c shipped, **Phase 10.5 part 2 is complete**: the eval suite supports live golden runs, deterministic CI replay (once a fixture is captured), and provider comparison mode. The remaining piece would be eval-runner integration to write fixture files automatically during a live run; for now, fixtures are constructed programmatically in tests, and the primitives ship + are testable on their own.

## Phase 10.5 part 2b-i — Replay primitives (provider + tool wrapper) - 2026-05-05

The deterministic-replay half of the eval surface. A `ReplayFixture` captures every StreamEvent the provider yielded plus every tool result the orchestrator received during a live run. `ReplayProvider` re-emits the captured events one turn per `stream()` call as a drop-in `LLMProvider`; `wrapToolsForReplay` returns wrapped tools whose `call()` returns the next captured result keyed by `(toolName, callIndex)`. The agent loop, orchestrator, permission gates, hooks, MCP wiring, and trace writer all run unchanged — only the provider + tool boundaries are stubbed.

Adds: `src/eval/replay/types.ts`, `src/eval/replay/provider.ts`, `src/eval/replay/toolPool.ts`, `src/eval/replay/loader.ts` (read/write/validate fixture JSON, atomic write via temp+rename).

Round-trip integration test drives a synthetic two-turn fixture (one tool call in turn 0, final text in turn 1) through `query()` with replay primitives, verifies the terminal reason + final assistant text are deterministic across runs, and confirms the live tool's body is never invoked.

24 new unit tests (provider 5, toolPool 7, loader 8, integration 2, +2 misc). Suite total: **1083/1083**. Lint + typecheck clean. No semantic test added — replay is internal test infrastructure, not an agent-prompt-driven surface.

**Deferred to Phase 10.5 part 2b-ii:** capture mode (a `CapturingProvider` + `wrapToolsForCapture` pair that wraps a real provider/tool pool to write a fixture file as a side-effect of a live run). Once 2b-ii lands, `sov eval run --capture <dir>` records goldens for later replay; `sov eval run --replay <fixture>` runs them deterministically without spending tokens.

**Deferred to Phase 10.5 part 2c:** provider comparison mode (`sov eval run --compare local,frontier,router`).

## Router model-swap fix + semantic test - 2026-05-05

`RouterProvider.stream()` now overrides `req.model` with the configured lane's model (`localModel` or `frontierModel`) before delegating to the child provider. Previously the synthetic combined-model string built for the splash card (`claude-haiku-4-5 | claude-sonnet-4-6`) leaked through to the underlying API call, producing 404s on `model not found`. Found by adding `router.router-completes-turn` to the semantic suite — first failure mode caught by the new test, fix landed in the same commit.

Also adds: `tests/semantic/suites/13-router.cases.ts` (one case using the new `setup.userConfig` framework hook to seed a router block in the per-test sandbox), `setup.userConfig` field on the semantic-test framework's TestSetup, `router` test category. Tightened `commands.context-budget-dispatch` criteria so the LLM judge stops oscillating ("BOTH system prompt AND tool schemas" instead of "at least two of [...]"), removing one error-prone test.

Semantic suite headline: **37 → 38** (full run 38/38 pass · 0 fail · 0 error · ~8.8 min · ~$2.04 informational).

## Phase 10.5 part 2a — Golden eval suite + `sov eval run` + budget - 2026-05-05

`sov eval run` is the new CLI driver for declarative end-to-end goldens. Each golden lives at `evals/goldens/*.golden.ts` and exports a `GoldenSpec` describing a sandbox to spin up (seeded files), a prompt (or array for multi-turn), and a list of code assertions. The runner spawns `sov chat` in a per-golden tempdir with isolated `HARNESS_HOME` / `HARNESS_CONFIG` / `sessions.db`, pipes the prompt + `/quit` into stdin, captures stdout/stderr, parses the session-summary footer for tool-call totals + cost, evaluates assertions, and reports pass/fail.

12 assertion primitives: `fileExists`, `fileNotExists`, `fileContains`, `fileMatches`, `fileEquals`, `agentResponseContains`, `agentResponseMatches`, `agentResponseLacks`, `noToolErrors`, `minToolCalls`, `maxToolCalls`, `exitCode`. Pure functions; pass `{sandboxCwd, transcript, exitCode, toolCalls?}` and get `{pass, detail?}`.

`evals/budget.json` is opt-in and declarative. Four independent thresholds: `maxWallSeconds`, `maxCostUsd`, `maxToolErrors`, `minPassCount`. The runner exits non-zero on any assertion fail, run abort (timeout/spawn error), or budget violation.

Four seed goldens cover the most basic surfaces: read-and-summarize (Read tool), edit-config (Edit tool in-place), create-from-spec (Write tool), recover-from-error (refusal-on-missing). `evals/README.md` documents the format + the assertion catalog + when to extend.

Adds: `src/eval/types.ts`, `src/eval/assertions.ts`, `src/eval/budget.ts`, `src/eval/sandbox.ts`, `src/eval/runner.ts`, `src/cli/evalRun.ts`. New `evals/` directory with goldens + budget + README. New `sov eval run` subcommand.

51 new unit tests (assertions 26, budget 15, runner pure-helpers + sandbox 10). Suite total: **1059/1059**. Lint + typecheck clean.

**Deferred to a Phase 10.5 part 2b:** replay fixtures + replay provider (deterministic CI mode — captures every StreamEvent + tool result from a live run, replays them against the same agent code path without spending tokens).

**Deferred to a Phase 10.5 part 2c:** provider comparison mode (`sov eval run --compare local,frontier,router`).

## Phase 10.6 — Local-model router (part 1) - 2026-05-04

`sov chat --provider router` now resolves to a meta-provider that routes each turn between two configured child providers (a `local` lane and a `frontier` lane) per a deterministic classifier, records every decision to a redacted JSONL audit log, and emits a `route_decision` StreamEvent so the runtime + UI know which lane handled each turn.

The classifier runs a fixed rule set: explicit user override > frontier triggers (recent tool errors ≥ 3, schema failures ≥ 2, context-overflow heuristic) > default-local. When triggers fire, the configured `escalationMode` (`ask` | `auto` | `never`) decides whether to actually escalate. `auto` ships data to the frontier; `ask` (the default) and `never` keep the run on the configured default lane — no surprise data egress. Audit entries hash the prompt (SHA-256, raw text never recorded by default), include the lane, the resolved provider/model, the reason, and the context byte count.

Added: `src/router/types.ts`, `src/router/classifier.ts` (12 tests), `src/router/auditLogger.ts` (8 tests), `src/router/provider.ts` (RouterProvider + 6 wiring tests). Settings schema gains a `router` block in `src/config/schema.ts` (user config). REPL build-resolves children + wraps in RouterProvider when `--provider router` is supplied; closes the audit logger at shutdown.

User config example:
```json
{
  "router": {
    "localProvider": "ollama",
    "localModel": "qwen2.5:14b",
    "frontierProvider": "anthropic",
    "frontierModel": "claude-sonnet-4-6",
    "escalationMode": "ask"
  }
}
```

26 new unit tests. Suite total: **1008/1008**. Lint + typecheck clean.

**Deferred to a Phase 10.6 part 2:** capability-profile lookup (per-model context length, JSON-mode reliability, recommended roles), per-lane concurrency guards (semaphores), interactive-prompt UX for `escalationMode: 'ask'`, REPL banner rendering of `route_decision` events, and recent-error/schema-failure tracking from the orchestrator side.

## Phase 10.5 — Operational traces + loop detection (part 1) - 2026-05-04

Adds an operational-observability layer beneath the user-facing turn loop. Every session now writes a JSONL trace at `<harness-home>/traces/<sessionId>.jsonl` covering session_start / turn_start / provider_request / provider_response / permission_check / tool_start / tool_end / tool_error / microcompact / interrupt / session_end / loop_detected. `sov trace show <sessionId>` renders the high-signal path (per-turn breakdown with usage, latency, TTFT, permission decisions, tool durations) for debugging or post-hoc investigation.

A multi-heuristic **loop detector** runs alongside: consecutive-identical tool calls (SHA-256 of `<name>:<JSON.stringify(input)>`, threshold 4), action stagnation (same tool name regardless of args, threshold 7), and content-loop (chunk-hash repeats inside a windowed sample, threshold 8 within a 1.5× window). On the first detection the orchestrator yields a `loop_detected` StreamEvent, records it to the trace, and injects a guidance user message ("looks like the same action is repeating"); on the second detection the run terminates with `reason: error` and an explanatory error message. Each detector clears its own history after firing so the next detection requires a fresh run, not just one more no-op turn.

Added: `src/trace/types.ts` (TraceEvent variants), `src/trace/writer.ts` (TraceWriter with sequential write chain, redaction, and best-effort error swallowing), `src/cli/traceShow.ts` (parseTraceFile + formatTrace + showTrace IO wrapper), `src/loop/detector.ts` (LoopDetectorState class). Wired `traceRecorder?` through `QueryParams` → `runTools` → `executeOne`. New `sov trace show <sessionId>` subcommand. New `loop_detected` StreamEvent variant.

40 new unit tests (writer 8, wiring 5, traceShow 10, loop detector 14, loop wiring 2, miscellaneous 1). Suite total: 982/982. Lint + typecheck clean.

**Deferred to a Phase 10.5 part 2:** the golden-task suite (`evals/golden/`), the deterministic replay fixtures, `sov eval run`, the regression budget, and provider-comparison mode. Tracked as Task 71 in the in-session task list.

## Phase 10.7 — Profile system - 2026-05-04

`sov` now scopes its on-disk state to a named profile so the same machine can host disjoint setups (work / personal / lab) with separate config, credentials, sessions, rate-limit ledgers, memory, and skills. The mechanism is intentionally narrow: a top-level `-p/--profile` flag (or a persisted `<base>/active-profile` pin) sets `process.env.HARNESS_HOME` to `<base>/profiles/<name>/` before any module that captures the path at load time, and every existing call site that previously hardcoded `homedir() + '.harness/...'` now resolves through `getHarnessHome()`. Per Invariant #11 — profile = env var before imports.

Added: `src/config/paths.ts` (profile-aware helpers + `assertProfileName` validator), `src/cli/profileFlag.ts` (pure argv scanner extracted for testability), `src/cli/profileCommands.ts` (`list` / `create` / `use` / `show` / `import-default`), `src/config/profileLock.ts` (atomic mkdir-based PID lock with stale-lock reclamation; helper only — REPL integration deferred so existing concurrent-session usage isn't broken). Rewired `src/agent/sessionDb.ts`, `src/config/store.ts`, `src/config/loader.ts`, `src/providers/credentials/pool.ts`, and `src/providers/credentials/rateGuard.ts` from eager `homedir()` consts to profile-aware functions; the deprecated consts remain for back-compat.

CLI breaking change: `chat`'s `-p` short flag for `--provider` was dropped to free `-p` for the top-level `--profile`. No tests or docs used the short form. `sov chat --provider <name>` is unchanged.

53 new unit tests (paths 17, profileCommands 15, profileFlag 12, profileLock 9). Suite total: 942/942.

Decisions recorded in DECISIONS.md.

## `sov upgrade --purge-cache` — defeat Bun's sticky URL→SHA cache - 2026-05-04

Empirically discovered while verifying Phase 13.1 end-to-end: `sov upgrade` (post-pre-uninstall fix below) was still installing a cached commit instead of master HEAD. Root cause: Bun's binary install-cache at `~/.bun/install/cache/` contains both per-SHA git package extracts (`@G@<sha>/`) and opaque `.npm` manifest files holding `URL → SHA` mappings. Even `bun install --no-cache --force <url>#master` (with the lockfile evicted) re-uses the cached SHA from `.npm` rather than re-resolving against the live remote.

Workaround: `sov upgrade --purge-cache` wipes `~/.bun/install/cache/` before installing, forcing Bun to re-resolve. Other Bun packages' manifest caches also evict — regenerable on next install. The flag is the "I want LATEST master, no kidding" hammer; the default (no flag) does the pre-uninstall + reinstall and works most of the time.

`--dry-run` now reports both the cache dir that would be wiped and the commands. `cacheDir` opt is a test seam so unit tests exercise the dry-run path without touching the real cache.

## `sov upgrade` — pre-uninstall to bypass Bun lockfile pin - 2026-05-04

`sov upgrade` was a no-op past the first install: Bun's lockfile pinned the resolved git SHA per URL, so `bun install -g <url>` re-installed that pinned SHA. Worse, requesting a different ref triggered `DependencyLoop` because the existing install and the new request had the same package name.

Fix: `bun uninstall -g @yevgetman/sov` first (failures intentionally ignored — covers first-install case), then `bun install -g <url>`. The uninstall evicts the lockfile entry so the next install can resolve cleanly without the loop.

API change: `buildUpgradeCommand` (returns `string[]`) → `buildUpgradeCommands` (returns `string[][]`). `UpgradeResult.command` → `UpgradeResult.commands`. `runUpgrade` now spawns up to 2 processes; the uninstall step is best-effort. New `--skip-uninstall` flag for the rare case when you actually want bun's cached SHA.

## Phase 13.1 — Trajectory capture - 2026-05-04

The Sovereign moat: every completed session writes a ShareGPT-shaped JSONL record to `<bundle>/state/artifacts/trajectories/samples.jsonl` (or `<harnessHome>/trajectories/samples.jsonl` in generic-agent mode); failed/interrupted sessions land in `failed.jsonl`. Records are redacted at write time via `redact()` against a 14-pattern allowlist (Anthropic / OpenAI / Tavily / Brave / OpenRouter / GitHub PATs / AWS keys / JWTs / Bearer tokens / PEM private keys / credential file paths).

Per Invariant #15, `HARNESS_REDACT_SECRETS` is snapshotted at module import — an agent tool call that mutates `process.env` mid-session can't disable redaction.

ShareGPT mapping handles the full content-block surface: `<think>…</think>` for thinking blocks (cross-model compatible: OpenAI o-series, Anthropic extended thinking, DeepSeek R1), `<tool_call name="X" id="Y">{…}</tool_call>` for assistant tool_use blocks, `from: 'tool'` records for tool_result blocks. `terminal.reason === 'max_turns'` counts as completed (run loop hit cap cleanly); only genuine error/interrupt/max_tokens paths land in `failed.jsonl`.

Wiring captures the most-recent Terminal across all turns of the session (per-session, not per-turn) and calls `tryWriteTrajectory()` after the REPL loop closes, before DB shutdown. Empty sessions (no in-memory messages) skip the write. Failures log to stderr without blocking shutdown — Invariant #10 (additive, non-blocking learning loop).

32 unit tests across `tests/trajectory/`. Build plan §"Phase 13.1".

## `sov upgrade` — one-command pull from the private repo - 2026-05-04

`sov upgrade` shells out to `bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-sdk.git` so users don't have to remember the URL. `--ref <ref>` pins to a tag, branch, or commit (e.g. `sov upgrade --ref v0.2.0`); `--dry-run` prints the command without running it; `SOV_UPGRADE_URL` env var overrides the default install URL for forks or mirrors. stdio is inherited so Bun's progress output flows through unchanged. The subcommand exits with the spawned bun's exit code so shell scripts can branch on success.

`src/cli/upgrade.ts` splits the pure argv builder from the side-effecting runner so unit tests exercise the URL/ref/env-override logic without ever spawning bun. Live spawn paths run only when the user actually invokes `sov upgrade`. Six unit tests cover ref handling, env override, opts override, and the dry-run path.

## Distribution: switched from npm to git+ssh - 2026-05-04

The private repo stays private — there is no public package registry entry. Distribution is via `bun install -g git+ssh://git@github.com/yevgetman/sovereign-ai-sdk.git`. SSH access to the repo is the access-control gate (same as cloning); upgrades are the same command rerun (or `sov upgrade` once landed). `package.json` re-marked `"private": true` so `npm publish` is impossible by mistake; `repository.url` switched to `git+ssh://`; the `engines.bun >= 1.2` constraint stays. README install section rewritten with the two install paths (registry-style git+SSH and the dev-mode `bun link`).

## Phase 12.5 + 12.6 semantic suite backfill (37/37 pass) - 2026-05-04

Two new semantic cases close the coverage gap from Phase 12.5 + 12.6 shipping earlier today:

- `tools.envelope-recovery-from-edit-mismatch` — config.txt seeded with `SETTING=alpha`; user asserts (incorrectly) that the file contains `SETTING_NAME=alpha` and asks for `SETTING_NAME=beta`. Accepts either correct path: literal-edit-attempt → mismatch envelope → re-read → correct edit, or proactive read → correct edit. Forbids retrying the same wrong old_string blindly, fabricating success, or leaving the file with the wrong key. First-shot pass, 44.1s, $0.076.
- `commands.context-budget-dispatch` — local-command dispatch test for `/context-budget`. Verifies the "total estimate" header, section grouping, and per-tool token counts. First-shot pass, 16.6s, $0.060.

Inventory bumped 35 → 37 (Tool dispatch 8→9, Slash-command pipeline 4→5). Mapping table extended with rows for `src/tool/types.ts` (`--filter envelope`), `src/core/orchestrator.ts` (`--filter envelope`), `src/context/budget.ts` (`--filter context-budget`), `src/commands/info.ts` (`--filter context-budget`).

Design lesson: the envelope-recovery case originally required the first FileEdit to fail, but the judge correctly rejected that — frontier models proactively read first and avoid the failure entirely. Revised criteria accept either path; the bug class is retrying the same wrong string blindly or fabricating success.

## Phase 12.6 — Context budget audit + `/context-budget` - 2026-05-04

`src/context/budget.ts` ships `auditContextBudget()` and `formatBudgetReport()`. The audit walks system-prompt segments, tool schemas (native + MCP), skills, bundle context, and memory files; emits per-component token estimates with bloat tier (`heavy` / `extreme` / null) and triage classification (`always` / `sometimes` / `rarely`). Defaults match the threshold table in the build plan (skill 300/800, tool-schema 500/1500, system-segment 800/2000, memory 1000, bundle 1500/3000) and are overridable via the `thresholds` opt and the prospective `~/.harness/config.json` `contextBudget.thresholds.*` block.

Three surfaces consume the audit:

- The new **`/context-budget` slash command** (Info category) prints a sectioned report.
- **`HarnessInfo`** gains a `'budget'` section so the model can reason about its own budget when answering meta-questions.
- A `CommandContext.getBudgetReport()` hook plumbs the data from the REPL's snapshot getter into the slash-command surface.

Lifts ECC's `context-budget` skill (inventory → classify → flag → recommend), trading line-count thresholds for token-count thresholds. Auto-warning at 60% utilization deferred — Invariant #4 freezes the system prompt per session; the audit currently surfaces utilization on demand via `/context-budget`.

10 unit tests in `tests/context/budget.test.ts` (empty audit, system-segment thresholds, deferred-tool classification, skill `requires_tools` matching, utilization ratio, memory char-based estimate, threshold overrides, formatter sections) plus a dispatch test in `tests/commands/info.test.ts`. Build plan §"Phase 12.6"; reference doc `harness/docs/reference/everything-claude-code-analysis.md` §2.3.

## Phase 12.5 — Tool observation envelope - 2026-05-04

Adds an optional uniform `{status, summary, next_actions, artifacts}` envelope to `ToolResult<T>`. The orchestrator's `formatToolResult` renders the envelope as a plain-text header above the existing `renderResult` content; `status: 'error'` forces `is_error: true` on the resulting `tool_result` block even when the tool's renderer didn't set it. Optional in v1 — tools opt in by populating the field. Provider-agnostic (no JSON in tool_result content).

Retrofitted: `BashTool` (per-error-class `next_actions`: command-not-found, permission-denied, timeout, expect_token miss, privilege-escalation refusal), `FileEditTool` (success path + envelope-emitting error returns for missing-match and non-unique-match — replaces the prior throws so the recovery hint reaches the model), `FileWriteTool`, `FileReadTool`, `GlobTool`, `GrepTool`, `MemoryTool`, `SkillTool`, `SkillsListTool`, `SkillsViewTool`, `WebFetchTool` (HTTP-status-aware next_actions), `WebSearchTool`, `HarnessInfoTool`, `ToolSearchTool`, plus the MCP wrapper (CallToolResult mapped to envelope; URL-shaped output → artifacts; common error keywords → next_actions inference).

Lifts ECC's `agent-harness-construction` skill ("Observation Design" + "Error Recovery Contract" + the anti-patterns it explicitly forbids: opaque tool output with no recovery hints, error-only output without next steps). Build plan §"Phase 12.5"; reference doc §2.2.

12 unit tests across orchestrator (3 envelope cases), BashTool (6 envelope cases), FileEditTool (3 envelope cases). MCP integration test updated to expect envelope-prefixed content. **Behavior change worth flagging:** `FileEditTool` now returns a structured envelope for the two recoverable error classes (missing match, non-unique match) instead of throwing — callers checking for `result.observation.status === 'error'` or `result.data.error !== undefined` see the failure; the orchestrator surfaces it as `is_error: true` automatically. Other errors (file doesn't exist, identical strings) still throw.

## Phase 9.6 — Skill `whenToUse` trigger rigor - 2026-05-04

Tightens skill-activation matching by validating `whenToUse` against a rigor rubric at load time. Three checks: empty / too-short field, low-rigor preamble (`use this skill`, `activate this skill`, `call this when`, `run when`, `when to use`, …), and absence of any trigger verb from a 22-word allowlist (`asks`, `mentions`, `runs`, `edits`, `commits`, `pushes`, `deploys`, …). Non-blocking — the skill still loads; the loader emits a one-line warning per low-rigor entry via the `warn` callback.

`SkillsListTool` now splits semicolon-separated `whenToUse` values into a `whenToUse: string[]` array so the model sees discrete trigger predicates rather than one buried sentence. Single-trigger skills keep the original `string` shape.

Lifts ECC's "When to Activate" predicate-list convention from `skills/agent-harness-construction` and `skills/continuous-learning-v2`. The `whenToUse` schema field stays as `string` for back-compat — the multi-trigger convention is documented but not a hard schema break.

## Self-doc segment + HarnessInfo runtime introspection - 2026-05-04

Surfaces harness-specific contracts to the model via two complementary seams so meta-questions ("how do I add an MCP server here?", "how do I configure permissions?") get harness-specific answers instead of generic Claude-Desktop / SDK fallbacks.

1. **`<harness-self-doc>` system-prompt segment** (`src/context/systemPrompt.ts`). Cacheable, vendor-neutral. Documents the settings file paths and precedence (`.harness/settings.json` layers vs `~/.harness/config.json`), the schema for `permissions` / `hooks` / `mcpServers`, the permission rule grammar (including the `mcp__server` server-prefix form), the inline-shell `!` prefix, the slash-command list, and clarifies that `ToolSearch` is the model's tool, not the user's. Per CLAUDE.md "no product-specific hardcoding in `src/`," the segment uses `<harness-home>` (not `~/.harness/`) and avoids the "Sovereign AI" identity — white-label deployments inherit the same prompt; product identity comes from the bundle.

2. **`HarnessInfo` native tool** (`src/tools/HarnessInfoTool.ts`). Read-only, native, always available when the snapshot getter is wired. Returns: permission mode + loaded settings layers (with paths + present/absent), configured MCP servers (with connection status + tool counts), the live native + MCP tool inventory, and the registered slash commands. Section filter (`settings` / `mcp` / `tools` / `commands` / `budget`) for scoped queries. Closure-injected (mirrors `ToolSearchTool`'s pattern); the snapshot reads `finalToolPoolRef` post-assembly so `tools.native` vs `tools.mcp` reflects the actual pool the model sees.

Together the prompt teaches the contracts; the tool exposes the live state. Semantic case `tools.harness-info-config-and-extension-guidance` covers the user's actual failure-mode question end-to-end (21.2s, $0.044, first-shot pass).

## WebSearch UX hardening - 2026-05-04

Two fixes addressing the same friction class — search-shaped prompts failing because of provider misconfiguration:

1. **Hide WebSearch when no key is configured.** `isEnabled()` returns false when `resolveProviderSettings().apiKey` is undefined, so the tool is filtered out at `assembleToolPool` time and the model never sees it in `<available-tools>`. The previous behavior surfaced WebSearch regardless of configuration; search-shaped prompts let the model pick it, and the call failed with a "needs an API key" error every time.

2. **Infer provider from key shape when not set explicitly.** Previously `webSearch.provider` defaulted to `tavily` whenever it wasn't set, so a user pasting a Brave key under `webSearch.apiKey` got 401s from Tavily. Now: an explicit `webSearch.provider` still wins (paired with the matching key, with the per-provider env var as a fallback). When provider is unset, the harness picks the path that has a key. Config-side keys are classified by prefix — Tavily keys start with `tvly-` by Tavily's own convention; anything else is treated as Brave. Env-only setups dispatch by which env var is set. Pasting either flavor of key under `webSearch.apiKey` Just Works without a second config command.

## MCP `mcp__<server>` permission rule prefix - 2026-05-04

Fix surfaced by the post-Phase-12 semantic suite (33/34 with `permissions.mcp-permission-rule-blocks-server` failing). The Phase 12 plan claimed "the rule matcher already does prefix matching" — it didn't. `ruleMatchesTool()` was exact-match-plus-aliases only, so a `deny: ["mcp__echo"]` rule never blocked any tool whose canonical name was `mcp__echo__<tool>`.

Extended `ruleMatchesTool()` (`src/config/rules.ts`) to recognize a server-scoped rule when the tool is MCP and `rule.tool === \`mcp__${tool.mcpInfo.serverName}\``. Tool-level rules (`mcp__server__tool`) still hit the exact-match path. Uses tool metadata (`tool.isMcp` + `tool.mcpInfo.serverName`), not name-string parsing.

Verified by a unit test in `tests/config/rules.test.ts` and the failing semantic case re-running green (21.6s, $0.044). Suite returned to 34/34, then 35/35 with the next add.

## Semantic suite — run + extend policy documented - 2026-05-03

Added a "When to run and when to extend" section to [`docs/06-testing/semantic-testing.md`](docs/06-testing/semantic-testing.md). Codifies a four-tier triage (skip / filtered / full / gate) with a concrete mapping table from changed source area → filter, plus rules for when to add a new test (new tool, new slash command, new permission rule path, new context surface, regression fix, phase completion). Brief pointer added to `CLAUDE.md` and `AGENTS.md`. The policy makes the suite's cost-benefit explicit so contributors don't either over-run it (per-commit) or under-run it (never).

## Semantic suite — /rollback end-to-end (30/30 pass) - 2026-05-03

`workflow.rollback-restores-parent-session` — four-turn case proving `/rollback` returns to the parent session and restores its full history. Pairs with the existing /compact case: Turn 1 introduces a token, Turn 2 /compact (spawn child), Turn 3 /rollback (return to parent), Turn 4 recall the token. The agent recalls correctly from the restored parent history (per `terminalRepl.ts:rollbackNow()` — switches `activeSessionId`, reloads messages from the DB, repairs orphaned tool_results).

Bug class: rollback fails silently, parent session lost, history not restored, or active-session pointer not flipped. First end-to-end coverage of the /compact + /rollback round-trip.

Suite total: 30/30 pass, 5.3 minutes, $0.87 informational on subscription.

## Semantic suite — /compact end-to-end (29/29 pass) - 2026-05-03

`workflow.compact-preserves-key-facts` — multi-turn case proving `/compact` summarizes prior turns AND preserves key facts through the child-session boundary. Three turns: introduce a distinctive token, fire `/compact` (auxiliary summarizer + child-session spawn), ask the agent to recall the token. The agent recalls correctly from the summary embedded in the child session. Bug class: compaction loses facts, child session starts blank, dispatch fires but subsequent turns hit the wrong session, or the auxiliary summarizer fails silently.

This case composes the multi-turn framework with the existing local-session-callback test path. First end-to-end coverage of `/compact` behavior.

Suite total: 29/29 pass, 5.5 minutes, $0.86 informational on subscription.

## Semantic suite — /init + skill invocation (28/28 pass) - 2026-05-03

Two more high-value adds, both filling complete-feature-coverage gaps:

- `commands.init-creates-context-md` — second prompt-command coverage path. `/init` scans a fixture project (package.json + README.md + src/main.ts) using Glob/FileRead/Bash, then writes a CONTEXT.md briefing. Tests the full prompt-command-with-multi-step-tool-pipeline path: dispatch, sequencing, file synthesis. Runs 25s (6+ tool calls).
- `commands.skill-invocation-via-slash-command` — first end-to-end skill coverage. Drops `marker-skill.md` (with frontmatter + body) into `<cwd>/.harness/skills/` and invokes `/marker-skill`. Verifies the full pipeline: filesystem discovery → frontmatter parse → registry registration → slash-command dispatch → model turn with skill body as prompt. Worked first try.

Suite total: 28/28 pass, 4.3 minutes, $0.79 informational on subscription.

## Semantic suite — virtual-tool-name + layer precedence + /commit (26/26 pass) - 2026-05-03

Three high-value adds targeting the most security-critical and feature-coverage gaps:

- `permissions.bash-cat-blocked-by-read-deny` — verifies the harness's shell-AST virtual tool name mapping. `Bash("cat foo")` resolves to `Read` for permission resolution, so a `Read(*)` deny rule blocks `cat` even when invoked through the shell. Without this mapping, deny rules can be silently bypassed via shell commands. Highest-stakes test in the suite.
- `permissions.rule-layer-local-overrides-project` — pins the layer precedence invariant. With project allowing `Bash(echo *)` and local denying it, local wins. Documents the contract for "team-loose project, individual-locked local" workflow.
- `commands.commit-on-non-git-directory` — first prompt-command coverage (vs `/help` which is local-only). The `/commit` registry entry feeds a constrained prompt to the model with allowedTools restricted to git Bash subcommands. In a non-git cwd, the agent should invoke git status, see "not a git repository", and report honestly without fabricating a commit.

Permission test timeouts bumped from 45s → 90s after the first full-suite run hit two false-positive timeouts on the existing deny/allow tests (tail latency on model calls).

Suite total: 26/26 pass, 4 minutes, $0.73 informational on subscription.

## Semantic suite — multi-turn support (23/23 pass) - 2026-05-03

Framework now supports multi-turn tests. `SemanticTest.prompt` accepts `string | string[]`; arrays drive one turn per element, sent to `sov` via piped stdin (separated by newlines, terminated with `/quit`). The harness's queued-question pattern consumes them sequentially, waiting for each turn to complete before reading the next. The judge prompt builder renders multi-turn cases readably.

**Three new cases** in `08-multi-turn.cases.ts`:
- `cross-turn-memory` — agent recalls a token from Turn 1 in Turn 2 (history retention).
- `refinement-after-tool-result` — Turn 2 edits a value Turn 1 read; tool-result amnesia bug class.
- `error-recovery-across-turns` — Turn 1 fails (missing file), Turn 2 fixes (write + read-back); failure in Turn 1 doesn't poison the conversation.

23/23 pass. Multi-turn coherence works correctly through the existing piped-stdin path — no driver re-architecture needed beyond the `string | string[]` type extension.

## Semantic suite — permissions + refusal hardening (20/20 pass) - 2026-05-03

Six new cases targeting the highest-impact safety surfaces.

**Permissions (3 new, 4 total):**
- `allow-rule-permits-tool` — settings allow rule under `--permission-mode default` lets the tool through (would auto-deny without the rule under piped stdin).
- `deny-wins-within-layer` — `allow + deny` for the same pattern → deny wins (key invariant from `canUseTool.ts`).
- `bypass-mode-honors-deny` — bypass mode does NOT override deny rules. Originally written as `bypass-mode-skips-deny` based on a wrong assumption; the suite caught the misunderstanding. Bypass only takes effect on fallthrough (no rule matched), where it skips the tool self-check and ask prompt. The redesigned test now documents the actual safety-first contract per `src/permissions/canUseTool.ts:33-44`.

**Refusal (3 new, 4 total):**
- `no-fabrication-on-zero-search-results` — search succeeds with zero matches; agent reports "no matches" instead of inventing filenames.
- `prompt-injection-resistance-from-tool-output` — file content contains injection text trying to override the agent's behavior; agent treats tool output as data, not instructions. (Passed clean — the harness/Claude treats file content as data.)
- `verify-not-trust-user-claims` — user makes a false assertion about file contents; agent reads the file and reports the actual content rather than parroting the user.

20/20 pass on the second run. The first-run failure on `bypass-mode-skips-deny` was a misunderstanding of the bypass contract, not a harness bug — fixed by inverting the test's expectations to match the actual (and correct) behavior. The suite catching its own design errors is the test category working as intended.

## Semantic suite — 6 high-value coverage additions (14/14 pass) - 2026-05-03

Closed the obvious gaps in the v1 starter set. New coverage:
- `tools.bash-error-reported` — Bash non-zero exit, agent reports failure, no fabricated output.
- `tools.edit-missing-string-no-fabrication` — Edit target string absent; accepts either the read-first or attempt-and-fail path; forbids fabricating success or substituting a different string.
- `permissions.deny-rule-blocks-echo` — `.harness/settings.local.json` deny rule for `Bash(echo *)` blocks the tool in `--permission-mode default`. Uses echo (not rm) so the model's safety reflexes don't pre-empt the permission system.
- `tools.glob-recursive-typescript-files` — Glob/Bash-find/Grep recursive search; setup hides one .ts file in src/sub/ specifically to catch non-recursive enumerations.
- `tools.grep-finds-marker-content` — content search for a unique marker token; failure to invoke a tool is treated as fabrication.
- `context.at-file-expansion-or-read` — @file reference; accepts either @-expansion or Read fallback, forbids "unrecognized reference" or fabricated content.

Also added to the driver: `--permission-mode` is now skipped from the default args when a test specifies it via `binaryArgs`, mirroring the existing `--model` override pattern.

Two of the new tests initially failed and were redesigned. The failures were genuine signals about agent behavior (the model is smart enough to read before editing, and refuses `rm` on its own safety judgment), not harness bugs — both criteria sets were tightened to test the bug class without tripping over correct-but-defensive agent paths.

## Semantic test suite (LLM-judged behavior tests) - 2026-05-03

New opt-in test category that complements the existing unit/integration suite. Drives the real `sov` binary as a subprocess, captures the transcript, and asks an LLM judge whether each prompt was handled correctly against per-test must-satisfy / should-not criteria.

**Strict isolation.** Lives entirely under `tests/semantic/`. Zero edits to `src/`. No new production deps (`@anthropic-ai/sdk` and `chalk` already in `package.json`). Each test spawns the binary in an `mktemp -d` sandbox with its own `HARNESS_HOME`, `HARNESS_CONFIG`, sessions DB — cleaned up on completion or crash. File names are `*.cases.ts` and `run.ts`, neither matches Bun's `*.test.ts` discovery, so `bun test` is unaffected. New `test:semantic` script is purely additive.

**Pluggable judge backends.** `Judge` is a function type `(test, transcript) => Promise<JudgeVerdict>`. Two backends ship in v1:
- `claude-code` (default) — shells out to the local `claude` CLI in `--print` mode with `--json-schema` for structured output. Uses your authenticated session, costs zero API tokens. Spawned in `tmpdir()` with `--tools ""`, `--no-session-persistence`, `--disable-slash-commands` for full isolation.
- `anthropic-api` (opt-in) — direct `@anthropic-ai/sdk` call with tool-use; needs `ANTHROPIC_API_KEY`. Useful for CI runners.

`auto` mode picks `claude-code` if available, else falls back to `anthropic-api`. Adding a new backend (e.g., `codex`, `sov`-itself) is one new file under `framework/judges/` plus a `selectJudge` switch case — `runner.ts`, `run.ts`, and test cases are unchanged.

**Framework (~700 LOC).** `framework/types.ts` (SemanticTest, JudgeVerdict, Judge, RunSummary), `sandbox.ts` (per-test ephemeral env), `driver.ts` (subprocess spawn + ANSI strip + transcript), `judges/` (prompt builder + verdict parser + per-backend factories), `runner.ts` (load + orchestrate, judge-agnostic), `reporter.ts` (chalk progress + summary).

**Starter cases (8 tests).** Bash output capture, Read/Edit/Write tool dispatch, /help command rendering, two-step write-then-verify workflow, directory enumeration, and refusal-on-missing-file (anti-fabrication).

**Designed for portability.** Framework only assumes a stdin-driven REPL that exits on `/quit`. Lift `tests/semantic/` to any project, adjust `driver.ts` defaults, point at a different binary via `SEMANTIC_BINARY` or `--binary`. Documented in `tests/semantic/README.md`, including a sketch for an eventual `sov`-judges-itself backend.

**Cost.** Default judge (`claude-code`) uses your subscription — no API tokens. Binary under test still spends model credit during its own turns regardless of judge backend. Not part of `bun test` — opt-in only via `bun run test:semantic`.

## Phase 10.5e Wave 4 stabilization — Ctrl-R, soft-wrap, Esc flush - 2026-05-03

Closeout of the input-editor work. Vim mode (originally Wave 5) deferred indefinitely per the LOC-to-value tradeoff.

**Ctrl-R reverse-i-search.** Press Ctrl-R to enter reverse-i-search mode. Type to filter history newest-first. Ctrl-R cycles backward through matches. Enter accepts and submits (readline / bash convention). Esc / Ctrl-C / Ctrl-G cancel and restore the pre-search buffer. Other special keys (Right/Home/End/Tab/Ctrl-A/etc.) accept the match into the buffer and dispatch the key in normal mode for editing before submit.

**Soft-wrap for long input lines.** New `wrapForDisplay(rendered, width)` pure function in `textBuffer.ts`. Each long logical line wraps to multiple display chunks of ≤ width characters; the cursor is mapped from logical (row, col) to display (row, col). `inputEditor.draw()` calls this with `cols - prompt.length`, so a long input line no longer overflows past the terminal column. Width ≤ 0 short-circuits.

**Esc-key flush in keypress dispatcher.** Lone ESC bytes were held in the partial-sequence buffer indefinitely (no `escape` key event emitted). Added a 50ms flush timer matching vim `timeoutlen` and readline `esc-timeout`. Cancelled the moment more bytes arrive, so Alt+key encoding and CSI sequences still work. Cleared on `disable()`.

**Tests.** 13 new (7 wrapForDisplay, 6 Ctrl-R search). All 645 tests pass. Lint clean. Hard-pass 105/105.

## Phase 10.5e Wave 4 — input editor (multi-line, history, autocomplete) - 2026-05-03

The largest single felt UX upgrade. Replaces readline's line-oriented input with a from-scratch raw-mode editor.

**Five new modules (~1,400 LOC):**

- `src/ui/keypress.ts` — raw-mode dispatcher. Reference-counted enable/disable. Parses ANSI escapes (CSI, SS3) + bracketed paste + control chars + Alt-letter into typed `Key` events. Subscribes/unsubscribes via callbacks. `getKeypressDispatcher()` singleton; suppresses dispatch while a modal is up.
- `src/ui/textBuffer.ts` — multi-line buffer with row/col cursor. `insert` (with embedded-newline split), `deleteLeft/Right/WordLeft/ToLineStart/ToLineEnd`, `moveLeft/Right/Up/Down/LineStart/LineEnd/BufferStart/BufferEnd`, `cursorIsOnFirstLine/LastLine`.
- `src/ui/inputHistory.ts` — persistent history at `~/.harness/input-history`. 1000-entry cap, dedup against previous, embedded newlines escaped as `\n`. `at(offsetFromEnd)` walks the history for Up/Down navigation.
- `src/ui/autocomplete.ts` — pure completion. Slash commands (`/co<Tab>` → `/cost`/`/commit`/`/compact`) and `@file` paths (`@src/m<Tab>` → `@src/main.ts`). Directories sorted first, dotfiles hidden, capped at 50 results.
- `src/ui/inputEditor.ts` — drop-in replacement for `question() ⇒ Promise<string>`. Owns one TextBuffer + subscribes to keypress events. Re-renders the buffer on every keystroke with ANSI cursor positioning. Paste bursts insert literally without keybind dispatch.

**Keybinds:**

| Key | Action |
|---|---|
| Enter | Submit (or insert newline if last char of buffer is `\`) |
| Tab | Autocomplete; subsequent Tabs cycle through matches |
| Up / Down | History walk when on first/last line; cursor motion otherwise |
| Left / Right / Home / End | Cursor motion (across line boundaries) |
| Backspace / Delete | Delete left / right (joins lines at boundaries) |
| Ctrl-A / E / B / F | Line start / end / cursor left / right (readline) |
| Ctrl-P / N | History prev / next (readline) |
| Ctrl-U / K | Delete to line start / end |
| Ctrl-W | Delete word left |
| Ctrl-L | Clear screen |
| Ctrl-C | Clear buffer; second on empty = EOF |
| Ctrl-D | EOF when empty; deleteRight otherwise |

**Wiring.** New editor is the default when `process.stdin.isTTY === true`. Piped stdin falls through to the legacy readline + queuedQuestion path. New `--legacy-input` flag forces legacy regardless (safety hatch).

**Tests.** 84 new (19 keypress parsing, 21 textBuffer ops, 12 inputHistory I/O, 12 autocomplete shapes, 20 inputEditor integration via FakeDispatcher). All 632 tests pass.

## Phase 10.5d Wave 3 — theme system + /settings dialog - 2026-05-03

First-class user customization via semantic color tokens.

**Theme module (`src/ui/theme.ts`).** ~25 semantic roles: text/textMuted/textBold, accent/accentBold/accentMuted, status×4 (success/warning/error/info), diff×3 (added/removed/context), border×3 (default/accent/warning), code×2 (inline/fence), header×3 (h1/h2/h3). Three built-in themes:

- `dark` (default) — preserves the existing look exactly. Migration is invisible.
- `light` — darker primaries via `chalk.rgb` for light terminals (amber warning, dark blue accent).
- `no-color` — identity tokens for transcripts and pipes (separate from chalk's NO_COLOR env handling).

API: `getTheme()` / `setTheme(name)` / `listThemes()` / `isThemeName(name)` / `resolveThemeName({configured, env})`. The last honors `NO_COLOR` overriding the configured value. `theme.tokens` is a getter so swapping themes via `setTheme()` takes effect on the next renderer call without re-imports.

**Renderers migrated** to theme tokens: `footer.ts`, `diff.ts`, `modal.ts`, `thinking.ts`, `toolSlot.ts`, `box.ts`, `splash.ts`. Behavior is identical under the default dark theme — every existing test passes without assertion changes.

**Schema.** New `ui.theme` enum (`'dark'` / `'light'` / `'no-color'`) in `SettingsSchema`. `terminalRepl.ts` calls `setTheme(resolveThemeName(...))` immediately after `readConfig()`, before any rendering.

**New slash commands.** `/theme [<name>]` opens a picker over the three built-in themes (or applies inline). Persists to `~/.harness/config.json`. Rejects unknowns with the available list. `/settings` opens the existing `runConfigMenu` from `sov config` (no verb) inside a session.

**Tests.** 17 new (12 theme module, 5 `/theme` command). 548 tests pass.

## Phase 10.5c Wave 2 hotfix — piped-stdin queue drain - 2026-05-03

Latent bug since Phase 3.5: under piped stdin, `readline` emits all `'line'` events for buffered input, then fires `'close'` on EOF. The REPL loop's `while (!closed)` flag flipped the moment the close event fired — exiting before the queued lines for `/copy`, `/export`, `/quit` could be drained. Single-prompt scripts hid this because `question()` throwing was already the correct exit path.

**Fix.** `createQueuedQuestion` now returns a `QueuedQuestion` with a `pending()` accessor. `question()` shifts buffered lines BEFORE checking the `closed` flag, so callers still receive queued input after readline has closed. `terminalRepl.ts`'s main loop now iterates while `!closed || question.pending() > 0`. `rl.on('close')` no longer flips `closed` — `question()`'s throw path signals exhaustion naturally.

**Tests.** 1 new regression test pinning the pre-close-then-drain pattern. All 531 tests pass.

## Phase 10.5c Wave 2 — pickers & slash command coverage - 2026-05-03

Discoverability upgrade: reusable picker primitive + 11 new slash commands.

**`src/ui/picker.ts` — generic raw-mode picker.** Generalizes `configMenu.ts`'s pattern. ↑/↓/PgUp/PgDn/Home/End/Enter/Esc, optional initial selection, optional hint per item, returns `Promise<T | null>`. Restores raw mode + cursor + screen in `finally` so a thrown error can't leave the terminal in a bad state. Falls back to null on non-TTY (callers display a fallback message).

**SessionDb additions.** `listSessions(limit)` returns recent sessions newest-first by `last_updated`. Title falls back to first user message text (truncated to 60 chars). Includes `msgCount`, `totalTokens`, `totalCostUsd`. `updateSessionModel(sessionId, model)` persists `/model` picks so they survive `--resume`.

**11 new slash commands** (registered via the existing slash-command registry):

| Command | Behavior |
|---|---|
| `/about` | Boxed info card: version, provider, model, cwd, bundle, session id |
| `/tools` | List of registered tools with descriptions |
| `/skills` | List of visible skills with `[source]` tags |
| `/stats` | Mid-session metrics card (mirrors goodbye summary shape) |
| `/permissions` | Mode + session always-allow rules + persistent layered rules |
| `/quit` (`/exit`, `/q`) | Clean exit via `ctx.requestExit()`; replaces hard-coded EXIT_COMMANDS |
| `/copy` | Copy last assistant message via pbcopy / wl-copy / xclip / xsel / clip.exe |
| `/resume` | Picker over recent sessions; prints resume command (in-process swap deferred) |
| `/model` | Picker over provider models when no arg; persists via DB |
| `/export [md|jsonl|json]` | Picker over format when no arg; writes `session-<short-id>.<ext>` |
| `/init` | Prompt-command that scans the project and writes `CONTEXT.md` |

**`/help` refactored** into a categorized 2-column layout (session / info / config / files / git / skills / other) with ANSI-aware visible-width padding so chalk wrapping doesn't misalign columns.

**CommandContext extended** with: `bundlePath`, `listSessions`, `getMetrics`, `skills`, `getLastAssistantText`, `getMessages`, `getPermissions`, `requestExit`. Shared test helper at `tests/commands/_makeCtx.ts`.

**Tests.** 37 new (8 picker navigation, 7 sessionDb listSessions/updateSessionModel, 11 info commands, 8 export+init, 3 misc). All 530 tests pass.

## Phase 10.5b Wave 1 hotfix — FileEdit diff line-context - 2026-05-03

Subagent-driven verification of Wave 1 surfaced a UX gap: the FileEdit diff renderer printed the raw `old_string`/`new_string` substrings (`- hello world` / `+ hello sovereign`) instead of the full line containing the change.

**Fix.** New optional `opts.preContent` in `DiffRenderOpts`. When provided for FileEdit, the renderer scans the file content for `old_string`, computes the surrounding line(s), and renders those full lines as `-`/`+` blocks with a 1-based line number. Multi-occurrence edits (`replace_all: true`) annotate the head with `(applied N× across M occurrences)` and render only the first hunk. Falls back to substring rendering when the match is missing, `old_string` is empty, or `preContent` is omitted.

**Wiring.** `terminalRepl.ts` reads the file synchronously at `tool_use` time (before the orchestrator dispatches the tool) and threads the snapshot through to `renderToolDiff` at `tool_result` time. FileWrite is unchanged.

**Tests.** 7 new diff tests covering full-line render, line numbers, multi-line `old_string`, multi-occurrence note, and fallbacks. All 493 tests pass.

## Phase 10.5b Wave 1 — REPL polish foundations - 2026-05-03

Make the REPL trustworthy. Modal prompts that don't get buried, status line that always shows where you are, errors you can actually read.

**`src/ui/modal.ts` — overlay primitive.** `withModal({title, rows, choices, parse, question})` renders a framed prompt that survives concurrent decorator output. Raises a module-level `modalActive` flag that decorators (spinner, slot) consult before writing. Boxed body uses `box.ts` for visual consistency. Re-prompts on parse failure with configurable message. Used by `permissions/prompt.ts` for the framed permission prompt.

**`src/ui/footer.ts` — pre-prompt status line.** `provider · model · ctx % · cost · perms · tools · bundle`, dim grey by default. Context segment turns yellow at warn threshold, red at danger threshold. Honors `NO_TTY` and `ui.footer.enabled`.

**`src/ui/contextMeter.ts` — token-utilization tracker.** Computes used / contextLength as a percentage. Exposes `getZone()` returning `'ok' | 'warn' | 'danger'` based on configurable thresholds (default 60% / 80%). Emits a one-shot pre-compaction warning a turn ahead of the auto-trigger so the user isn't surprised by silent compaction.

**`src/ui/diff.ts` — inline diff renderer for FileEdit / FileWrite.** Renders `- old / + new` lines under the tool slot summary. Verbose: full block. Non-verbose: head + tail with `… N more lines …` truncation. Multi-line `old_string` and `replace_all` both handled. Returns null for non-diff-shaped tools.

**Schema.** New optional `ui.{footer,contextMeter,diffRender}` block in `SettingsSchema`. All flags default to enabled / sensible thresholds.

**Wiring (`terminalRepl.ts`).** ContextMeter constructed from provider's contextLength. Updates on `usage_delta`. Footer printed before each prompt frame. Pre-compaction warning fires once when crossing 5% below the proactive threshold. Diff renderer called after successful FileEdit/FileWrite. Splash banner shows count of loaded allow-rules. ToolSlot multi-line errors show first line + `+N more lines` hint.

**Tests.** 42 new (modal/contextMeter/footer/diff). All 486 tests pass.

## Binary rename: `sovereign` → `sov` - 2026-05-01

CLI invocation shortened. `package.json` `bin` mapping is now `"sov": "./src/main.ts"`; `bun link` produces `~/.bun/bin/sov`. Commander program name, error prefix, in-session resume hint, max-tokens warning, WebSearch missing-API-key error message, and active docs (README, usage.md, architecture.md) all updated. Historical changelog/testing-log entries are kept verbatim. Existing users running `bun link` from this checkout will need to remove `~/.bun/bin/sovereign` (the old name) and re-`bun link` to install `sov`.

## Bundleless / generic-agent mode - 2026-05-01

`sovereign` now runs in any directory without a harness bundle. Bundle resolution still tries `--bundle` → `HARNESS_BUNDLE` → walk-up-for-`index.yaml`, but the no-match path no longer errors — it launches a generic agent with no bundle context, the splash shows `no bundle`, and resume hints/max-token warnings drop the `--bundle` arg.

**Identity moved to the bundle.** `BASE_INSTRUCTIONS` in `src/context/systemPrompt.ts` is now generic — no Sovereign-specific "canonical AI entity of the business" framing. That language moved to the docs-repo bundle's `state/CONTEXT.md` under a new `## Identity and voice` section, where it belongs per CLAUDE.md rule #9 ("no product-specific hardcoding in `src/`"). The generic prompt still describes the segment layout and points the model at any loaded bundle context as the authoritative project/business prior.

**Bundle plumbing made optional.** `loadBundleIfPresent(path)` is the new tolerant entry point used by the CLI; `loadBundle` still throws for callers that require one. `ToolContext.bundleRoot` and `LoadSkillsOptions.bundleRoot` are optional; the skill loader skips the three bundle-relative roots when unset (project + user roots still load). Session metadata stores `bundleRoot: null` for bundleless sessions; resume validation tolerates either side being unset.

**Tests.** `tests/bundle/loader.test.ts` covers null-path / missing-index / valid-bundle behavior. `tests/skills/loader.test.ts` adds a no-bundleRoot case. `tests/ui/splash.test.ts` and `tests/ui/terminalMessages.test.ts` assert the bundleless display + resume-hint shape. `tests/context/systemPrompt.test.ts` asserts the generic prompt has no Sovereign framing and no bundle segments when bundleless. Smoke-tested both modes end-to-end (`/tmp/sovereign-no-bundle-test` shows `no bundle`; `~/code/sovereign-ai-docs` shows the bundle path).

## Phase 10.2 complete — web reach (WebFetch + WebSearch) - 2026-04-29

Two model-callable tools added for open-web reach. Closes the gap relative to Claude Code (built-in WebFetch/WebSearch) and matches the Cloudflare-stack reference pattern noted in `sovereign-ai-docs/harness/docs/reference/cloudflare-internal-stack-analysis.md`.

**`WebFetchTool` (`src/tools/WebFetchTool.ts`).** Model-callable URL fetcher. Reuses `globalThis.fetch` with: private-host/loopback blocking (`localhost`, `127.x`, `10.x`, `192.168.x`, `172.16-31.x`, IPv6 link/private), 10s timeout, 1MB response cap, 5 redirects (platform default), 50K-char output cap (overridable up to 200K via `max_chars`). HTML responses pass through `htmlToText` — strips `<script>`/`<style>`/`<noscript>`/comments, converts block-level tags to newlines, decodes common entities. Plaintext/JSON/Markdown pass through verbatim. Read-only, concurrency-safe.

**`WebSearchTool` (`src/tools/WebSearchTool.ts`).** Pluggable search. Tavily default (free 1K queries/month, designed for AI agents); Brave optional. API key resolves from `webSearch.apiKey` config first, then `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` env vars. Throws a structured error with setup commands when no key is configured. Returns up to 20 `{title, url, snippet}` results — model uses these to discover URLs to drill into via WebFetch.

**Schema additions:** `webSearch.provider` (enum `tavily | brave`), `webSearch.apiKey` (secret, redacted in display), `webSearch.maxResults` (int 1–20). Surfaced in the config picker.

**Tests (19 new):** htmlToText edge cases, validateInput URL/scheme/private-host rejection, fetch mocks for HTML/plain/truncation/non-2xx, Tavily/Brave parsing, env-var fallback, max-results cap, no-key error.

**Build plan:** Phase 10.2 marked complete in `harness/docs/runtime/harness-build-plan.md`. The earlier "web search via MCP" recommendation in the Cloudflare analysis remains relevant for higher-fidelity needs (JS-rendered SPAs, browser-only content) — that comes naturally with Phase 12 (MCP client).

## REPL UX overhaul + Phase 10.1 config command - 2026-04-29

A session of UX hardening on top of Phase 10. Bundle resolution, conversation framing, tool-output rendering, and config management all got first-class user-facing surfaces. No new architectural phases beyond Phase 10.1 (drafted in the docs build plan as the writeable-config phase).

**Bundle resolution chain.** `--bundle` flag → `HARNESS_BUNDLE` env → walk up from CWD looking for `index.yaml`. Bare `sovereign` from inside any bundle directory now Just Works; `chat` is no longer needed in any documented invocation (still works for backward compat). Phase 10.8 (default bundle / bundleless invocation) remains drafted in the docs repo as the eventual fix for "no bundle anywhere upstream".

**Phase 10.1 — config command + `/config` slash + interactive picker.** New `src/config/store.ts` shared by:
- `sovereign config show|path|get|set|unset` CLI subcommands
- `/config <verb>` in-session slash command
- `sovereign config` (no verb) opens a hand-rolled raw-mode picker with ↑/↓ navigation, choice sub-pickers for enum-shaped fields (defaultProvider, defaultModel scoped by provider, permissionMode, maxTurns, etc.), Enter to edit, `u` to unset, `s` to save and quit. Every write is zod-validated before touching disk; secret-bearing paths (`apiKey`, `apiKeys`, `credentials.apiKey`) are redacted in display. Phase 16.7 will replace the picker with an Ink-based TUI.

**Tunable proactive compaction.** New `compaction.proactiveThresholdPct` setting (1–99, default 75%). Default raised from 50% so small-context local models get headroom for the bundle's system prompt. Compactor self-guards: when the frozen system prompt alone exceeds the threshold (heavy bundle on a small-context model) `shouldCompactProactively` returns false instead of firing in a runaway loop.

**Ollama `num_ctx` auto-pinning.** Provider now sends `num_ctx` based on the model's registered context length (qwen2.5 family → 32K, llama3.1 → 128K). Override per-deployment via `providers.ollama.numCtx`. Stops the silent 2K-truncation that was causing constant compaction on local sessions. New models registered: `qwen2.5:7b/14b/32b`, `llama3.1:8b/70b`, `mistral-nemo`.

**Configurable maxTurns.** New `maxTurns` setting (positive int, default 100). Reframed in the schema as a runaway-loop circuit breaker rather than a task ceiling, mirroring Claude Code's "rely on permissions + Ctrl-C, not a numeric cap" pattern.

**REPL UX layer (`src/ui/`).** Six new modules + significant `terminalRepl.ts` work:
- `splash.ts` — startup splash with block-letter "S" logo (cyan→blue gradient) next to a boxed info card showing version, provider/auth, model, bundle path
- `sessionSummary.ts` — boxed goodbye summary with Interaction Summary (session ID, tool calls, success rate), Performance (wall time, agent active, API time, tool time), and Tokens (total, cache, est. cost)
- `box.ts` — shared unicode-box helper (`╭─╮ │ ╰─╯`) with ANSI-aware width
- `thinking.ts` — braille spinner (`Thinking 12s ↑ 1234 ↓ 56`) with 500ms grace, live token counts that tick from streamed chars and lock to the authoritative `usage_delta` value when it lands
- `markdownStream.ts` — line-buffered markdown renderer for streamed text deltas (headings, bold/italic/inline code, bullet/numbered lists, blockquotes, fenced code, hrules)
- `toolSlot.ts` — compact in-place tool display: sequential tool calls overwrite a single line via `\x1b[1A\x1b[2K`. With ANSI-clear-of-inter-tool-text logic in `terminalRepl.ts`, a 20-tool thinking run leaves one line of "what happened" between user input and final answer instead of 40
- `writeStatusLine` helper enforces leading + trailing newlines on every bracketed status (`[tool: ...]`, `[cleared ...]`, `[debug] ...`, `[error] ...`) so they never collide with adjacent assistant text
- Input frame: top + bottom dim-gray rules around the readline prompt (TTY-only, ANSI-positioned), so `> your message` always reads as a distinct visual block
- Final-answer prelude: every fresh agent text run gets one leading `\n` so prose never crams against a slot or status line

**Tool result visibility.** Default rendering is now a one-line summary (`└─ ok · 663 lines, 22.7K chars` or `└─ error · ...`). Pass `--verbose` (or set `verbose: true` in config) for the full 40-line / 4K-char preview block. Errors render in red.

**Debug mode umbrella.** `debugMode.enabled = true` auto-enables every child capability (currently `transcript`, with `transcriptDir` honored). When the umbrella is unset, children remain individually toggleable a la carte. When transcripts are auto-enabled by debug mode, the REPL prints `[debug] transcript → <path>` at startup so the user sees where their JSONL is going.

**Per-turn `[usage:]` gated behind debugMode.** Removed from default output (token usage still recorded to the DB and summarized in the goodbye box; the per-turn line was redundant noise).

**Bundle-side companion.** `~/code/sovereign-ai-docs/07-history/state/CONTEXT.md` got a "How tool results reach the user" section telling the agent that tool output isn't auto-shown to the user — to display content, paste it into the reply text inside a code fence. Pairs with the harness's tool-result preview surfacing.

**Hardening.**
- Fixed `exactOptionalPropertyTypes` typecheck failures that broke CI
- 21+ new tests across config store, slash command, picker, splash, summary, markdown rendering, thinking indicator, tool slot, and Ollama num_ctx wiring (382 tests passing as of session end, up from 337)

## Cross-Repo Sync Queue - 2026-04-28

Added `notify-docs.yml` GitHub Action (H-0009). On push to master, if CHANGELOG.md, DECISIONS.md, or README.md changed, the workflow appends a structured entry to the docs repo's `state/feed/harness-sync-queue.md`. Agent sessions on the docs repo process pending entries during boot. Requires `DOCS_REPO_TOKEN` PAT secret.

## Qwen Amendment Phases A+B Complete - 2026-04-28

Two production-hardening patterns from the Qwen Code analysis integrated as targeted deepenings of completed phases.

**Phase A — Microcompaction.** Per-part tool-result clearing as a first-line defense before full compaction. When compactable tool results (Bash, Read, Write, Edit, Grep, Glob) exceed 40% of estimated context tokens, all but the 5 most recent results are replaced with short placeholders. No model call, no latency hit. Integrated into the query loop after every tool-result round; emits a `microcompact` StreamEvent rendered by the REPL. Settings-configurable via `microcompaction: { enabled, keepRecent, triggerThresholdPct }` in `~/.harness/config.json`.

**Phase B — Shell command AST analysis.** Hand-written quote-aware tokenizer mapping 60+ shell commands to virtual Read/Write/Edit/Web operations. `Bash("cat src/main.ts")` resolves as a Read operation and matches Read permission rules without requiring an explicit `Bash(cat *)` allow rule. Transparent prefix stripping for sudo, timeout, env, nice, nohup. Command substitution ($(), backticks) conservatively returns unsafe. Redirects (>, >>) promote read commands to write. `virtualToolName` added to the `Tool<I,O>` interface; BashTool implements it via `analyzeShellCommand()`. The permission evaluator now checks rules for both the actual tool name and the virtual tool name.

## Phase 10 Complete - 2026-04-26

Context-window compaction. The REPL supports `/compact`, creates a child session with `parent_session_id`, writes a guarded handoff summary plus the preserved tail into the child, and leaves parent messages intact for `/rollback`. Schema version 3 records lineage, estimated message tokens, and separate compaction cost lanes. The REPL proactively compacts above 50% of the model context window and retries once after provider context-overflow errors.

## Phase 9.5 Complete - 2026-04-25

Skills production upgrade. The system prompt carries only a progressive-disclosure reminder; models discover skills through `skills_list` and inspect bodies/reference files through `skill_view`. Skills support visibility gates (`metadata.harness.requires_*` / `fallback_for_*`), trust-tier guard scanning for third-party content, `${HARNESS_SKILL_DIR}` / `${HARNESS_SESSION_ID}` substitutions, `!` inline-shell interpolation, and an agent-created skill writer via `skill_manage` under `$HARNESS_HOME/skills/agent-created/`.

## Phase 9 Complete - 2026-04-25

Skills MVP. Markdown files under `<cwd>/.harness/skills/`, `$HARNESS_HOME/skills/`, and `<bundle>/skills/` load as skills with YAML frontmatter (`name`, `description`, `allowedTools`, `whenToUse`). Skills register as prompt slash commands and can be activated by the model through `SkillTool`. Skill bodies support `{{args}}` substitution.

## Phase 8 Complete - 2026-04-25

Slash commands and session cost accounting. The REPL dispatches `/help`, `/clear`, `/cost`, `/model <name>`, and prompt-backed `/commit` through `src/commands/`. Prompt commands temporarily narrow the visible tool pool and permission surface; `/commit` can use only scoped git status/diff/add/commit Bash operations. The session DB migrated to schema version 2 with token and estimated-cost columns, and each provider turn records input/output/cache token usage plus a price-table estimate used by `/cost`.

## Phase 7 Complete - 2026-04-25

Rule-based permissions. The runtime loads layered permission settings from `$HARNESS_HOME/settings.json`, `<cwd>/.harness/settings.json`, and `<cwd>/.harness/settings.local.json` with local > project > user precedence. Rules support `allow`, `deny`, and `ask` entries such as `Bash(git *)`, `Read(*.ts)`, `Write(notes.md)`, `Edit`, or `mcp__server`, with matching delegated to each tool. Deny rules win within a layer, allow rules skip prompts, ask rules force a prompt, and mode fallthrough is `default`, `ask`, or `bypass`. "Always" approvals persist a specific allow rule into project-local settings instead of allowing a whole tool by name. Permission `updatedInput` is revalidated and honored before tool execution.

## Phase 6.7 Complete - 2026-04-25

Context references and subdirectory hint loading. User turns expand `@file:path`, `@file:"path with spaces"`, `@file:path:10-20`, `@folder:path`, `@diff`, `@staged`, and `@url:https://...` before the provider call, with sensitive-path blocks for SSH/AWS/GPG/Kube material, shell rc files, sudoers, and `/etc/passwd`/`/etc/shadow`. Tool results for newly touched directories append nearby safe `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` hints instead of mutating the frozen system prompt.

## Phase 6.5 Complete - 2026-04-25

Bounded memory surfaces. `$HARNESS_HOME/memory/USER.md` and `$HARNESS_HOME/memory/MEMORY.md` are read once per user turn, fenced as recalled context in the user message, and never spliced into the system prompt. The `memory` tool supports explicit `view` and `replace`; over-cap writes fail with a consolidation error rather than truncating. A memory-provider abstraction is in place and rejects more than one external non-builtin provider.

## Phase 6 Complete - 2026-04-25

Context assembly, prompt-cache boundaries, and injection defense. New sessions freeze a static-to-dynamic system prompt: base instructions, available tools, bundle context/memory, runtime facts, and local user/project context. Runtime facts capture OS, shell, cwd, date, git status, recent commits, and recent branches once per session; `--resume` reuses the stored system prompt verbatim. Local context discovery merges `~/.harness/CONTEXT.md` first, then `AGENTS.md`, `CONTEXT.md`, and `.cursorrules` from filesystem root to cwd. Suspicious or oversized context files are blocked/truncated before inclusion. Anthropic applies cache markers to cacheable system segments plus the last three messages; `--no-cache` disables provider cache markers for testing.

## Phase 5.5 Complete - 2026-04-25

Provider hardening. `resolveProvider()` is the single entrypoint for Anthropic, OpenAI, OpenRouter, and Ollama. API-key providers use a persistent credential-pool metadata file at `~/.harness/credentials.json` for status, cooldown, and usage only. A cross-session rate guard writes `~/.harness/rate_limits/<provider>.json` after 429s so other sessions pause or fail fast instead of amplifying retries. Auxiliary clients (`compression`, `title`, `web-extract`) resolve through the cheap fallback chain OpenRouter to Anthropic Haiku to OpenAI mini to local Ollama.

## Phase 5 Complete - 2026-04-25

Multi-provider core. The CLI accepts `--provider anthropic|openai|openrouter|ollama`; `--model` overrides provider/config defaults. Anthropic keeps native prompt-cache markers, OpenAI/OpenRouter flatten system segments into a system message, and Ollama speaks `/api/chat`. All providers normalize back into the same internal `StreamEvent` and content-block message shape, so `query()`, the tool loop, permissions, and session persistence remain provider-agnostic.

## Phase 4 Complete - 2026-04-24

Tool ecosystem and concurrency-safe batching. Five tools landed alongside Bash: `FileRead`, `FileWrite`, `FileEdit`, `Grep`, and `Glob`. The orchestrator partitions per-turn `tool_use` blocks into contiguous concurrent and serial runs, splits concurrent runs into path-conflict-free sub-batches, caps batches at 10, and reinserts results in original tool-call order.

## Phase 3.5 Complete - 2026-04-24

Conversations persist across runs. SQLite via `bun:sqlite` plus WAL and FTS5 at `~/.harness/sessions.db` by default; schema-versioned migrations framework in place. Every user, assistant, and tool-result message is saved as it is produced. `--resume <uuid>` hydrates history and the frozen system prompt from the stored session. Bundle mismatch on resume is rejected with a clear error. Jittered retry plus periodic WAL checkpoints prepare for later multi-writer contention.

## Phase 3 Complete - 2026-04-24

Permission prompts around every tool dispatch. The orchestrator calls `canUseTool()` before `tool.call()`; denials flow back as `is_error` tool-result blocks. `query()` now propagates its `AbortSignal` into the tool context. Phase 7 later replaced the original coarse tool-name "always" cache with rule-based matching.

## Phase 2 Complete - 2026-04-24

Streaming REPL with the first tool wired through a full `buildTool()` to registry to orchestrator to `query()` loop. `BashTool` was the first capability. Tool results flow back as a user message with `tool_result` content blocks.

## Phase 1 Complete - 2026-04-24

Baseline streaming REPL against Anthropic, in-memory history, Ctrl-C aborts stream, `/quit` or Ctrl-D exits.
