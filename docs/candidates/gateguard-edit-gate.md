# GateGuard Pre-Edit Gate · Candidate

Status: candidate — not scheduled
Created: 2026-06-14
Origin: ECC integration review (`~/code/ecc-integration-review.md`, Tier 1 #2). Upstream pattern:
`zunoworks/gateguard` (third-party), surfaced via ECC `scripts/hooks/gateguard-fact-force.js`.

## Problem

Agents edit files without first understanding **blast radius** — who imports the file, what API
surface or data schema the change affects, what downstream consumers break. The harness's
permission model is fail-closed about *whether a tool may run* (`src/permissions/canUseTool.ts`),
but it has nothing to say about *whether the agent understands the edit it's about to make*. The
usual mitigation — an "are you sure?" confirmation prompt — is useless: the agent confirms its
own under-informed plan. Self-evaluation doesn't create the missing awareness.

## Concept

An **opt-in** pre-edit gate: block the **first** `Edit`/`Write` to a given file in a session
until the agent has demonstrably investigated the edit's blast radius — importers, affected API,
data schemas. The block isn't a yes/no prompt; it's a **forced investigation** — the gate returns
a checklist the agent must satisfy before the edit proceeds. The insight (from GateGuard): *the
act of investigation creates awareness that self-evaluation never did.* Subsequent edits to the
same file in the session pass freely.

## Design sketch

- **Mechanism:** a `PreToolUse` policy matched on `Edit|Write|MultiEdit`, keyed by target path.
  First touch of a path → block (the harness's exit-2-style block) with `additionalContext`
  enumerating the required investigation: "list importers of this file, the public API it
  exposes, and any schema it defines, before editing." Path seen before → pass.
- **What counts as "investigated" (escalating strictness — start simple):**
  1. *Soft:* block once, inject the checklist, trust the agent to comply on retry (cheapest).
  2. *Tracked:* require prior `Grep`/`Read` activity referencing the path's importers in this
     session (the harness already records tool history — `src/trace/writer.ts`).
  3. *Structured:* require the agent to emit a short blast-radius statement the gate validates.
  Ship (1), measure, escalate only if edits still land blind.
- **Opt-in:** a settings knob, e.g. `editGate: "off" | "warn" | "block"`, default **off**
  (`src/config/schema.ts`). Per-project enable. New files (no importers yet) are exempt.

## Fit with existing subsystems

| Concern | Reuse |
|---|---|
| Gate mechanism | `src/hooks/` (PreToolUse matcher + runner, exit-2 block, `additionalContext`) |
| Alternative home | `src/permissions/canUseTool.ts` (policy that returns block + guidance) |
| Session tool history | `src/trace/writer.ts` (for the "tracked" strictness tier) |
| Config | `src/config/schema.ts` (the `editGate` knob, default off) |

The harness already has the exact primitives (PreToolUse hooks that block with injected context,
per-session state), so this is a *policy*, not new infrastructure.

## Open questions

- Strictness: soft checklist vs prior-Grep tracking vs explicit statement vs LLM-judge? Start soft.
- Granularity: per-file-once, per-session, or per-symbol/region? Per-file-once is the cheap default.
- Sub-agents: does each delegated child re-gate independently, or inherit the parent's cleared
  paths? (Likely re-gate — a child has its own context and blast-radius blind spot.)
- New-file handling: exempt (no importers) — confirm, and decide on rename/move.
- Build vs adopt: evaluate `zunoworks/gateguard` upstream before writing a sov-native version;
  the value is the *pattern*, and the pattern is ~50 lines as a hook.
- Noise threshold: at what edit-count does the friction outweigh the catch rate? Needs measurement.

## Value

The one genuinely novel *behavioral* safety pattern in ECC, and a clean fit for the harness's
fail-closed ethos: it converts a worthless confirmation into a forced understanding step, cutting
blast-radius mistakes (edit-then-break-importers) that current gates can't see.

## Bloat guard

**Ship opt-in, default off.** Implement as **one** PreToolUse policy/hook, never a subsystem.
Only graduate this past "candidate" if blast-radius edit mistakes are an **observed, measured**
problem in real sessions — not speculatively. Prefer adopting/wrapping the upstream over a
bespoke reimplementation. If the "investigated" check creeps toward an LLM-judge or a stateful
tracker, re-scope down to the soft checklist — the cheap version captures most of the value.
