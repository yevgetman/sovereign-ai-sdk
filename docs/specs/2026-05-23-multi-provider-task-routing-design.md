# Multi-provider task routing — Design Spec

**Date:** 2026-05-23
**Status:** Draft (pre-implementation)
**Predecessor work:** Phase 5 (multi-provider core), Phase 5.5 (provider hardening), Phase 10.6 (local-model router), Phase 13 (sub-agent runtime + AgentTool), Phase 13.5 (scheduled-mission sub-agents), Phase 17 (cron), Phase 18 (OpenAI HTTP API)

## Goal

Enable the harness to autonomously decompose a user turn into atomic sub-tasks and route each to the cheapest sufficient lane (provider + model). When enabled, the parent agent's first action on every turn is to invoke a `delegator` sub-agent that decides whether to single-shot or decompose, then dispatches each atom to a cost-tier sub-agent (`cheap-task`, `moderate-task`, `frontier-task`) backed by a user-configurable provider/model. Synthesis of compound results is itself just another atom dispatched at a chosen lane.

## Business context

This is the pivotal feature of the Sovereign AI harness. The Sovereign AI business model (per the docs repo) centers on letting users run local open-source models for the majority of their work. But local models cannot match frontier-lab models on hard reasoning, so the harness must seamlessly route reasoning-heavy atoms to frontier models (Anthropic, OpenAI, OpenRouter) while keeping the bulk of cheap atoms (file scanning, simple Q&A, syntax fixes, etc.) on local lanes. Target: 60-80% of atoms routed to free local models in typical workloads, with frontier escalation reserved for the 20-40% of atoms that genuinely need it.

## Locked design decisions

These were settled through the brainstorming dialogue on 2026-05-23. They are not relitigated downstream.

| ID | Decision | Choice |
|---|---|---|
| D1 | Opt-in surface | `taskRouting.enabled: false` by default. When `true`, the smart router activates. |
| D2 | Default-state behavior (`enabled: false`) | Ship a **B-via-D bridge** baseline improvement: the parent's system prompt mentions the cost-lane sub-agents (`cheap-task`, `moderate-task`, `frontier-task`) so the parent CAN delegate to them manually even with the smart router off. No delegator agent in the loop. |
| D3 | Routing granularity (`enabled: true`) | **Dynamic per turn.** The delegator decides whether to single-shot (trivial turn → 1 atom) or decompose (compound turn → multiple atoms with synthesis). Granularity is the delegator's call, not a hardcoded rule. |
| D4 | Delegator identity | **Dedicated `delegator` sub-agent** (Sonnet-grade) — option B from Q2. The delegator is itself self-tiering via its prompt (instructs it to be fast on trivial classify and only "think hard" when decomposing). |
| D5 | Atom abstraction | **Sub-agent invocation** via `AgentTool` — option A from Q3. Phase 1 ships A only. Phase 2 may add direct-provider-dispatch (B) if soak shows it's needed. |
| D6 | Lane configuration | **Sensible defaults + per-lane override** — option B from Q4. Defaults assume Anthropic Haiku/Sonnet/Opus. User overrides per lane in `~/.harness/config.json`. |
| D7 | Tool access per lane | **Inherit parent's tool pool minus `SUBAGENT_EXCLUDED_TOOLS`** by default, with optional per-lane `allowedTools` override — option C from Q5. Permission policy uniform across lanes (`default` mode, auto-deny on `ask` — same as cron and `sov serve`). |
| D8 | Synthesis | **Synthesis is the final atom.** Same `AgentTool` mechanism; lane chosen dynamically by the delegator per task complexity. For trivial turns (1 atom), no synthesis step — the single atom's output IS the response. |
| D9 | Phase 1 UX | **A-level UX** — zero new code; reuse existing tool-card rendering (compact line + spinner + elapsed time when collapsed; full transcript when expanded). The delegator is just another `AgentTool` sub-agent invocation. |
| D10 | Phase 2 UX | **C-level UX** — atom-progress events. New SSE event types (`delegator_plan`, `delegator_atom_started`, `delegator_atom_complete`); compact-line renderer in TUI consumes them. |
| D11 | Phase 1 escalation | **Transport-error retry only** — one retry on same lane via Phase 5.5's existing fallback chain. No quality-escalation; failed atoms surface in the synthesis step's explanation to the user. |
| D12 | Smart-router-on trigger | **System-prompt-driven**, not hard-coded. When `taskRouting.enabled: true`, runtime injects `bundle-default/prompts/smart-router.md` into the parent's system prompt telling it to delegate every turn. Toggling the flag changes only the prompt assembly. |
| D13 | Boot-time lane preflight | When `enabled: true`, the runtime calls `resolveProvider` for each configured lane at boot. Aggregated failures abort boot with a clear message. When `enabled: false`, no preflight. |

## Phase boundaries

Three phases. Phase 1 + Phase 2 will be shipped in quick succession. Phase 3 is deferred pending a soak period.

### Phase 1 — Foundation + opt-in smart router (basic UX)

**Ships in default (`enabled: false`) state — B-via-D bridge baseline improvement:**

- `taskRouting` config block (Zod schema in `src/config/schema.ts`).
- Three cost-lane sub-agent definitions in `bundle-default/agents/`: `cheap-task.md`, `moderate-task.md`, `frontier-task.md`. Each uses `role:` resolution against the configured lane.
- Parent's system prompt (`bundle-default/CONTEXT.md` or equivalent) extended to mention the cost-lane sub-agents.
- Lane resolution module `src/router/lanes.ts` mapping agent `role:` to `(provider, model, allowedTools, timeoutMs)`.

**Ships when `taskRouting.enabled: true`:**

- `bundle-default/agents/delegator.md` — Sonnet-grade routing agent. Self-tiering via prompt.
- `bundle-default/prompts/smart-router.md` — parent system prompt segment injected when flag is on. Instructs parent to dispatch every user turn through the delegator.
- Boot-time lane preflight (`src/router/preflight.ts`) — validates each configured lane via `resolveProvider`.
- Per-atom timeout enforcement (default 120s, configurable per lane).
- Transport-error retry via Phase 5.5's auxiliary fallback chain (one retry on same lane).
- Atom failure handling: failed atoms surface explicitly in the synthesis atom's prompt; synthesis acknowledges gaps in user-facing output.
- A-level UX via existing tool-card rendering (no new code).

**Out of scope for Phase 1:**

- C-level atom-progress UX (Phase 2).
- Quality-escalation beyond transport-error retry (Phase 2 conditional on soak).
- Spend tracking and budget caps (Phase 3).
- Profile presets (Phase 2 optional).
- Parent-model downgrade when smart router is on (Phase 2 conditional).
- Multi-tier delegator (`fastModel`/`deepModel`) — Phase 1 ships a single Sonnet-grade delegator with prompt-level self-tiering.

### Phase 2 — Rich observability + quality escalation

**Adds:**

- C-level UX: new SSE events (`delegator_plan`, `delegator_atom_started`, `delegator_atom_complete`); compact-line renderer in TUI consumes them; `drive` and `sov serve` SSE translation layers updated.
- Per-atom lane attribution in session traces.
- `/routing-stats` slash command: lane distribution, success rate per session.
- **Conditional on Phase 1 soak data:**
  - Delegator-driven quality-escalation (re-dispatch insufficient atoms to higher tier).
  - Parent-model auto-downgrade option (since parent's role is mostly relay when smart router is on).
  - "Trivial chat" fast-path that bypasses delegator for clearly-conversational turns.
- **Optional:** `taskRouting.profile: '<name>'` shorthand for preset lane bundles in `bundle-default/profiles/`.

### Phase 3 — Spend management (deferred)

**Adds:**

- Per-session and per-day spend tracking. Aggregates `chat.completion.usage` data already wired in Phase 18.
- `taskRouting.budget` config: `dailyMaxUsd`, `sessionMaxUsd`, `softCapAction: 'warn' | 'local-only' | 'reject'`.
- `/cost-budget` slash command showing current spend + cap + projected exhaustion.
- Boot-time soft-cap injection into delegator's prompt (so the delegator knows remaining budget and biases toward local lanes when low).
- Hard-cap enforcement: when exceeded, force local-only routing or reject new requests.
- Cost-aware delegator: weighs (capability × cost) when picking lanes, not just (capability).

**Gating:** Phase 3 ships only after Phase 1 + Phase 2 have a 1-2 week soak period with the smart router on. The user will validate that the 60-80% local-routing target is being hit and that lane choices are sensible before adding spend management on top.

## Components and file layout

### Phase 1 — files to create

| Path | Purpose |
|---|---|
| `bundle-default/agents/delegator.md` | Sonnet-grade routing agent. Prompt describes lane catalogue, decomposition heuristics, synthesis-atom pattern, failure handling. `model:` field points at configured delegator model (defaults to `claude-sonnet-4-6`). |
| `bundle-default/agents/cheap-task.md` | `role: cheap-task`. Broad `allowedTools` (inherits parent pool minus exclusions). Brief system prompt that says "execute the task efficiently; return a concise summary + full output." |
| `bundle-default/agents/moderate-task.md` | `role: moderate-task`. Same shape. |
| `bundle-default/agents/frontier-task.md` | `role: frontier-task`. Same shape. May include synthesis-specific instructions ("when input contains prior atom outputs labeled 'Atom N output:', integrate them into a coherent final response"). |
| `bundle-default/prompts/smart-router.md` | System prompt segment injected into parent's prompt when `taskRouting.enabled: true`. Tells the parent: "Your FIRST action on every user turn is `AgentTool subagent_type: 'delegator', task: <user-turn>`. Relay the delegator's return value as your assistant message verbatim, with light wordsmithing only if needed." |
| `src/router/lanes.ts` | Pure-function lane resolution. `resolveLane(name: string, config: TaskRoutingConfig): LaneConfig`. Merges per-lane user overrides with defaults. |
| `src/router/laneRegistry.ts` | Boot-time assembly of the lane map. `buildLaneRegistry(config): LaneRegistry`. Validates lane names referenced by agent definitions. |
| `src/router/preflight.ts` | Boot-time preflight when `enabled: true`. For each lane: call `resolveProvider(provider, model, opts)`; aggregate failures; format clear error message. |
| `tests/router/lanes.test.ts` | Unit tests for lane resolution + override merging. |
| `tests/router/laneRegistry.test.ts` | Unit tests for registry assembly + validation. |
| `tests/router/preflight.test.ts` | Unit tests for preflight (mock providers, assert error aggregation). |
| `tests/agents/delegator.integration.test.ts` | Integration test against the real delegator agent + mock provider in tool-use mode. Asserts: trivial turn → 1 atom; compound turn → multi-atom + synthesis. |
| `tests/router/smartRouter.endToEnd.test.ts` | End-to-end smart-router-enabled test against mock provider. Asserts dispatch sequence and final synthesis. |
| `tests/router/atomFailure.test.ts` | Failure-injection tests: mock provider fails at atom level; assert delegator continues; synthesis acknowledges gap. |
| `tests/router/atomTimeout.test.ts` | Configure tight timeout; assert atom cancellation and timeout error envelope. |
| `tests/semantic/suites/task-routing.cases.ts` | Semantic test suite — real LLM judgment on routing behavior. (See "Testing strategy" below for cases.) |

### Phase 1 — files to modify

| Path | Change |
|---|---|
| `src/config/schema.ts` | Add `taskRouting` Zod block with defaults. |
| `src/agents/loader.ts` (or wherever `role:` resolution lives — verify in implementation) | Extend the capability-profile path to look up lanes from `taskRouting.lanes` config block. The existing `role:` field resolution is the natural integration point per `src/agents/types.ts:11-14`. |
| `src/server/runtime.ts` | (a) When `taskRouting.enabled: true`, run `runLanePreflight` after the existing provider preflight; fail boot loudly on lane errors. (b) When `taskRouting.enabled: true`, inject `bundle-default/prompts/smart-router.md` content into the parent's system-prompt assembly. (c) Build the lane registry at boot and stash on `Runtime`. |
| `bundle-default/CONTEXT.md` (or the parent's primary system prompt file) | Add a section describing the cost-lane sub-agents — the B-via-D bridge baseline. Applies regardless of `enabled` flag. |
| `src/agents/exclusions.ts` | **Verify and potentially adjust:** ensure `AgentTool` is NOT in `SUBAGENT_EXCLUDED_TOOLS` for the delegator's session, so the delegator can dispatch atoms. If currently excluded, add a per-agent override mechanism (e.g., agent-definition field `allowedSubagents: string[]`). |

### Phase 2 — additional files

| Path | Purpose |
|---|---|
| `src/router/progressEvents.ts` | Defines `delegator_plan`, `delegator_atom_started`, `delegator_atom_complete` event types and emitter helpers. |
| `bundle-default/profiles/all-anthropic.json` | Preset lane bundle. |
| `bundle-default/profiles/anthropic-plus-local.json` | Cheap-task → Ollama Qwen, others → Anthropic. |
| `bundle-default/profiles/frugal.json` | Aggressive cost-cutting bundle. |
| `src/commands/routingStats.ts` | `/routing-stats` slash command. |
| `src/router/escalation.ts` (conditional on soak) | Quality-escalation logic. |
| `tests/router/progressEvents.test.ts` | Wire-shape tests. |
| `tests/router/escalation.test.ts` | If escalation ships. |

### Phase 2 — modifications

- `src/server/routes/events.ts` — forward delegator events through SSE.
- `packages/tui/internal/components/compactline.go` — consume delegator events; update collapsed tool-card line per atom.
- `packages/tui/internal/transport/events.go` — type defs for new events.
- `src/cli/driveCommand.ts` — plain-text renderer for delegator events.
- `src/openai/streaming/sseTranslator.ts` — translate delegator events to `hermes.tool.progress` payloads on the OpenAI side-channel.
- `bundle-default/agents/delegator.md` — extended with progress-event emission directive and (conditional) escalation criteria.
- `src/agents/loader.ts` — handle `taskRouting.profile: '<name>'` shorthand.

### Phase 3 — additional files (sketch)

- `src/router/budget.ts` — spend tracking + cap enforcement.
- `src/commands/costBudget.ts` — `/cost-budget` slash command.
- `tests/router/budget.test.ts` — spend tracking + cap tests.

### Phase 3 — modifications

- `src/config/schema.ts` — add `budget` block.
- `bundle-default/agents/delegator.md` — budget-awareness in prompt.
- `src/server/runtime.ts` — inject budget context into delegator prompt at boot/per-session.

## Data flow

### Mode 1 — Smart router disabled (default, B-via-D bridge baseline)

User turn: `"find files using AuthMiddleware in src/"`

```
USER → PARENT (Sonnet — system prompt mentions cost-lane sub-agents)
PARENT reasons: "lookup task; delegate to cheap lane"
PARENT → AgentTool(subagent_type='cheap-task', task='find files using AuthMiddleware')
    cheap-task (Haiku) session opens
    cheap-task → Grep -rn 'AuthMiddleware' src/
    cheap-task ← "src/auth/middleware.ts:14, src/server/index.ts:203"
    cheap-task session closes; returns {summary, output} to PARENT
PARENT relays to USER as assistant message
```

The parent decides to delegate (or not) on its own. No delegator agent in the loop. The B-via-D bridge means the parent's system prompt knows the cost-lane sub-agents exist.

**Cost:** ~$0.001 (one Sonnet decision + one Haiku atom).

### Mode 2 — Smart router enabled, trivial turn

User turn: `"what is a dog?"`

```
USER → PARENT (Sonnet — system prompt has smart-router.md addition)
PARENT (per prompt addition): "always delegate first"
PARENT → AgentTool(subagent_type='delegator', task='what is a dog?')
    DELEGATOR (Sonnet) session opens
    DELEGATOR reasons: "trivial general-knowledge; 1 atom, cheap lane, no synthesis needed"
    DELEGATOR → AgentTool(subagent_type='cheap-task', task='explain what a dog is')
        cheap-task (Haiku) session opens
        cheap-task ← "A dog is a domesticated mammal..."
        cheap-task session closes; returns to DELEGATOR
    DELEGATOR returns cheap-task's output verbatim
    DELEGATOR session closes; returns to PARENT
PARENT relays to USER
```

The delegator notices trivial → dispatches 1 atom → returns single result. No decomposition step, no synthesis atom.

**Cost:** ~$0.002 (Sonnet delegator decision + Haiku atom + Sonnet relay).
**Latency overhead vs Mode 1:** ~1-2 seconds for delegator session boot + decision.

### Mode 3 — Smart router enabled, compound turn

User turn: `"do a security audit of this codebase and write a detailed report"`

```
USER → PARENT
PARENT → AgentTool(subagent_type='delegator', task='security audit + report')
    DELEGATOR (Sonnet) opens
    DELEGATOR reasons + plans:
      "Compound task. Decompose into 4+1 atoms:
       1. List source files (cheap-task)
       2. Analyze auth code (moderate-task)
       3. Analyze crypto code (moderate-task)
       4. Analyze input-validation code (moderate-task)
       5. SYNTHESIZE report from prior 4 (frontier-task)"
    DELEGATOR → AgentTool(cheap-task, 'list src/ and bundle-default/ source files')
        cheap-task (Haiku) → Grep+Glob → returns {summary, output}
    DELEGATOR collects result_1 in memory
    DELEGATOR → AgentTool(moderate-task, 'read src/auth/* and identify security risks')
        moderate-task (Sonnet) → Read several files → returns {summary, output}
    DELEGATOR collects result_2
    DELEGATOR → AgentTool(moderate-task, 'read src/openai/auth.ts and src/permissions/*')
        moderate-task → analysis → returns result_3
    DELEGATOR → AgentTool(moderate-task, 'read input-validation code')
        moderate-task → analysis → returns result_4
    // Final synthesis atom — prompt includes prior outputs
    DELEGATOR → AgentTool(frontier-task, 'write security audit report. Atom outputs: <result_1..4>')
        frontier-task (Opus) → writes structured report → returns final text
    DELEGATOR returns frontier-task's output verbatim
PARENT relays to USER (streamed as text deltas)
```

Synthesis is the final atom — same dispatch primitive, lane chosen dynamically. For trivial turns the synthesis step does not exist.

**Cost example with all-Anthropic config:** ~$0.36 (delegator decision $0.01 + 1 cheap atom $0.0005 + 3 moderate atoms $0.15 + 1 frontier atom $0.20).

**Cost example with `anthropic+local` config** (cheap-task → Ollama): ~$0.36 (the audit example has small cheap atoms; bigger savings appear in workloads dominated by cheap/local atoms).

### Edge cases

**Multi-turn context:** The delegator's session is fresh per invocation. The parent constructs the delegator's task input with conversation context when needed:

```json
{
  "user_message": "expand on the auth section",
  "conversation_context": "Prior assistant message was a security audit report. Summary: <one-line digest>."
}
```

The delegator's prompt knows this shape. Adds ~1-2k tokens to delegator input — manageable.

**`AgentTool` recursion check:** Verify during implementation that `AgentTool` is not in `SUBAGENT_EXCLUDED_TOOLS` for the delegator's session. If excluded, add an `allowedSubagents: string[]` field to agent definitions; the delegator declares it can invoke `cheap-task`, `moderate-task`, `frontier-task`. Strict — prevents arbitrary nesting.

**Atom failure mid-decomposition:** Delegator's prompt includes: "if any atom fails, note it in the synthesis input and proceed. The synthesis atom should acknowledge the gap explicitly to the user." No automatic re-dispatch in Phase 1. The user sees: "I attempted a security audit. The auth analysis completed but I couldn't read crypto-related files due to a permission error. Here's what I found in the parts that succeeded..."

## Configuration surface

### Phase 1 schema

```json
{
  "taskRouting": {
    "enabled": false,
    "delegator": {
      "model": "claude-sonnet-4-6"
    },
    "lanes": {
      "cheap-task": {
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001"
      },
      "moderate-task": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      },
      "frontier-task": {
        "provider": "anthropic",
        "model": "claude-opus-4-7"
      }
    }
  }
}
```

Shipped defaults match this exactly. Users override only what they want.

### Per-lane fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `provider` | string | (required) | Provider name from `src/providers/resolver.ts` registry: `anthropic`, `openai`, `ollama`, `openrouter`, `router`. |
| `model` | string | (required) | Model name on that provider. |
| `allowedTools` | string[] \| null | `null` | When `null`: inherits parent's tool pool minus `SUBAGENT_EXCLUDED_TOOLS`. When set: strict allowlist. |
| `maxTokens` | number \| null | `null` | Per-atom max output tokens. `null` = inherit runtime default. |
| `timeoutMs` | number | `120000` | Per-atom timeout. Atom returns timeout error envelope if exceeded. |

### Example with mixed providers

```json
{
  "taskRouting": {
    "enabled": true,
    "lanes": {
      "cheap-task": {
        "provider": "ollama",
        "model": "qwen2.5:7b",
        "timeoutMs": 180000
      },
      "moderate-task": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      },
      "frontier-task": {
        "provider": "anthropic",
        "model": "claude-opus-4-7",
        "timeoutMs": 240000
      }
    }
  }
}
```

### Lane name conventions

Phase 1 ships three lane names: `cheap-task`, `moderate-task`, `frontier-task`. **Fixed in Phase 1** — the delegator's prompt and the sub-agent definitions assume these exact names.

Phase 2 allows custom lane names via additional agent definitions + delegator-prompt extensions.

### CLI surface

| Command | Effect |
|---|---|
| `sov config get taskRouting` | Show effective config (defaults + overrides). |
| `sov config set taskRouting.enabled true` | Toggle the smart router. |
| `sov config set taskRouting.lanes.cheap-task.provider ollama` | Override one lane field. |

No new CLI primitives — uses existing `sov config get/set`.

### Environment overrides

| Var | Maps to |
|---|---|
| `SOV_TASK_ROUTING_ENABLED=1` | `taskRouting.enabled = true` |

### Phase 2 additions (flagged, not Phase 1)

```json
{
  "taskRouting": {
    "profile": "anthropic+local",
    "lanes": {
      "cheap-task": { "fallbackLane": "moderate-task" }
    },
    "delegator": {
      "fastModel": "claude-haiku-4-5-20251001",
      "deepModel": "claude-sonnet-4-6"
    },
    "observability": { "emitProgressEvents": true }
  }
}
```

### Phase 3 additions (deferred)

```json
{
  "taskRouting": {
    "budget": {
      "dailyMaxUsd": 5.00,
      "sessionMaxUsd": 0.50,
      "softCapAction": "local-only"
    }
  }
}
```

## Error handling

### Boot-time

When `taskRouting.enabled: true`, lane preflight runs immediately after the existing provider preflight. For each configured lane:

1. Call `resolveProvider(provider, model, { harnessHome })`.
2. On success: lane validated.
3. On failure: capture lane name + provider + model + error message.

After all lanes processed: if any failed, abort boot with an aggregated error:

```
sov: cannot start with taskRouting enabled — preflight failures:
  cheap-task     anthropic/claude-haiku-4-5-20251001  — missing ANTHROPIC_API_KEY
  moderate-task  anthropic/claude-sonnet-4-6           — missing ANTHROPIC_API_KEY
  frontier-task  anthropic/claude-opus-4-7             — missing ANTHROPIC_API_KEY

Set ANTHROPIC_API_KEY or override lanes in ~/.harness/config.json.
```

No silent fallback to disabled state.

### Runtime, atom level

**Transport errors** (5xx, network timeouts): reuses Phase 5.5's auxiliary fallback chain. One retry on same lane with backoff. After exhaustion, atom returns `{ ok: false, error: '<transport error>', durationMs }`.

**Atom timeout** (per-lane `timeoutMs` exceeded): runtime cancels the atom via `AbortSignal` (same primitive Phase 18's abort-on-disconnect added). Atom returns timeout error envelope.

**Permission denial:** tool's `canUseTool` returns `deny` on `ask` fall-through; tool result is `{ is_error: true, content: 'permission denied: <tool> <input>' }`. Atom continues — the inner sub-agent can decide to try another tool or give up.

**Model output is garbage** (Phase 1 doesn't detect this): atom returns whatever the model produced. Phase 2 adds quality-escalation.

### Runtime, delegator level

**Delegator session fails** (provider error mid-decomposition, hits `maxTurns` ceiling): the delegator's `AgentTool` invocation in the parent returns a terminal error. Parent handles like any other failed `AgentTool` call — surfaces a clear error message to the user via existing `turnSubmitErrMsg` path.

**Ambiguous task:** prompt-level handling. The delegator asks for clarification rather than guessing.

### Synthesis atom robustness

Synthesis prompt always includes per-atom status (`ok` / `error` / `timeout`). When any prior atom failed: synthesis prompt instructs the model to acknowledge the gap explicitly. User sees: "I attempted X. Step 3 (analyzing crypto code) timed out, so the crypto portion is incomplete. Here's what I found in the parts that succeeded..."

The synthesis atom is the user-facing failure surface. No silent failures.

## Testing strategy

### Unit tests (Phase 1)

| File | Coverage |
|---|---|
| `tests/router/lanes.test.ts` | Lane resolution; defaults merging with user overrides; `role:` from agent definition → `(provider, model, allowedTools, timeoutMs)`. |
| `tests/router/laneRegistry.test.ts` | Build registry from config; error cases (unknown provider, malformed config). |
| `tests/router/preflight.test.ts` | Boot-time preflight; mock providers; assert error aggregation. |
| `tests/config/schema.test.ts` (extend existing) | Zod schema for `taskRouting` block; valid configs accepted; malformed rejected. |

### Integration tests (Phase 1)

| File | Coverage |
|---|---|
| `tests/agents/delegator.integration.test.ts` | Real delegator agent + mock provider in tool-use mode. Trivial turn → 1 atom; compound turn → multi-atom + synthesis; lane choices observable via session metadata. |
| `tests/router/smartRouter.endToEnd.test.ts` | End-to-end via `query()` with smart router enabled; mock provider canned tool-use sequences; assert dispatch sequence; assert final synthesis reaches parent's assistant message. |
| `tests/router/atomFailure.test.ts` | Inject mock provider failures at atom level; assert delegator continues; synthesis acknowledges gap. |
| `tests/router/atomTimeout.test.ts` | Configure tight timeout; assert atom cancellation and timeout error envelope. |

### Semantic tests (Phase 1 — critical layer)

`tests/semantic/suites/task-routing.cases.ts` — real-LLM judgment on routing behavior:

| Case | Expected behavior |
|---|---|
| Trivial turn ("what is a dog") | 1 atom on cheap lane; answer matches expected explanation. |
| Lookup turn ("find files with X") | 1 atom (cheap or moderate); result lists correct files. |
| Compound turn ("summarize what this project does") | Multi-atom (cheap lookup, moderate read+summarize, optional frontier synthesis); coherent summary. |
| Hard reasoning ("design a permission model for X feature") | At least one frontier-task atom; result demonstrates Opus-grade reasoning. |
| Atom-failure recovery | Configure cheap-task to non-existent local model; assert delegator surfaces the failure; synthesis explains the gap. |

Semantic tests are the most important coverage for this feature — behavior depends on LLM judgment.

### Soak metrics

Smart router emits per-atom metadata to session traces:
- Atom lane chosen.
- Atom duration.
- Atom token usage (from `usage` field already wired in Phase 18).
- Atom success/failure.

Aggregated per-session:
- % atoms by lane (60-80% local target measurement).
- Average atoms per turn.
- Average synthesis latency.
- Failure rate per lane.

Introspect via `sov stats --routing` (extend existing `sov stats` command in Phase 1).

### Phase 1 Definition of Done — manual smoke

1. Set `taskRouting.enabled: true` in config.
2. Run `sov` with default Anthropic-only lane config.
3. Send 5 representative turns:
   - Trivial: "hi"
   - Lookup: "find files with X"
   - Simple compound: "explain how Y works"
   - Hard compound: "design Z"
   - Refused-by-policy: "delete all my files"
4. Verify each turn's lane distribution + synthesis output matches expectations.
5. Toggle `enabled: false`; verify parent's behavior returns to disabled-mode (parent can still manually delegate to cost-lane agents but the delegator is not in the loop).

## Out of scope (across all three phases)

- Mid-conversation parent-model swap (parent's model fixed at runtime boot).
- Reverse-engineering Anthropic OAuth / subscription auth (TOS-prohibited as of 2026-02-19; see earlier research conclusion).
- Reverse-engineering OpenAI ChatGPT cookie auth (no clean path; TOS-prohibited).
- Routing decisions based on time-of-day or workload patterns (no temporal awareness in Phase 1-3).
- Distributed routing across multiple harness instances.
- A web dashboard for routing observability (CLI + slash commands only).
- A "routing instruction" tool the user can call mid-conversation to override (e.g., `/route frontier` for the next turn). Future enhancement; not blocking.

## Risks and open questions

| ID | Risk / question | Mitigation / resolution |
|---|---|---|
| R1 | The Sonnet-grade delegator may make poor routing decisions (route too much to frontier, or refuse to decompose). | Semantic tests cover the common cases. Soak data after Phase 1 ship informs prompt tuning. The delegator's system prompt is the load-bearing piece and is iteratively refined. |
| R2 | `AgentTool` may be in `SUBAGENT_EXCLUDED_TOOLS` for sub-agent sessions, blocking the delegator from dispatching atoms. | Verify during implementation. If excluded, add `allowedSubagents: string[]` field to agent definitions (delegator declares it can call cheap/moderate/frontier-task only). |
| R3 | Per-turn latency overhead from delegator session boot. Trivial turns pay ~1-2s extra. | Acceptable for v1. Phase 2 can add a parent-level fast-path for clearly-trivial turns if soak shows the overhead is felt. |
| R4 | The 60-80% local target may not be achievable on workloads dominated by hard reasoning. | The target is workload-dependent. Document this explicitly. Soak data will show the actual distribution; users can tune lane configs based on observed patterns. |
| R5 | Local model quality (Ollama Qwen 7B etc.) may produce garbage on atoms the delegator routed to it. | Phase 1 has no quality-escalation; failed atoms surface in synthesis. Phase 2 conditional on soak adds escalation. Users can shrink cheap-task's `allowedTools` if local models misuse certain tools. |
| R6 | Token cost of synthesis input (when prior atom outputs are large). | Atoms return `{ summary, output }`; the synthesis prompt by default uses summaries. Delegator's prompt instructs each non-synthesis atom to keep summaries short. |
| R7 | Permission rule layers from `settings.local.json` apply to all lanes. A pre-approved `Bash(rm *)` rule lets the cheap lane run destructive commands. | Documented. The B-via-D bridge already inherits this (cost-lane sub-agents see the same rule layers as cron / drive / openai-api). Users who want extra safety on cheap lane use the per-lane `allowedTools` override. |
| R8 | Multi-turn conversation context loss in the delegator. | Phase 1: parent constructs the delegator's task with `conversation_context` field. If insufficient in practice, Phase 2 refines. |
| R9 | The Sovereign AI business case depends on this feature working well. | This is THE critical feature. Semantic test coverage is non-negotiable. Phase 1 ships with semantic tests; soak validates the routing behavior before Phase 2 + 3 layer on. |

## Implementation guidance

Phase 1 follows the project's standard implementation workflow:

1. Brainstorm — done (this document).
2. Plan — writing-plans skill produces `docs/plans/2026-05-23-multi-provider-task-routing.md` after this spec is approved.
3. Subagent-driven implementation, per `docs/conventions/subagent-policy.md`:
   - Opus 4.7 default for non-mechanical tasks.
   - Sonnet 4.6 acceptable only for trivially mechanical work (e.g., config field renames, simple schema additions).
   - **Never Haiku.**
4. TDD per the existing convention. Pre-commit gate: `bun run lint && bun run typecheck && bun run test` all green.
5. Atomic commits, autonomous push to master per `docs/conventions/lint-and-commit.md`.
6. Cut a binary release in the same session when runtime code changes, per `docs/conventions/cutting-releases.md`.
7. After Phase 1 ships: 1-2 week personal soak with smart router enabled. Collect routing metrics. Inform Phase 2 priorities.
8. Phase 2 plan written based on soak data.
9. Phase 3 gated until Phase 1 + 2 soak validates the cost-routing model.

Plan-to-spec ratio for Phase 1: ~12-15 tasks expected (foundation + delegator agent + cost-lane agents + preflight + system-prompt wiring + tests + docs + release). Estimated wall-time per the project's subagent calibration memory: ~2-3 wall-hours of subagent dispatches (5x discount on the ~12-hour human-time estimate).
