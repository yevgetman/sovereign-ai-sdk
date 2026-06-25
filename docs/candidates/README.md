# Candidates

Features **considered for implementation someday but deliberately NOT on the roadmap.**

This area is for ideas that have cleared "random thought" but have **not** been committed to a
phase. It sits one notch below the other doc types:

| Area | Means | Commitment |
|---|---|---|
| `docs/candidates/` (this) | "We might build this. Here's the shape." | **None** — unscheduled |
| `docs/specs/` | A design we intend to build, pending review | Pre-implementation |
| `docs/plans/` | Phased, milestoned implementation work | Scheduled |
| `DECISIONS.md` | A choice already made | Decided |

The authoritative roadmap / phase plan lives in
`~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md`. Nothing here is on it.

## Lifecycle

```
idea → candidate (here) → [greenlit] → docs/specs/<dated>-design.md + docs/plans/<dated>-<phase>.md
                        → [rejected]  → note the reason inline and leave it (or move to archive/)
```

A candidate graduating to real work gets a dated spec in `docs/specs/` and milestones in
`docs/plans/`; the candidate file then points at them and is left as provenance.

## Format

One markdown file per candidate. Keep it **high-level** — the problem, the concept, how it
fits the *existing* subsystems (cite real `src/` paths), open questions, the value, and an
explicit **bloat guard** (why it won't balloon the codebase). Start each file with:

```
# <Feature> · Candidate
Status: candidate — not scheduled
Created: YYYY-MM-DD
```

## Current candidates

- [`authored-instincts.md`](./authored-instincts.md) — a human-authored, declarative "always-rules"
  lane alongside the existing *learned* instinct corpus.
- [`gateguard-edit-gate.md`](./gateguard-edit-gate.md) — an opt-in pre-edit gate that forces
  blast-radius investigation before the first write to a file.

Both originated from the 2026-06-14 review of the ECC project (`~/code/ecc-integration-review.md`)
— the two concepts judged worth lifting from a ~90%-overlap codebase.
