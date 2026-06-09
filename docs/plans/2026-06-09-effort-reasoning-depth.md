# Plan — `/effort` reasoning-depth control

**Spec:** `docs/specs/2026-06-09-effort-reasoning-depth-design.md`
**Execution:** `superpowers:subagent-driven-development` — fresh Opus subagent per task, review at each checkpoint, fully autonomous (no approval gates). Subagent model policy: Opus default; never Haiku.

Dependency chain: **T1 + T3** (parallel leaves) → **T2** → **T4** → **T5** → **T6 + T7** (parallel) → **T8** → **T9**.

---

## T1 — Pure effort module + vocabulary
**Goal:** The provider-neutral effort model, with zero wiring.
**Files:** `src/providers/effort.ts` (new), `tests/providers/effort.test.ts` (new).
**Deliver:**
- `REASONING_EFFORTS = ['off','low','medium','high','max'] as const`; `type ReasoningEffort`.
- `EFFORT_BUDGET_TOKENS: Record<ReasoningEffort, number>` = `{off:0, low:4_000, medium:8_000, high:16_000, max:24_000}`.
- `RESPONSE_HEADROOM = 8_192`, `MIN_THINKING_BUDGET = 1_024`, `MAX_TOKENS_CEILING = 32_000`.
- `modelSupportsReasoning(model: string, apiMode: ApiMode): boolean` per spec §5 (4.x Anthropic incl. `claude-haiku-4-5` ⇒ true; o1/o3/o4/gpt-5 ⇒ true; sov/ollama ⇒ true; else false).
- `anthropicThinkingFor(effort, maxTokens)` → `{ thinking?: { type:'enabled'; budget_tokens:number }; maxTokens:number; dropTemperature:boolean }`. Off ⇒ `{ maxTokens, dropTemperature:false }` (no thinking). On ⇒ budget = `max(MIN_THINKING_BUDGET, EFFORT_BUDGET_TOKENS[effort])`; `maxTokens = min(MAX_TOKENS_CEILING, max(maxTokens, budget + RESPONSE_HEADROOM))`; `dropTemperature:true`.
- `openAiReasoningFor(effort)` → `{ reasoning_effort?: 'low'|'medium'|'high' }` (`max`→`high`, `off`→`{}`).
**Acceptance:** unit tests cover the budget table, the `modelSupportsReasoning` matrix (incl. haiku-4 ⇒ true, claude-3 ⇒ false, gpt-4o ⇒ false, gpt-5 ⇒ true), clamping + headroom + ceiling, temperature-drop flag, and `max` clamped under ceiling. Lint+typecheck clean. **No imports of this module elsewhere yet.**

## T2 — Provider adapters forward effort
**Goal:** `ProviderRequest.effort` reaches each wire; `off` is byte-identical to today.
**Files:** `src/providers/types.ts`, `src/providers/anthropic.ts`, `src/providers/openai.ts`, adapter tests.
**Deliver:**
- `ProviderRequest`: add `effort?: ReasoningEffort`; **remove the dead `thinking?: { budgetTokens?: number }`** (spec §8 — no caller).
- Anthropic `buildKwargs`: when `req.effort && req.effort!=='off' && modelSupportsReasoning(model,'anthropic')` → apply `anthropicThinkingFor`: set `thinking`, override `max_tokens`, and **omit `temperature`** when `dropTemperature`. `stream()`: attach interleaved beta `interleaved-thinking-2025-05-14` (via `anthropic-beta` header / `client.beta.messages` — implementer chooses the SDK-correct seam) only when thinking is applied.
- OpenAI `buildKwargs`: when reasoning-capable + effort on → spread `openAiReasoningFor(effort)` (`reasoning_effort`). For `apiMode ∈ {'sov','ollama'}` also add `chat_template_kwargs: { enable_thinking: true }`. `off` / unsupported ⇒ no new keys.
- `sov` inherits via `src/providers/sov.ts` (no change beyond apiMode-aware branch already in openai buildKwargs).
**Acceptance:** request-body tests per provider per level. **Regression guard:** `effort:'off'` and `effort:undefined` ⇒ request body deep-equals the pre-change body. `max` on a small `maxTokens` ⇒ budget+max_tokens within ceiling. Thinking-on Anthropic body ⇒ no `temperature`. Lint+typecheck clean.

## T3 — Config: `thinking.effort` default
**Goal:** A persisted default settable via `/config`.
**Files:** `src/config/schema.ts`, `src/config/catalog.ts`, `src/config/liveApply.ts` (if a live hook fits), tests.
**Deliver:** `thinking: z.object({ effort: ReasoningEffortEnum.default('off') }).default({ effort: 'off' })` (or equivalent that satisfies the absent-parent default — see `project_zod_nested_default_absent_parent`: test with `{}`). Add a `/config` catalog row for `thinking.effort` (enum editor).
**Acceptance:** parsing `{}` ⇒ `thinking.effort === 'off'`; explicit value round-trips; catalog row renders the enum. Tests green.

## T4 — Core plumbing (`QueryParams` → `provider.stream`)
**Goal:** `effort` flows from a query into the request.
**Files:** `src/core/types.ts`, `src/core/query.ts`, test.
**Deliver:** `QueryParams.effort?: ReasoningEffort`; destructure at `query.ts:47‑58`; spread `...(effort !== undefined ? { effort } : {})` into the `provider.stream({...})` call at `:143‑152`.
**Acceptance:** MockProvider captures the request and sees the forwarded `effort`; omitted when unset. Tests green.

## T5 — Runtime state + `setEffort` + side-effect + turns wiring
**Goal:** Live per-session effort, mutated by command, read per turn.
**Files:** `src/server/runtime.ts`, `src/commands/types.ts`, `src/server/commandContext.ts`, `src/server/routes/turns.ts` (+ any other `query()` call sites: `sov drive`, cron, channels, openai server — thread `effort` from `runtime.effort` consistently), tests.
**Deliver:** `runtime.effort: ReasoningEffort` init from config `thinking.effort`. `CommandContext`: `effort: runtime.effort` getter + `setEffort(level)` mutating `runtime.effort` + `sideEffects.effortChanged = level`. `CommandSideEffects.effortChanged?: ReasoningEffort`. Turns route (and sibling query sites) pass `effort: runtime.effort` into the `query()` params.
**Acceptance:** setting effort via ctx mutates runtime + emits side-effect; a turn after the set carries the new effort into `provider.stream`. Tests green. Cron/channel/openai-server sites still default-safe (`off`).

## T6 — `/effort` slash command
**Goal:** The user-facing command.
**Files:** `src/commands/effortControl.ts` (new), `src/commands/registry.ts`, tests. Mirror `src/commands/pickers.ts`.
**Deliver:** `effortCommand` (`type:'local'`, name `effort`, usage `/effort [off|low|medium|high|max]`). No arg ⇒ show current + active-model effect, open picker when interactive (reuse the `pickerOpen` side-effect card). `<level>` ⇒ `setEffort` + confirm; if `!modelSupportsReasoning(ctx.model, apiMode)` append the no-effect notice (spec §7). `status`/`current` ⇒ non-interactive show. Invalid ⇒ usage. Register in `COMMANDS` (built-ins win collisions).
**Acceptance:** `/effort high` → runtime mutated + `effortChanged` emitted + confirmation string; unsupported-model notice; invalid-arg usage; `/help` lists it. Tests green.

## T7 — TUI `effortChanged` rendering
**Goal:** The TUI reflects an effort change like it does a model change.
**Files:** `packages/tui/internal/transport/*` (decode), `packages/tui/internal/app.go` (SSE case), a status/chrome surface, Go tests. **Style guide:** all spacing/color/glyph via `style.S.*` — no hardcoded values.
**Deliver:** decode `effortChanged` side-effect; render a confirmation line mirroring `modelChanged`. Optionally surface current effort in status chrome (only if it fits the existing pattern cleanly — else just the confirmation line).
**Acceptance:** Go tests for decode + render; `bun run visual` sanity if chrome changes. Go packages green.

## T8 — Semantic test + docs + testing-log
**Files:** `tests/semantic/suites/NN-effort.cases.ts` (next free number), `docs/usage.md`, `docs/architecture.md`, `docs/extending.md` (if a new seam warrants), `docs/testing-log.md`.
**Deliver:** a judge-scored case (`/effort high` + reasoning prompt ⇒ thinking block / deeper answer). `usage.md`: command + `thinking.effort` config + the level→provider mapping table. `architecture.md`: one note in the request-build/provider section. testing-log entry.
**Acceptance:** docs accurate to shipped behavior; semantic case registered.

## T9 — Final pass, gate, ship
**Deliver:** holistic correctness/UX review of the integrated feature (per `feedback_security_vs_holistic_review` — a dedicated non-mechanical pass, not just per-task review): off-by-default regression, all five levels across providers, unsupported-model path, cron/channel safety. Run `bun run lint && bun run typecheck && bun run test` (green modulo known env-only fails). Commit (atomic, conventional) + push `origin/master`. `sov upgrade`. Cut the next patch release per `docs/conventions/cutting-releases.md`.
**Acceptance:** gate green; pushed; binary upgraded; release cut; `/effort` live from `~/.sov/bin/sov`.
