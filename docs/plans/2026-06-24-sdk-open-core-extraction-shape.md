# SDK Open-Core Extraction — shape (2026-06-24)

> **High-level shape, not a rigorous plan.** This records what a code-level audit found and the direction for re-orchestrating this harness as an **open-core SDK**. The module-by-module open/closed call, the exact public API, the persistence-port interface, packaging mechanics, and the OSS-license choice are a **deliberate follow-up pass**. Business decision: **B-0014** in `~/code/sovereign-ai-docs` (`business/decisions/0014-sdk-open-core-split.md`); full readiness/boundary write-up: `business/architecture/sdk-open-core-extraction.md`.

## Why

Two questions were posed: is there enough IP here to keep proprietary, and how ready is the harness to become an importable SDK — measured against Anthropic's `claude-agent-sdk-typescript`. Answer: **the moat is execution and integration, not invention.** Most of the harness is reproducible commodity; four subsystems are genuinely differentiated. So the shape is **open-core**: open the reproducible primitives for adoption + brand; keep the differentiated subsystems as the proprietary layer.

## Readiness vs. Anthropic's Agent SDK — ~3/5

The reference SDK is a thin importable surface: a single `query({ prompt, options })` async generator + typed Tool/MCP/hook config + a clean `exports` map (it shells out to the `claude` CLI). Its public repo is itself thin (README + examples + issue-triage) — the lesson being that a mature SDK is a *lean, documented, importable surface*, not a wholesale app.

**Good bones (already SDK-grade):**
- `src/core/query.ts` — `query()` is a pure async generator, no TTY/process/CLI entanglement.
- `src/core/types.ts` — `QueryParams` is a clean, fully-typed, injectable options bag (provider, model, tools, permissions, hooks, memory, abort), caller's messages never mutated.
- `src/tool/buildTool.ts` — a real `buildTool<I,O>` factory; permissioned, fail-closed; tools hold no global state.
- `src/providers/resolver.ts` — swappable multi-provider abstraction (one interface across anthropic/openai/openrouter/ollama/local). This *is* the anti-lock-in capability.
- `src/mcp/` — MCP flows through the same Tool pipe.

**App-shaped seams (the blockers):**
- `package.json` — `private: true`, `UNLICENSED`, `module: src/main.ts`, `bin → src/main.ts`; **no `exports` map, no barrel.**
- `src/server/runtime.ts` — the only runtime assembler, `buildRuntime()`, is **fused to the Hono HTTP server** and pulls in ~50 subsystems; every surface reaches a turn over local HTTP.
- `bun:sqlite` opened at boot; Bun-only (not Node).
- Config is file-only (`src/config/loader.ts`) — no settings-object injection.

## The open / proprietary boundary

**OPEN CORE — the Sovereign AI SDK (reproducible primitives):**
- the `query()` agent-loop core + its typed options contract;
- the `Tool<I,O>` factory + permissioned tool contract;
- the multi-provider (local-first) provider abstraction;
- MCP client integration;
- hooks, skill/slash loading, a basic memory interface, transcripts.

**PROPRIETARY LAYER — built on top (source-available or closed):**
1. **Learning layer** — `src/learning*` (observe → cluster → synthesize → recall; eval-backed).
2. **Gateway / multi-tenancy** — `src/server/` (SSE replay ring for reconnect, human-in-the-loop approval queue, per-principal isolation).
3. **Workflow engine** — `src/workflows/` (declarative parallel DAG with *enforced* per-task write-globs + lane semaphores).
4. **Subscription-executor bridge** — `src/runtime/subprocessExecutor.ts` (canonicalize-and-replay a headless `claude -p` transcript into the native learning loop — the hardest to copy).

**Fix-or-drop:** the "bundle separates runtime from business data (read-only tiers)" story is **convention-only in code** (`src/bundle/` — no write-guard; the promised business-doc accessor doesn't exist). Build the enforcement or stop marketing it.

## Extraction shape (high-level)

- **A. Draw the line** — ratify the per-module open/proprietary map above.
- **B. Carve a public surface** — add a barrel (`src/sdk.ts` / `index.ts`) + a package `exports` map re-exporting `query`, `QueryParams`, `buildTool`, core types, the provider resolver, MCP types; add **one thin `createAgent()` assembler** that composes provider + tools + system *without* the server/cron/daemon/learning, defaults to no-disk state, and accepts a config **object**.
- **C. Decouple the blockers** — make session persistence an injectable port (in-memory default) so `bun:sqlite` isn't mandatory; add object-based config injection; document an ephemeral/no-state default; decide Node compatibility (Bun-only today).
- **D. Split packaging** — open-core package (license flipped to OSS) vs. the proprietary layer (separate package/repo or source-available license) consuming the open core through its public ports.
- **E. SDK-grade docs + examples** (the thin-repo lesson).

Effort to a *first thin SDK* is modest — the core, types, tool factory, and provider injection already exist; the real work is the boundary decision and decoupling the server-fused assembler, not a rewrite.

## Not in scope here (next pass)

The rigorous, actionable version: the module-by-module open/closed decision, the exact public API surface, the persistence-port interface, the packaging mechanics, and the OSS-license choice.
