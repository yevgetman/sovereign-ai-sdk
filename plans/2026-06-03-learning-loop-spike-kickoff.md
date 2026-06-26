# Learning Loop Spike — Kickoff & Canonical Specs (start here)

> **For Claude Code sessions in this repo:** this is the entry point for the **#1 near-term engineering priority** — building and proving the **learning loop** as a *portable* layer. The design and the "why" are **canonical in the sister `sovereign-ai-docs` repo** (linked below) and must stay there. **Your job is to produce the implementation specs and build plans in THIS repo, and execute them.**

## What this is

Per **ADR H-0010** (*compose the Layer-2 agent core, own the differentiators*), the **learning layer is our moat** — the one piece no off-the-shelf framework provides. This harness already has ~80% of the machinery, but **the loop is open**: instincts are synthesized to disk and then never injected back into the main agent (verified 2026-06-03: 185 trajectories → 2 synthesized instincts → 1 ever-approved memory). We are **closing that loop**, and building it **portably** so the same learning layer can later sit on a rented engine (Deep Agents or a TypeScript equivalent) via a thin adapter — not a rebuild.

## Canonical specs — read these first (they live in the docs repo)

These are authoritative and stay in `sovereign-ai-docs`. **Do not copy them here — link to them.** Implementation detail lives in this repo.

- **The spike — what to build first:** `~/code/sovereign-ai-docs/harness/docs/runtime/learning-loop-spike-spec.md`
- **The design — the four-port portable seam:** `~/code/sovereign-ai-docs/harness/docs/runtime/portable-learning-layer-spec.md`
- **The decision (H-0010):** `~/code/sovereign-ai-docs/harness/decisions/0010-compose-l2-agent-core-own-differentiators.md`
- **The analysis behind it:** `~/code/sovereign-ai-docs/07-history/state/analysis/2026-06-03-deepagents-vs-harness-build-vs-adopt.md`

## The shape (gist, so you have it without leaving the repo)

The learning layer is built as a **sealed module that talks to any host harness through exactly four ports:**

- **Observe** — the host hands completed sessions / tool events to the layer.
- **Recall** — before a turn, the layer returns the learned context to inject into the agent. **This is the missing link today.**
- **Reason** — the layer calls a model to synthesize lessons.
- **Persist** — the layer reads/writes its own corpus.

Everything proprietary lives inside the module; the only host-specific code is a **thin adapter** (adapter #1 = this harness). Portability acceptance gate: the layer runs **unchanged** against a mock host *and* this harness, with only the adapter differing.

The spike is two phases: **Phase 1** — close the loop on this harness behind the contract, and prove via an eval that a lesson from session N changes behavior in session N+1 **with no human approval** (use the existing trajectory corpus as the test set). **Phase 2** — stand the *same* layer on one rented engine via a second adapter to prove it ports.

## Your task (start here)

1. **Read the four canonical specs above.**
2. **Map the current learning machinery against the four ports** — what exists and where it's wired: `src/learning/`, `src/review/`, `src/trajectory/`, `src/tool/registry.ts` (`LEARNING_ONLY_TOOLS`), `src/context/`, `src/memory/`. Confirm the gap: **Recall** (injection of learned instincts into the main agent's context) is unwired, and synthesis yield is near-zero.
3. **Author the implementation specs + build plans in THIS repo**, per `docs/05-conventions/repo-layout.md`:
   - a **design doc** under `specs/` for the four-port contract and how each port binds to this harness (adapter #1);
   - a **Phase 1 implementation plan** under `plans/` (close Recall; fix synthesis yield; build the with-vs-without eval), task-checkboxed for `superpowers:subagent-driven-development`.
4. **Execute Phase 1.** Prove the loop with the eval **before** any Phase 2 / rented-engine work.

## Decisions reserved for the founder — do NOT decide these yourself

- **Which rented engine** to test in Phase 2 (Deep Agents-TS / Vercel AI SDK / Mastra). **TypeScript-vs-Python is a *major* decision — surface it, don't decide it.**
- **Go / no-go after Phase 1** — does the loop actually change behavior?
- Whether learned memory/skills **auto-promote** by default.

## Keeping the record straight (cross-repo)

This repo owns the **implementation** docs (the design + plans you author here). The **roadmap and decision record stay canonical in `sovereign-ai-docs`** — when you make progress, update (or flag for a docs-repo session) the spike spec's phase `**Status:**` lines, the `learning-loop-closure-and-proof` open-question, and the dev status page, all in `sovereign-ai-docs`.
