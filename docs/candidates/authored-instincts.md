# Authored Instincts · Candidate

Status: candidate — not scheduled
Created: 2026-06-14
Origin: ECC integration review (`~/code/ecc-integration-review.md`, Tier 1 #1)

## Problem

The harness has a mature **learned** instinct corpus: tool calls are observed
(`src/learning/observer.ts`), a synthesizer clusters them into confidence-weighted instincts
with reinforce/saturate/contradict math (`src/learning/confidence.ts`), and relevant ones are
recalled and injected into context each turn — deterministically, token-ranked, no model call
(`src/learning-layer/`). Cross-project promotion graduates an instinct to global at ≥2 projects
∧ ≥0.7 confidence.

What it lacks is a first-class place for **human-authored, declarative "always rules."** Today
those reflexes are scattered across three incoherent homes:

- **System-prompt prose** (`bundle-default/business/system-prompt.md`, the docs bundle) — frozen
  per session, unranked, not recalled by relevance.
- **Permission rules** (`src/config/rules.ts`) — only express *allow/deny on tool use*, not
  behavioral guidance.
- **Hooks** (`src/hooks/`) — imperative, code-shaped, heavyweight for "prefer X over Y."

There is no single inspectable, versionable, relevance-recalled layer for "when X, always
do/avoid Y" that a human writes directly. That is the gap.

## Concept

Add an **`origin: authored`** lane to the *existing* instinct store. Human-written rules carry
the same shape as learned ones (trigger / guidance / rationale / confidence / scope) and flow
through the **same recall → inject path** — so authored and learned reflexes arrive by one
mechanism. Authored rules differ only in provenance and lifecycle:

- **Pinned confidence** — authored rules are pre-approved by a human, so they bypass the
  reinforcement/decay math (or are floored), rather than being reweighted by the learning loop.
- **No review tray** — `src/review/` exists to human-gate *machine* proposals; authored rules
  are already human-authored, so they skip it.
- **Authoritative on conflict** — when an authored rule and a learned instinct collide on the
  same topic, the authored one wins (or sets a floor the learned one can't override down).

## Design sketch

- **Storage:** an authored corpus parallel to the learned one — e.g. `instincts/authored/*.md`
  in the bundle (versionable with the business data) and/or under `$HARNESS_HOME`. Reuse the
  instinct frontmatter the loader already parses.
- **Shape:** `id`, `when` (trigger), `guidance` (do / don't), `rationale`, `confidence` (pinned),
  `scope` (global | project), `enabled`.
- **Recall:** merge authored into the existing ranked-injection step; dedup against learned by
  topic/id with authored taking precedence; respect the same injection token budget.
- **Authoring surface:** a plain editable file is the floor. The `Instinct{List,View,Propose,
  UpdateConfidence}` tools already exist — extend `InstinctPropose` with an `--authored` path,
  or add a `/instinct` slash command, so the agent (or Gene) can add rules in-session.

## Fit with existing subsystems

| Concern | Reuse |
|---|---|
| Recall + injection | `src/learning-layer/` (token-ranked, deterministic) |
| Confidence handling | `src/learning/confidence.ts` (authored = pinned/floored branch) |
| Tools | `Instinct{List,View,Propose,UpdateConfidence}` (already shipped) |
| Injection point | `src/context/systemPrompt.ts` segment assembly |
| Storage convention | bundle three-tier + `$HARNESS_HOME` (`src/bundle/`, `src/config/paths.ts`) |

## Open questions

- Do authored rules bypass the confidence math entirely (pure pinned) or seed it as a prior?
- Conflict resolution authored-vs-learned: hard override, or floor-only?
- Corpus home: bundle (travels with business identity) vs `$HARNESS_HOME` (machine-local)? Likely
  bundle for identity rules, harness-home for machine-local ones — support both.
- Per-project vs global authoring ergonomics.
- Injection priority: should authored always win the token budget over learned when both qualify?

## Value

Fills the single clearest governance seam the subsystem audit found, while **reusing ~80% of
existing machinery** (store, recall, injection, tools). Makes the harness's reflexive rules
inspectable and version-controlled in one place instead of three. Complements — does not replace
— the learned corpus: human priors + machine-learned patterns, one injection path.

## Bloat guard

**Hard constraint: this must reuse the existing instinct store + recall/injection path, not add
a parallel subsystem.** If a prototype can't ride the current recall pipeline and instead needs
its own loader/ranker/injector, the design is wrong — stop and reconsider. The authored lane is a
provenance flag + a pinned-confidence branch + a file, not a new engine. Net new code should be
small (a loader source, a precedence rule, one tool flag).
