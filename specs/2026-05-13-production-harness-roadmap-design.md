# Production Harness Roadmap — Design Spec

Status: **partially superseded** — Phase 14 dropped (proprietary, distribution deferred); Phase 16.1 detailed in `specs/2026-05-13-phase-16-1-tui-rebuild-design.md`; Open Q1 (TUI framework) CLOSED → Go + Bubble Tea; Open Q2 (provider strategy) remains open
Created: 2026-05-13
Source moment: Comparison of `sovereign-ai-harness` against `opencode` (open-source coding agent harness, used as a polish benchmark) on 2026-05-13. The comparison surfaced a set of production-grade affordances the canonical build plan does not yet cover (distribution, LSP, provider breadth, plugin SDK, IDE extensions, public docs site) and a re-prioritization of phases already in the plan (Phase 16.1 TUI rebuild, Phase 18 HTTP API, Phase 19 MCP server).

This spec is the umbrella roadmap. Per-phase implementation plans land in `plans/YYYY-MM-DD-phase-NN-<feature>.md` when each phase is ready to execute, following the `superpowers:writing-plans` skill's TDD-task-by-task format.

---

## 1. Purpose

Define the next stage of harness development: get the **base coding harness** to a polish level on par with opencode and Claude Code, **before** doubling down on the Sovereign-specific learning + adapter layer.

The Hermes-pattern memory/learning runtime (Phases 13.3, 13.4, 13.5) is largely shipped and is the harness's strategic differentiator. But the runtime sits behind a readline REPL, has no public distribution, no LSP, no plugin SDK, no IDE integration, and no public docs site. A new user landing on the project today cannot install it, cannot evaluate it without reading the code, and would not get the same daily-driver experience they get from `opencode` or `claude-code`.

This spec defines a phased path to close that polish gap, while explicitly preserving the existing strategic features (Hermes layer, microcompaction, shell-AST analysis, secret redactor, scheduled missions, review daemon, instinct corpus).

The order of operations is:

1. **First**, make the base harness as polished as opencode — installable, discoverable, with a real TUI, LSP, broad provider matrix, plugin SDK, and IDE integration.
2. **Then**, layer the Sovereign-specific surfaces (channel adapters for Telegram/Slack, scheduled-mission UX polish, web dashboards for bundle-mode monitoring, etc.) on top.

The user-facing framing: "Sov harness = opencode/claude-code/qwen-code + Hermes learning + business adapters."

---

## 2. Current Baseline (2026-05-13)

The harness has shipped Phases 0–13.5 and Phase 16.0a (daemon skeleton, dormant). Phase 16.0b/c (Ink TUI + slash dispatch on Ink) were reverted on 2026-05-12 — see `docs/07-history/postmortems/2026-05-12-phase-16-revert.md`. Suite: 1809/1809 unit + 57/58 semantic. HEAD: `2ddf5fc`.

What works today:

- **Runtime architecture (production-grade):** async-generator turn loop, content-block messages, fail-closed tool defaults, transformable permissions, segmented cacheable system prompts, uniform Tool interface, sub-agents-as-recursion, bundle-as-data contract. Locked per ADR H-0003.
- **Tool ecosystem (31 native tools):** file ops (`FileRead`/`FileWrite`/`FileEdit`), shell (`Bash` with 60+ read-only command virtual-mapping), search (`Glob`/`Grep`), web (`WebFetch` with private-host blocking, `WebSearch` via Tavily/Brave), agents (`AgentTool` + `Task*` family), memory (`MemoryTool` + `MemoryProposeTool`), skills (`SkillManageTool` + `SkillTool`), introspection (`HarnessInfo`, `ToolSearchTool`).
- **MCP support:** stdio MCP servers via `@modelcontextprotocol/sdk@1.29.0`; tools surface as `mcp__<server>__<tool>` and flow through the same Tool pipe; server-level permission rules.
- **Providers (4):** Anthropic (native streaming + prompt caching), OpenAI, Ollama, OpenRouter (via auxiliary). Provider auto-detection from env or `~/.harness/credentials.json`.
- **Hermes pattern (the moat):** trajectory capture → observation stream → instinct synthesis → background review daemon → propose-then-promote lifecycle for memory and skills. Reference agents `explore` / `verify` / `plan` / `review-memory` / `review-skill` / `review-consolidate` / `instinct-synthesizer` / `scheduled-mission` ship in `bundle-default/`.
- **Session persistence:** SQLite at `~/.harness/sessions.db`, WAL mode, FTS5 for search, jittered busy retry, frozen system prompts.
- **Microcompaction:** per-part tool-result clearing (no model call) when tool content exceeds 40% of context.
- **Sub-agent scheduler:** per-parent caps, per-lane concurrency semaphores, write-lock, per-child timeout via `AbortSignal.timeout()`.
- **Two CLI surfaces:** interactive REPL (`src/ui/terminalRepl.ts`), headless dispatch (`src/cli/dispatchCommand.ts`).
- **Slash commands (~20):** session / info / config / files / git / skills / review / learning / tasks / tools / mission / search / utilities.
- **Tests:** 1,809 unit + 58 semantic with three judge backends (`claude-code`, `anthropic-api`, `string-match`).
- **Documentation:** in-repo `architecture.md`, `usage.md`, `extending.md`, `semantic-testing.md`, state snapshots, postmortems, DECISIONS.md (343 lines), append-only testing log.

What does NOT work today (the gaps this spec closes):

- **No public distribution.** Install is `bun install -g git+ssh://github.com/yevgetman/sovereign-ai-harness.git` — requires GitHub SSH access. No npm package, no Homebrew tap, no install script, no multi-platform binaries.
- **No public docs site.** Docs are excellent in-repo but unpublished.
- **No real TUI.** The REPL is readline-based; Phase 16.0b's Ink TUI was reverted. There is no persistent layout, no status line, no scrollback navigation, no syntax highlighting, no streaming tool cards, no live diffs, no mouse support.
- **No LSP integration.** Tool layer has `Glob` and `Grep` but no go-to-definition, hover, symbol search, or references. Agent must grep its way through unfamiliar code.
- **Narrow provider matrix.** Four providers vs. opencode's ~15. No Bedrock, no Vertex, no Groq, no Mistral, no DeepInfra, no Cerebras, no Together, no XAI, no Perplexity, no GitHub Copilot, no GitLab, no Poe. No model registry — every new model requires code changes.
- **No HTTP API server.** Headless usage is stdin/stdout via `sov dispatch`. No way for IDE extensions, web UIs, or external adapters to consume the harness programmatically.
- **No published plugin SDK.** Internal extensibility exists (skills, agents in the bundle, MCP servers, hooks) but there is no public `@sovereign/plugin` package with a versioned contract. Third parties cannot add tools, slash commands, or TUI components without forking.
- **No IDE integration.** No VS Code extension, no Zed extension, no JetBrains plugin.
- **No web UI.** Bundle-mode monitoring, session browsing, and review-queue UX live in the terminal only.

Existing canonical build plan (`~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`) reserves:

- Phase 16.0 — Local daemon + worker supervisor + Ink TUI (16.0a shipped/dormant, 16.0b/c reverted, **16.1 next when retried**).
- Phase 16.5 — Optional Telegram adapter.
- Phase 16.7 — TUI polish with Ink.
- Phase 17 — Cron / scheduled jobs.
- Phase 18 — Optional OpenAI-compatible HTTP API server.
- Phase 19 — Optional MCP server mode.

These existing phases cover roughly half the gap. The other half (distribution, LSP, provider breadth, plugin SDK, IDE extensions, web UI, public docs site) is not in the canonical plan and needs new phases.

---

## 3. Goal

When this roadmap is complete, a new user evaluating Sovereign AI Harness will be able to:

1. Install the harness in under 60 seconds via `npm i -g @sovereign/harness`, `brew install sovereign/tap/sov`, or `curl -fsSL sovereign.ai/install | sh` — no GitHub SSH access required.
2. Open `docs.sovereign.ai` and read the same content that lives in-repo, with working anchor links and copy-paste configs.
3. Launch `sov` and get a polished TUI: persistent status line, streaming text deltas, live tool-use cards with input/result rendering, syntax highlighting on code blocks, slash-command autocomplete with fuzzy matching, mouse support, scrollback navigation, themable.
4. Point at any of ~12 model providers (Anthropic, OpenAI, Bedrock, Vertex, Azure, OpenRouter, Groq, Mistral, DeepInfra, Cerebras, Together, Ollama, OpenAI-compat-generic) by config — no code changes.
5. Get LSP-grade tool accuracy on Go-to-Definition, Hover, References, and Symbols across at least TypeScript, Python, Rust, Go, and JavaScript.
6. Run `sov serve` to expose the harness over HTTP (SSE streaming, password-gated for v1) for IDE extensions, web UIs, and external adapters.
7. Install a VS Code extension (`Sovereign AI`) that drives `sov serve` from the editor — sidebar chat, inline diff approval, diagnostics passthrough, status-bar cost tracking.
8. Build a third-party tool, slash command, or skill against `@sovereign/plugin@1.x` without forking the harness.
9. Continue to get all the Hermes-pattern benefits (trajectory capture, instinct synthesis, review daemon, microcompaction, shell-AST analysis, secret redactor) — none of the polish work degrades or replaces these.

A founder running Sovereign AI for a client will be able to:

10. Point a Telegram bot, Slack workspace, or future Openclaw-style channel adapter at the same `sov serve` endpoint, with channel-specific authorization and session-key routing.
11. Open a web dashboard (Phase 22, deferred — see §10) to monitor bundle state, review queue, instinct corpus, trajectory volume, and scheduled-mission status.
12. Demonstrate parity-or-better-than opencode/claude-code on a daily coding-task benchmark to a non-technical evaluator inside 10 minutes.

The Hermes layer and bundle-mode focal-point UX are the differentiation. The work in this roadmap is the base layer that lets those differentiators land in a polished package.

---

## 4. Definition of "Polished Coding Harness" — The Bar

Distilled from the opencode / Claude Code / Qwen-Code feature convergence. A coding harness is "polished" at the production level when it has:

| # | Capability | Why it matters | Current Sov status |
|---|---|---|---|
| P1 | Frictionless install (`npm`/`brew`/`curl \| sh`) | Without this, no external users try the project | **missing** (private SSH only) |
| P2 | Public docs site with copy-paste configs | Discoverability and trust signal | **missing** (in-repo only) |
| P3 | Polished TUI (status line, streaming, tool cards, mouse) | Daily-driver UX | **missing** (readline REPL; Phase 16.0b reverted) |
| P4 | LSP-driven tool accuracy (go-to-def, hover, refs, symbols) | Agent edits the right code, not the closest grep match | **missing** |
| P5 | Broad provider matrix (≥10 providers, config-only additions) | User retains choice between frontier + local + fast-tier | **partial** (4 providers, code change per new provider) |
| P6 | HTTP API server (`sov serve`) | Foundation for IDE plugins, web UI, channel adapters | **missing** (stdin/stdout dispatch only) |
| P7 | Published plugin SDK with versioned contract | Third-party extensibility without forks | **missing** (internal interfaces only) |
| P8 | IDE integration (VS Code at minimum) | Where target users actually live | **missing** |
| P9 | Web UI or rich monitoring surface | Optional but expected for daily power use | **missing** |

Sov is **0/9** on the polish bar today. This spec defines the path to **9/9**, in priority order matched to user-visible impact.

---

## 5. Phase Map

The roadmap adds five new phases (14, 15, 20, 21, 22) and re-prioritizes three existing phases (16.1, 18, 19) earlier than the canonical plan currently places them. The Sovereign-specific later phases (16.5 Telegram, 16.7 TUI polish, 17 Cron) stay in their canonical positions but execute AFTER the polish track.

Phase numbering note: 14 and 15 are currently gaps in the canonical plan (there is no Phase 14 or 15). Phases 20+ are forward extensions of the existing numbering scheme.

| Phase | Name | New / Reprio'd | Est. cost | Hard deps | Status |
|---|---|---|---|---|---|
| 15 | Provider Breadth via `@ai-sdk/*` | new | ~120–180K | none | not started |
| 16.1 | Foreground TUI Rebuild | existing, reprio | ~400–600K (highest risk) | 24 prereqs in `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` | **ACTIVE — see linked spec & plan** |
| 18 | HTTP API Server | existing, reprio earlier | ~100–150K | 15 | not started |
| 19 | MCP Server Mode | existing, reprio | ~60–100K | 18 | not started |
| 20 | LSP Integration | new | ~150–220K | (none — parallel-safe with TUI) | not started |
| 21 | Plugin SDK + IDE Extensions | new | ~250–350K | 16.1, 18 | not started |
| — | (Hermes-layer + adapter phases) | existing | (canonical plan) | 16.1, 18 | deferred per user direction |
| 16.5 | Telegram adapter | existing | (canonical) | 16.1, 18 | deferred |
| 16.7 | TUI polish with Ink | existing | (canonical) | 16.1 | absorbed into 16.1 (see §11) |
| 17 | Cron / scheduled jobs | existing | (canonical) | 16.1 | deferred |
| 22 | Web Dashboard (bundle-mode monitoring) | new, deferred | ~300–500K | 18, 21 | deferred |

Sequencing rationale:

- **14 first** because it is the cheapest unblock and gates external evaluation. Multi-platform binaries via `bun build --compile` are mechanical; the docs site is deployment of existing content. ~1–2 weeks wall, high return-on-effort.
- **15 in parallel with or right after 14** because new providers are mechanically additive and unblock Sovereign clients who want Bedrock/Vertex/Groq today. Wrapping `@ai-sdk/*` behind the existing `LLMProvider` interface preserves prompt-caching control.
- **16.1 (TUI rebuild) is the biggest rock** and the highest risk per the Phase 16 postmortem. Sequenced after 14 and 15 so that when it lands, the distribution and provider matrix are ready to receive new users. Phase 16.7 (TUI polish) folds into 16.1 — there is no separate polish phase; the rebuild aims for polished from the start.
- **18 (HTTP API) immediately after 16.1** because it sits architecturally beneath everything that follows: IDE extensions (21), MCP server mode (19), Telegram/Slack adapters (16.5), web dashboard (22), Hermes-layer remote viewers. Without 18, those phases either reinvent transport or stay terminal-only.
- **19 (MCP server) right after 18** because the work is mostly transport-layer reuse from 18 and unlocks "use Sov tools from Claude Code / Cursor / etc."
- **20 (LSP) parallel-safe with 16.1** because it touches the tool layer, not the foreground surface. Can run as a separate track if effort allows.
- **21 (Plugin SDK + IDE) last in the polish track** because it depends on 16.1 (TUI hook points), 18 (HTTP API), and 14 (npm distribution for `@sovereign/plugin`).
- **22 (web dashboard) deferred** until polish track lands; revisit when Hermes-layer bundle-mode UX needs a non-terminal surface.

Hermes-layer extensions (16.5 Telegram, 17 Cron, additional channel adapters) execute AFTER the polish track is complete, per the user-stated sequencing: "before we get to the memory and learning features, it needs to be a fully polished useable coding harness."

---

## 6. Open Decisions

Open Q2 should be resolved before Phase 15 plan-writing begins. Open Q1 is closed (see §6 below).

### Open Q1 — TUI framework for Phase 16.1

**CLOSED 2026-05-13.** Decision: **Go + Bubble Tea (split-process architecture)**. See the 2026-05-13 split-process and Bubble Tea ADRs in `DECISIONS.md`, and `specs/2026-05-13-phase-16-1-tui-rebuild-design.md`. The umbrella's prior claim that opencode uses OpenTUI/SolidJS was incorrect; opencode uses Bubble Tea.

Original options (preserved for the record):

Options:

| # | Option | Pro | Con | Risk |
|---|---|---|---|---|
| A | Ink (again) | React mental model; vast component library; survives `origin/archive/ink-tui-2026-05-12` | Same architecture that failed; closures vs hooks mismatch with terminalRepl | high |
| B | OpenTUI (with SolidJS reactivity) | What opencode adopted; designed for this; mature | New abstraction; SolidJS not currently in the stack | medium |
| C | Custom Bun-native TUI (raw ANSI + manual layout) | No abstraction risk; full control; matches existing async-generator model directly | ~2× implementation cost vs A/B; reinventing wheels | low-medium |
| D | Polished REPL (cli-highlight + ANSI status line + scrollback) | Lowest risk; no foreground refactor; ships in days | Lowest ceiling; not visually competitive with opencode/claude-code | very low |

Recommendation: **Option B (OpenTUI)**, with the four durable rules from `docs/07-history/postmortems/2026-05-12-phase-16-revert.md` enforced as plan-mode preconditions. Rationale:

- OpenTUI is the only path to feature-parity-with-opencode within a quarter; Option C is a year.
- Option D leaves a visible polish gap that this whole roadmap exists to close.
- Option A re-walks the exact path that failed; the postmortem rules can be applied to any framework, but the framework itself is part of what made plumbing-lift expensive.
- SolidJS is a known quantity in the broader Bun ecosystem; adopting it for the TUI does not commit other surfaces.

**Decision needed before Phase 16.1 plan-writing begins.** Brainstorm via `superpowers:brainstorming` and record outcome in `DECISIONS.md` as ADR H-001x.

### Open Q2 — Provider strategy for Phase 15

Options:

| # | Option | Pro | Con |
|---|---|---|---|
| A | Hand-roll each provider behind `LLMProvider` | Full control over caching, retry, redaction | ~3–5 days per provider; 10 providers = 30–50 days |
| B | Adopt `@ai-sdk/*` directly, replace existing providers | Inherit `models.dev` registry, ~15 providers near-free | Lose prompt-caching control on Anthropic; provider-agnostic features regress |
| C | Wrap `@ai-sdk/*` behind existing `LLMProvider` | Inherit AI-SDK provider matrix; preserve caching, retry, redaction | ~1 day per provider after wrapper scaffolding |

Recommendation: **Option C (wrap)**. Rationale:

- Existing `LLMProvider` interface defines the contract Sov runtime depends on (async-generator yield, content-block translation, cache-control segments). Replacing it (Option B) destabilizes Anthropic prompt caching which is load-bearing for Sov's cost profile.
- Option A is genuinely a quarter of work that adds no architectural value once Option C exists.
- Option C lets the wrapper handle Sov-specific concerns (secret redaction at provider boundary, cache-control segment translation, model-registry hydration) while delegating transport, retry, and SDK-version handling to `@ai-sdk/*`.

**Decision needed before Phase 15 plan-writing begins.** Lighter weight than Q1; can be resolved inline in the Phase 15 plan kickoff.

---

## 7. Per-Phase Specs

Each phase below has: Goal, Scope (in/out), Deliverable, Key files (create / modify), Build items, Success criteria, Acceptance tests, Risks, Dependencies, Rough effort.

---

### Phase 15 — Provider Breadth via `@ai-sdk/*`

**Goal:** raise the supported provider count from 4 to 10+ by wrapping `@ai-sdk/*` packages behind the existing `LLMProvider` interface. Adopt an external model registry so new models are config-only.

**Scope (in):**
- Wrapper layer: `src/providers/aiSdk/<provider>.ts` per `@ai-sdk/*` package.
- Provider additions: AWS Bedrock, Google Vertex, Azure, Groq, Mistral, DeepInfra, Cerebras, Together, OpenAI-compatible-generic.
- Existing providers (Anthropic, OpenAI, Ollama, OpenRouter) refactored to share the wrapper pattern OR explicitly kept as hand-rolled, with reasoning documented.
- Model registry: mirror `models.dev` schema or pull directly via HTTP at boot, cached locally with TTL.
- Provider-level config additions to `~/.harness/config.json`: per-provider creds, endpoint overrides, model allowlist.
- Per-provider semantic test coverage (1 case per provider, against a small model).

**Scope (out):**
- Provider-specific feature parity (Bedrock Converse vs OpenAI Chat differences are handled by `@ai-sdk/*`; Sov runtime sees uniform shape).
- Cost dashboards beyond what already exists (`/cost` slash command works unchanged).
- Provider-specific prompt-caching extensions beyond Anthropic (which already has it).

**Deliverable:**

```bash
sov --provider bedrock --model claude-3-7-sonnet-v1:0    # works
sov --provider vertex --model gemini-2.5-pro              # works
sov --provider groq --model llama-3.3-70b-versatile       # works
sov --provider openai-compat --model my-local-model       # works against any OpenAI-compatible endpoint
```

Adding a new model from an existing provider requires no code change — just `~/.harness/config.json` entry (and the model registry fetches metadata).

**Key files:**

Create:
- `src/providers/aiSdk/wrapper.ts` — generic adapter: takes an `@ai-sdk/*` `LanguageModel` instance, exposes the existing `LLMProvider` interface (async-generator streaming, content-block translation, cache-control segment handling for Anthropic, `LLMProvider.preflight()`).
- `src/providers/aiSdk/anthropic.ts` — wraps `@ai-sdk/anthropic`, preserves prompt-caching behavior.
- `src/providers/aiSdk/openai.ts` — wraps `@ai-sdk/openai`.
- `src/providers/aiSdk/bedrock.ts` — wraps `@ai-sdk/amazon-bedrock`.
- `src/providers/aiSdk/vertex.ts` — wraps `@ai-sdk/google-vertex`.
- `src/providers/aiSdk/azure.ts` — wraps `@ai-sdk/azure`.
- `src/providers/aiSdk/groq.ts` — wraps `@ai-sdk/groq`.
- `src/providers/aiSdk/mistral.ts` — wraps `@ai-sdk/mistral`.
- `src/providers/aiSdk/deepinfra.ts` — wraps `@ai-sdk/deepinfra`.
- `src/providers/aiSdk/cerebras.ts` — wraps `@ai-sdk/cerebras`.
- `src/providers/aiSdk/together.ts` — wraps `@ai-sdk/together-ai`.
- `src/providers/aiSdk/openaiCompat.ts` — wraps `@ai-sdk/openai-compatible`, generic for any OpenAI-protocol endpoint.
- `src/providers/registry.ts` — model registry; fetches `models.dev` JSON; caches locally at `~/.harness/cache/models.json` with 24h TTL; provides `getModel(providerId, modelId) → ModelInfo`.
- `tests/providers/aiSdk-wrapper.test.ts` — wrapper-shape unit tests (mocked).
- `tests/semantic/suites/providers-breadth.suite.ts` — one semantic case per provider (10+ cases) against the smallest available model.

Modify:
- `src/providers/index.ts` — register the new wrapped providers; phase out the old hand-rolled ones (keep Ollama and Anthropic-direct as fallbacks initially, then deprecate).
- `package.json` — add `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex`, `@ai-sdk/azure`, `@ai-sdk/groq`, `@ai-sdk/mistral`, `@ai-sdk/deepinfra`, `@ai-sdk/cerebras`, `@ai-sdk/together-ai`, `@ai-sdk/openai-compatible`. Update lockfile.
- `docs/03-cli-reference/usage.md` — Providers section: expand from 4 to all supported; per-provider auth setup; example config.
- `docs/04-extending/extending.md` — "Adding a provider" recipe updated to point at the wrapper pattern.
- `DECISIONS.md` — ADR H-001x: "Adopt `@ai-sdk/*` wrappers for provider breadth" (the resolution of Open Q2).
- `~/.harness/config.json` schema (in `src/config/schema.ts`) — add per-provider auth fields.

**Build items:**

1. **Resolve Open Q2** (provider strategy decision). Default recommendation: Option C (wrap `@ai-sdk/*`). Land in `DECISIONS.md`.

2. **Scaffold the wrapper.** `src/providers/aiSdk/wrapper.ts` exposes `wrapAiSdk(model: LanguageModel, options: WrapperOptions): LLMProvider`. The wrapper handles: (a) translating Sov's `Message[]` (content-blocks) to AI-SDK's message shape; (b) translating AI-SDK's stream events to Sov's `StreamEvent` union; (c) preserving Anthropic-specific `cache_control: { type: 'ephemeral' }` markers on system-prompt segments (passed through `providerOptions.anthropic.cacheControl`); (d) `preflight()` makes a small completion call and surfaces auth errors with redaction.

3. **Migrate Anthropic to the wrapper.** First wrapper migration is Anthropic because it has the most surface area (prompt caching). Run the full unit + semantic suite; verify no regressions on cache hit rate, message shape, or tool-use translation. Anthropic-direct (current `src/providers/anthropic.ts`) stays in-tree as a fallback for one release cycle, then deprecates.

4. **Add the other ten providers.** Each is ~80 lines: instantiate the `@ai-sdk/<provider>` factory with config; call `wrapAiSdk`. Order: OpenAI → Bedrock → Vertex → Azure → Groq → Mistral → DeepInfra → Cerebras → Together → OpenAI-compat-generic.

5. **Build the model registry.** `src/providers/registry.ts` fetches `https://models.dev/api/models.json` (or equivalent — verify URL) on first call per session; caches to `~/.harness/cache/models.json` with timestamp; refreshes if older than 24h. Schema: `{ providers: { <id>: { models: { <id>: { context, output, capabilities, pricing } } } } }`. Exposes `getModel(provider, model)`, `listModels(provider?)`, `getDefault(provider)`.

6. **Wire the registry into CLI flag handling.** `sov --provider <p> --model <m>` validates against the registry; invalid combinations print available models. `sov --provider <p>` without `--model` uses the registry default. Existing CLI flag pattern in `src/main.ts` preserved.

7. **Add per-provider semantic tests.** `tests/semantic/suites/providers-breadth.suite.ts` — one case per provider: "What is 2+2? Reply with only the digit." against the smallest non-deprecated model. Run with `--judge string-match` to keep cost bounded. Total: ~$0.10/run, ~30s wall.

8. **Update docs.** `docs/03-cli-reference/usage.md` Providers section enumerates all ten with one-line auth setup each. `docs/04-extending/extending.md` "Adding a provider" updated to the wrapper recipe (`@ai-sdk/<p>` install → `src/providers/aiSdk/<p>.ts` file → register).

**Success criteria:**

- [ ] All ten new providers respond to a trivial completion within 30s.
- [ ] Anthropic prompt-caching hit rate is preserved (verify via existing cache-instrumented session: cost-per-turn after migration matches pre-migration within 5%).
- [ ] `sov --provider <p>` works for every new provider without code changes beyond config.
- [ ] Model registry fetches and caches; `sov models list` (new subcommand) prints models grouped by provider.
- [ ] Semantic suite has one passing case per new provider.

**Acceptance tests:**

- Unit suite (1809 cases pre-migration) + new tests for wrapper, registry, provider-shape. Target: ≥1850 passing.
- Semantic suite full run: pre-existing 58 + 10 new provider cases = 68 cases. Pass rate ≥ 95% (allowing for transient model-API flakes).
- Smoke: `sov --provider bedrock --model claude-3-7-sonnet-v1:0` against a test AWS account. Same for Vertex against a test GCP project.

**Risks:**

- **`@ai-sdk/*` API instability.** AI-SDK is at v3.x/v4.x at the time of writing; minor releases can introduce breaking changes. Mitigation: pin to a specific minor (`^3.0`) and bump deliberately; subscribe to AI-SDK releases.
- **Bedrock / Vertex auth complexity.** AWS SigV4, GCP service accounts. Mitigation: lean on `@ai-sdk/*`'s built-in auth flows; provide doc examples for both common auth patterns (long-lived creds, short-lived STS); allow auth-failure messages to surface verbatim from AI-SDK.
- **Prompt-caching regression on the Anthropic migration.** Mitigation: instrumented A/B test on a fixed transcript before promoting the wrapper to default; rollback path is keeping the hand-rolled `anthropic.ts` for one release.
- **Model registry latency on first call.** Mitigation: lazy fetch; if `models.dev` is unreachable, fall back to a bundled `src/providers/modelsFallback.json` updated periodically.

**Dependencies:** Open Q2 resolved. Otherwise none.

**Rough effort:** 2–3 weeks wall. Wrapper scaffolding is the first week; per-provider additions are ~1 day each; semantic tests + docs round out the third week.

---

### Phase 16.1 — Foreground TUI Rebuild

**Status:** ACTIVE. Detailed in `specs/2026-05-13-phase-16-1-tui-rebuild-design.md` (design spec) and `plans/2026-05-13-phase-16-1-tui-rebuild.md` (M0–M3 plan).

**Locked decisions:** split-process architecture; Go + Bubble Tea framework; polish-craft differentiator; bottom-anchored chrome layout; postinstall `go build` for binary delivery; HTTP + SSE transport on `127.0.0.1`; terminalRepl untouched through M11.

**Open Q1** (TUI framework) — CLOSED per above.

See the linked spec for the full per-phase plan: architecture, backend (`src/server/`), foreground (`packages/tui/`), tool renderer bridge, 24-prereq wiring strategy, milestones M0–M13, risks.

---

### Phase 18 — HTTP API Server (`sov serve`)

**Goal:** expose the harness over HTTP/SSE so IDE extensions, web UIs, and channel adapters can drive it programmatically. This phase pulls Phase 18 from its current canonical position (after Phase 17 cron) forward to immediately after Phase 16.1 because it is architecturally load-bearing for downstream polish phases.

**Scope (in):**
- `sov serve` subcommand starting an HTTP server.
- Endpoints: `POST /sessions` (create), `POST /sessions/:id/turns` (submit a turn, returns SSE stream), `GET /sessions/:id` (read state), `GET /sessions` (list), `GET /tools` (list available tools), `GET /providers` (list configured providers), `GET /health`.
- SSE streaming for turn output (matches the async-generator turn loop).
- Password authentication via `SOV_SERVER_PASSWORD` env var (warn on unset; refuse to bind to non-localhost without it).
- Per-directory instance routing via `x-sov-directory` header (mirror opencode's `x-opencode-directory` pattern).
- Permission-prompt approval queue: when a turn needs `ask` consent, the SSE stream emits a `permission_request` event; client posts to `POST /sessions/:id/approvals/:requestId` to approve/deny.
- Session lifecycle hooks: HTTP server reuses the Phase 16.0a daemon's session cache (`src/daemon/sessionCache.ts`).

**Scope (out):**
- OAuth / JWT auth (deferred — password is sufficient for v1; OAuth lands when hosted deployment is on the table).
- WebSockets (SSE is sufficient for turn streaming; SSE has better proxy compatibility).
- Multi-tenant isolation (deferred — single-user v1).
- OpenAI-compatible endpoint shape (deferred — the canonical Phase 18 in the build plan mentions this as optional; defer to a sub-phase 18.1 if/when a Sov-hosted UI needs it).

**Deliverable:**

```bash
SOV_SERVER_PASSWORD=hunter2 sov serve --port 8080
```

```bash
curl -X POST http://localhost:8080/sessions \
  -H "Authorization: Bearer hunter2" \
  -H "x-sov-directory: /home/julie/projects/foo" \
  -H "Content-Type: application/json" \
  -d '{"agent": "default"}'
# → {"sessionId": "s_abc123"}

curl -X POST http://localhost:8080/sessions/s_abc123/turns \
  -H "Authorization: Bearer hunter2" \
  -H "Accept: text/event-stream" \
  -d '{"text": "What files are in src/?"}'
# → SSE stream of turn events
```

**Key files:**

Create:
- `src/cli/serveCommand.ts` — `sov serve` subcommand.
- `src/server/` — root directory for HTTP server code.
- `src/server/app.ts` — Hono app with route registration.
- `src/server/routes/sessions.ts` — session CRUD.
- `src/server/routes/turns.ts` — turn submission + SSE streaming.
- `src/server/routes/tools.ts` — tool list endpoint.
- `src/server/routes/providers.ts` — provider list endpoint.
- `src/server/routes/health.ts` — health endpoint.
- `src/server/routes/approvals.ts` — permission approval queue endpoints.
- `src/server/auth.ts` — password middleware.
- `src/server/sseStream.ts` — adapter from `query()`'s async-generator to SSE event stream.
- `src/server/sessionRouter.ts` — `x-sov-directory` header → instance dispatch.
- `src/server/types.ts` — request/response shapes (Zod schemas).
- `tests/server/` — endpoint integration tests with mocked runner.

Modify:
- `src/main.ts` — register `sov serve` subcommand.
- `package.json` — add `hono` and `@hono/node-server` (or use Bun.serve directly — recommend Hono for ecosystem compatibility).
- `docs/03-cli-reference/usage.md` — new "HTTP API" section.
- `docs/04-extending/extending.md` — "Consuming the HTTP API" recipe.
- `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md` — reflect re-prioritization of Phase 18 earlier in the sequence; sister-repo edit.

**Build items:**

1. **Pick the HTTP framework.** Recommend Hono — battle-tested, Bun-compatible, fast, what opencode uses. Alternative: `Bun.serve` directly (no abstraction, less ecosystem). Decide in plan kickoff.

2. **Scaffold Hono app.** Routes registered via `app.route('/sessions', sessionsRouter)` etc. Middleware: password auth (Bearer token in `Authorization` header matches `SOV_SERVER_PASSWORD`); CORS (configurable; default allow localhost only); request logging via existing `src/trace/`.

3. **Implement `POST /sessions`.** Creates a new session via existing `sessionDb.createSession`. Returns `{ sessionId, createdAt }`. Optional body: `{ agent?: string, provider?: string, model?: string }` — same overrides accepted by `sov chat` CLI flags.

4. **Implement `POST /sessions/:id/turns` with SSE.** Body: `{ text: string }` (or `{ blocks: ContentBlock[] }` for richer input). Response: `text/event-stream`. Each `StreamEvent` from `query()` becomes one SSE `data:` event with `event: <type>`. Per-event types: `text_delta`, `tool_use`, `tool_result`, `thinking`, `permission_request`, `turn_complete`, `turn_error`.

5. **Implement permission queue.** When `query()` emits a `tool_use` that needs consent, the SSE stream emits `event: permission_request` with the request payload. The turn pauses (server holds the async-generator's awaiting promise). Client calls `POST /sessions/:id/approvals/:requestId` with `{ approved: true | false }`. Server resolves the promise; turn continues. Timeout: 60s default, configurable; on timeout, deny.

6. **Implement `GET /sessions/:id`.** Returns session metadata + truncated message history (full history via `?include=messages`).

7. **Implement `GET /sessions`, `GET /tools`, `GET /providers`, `GET /health`.** All read-only; password-gated.

8. **`x-sov-directory` header routing.** Each session is associated with a working directory. Header overrides the server's process CWD for that session's tool calls (bundle resolution, FileRead/Write/Edit paths). Validation: directory must exist; default to server's CWD.

9. **Integration with Phase 16.0a daemon.** The daemon already has `src/daemon/sessionCache.ts` — reuse it for hot session retention across HTTP requests. PID lock prevents two `sov serve` processes against the same profile.

10. **Per-endpoint integration tests.** `tests/server/sessions.test.ts` etc. Run an in-process Hono test client; assert status codes, response shapes, SSE event sequences for the common paths.

11. **Documentation.** `docs/03-cli-reference/usage.md` adds "HTTP API" section with the curl examples above + endpoint reference. `docs/04-extending/extending.md` adds "Consuming the HTTP API" recipe for an IDE-extension author.

**Success criteria:**

- [ ] `sov serve` starts; responds to all endpoints; SSE stream works through nginx/Cloudflare proxy.
- [ ] Permission approval round-trip works: turn pauses on `permission_request`, resumes on POST to approval endpoint.
- [ ] Password gate refuses requests without correct Bearer token.
- [ ] `x-sov-directory` correctly routes tool execution to the specified directory.
- [ ] Long-running session survives multiple turns over multiple HTTP requests with consistent state.

**Acceptance tests:**

- Unit: route handlers, auth middleware, SSE adapter.
- Integration: in-process Hono test client; semantic suite gets a new entry for SSE turn streaming.
- Manual: drive `sov serve` from a hand-written client (a TypeScript script or `curl`) and verify a multi-turn coding session with permission prompts works end-to-end.

**Risks:**

- **SSE proxy compatibility.** Some proxies buffer SSE. Mitigation: set `X-Accel-Buffering: no`; emit periodic `event: heartbeat`; document supported proxies.
- **Session cache cross-contamination via `x-sov-directory`.** Mitigation: directory becomes part of the session key; sessions for different directories never share state.
- **Permission timeout UX in long-running tools.** Mitigation: default 60s; configurable per-tool; document the constraint for IDE-extension authors.
- **Server-binding security.** Mitigation: refuse to bind to non-localhost without `SOV_SERVER_PASSWORD` set; print warning on insecure config; document deployment recommendations.

**Dependencies:** Phase 15 (so provider list endpoint enumerates all 10+). Optionally Phase 16.1 (so the new TUI can also drive `sov serve` via the API, demonstrating the surface).

**Rough effort:** 2–3 weeks wall. Hono and SSE are well-trodden; the novel work is permission-queue round-trip and session-cache integration.

---

### Phase 19 — MCP Server Mode

**Goal:** allow Sov to expose its tool set as an MCP server, so other harnesses (Claude Code, Cursor, Continue, etc.) can consume Sov tools.

**Scope (in):**
- `sov mcp serve` subcommand starting an MCP stdio server.
- Tool surface: existing 31 Sov tools, exposed via MCP protocol.
- Permission gating identical to local execution.
- Documentation for connecting Claude Code / Cursor / Continue to a running `sov mcp serve`.

**Scope (out):**
- HTTP-based MCP (deferred — stdio is sufficient for v1; HTTP MCP is a separate protocol variant).
- Sub-agent invocation through MCP (deferred — too much state to round-trip cleanly).
- Skill invocation through MCP (deferred — semantic mismatch with MCP tool shape).

**Deliverable:**

```bash
sov mcp serve
# → Listens on stdio; speaks MCP protocol.
```

Configured in Claude Code's `~/.config/claude/mcp.json`:
```json
{ "mcpServers": { "sov": { "command": "sov", "args": ["mcp", "serve"] } } }
```

Claude Code can now call `mcp__sov__FileRead`, `mcp__sov__Bash`, etc.

**Key files:**

Create:
- `src/cli/mcpServeCommand.ts` — `sov mcp serve` subcommand.
- `src/mcp/server.ts` — MCP server wrapping the existing tool pool.
- `src/mcp/toolAdapter.ts` — translates Sov `Tool<I,O>` to MCP tool definitions.
- `tests/mcp/server.test.ts` — protocol-level tests.

Modify:
- `src/main.ts` — register `sov mcp` subcommand group; add `serve` and existing client-side subcommands.
- `package.json` — `@modelcontextprotocol/sdk` already present; bump if needed for server-side APIs.
- `docs/03-cli-reference/usage.md` — "MCP server mode" section.
- `docs/04-extending/extending.md` — "Connect Claude Code / Cursor to Sov tools" recipe.

**Build items:**

1. Scaffold the MCP server using `@modelcontextprotocol/sdk`'s `Server` class. Stdio transport.
2. Iterate the tool pool; expose each as an MCP tool. Tool name: `<sov-tool-name>` (no `mcp__sov__` prefix at the server; the client adds that on consumption).
3. Translate Sov input/output schemas to MCP shape. Sov uses Zod; MCP uses JSON Schema. Use `zod-to-json-schema`.
4. Wire permission checks: when an MCP tool is invoked, run the same `canUseTool` pipeline as local invocation. Denied → return MCP error response.
5. Document the Claude Code / Cursor / Continue connection setup with copy-paste configs.

**Success criteria:**

- [ ] `sov mcp serve` boots; `tools/list` returns all 31 Sov tools.
- [ ] Claude Code can call `FileRead` via the MCP bridge and get the same result as local `Read`.
- [ ] Permission denials surface as MCP errors with the same reasons as local denials.

**Acceptance tests:**

- Unit: tool adapter, schema translation.
- Manual: connect Claude Code; invoke 5 different tools; verify behavior matches local.

**Risks:**

- **Schema translation lossiness.** Zod has constructs JSON Schema can't express cleanly. Mitigation: per-tool override pattern for fields that don't translate; document any tools that intentionally don't ship via MCP (deferred sub-agent and skill invocations).
- **State coupling.** MCP tool calls are stateless from the client's perspective, but some Sov tools (e.g., `TaskCreate`) imply session-scoped state. Mitigation: explicitly exclude session-scoped tools from MCP surface in v1; document the constraint.

**Dependencies:** Phase 18 (for HTTP variant later). Otherwise standalone.

**Rough effort:** 1–2 weeks wall. Most of the work is schema translation + permission-pipeline reuse.

---

### Phase 20 — LSP Integration

**Goal:** give the agent LSP-grade tool accuracy on go-to-definition, hover, references, and symbol search. The single biggest lever for agent quality on real codebases.

**Scope (in):**
- LSP client implementation: spawn a language server per language, lazy-launched, cached per session.
- Language servers: TypeScript (`typescript-language-server`), Python (`pyright`), Rust (`rust-analyzer`), Go (`gopls`), JavaScript (sharing TS server).
- Tree-sitter integration for syntax-aware editing (already a Node ecosystem package).
- New tools: `LspGoto`, `LspHover`, `LspReferences`, `LspSymbols`, `LspDiagnostics`.
- `RepoOverview` tool (port from opencode pattern) — structural map of a repo for cold-start orientation.
- Upgrade to `apply_patch` style editing for `FileEdit` (more robust than current diff-replace).
- Cache layer for ripgrep results (mirror opencode pattern).

**Scope (out):**
- Custom-built language server (none; consume off-the-shelf).
- LSP over the wire (server lives in the harness process).
- Code actions, formatting, refactor LSP features (deferred; agent does these via Bash + Edit).

**Deliverable:**

```bash
sov
> /tools
... LspGoto, LspHover, LspReferences, LspSymbols, LspDiagnostics, RepoOverview ...

> open the file where `parseSlashCommand` is defined
# Agent uses LspGoto(symbol="parseSlashCommand") instead of grep
# Returns: src/commands/parser.ts:42
```

**Key files:**

Create:
- `src/lsp/` — root directory.
- `src/lsp/client.ts` — LSP client (`vscode-jsonrpc` + `vscode-languageserver-protocol`).
- `src/lsp/manager.ts` — lazy-launches servers per detected language; per-session lifecycle.
- `src/lsp/detect.ts` — language detection from file extensions / project markers (tsconfig.json, Cargo.toml, go.mod, pyproject.toml).
- `src/lsp/servers.ts` — known server registry: command + args + initialization options per language.
- `src/tools/lspGoto.ts` — `Tool<{symbol: string, file?: string}, {file: string, line: number}>`.
- `src/tools/lspHover.ts` — `Tool<{file: string, line: number, col: number}, {hover: string}>`.
- `src/tools/lspReferences.ts` — `Tool<{symbol: string}, {refs: {file, line}[]}>`.
- `src/tools/lspSymbols.ts` — `Tool<{query: string}, {symbols: {name, file, line}[]}>`.
- `src/tools/lspDiagnostics.ts` — `Tool<{file?: string}, {diagnostics: ...}>`.
- `src/tools/repoOverview.ts` — `Tool<{}, {tree: string, languages: string[], entrypoints: string[]}>`.
- `src/treesitter/` — tree-sitter wrapper for syntax-aware patch application.
- `tests/lsp/` + `tests/tools/lsp*.test.ts` + `tests/tools/repoOverview.test.ts`.

Modify:
- `src/tools/fileEdit.ts` — adopt apply_patch style; reuse tree-sitter for syntactic-boundary detection on edits.
- `src/tools/index.ts` — register the new tools.
- `package.json` — `vscode-jsonrpc`, `vscode-languageserver-protocol`, `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-go`.
- `docs/03-cli-reference/usage.md` — "LSP tools" section.
- `docs/02-architecture/runtime-architecture.md` — LSP subsystem documented.
- `docs/04-extending/extending.md` — "Adding LSP support for a new language" recipe.

**Build items:**

1. **LSP client.** Implement `LspClient` over `vscode-jsonrpc` stdio; methods: `initialize`, `definition`, `hover`, `references`, `documentSymbol`, `diagnostics`.

2. **Server manager.** `LspManager.getServer(language)` returns a running server; spawns lazily on first use; tracks per-session; tears down on session close.

3. **Language detection.** `detectLanguage(file)` looks at extension and project markers. Falls back to file content sniffing for ambiguous extensions.

4. **Server registry.** `src/lsp/servers.ts` declares per-language: command (`typescript-language-server`, `pyright`, etc.), args, init options. Surface a config override so users can point at custom server installs.

5. **Tools.** Each LSP tool is ~50 lines: validate input → resolve server → invoke method → translate result to Sov tool result shape. Permission: LSP tools default to `isReadOnly: true`, `isConcurrencySafe: true`.

6. **`RepoOverview` tool.** Walk the repo respecting `.gitignore`; classify languages; identify entry points (main.ts, src/index.ts, Cargo.toml binaries, etc.); return a structured summary <2KB. Mirror opencode's pattern.

7. **`apply_patch` upgrade for FileEdit.** Replace the current substring-match-and-replace with a unified-diff-style patch application. Use tree-sitter when available for syntactic boundary validation. Port the algorithm from opencode's `apply_patch` tool (it's well-tested).

8. **Ripgrep cache.** Wrap existing `Grep` tool: cache last-N query results keyed by repo state hash; invalidate on file changes. Cuts repeat-query cost.

9. **Documentation.** `docs/03-cli-reference/usage.md` LSP section with one example per tool. `docs/02-architecture/runtime-architecture.md` LSP subsystem diagram. `docs/04-extending/extending.md` recipe for adding a new language.

10. **Semantic tests.** New suite `tests/semantic/suites/lsp.suite.ts` — 5 cases: goto-def, hover, refs, symbols, diagnostics. Use the Sov repo itself as the test corpus.

**Success criteria:**

- [ ] LSP servers spawn lazily; first use latency <2s; subsequent calls <100ms.
- [ ] Agent uses LSP tools in preference to Grep when symbol-aware queries arrive (measurable via trace analysis).
- [ ] `RepoOverview` returns useful output on the Sov repo and at least 3 external repos (small, medium, large).
- [ ] `FileEdit` failure rate decreases vs current (measure on a corpus of 50 historical edits).
- [ ] Semantic LSP suite passes 5/5.

**Acceptance tests:**

- Unit: client, manager, detect, each tool.
- Semantic: new LSP suite.
- Manual: drive a non-trivial refactor on the Sov repo using only LSP tools (no Grep); confirm correctness.

**Risks:**

- **Language server installation.** Users may not have `pyright` or `gopls` installed. Mitigation: `sov lsp install <lang>` subcommand wrapping `npm i -g`/`go install`/`pip install`; print install instructions when a server is missing.
- **Server crashes mid-session.** Mitigation: restart-on-crash with backoff; surface crashes as tool errors with retry guidance.
- **`apply_patch` regression on the FileEdit migration.** Mitigation: A/B run on a corpus of historical edits before swap; rollback path keeps the old algorithm for one release.

**Dependencies:** None. Can run parallel with Phase 16.1.

**Rough effort:** 3–4 weeks wall.

---

### Phase 21 — Plugin SDK + IDE Extensions

**Goal:** publish a versioned plugin SDK so third parties can extend Sov. Ship VS Code and Zed extensions as the first consumers.

**Scope (in):**
- `@sov-ai/plugin` package: tool, slash-command, hook, skill-loader, TUI-component (if 16.1 architecture supports it) contracts as a public API.
- `@sov-ai/sdk` package: HTTP API client for `sov serve` (TypeScript).
- VS Code extension at `extensions/vscode/`: sidebar chat, inline edit approval, status bar, diagnostics passthrough.
- Zed extension at `extensions/zed/`: minimum viable parity (chat panel).
- Documentation: plugin author guide + extension consumer guides.

**Scope (out):**
- JetBrains plugin (deferred; Sublime, Vim, Neovim too).
- Auto-discovery of plugins from a registry (deferred — npm install + config registration in v1).
- Sandboxed plugin execution (deferred — plugins are trusted code in v1).

**Deliverable:**

```bash
npm i -g @sov-ai/plugin-example
# In ~/.harness/config.json:
{ "plugins": ["@sov-ai/plugin-example"] }
# Plugin's tools / commands / skills now available in sov.
```

VS Code Marketplace: install "Sovereign AI"; open command palette → "Sov: Ask"; sidebar chat opens against the project's `sov serve` instance.

**Key files:**

Create:
- `packages/plugin/` — new workspace package `@sov-ai/plugin`.
- `packages/plugin/src/index.ts` — public exports: `Tool`, `SlashCommand`, `Hook`, `Skill`, `Plugin` types.
- `packages/plugin/src/types.ts` — versioned public types.
- `packages/sdk/` — new workspace package `@sov-ai/sdk`.
- `packages/sdk/src/client.ts` — HTTP client for `sov serve`.
- `extensions/vscode/` — VS Code extension.
- `extensions/vscode/package.json` — extension manifest.
- `extensions/vscode/src/extension.ts` — activation, command registration.
- `extensions/vscode/src/sidebar.ts` — chat panel webview.
- `extensions/vscode/src/diff.ts` — inline diff approval handler.
- `extensions/zed/` — Zed extension.
- `docs/plugin-authoring.md` — recipe + reference.

Modify:
- `package.json` — set up Bun workspaces if not already; reference `packages/*` and `extensions/*`.
- `src/plugins/loader.ts` — extend existing skill/agent loader pattern to plugins; load plugins from `config.plugins[]` array on boot.
- `docs/04-extending/extending.md` — point to plugin-authoring guide.
- `CHANGELOG.md` — plugin SDK v1.0.0 release entry.

**Build items:**

1. **Extract the plugin contract.** Audit current internal interfaces (`Tool<I,O>`, `SlashCommand`, `Hook`, `SkillDef`); freeze the subset that should be public; document each field; mark internal-only fields as such.

2. **Set up monorepo.** Convert root `package.json` to Bun workspaces declaring `packages/*` and `extensions/*`. Verify existing build/test pipelines still work.

3. **Build `@sov-ai/plugin`.** Re-exports the public contract types. Versioned 1.0.0 on first publish; semver from there.

4. **Build `@sov-ai/sdk`.** HTTP client matching `sov serve` endpoints. Returns typed responses. SSE handling via `EventSource` polyfill (Bun has native; browser-side uses native).

5. **Plugin loader.** `src/plugins/loader.ts` reads `config.plugins[]`; for each entry, `import(<name>)`, validates the exported default against the `Plugin` contract; registers tools/commands/skills/hooks. Per-plugin namespace prefix (`<plugin-id>__tool-name`).

6. **VS Code extension scaffolding.** `yo code` or manual scaffold; activation event on `onCommand:sov.ask`; commands: `Sov: Ask`, `Sov: Apply Diff`, `Sov: Show Sidebar`. Sidebar webview hosts a Solid (or React) app driving `@sov-ai/sdk` against `sov serve` on `localhost:8080`.

7. **VS Code: inline diff approval.** When `sov serve` emits `permission_request` for a FileEdit, the extension shows a VS Code diff editor; approve/deny buttons call back to `/sessions/:id/approvals/:requestId`.

8. **VS Code: status bar.** Cost-this-session + current-model in the status bar.

9. **Zed extension.** Minimum viable: chat panel via Zed's extension API; one-shot prompt → response.

10. **Plugin author guide.** `docs/plugin-authoring.md`: skeleton plugin, publishing to npm, configuring in `~/.harness/config.json`, debugging.

11. **Reference plugin.** `packages/plugin-example/` — adds one tool (`Greet`), one slash command (`/greet`), one skill. Used as the tutorial in plugin-authoring.md.

12. **CI for extensions.** GitHub Actions: lint + typecheck + package; on tag, publish VS Code via `vsce`, publish to Zed registry. Plugin packages publish to npm via a Phase-21-internal release workflow (set up as part of this phase since Phase 14's release workflow was dropped).

**Success criteria:**

- [ ] `npm i -g @sov-ai/plugin-example` + config entry surfaces the plugin's tool, command, and skill in `sov`.
- [ ] VS Code extension installs from the marketplace; opens sidebar; runs a turn against `sov serve`; renders permission approvals as inline diffs.
- [ ] Zed extension installs from Zed's registry; opens a chat panel; runs a turn.
- [ ] Plugin author guide enables a new developer to ship a plugin from scratch in under 1 hour (validated via at least one external test).

**Acceptance tests:**

- Unit: plugin loader, contract validation, SDK client.
- Integration: VS Code extension test harness; Zed extension test (where Zed API supports it).
- Manual: install both extensions on a clean machine; drive a coding task end-to-end.

**Risks:**

- **Public API churn.** Once published, breaking changes are expensive. Mitigation: explicit semver discipline; deprecation warnings ahead of removals; CHANGELOG.md as the contract record.
- **VS Code extension review delays.** Mitigation: submit early; iterate on a staging tag.
- **Plugin namespace collisions.** Mitigation: enforce `<plugin-id>__` prefix on registered names; plugin-id derived from package name.

**Dependencies:** Phase 16.1 (TUI hook points if exposed), Phase 18 (HTTP API for the IDE extensions). Note: Phase 14 (distribution) was dropped from the roadmap — Phase 21 needs to set up its own minimal release path for the `@sov-ai/plugin` and `@sov-ai/sdk` packages as part of build item 12.

**Rough effort:** 4–6 weeks wall.

---

### Phase 22 — Web Dashboard (Deferred)

**Goal:** monitoring surface for bundle-mode operation; review queue, instinct corpus, trajectory volume, scheduled-mission status, cost dashboards.

**Scope:** deferred. Revisit after Phases 15, 16.1, 18, 19, 20, 21 are complete. The bundle-mode UX may not need a web dashboard if VS Code extension + TUI cover monitoring sufficiently. Decision point: assess after Phase 21 ships.

If pursued: SolidJS + Hono server-side rendering (or Astro static + API calls); read-only initially; consumes `sov serve` HTTP API; deploys per-bundle alongside the harness.

---

## 8. Risks & Mitigations (cross-phase)

| Risk | Phase(s) | Mitigation |
|---|---|---|
| Phase 16.1 plumbing-lift recurrence | 16.1 | Rules 1–4 from postmortem enforced; opt-in flag until parity audit; 24-row prereq checkbox tracking |
| `@ai-sdk/*` API instability | 15 | Pinned minor versions; per-provider integration tests; A/B before Anthropic migration |
| Public API churn on plugin SDK | 21 | Semver discipline; ADR for every breaking change; deprecation cycle ≥1 release |
| LSP server install friction | 20 | `sov lsp install` subcommand; clear missing-server diagnostics |
| Cost explosion from broader provider testing | 15 | Use smallest non-deprecated models; `string-match` judge for provider breadth tests; cap per-CI-run total |
| HTTP API authentication weakness | 18, 21 | Password-required by default off-localhost; OAuth deferred but tracked; document deployment recommendations |
| Roadmap scope creep | all | This spec lists explicit "scope out" per phase; per-phase plans inherit those boundaries; new requests trigger ADR + scope-decision rather than silent absorption |

---

## 9. Integration With the Existing Canonical Build Plan

The canonical build plan lives at `~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`. This spec proposes the following edits to it (executed in a separate sister-repo commit cascade after this design spec is accepted):

**Insertions:**

1. ~~Phase 14 — dropped~~. Per the 2026-05-13 Phase-14-dropped ADR in DECISIONS.md, distribution is deferred until the product is production-grade. No sister-repo insertion for Phase 14.

2. Insert a new **Phase 15 — Provider Breadth via `@ai-sdk/*`** section after Phase 13.5. Body copied from §7 above.

3. Insert a new **Phase 20 — LSP Integration** section after Phase 19. Body copied from §7 above.

4. Insert a new **Phase 21 — Plugin SDK + IDE Extensions** section after Phase 20. Body copied from §7 above.

5. Insert a new **Phase 22 — Web Dashboard (Deferred)** section after Phase 21. Body summarized from §7 above.

**Modifications:**

6. Update **Phase 16.0**'s Status block: confirm 16.0a/b/c outcomes already documented; cross-link this spec for Phase 16.1 details. Phase 16.7 (TUI polish with Ink) absorbed into Phase 16.1 — mark Phase 16.7 as "rolled into Phase 16.1 (see §16.1)".

7. Update **Phase 18** (HTTP API Server): expand the scope per §7 above; remove "Optional" from the title (it is no longer optional — it gates Phase 19, 21, 22, and channel adapters). Note the reprioritization: Phase 18 now follows Phase 16.1 rather than Phase 17.

8. Update **Phase 19** (MCP Server Mode): minor refinement per §7 above.

9. Cross-cutting: add a **Polish track summary** subsection to the build plan's introduction that lists Phases 15, 16.1, 18, 19, 20, 21 as "production polish track" — the phases that bring the base harness to opencode-comparable polish before later Sov-specific phases (16.5, 17, 22).

**Sister-repo edits in detail:**

The canonical build plan is in a separate repo (`~/code/sovereign-ai-docs/`) with its own CLAUDE.md, version-bump convention, frontmatter, and cascade workflow. Edits there should:

- Bump `version` and `updated` in frontmatter.
- Run `npm run lint` before commit (mechanical cascade + structural lint).
- Add a one-liner to `state/memory/decisions-made.md`: "Production polish track defined (Phases 15, 16.1, 18, 19, 20, 21) — base harness reaches opencode polish before Sov-specific extensions; Phase 14 dropped per 2026-05-13 ADR."
- Commit and push to origin/master per the docs-repo workflow.

**Harness-repo edits (this repo):**

1. Insert this spec at `specs/2026-05-13-production-harness-roadmap-design.md` (this file).

2. ~~Original direction (preserved for the record): set CLAUDE.md `Next:` to Phase 14.~~ **Updated 2026-05-13:** CLAUDE.md `Next:` now points at Phase 16.1 directly (`specs/2026-05-13-phase-16-1-tui-rebuild-design.md`). Phase 14 is dropped; Open Q1 (TUI framework) is closed (Go + Bubble Tea). See the 2026-05-13 Phase-14-dropped ADR in DECISIONS.md.

3. Update `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md`: add a header line linking back to this spec.

4. Add an ADR-stub entry to `DECISIONS.md`: "Production polish track defined (Phases 15, 16.1, 18, 19, 20, 21). Phase 14 dropped per 2026-05-13 ADR. Hermes-layer extensions (16.5, 17, 22) deferred until polish track complete. See `specs/2026-05-13-production-harness-roadmap-design.md`."

5. On the next state-snapshot session, the close-out snapshot at `docs/07-history/state/<YYYY-MM-DD>.md` references this spec as the active forward-looking plan.

---

## 10. Sequencing & Timing

Approximate token estimates (per the docs-repo CLAUDE.md convention) and wall-time ranges are illustrative; actual rates depend on AI-pair-programming throughput.

| Phase | Tokens | Wall (single track) | Wall (parallel-safe) |
|---|---|---|---|
| 15 — Provider breadth | ~120–180K | 2–3 wk | parallel with 16.1 |
| 16.1 — TUI rebuild | ~400–600K | 8–14 wk | parallel-safe with 20 |
| 18 — HTTP API | ~100–150K | 2–3 wk | after 16.1 M5 (mid-rebuild) |
| 19 — MCP server | ~60–100K | 1–2 wk | after 18 |
| 20 — LSP | ~150–220K | 3–4 wk | parallel with 16.1 |
| 21 — Plugin SDK + IDE | ~250–350K | 4–6 wk | after 16.1, 18 |
| 22 — Web dashboard | (deferred) | (deferred) | after 21 |

Single-track sequential total: **~21–34 weeks** (~5–8 months).

Parallel-safe ordering reduces by ~30–40%:

- Track A (foundation): 16.1 → 18 → 19 → 21
- Track B (parallel-safe): 20 (LSP) and 15 (providers), user's call on order

Realistic estimate with one developer + AI pairing, prioritizing parallel-safe work: **~4–6 months** to complete Phases 14, 15, 16.1, 18, 19, 20, 21 to a quality bar that closes the polish gap.

Per-phase milestones (especially Phase 16.1) close with state snapshots so the user can steer mid-track. No phase is monolithic.

---

## 11. Design Questions To Answer Before Each Phase Plan-Writes

Each per-phase plan should resolve at least these questions before TDD task-decomposition begins. Questions inherit from the spec but the plan owns the answer.

**Phase 15:**
- Resolve Open Q2 (recommend Option C: wrap `@ai-sdk/*`).
- Final provider list (ten + OpenAI-compat-generic).
- Model registry source (recommend `models.dev` mirror).
- Whether existing `Ollama` and `OpenRouter` providers migrate to wrapper or stay hand-rolled (recommend migrate for consistency).

**Phase 16.1:**
- Resolve Open Q1 (recommend Option B: OpenTUI).
- Whether 16.0a daemon code keeps a foreground subscriber via TUI (recommend yes — surfaces the daemon's PID lock + event bus).
- Whether `terminalRepl.ts` deletion happens after M11 (recommend yes, with deprecation warning two releases prior).
- Theme set in v1 (recommend light + dark only; community themes come later).

**Phase 18:**
- HTTP framework (recommend Hono).
- Whether SSE or WebSocket for streaming (recommend SSE — proxy compatibility, simpler).
- Auth model in v1 (recommend password only; OAuth deferred to Phase 21 if hosted IDE demands it).

**Phase 19:**
- Which Sov tools intentionally don't ship via MCP (recommend: `AgentTool`, `TaskCreate/Get/List/Stop`, `SkillTool`, `MemoryProposeTool`, `SkillProposeTool` — all state-coupled or recursion-prone).

**Phase 20:**
- Initial language set (recommend TypeScript, Python, Rust, Go; defer C/C++, Java, etc.).
- Whether `sov lsp install` ships in this phase or as a follow-up.

**Phase 21:**
- Plugin contract surface in v1 (recommend: tool, slash command, skill, hook; defer TUI components until 16.1 architecture stabilizes).
- Whether IDE extensions ship together or VS Code first then Zed (recommend VS Code first).

---

## 12. Self-Review

**Spec coverage check** (per writing-plans skill self-review):

- §2 covers current baseline — ✓
- §3 covers goal — ✓
- §4 covers definition of polish bar — ✓
- §5 covers phase map — ✓
- §6 covers open decisions — ✓
- §7 covers per-phase specs (8 phases) — ✓
- §8 covers risks — ✓
- §9 covers integration with canonical build plan — ✓
- §10 covers sequencing — ✓
- §11 covers per-phase open questions — ✓

**Placeholder scan:**
- No "TBD", "TODO", "implement later", or "fill in details" remain in the spec body.
- All file paths are absolute or repo-relative.
- All recommendations are concrete (named packages, named files, named decisions) — no "appropriate library", no "suitable approach".
- Two open decisions (Q1, Q2) explicitly named as decisions, with recommended defaults and decision-points.

**Type and naming consistency:**
- `LLMProvider`, `Tool<I,O>`, `StreamEvent`, `Message`, `ContentBlock`, `query()` — used consistently with the existing runtime contract per §2 and `CLAUDE.md` design principles.
- `sov serve` (not `sov server`), `sov mcp serve` (not `sov mcp-serve`), `@sov-ai/plugin` (not `@sovereign/plugin`) — chosen for consistency with `sov` binary and assumed npm org.
- Phase numbers (14, 15, 16.1, 18, 19, 20, 21, 22) — non-overlapping with existing canonical phases.

**Per-phase plan gaps to fill at execution time:**
- Each per-phase plan (saved to `plans/YYYY-MM-DD-phase-NN-<feature>.md`) will fill in TDD task-decomposition with concrete code in every step per the writing-plans skill format. This spec is the umbrella; per-phase plans are the executable units.

---

## 13. Next Steps

1. **User review of this spec.** Specifically: confirm phase numbering, confirm sequencing, confirm recommended defaults for Open Q1 and Open Q2, confirm sister-repo edits to the canonical build plan.

2. **Resolve Open Q1 (TUI framework).** Best path: dedicated `superpowers:brainstorming` session weighing Options A–D against the postmortem rules. Record outcome in `DECISIONS.md` as ADR H-001x.

3. **Resolve Open Q2 (provider strategy).** Lighter weight than Q1; can be resolved inline at Phase 15 plan kickoff.

4. **Sister-repo edit to canonical build plan.** Insert new phases per §9; bump versions; commit; push. Separate from this commit.

5. **Update harness-repo metadata.** `CLAUDE.md` Phases section; `DECISIONS.md` ADR-stub; `docs/08-roadmap/backlog/phase-16-rebuild-prereqs.md` cross-link.

6. ~~Original next step: write the Phase 14 plan.~~ **Updated 2026-05-13:** Phase 14 dropped. The first per-phase plan that shipped was Phase 16.1 (`plans/2026-05-13-phase-16-1-tui-rebuild.md`).

7. **Track open backlog.** Item #17 (eval-gated auto-promote, P4) remains open and orthogonal to this roadmap; close when convenient.
