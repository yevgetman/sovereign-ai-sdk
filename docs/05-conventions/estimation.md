# Estimating effort and remaining work

**Do NOT use wall-clock weeks or person-weeks** when estimating remaining work.

## Why weeks are meaningless here

There is no human development team. This codebase is built exclusively by AI coding agents — in the current session and future ones. Estimates like "1-2 weeks" or "M7 takes ~3 weeks" presume a calendar-driven development pace that doesn't exist.

The same applies to "sprints," "quarters," calendar dates ("by end of Q2"), or anything else assuming a traditional dev team.

## What to use instead

In rough order of preference:

### Sessions

Discrete planning + dispatch + review cycles, scaled like a milestone close-out.

Baseline: M4 (3 prereq boxes, 11 implementer tasks + 8 cleanup passes + 1 final whole-branch review) was ~1 focused session.

- A small milestone might fit in 1 session.
- M7 (6 prereq boxes, hardest group) might be 2–3 sessions because of scope.

### Token-proxy units

Counts of implementer-task dispatches, files touched, or subagent rounds.

Each round ≈ Opus implementer + spec reviewer + quality reviewer + cleanup.

Useful for sub-session granularity.

### Wall-clock minutes within a session

Fine for short specific tasks ("~30 minutes to wire up X" or "1-2 hours for the full M5 plan"). Acceptable for sub-session work, NOT for milestone-scale estimates.

## How to report

When reporting on completed work, count what actually happened in these units. Example:

> M4 shipped in one session: 11 implementer tasks, 8 cleanup passes, 1 final review, ~22 subagent dispatches total.

Past performance in agent-sessions is the most reliable basis for future estimates; don't translate it back into "engineer-weeks."

## Legacy estimates

If a doc you're updating (state snapshot, plan, spec) contains week-based estimates from earlier sessions, treat them as legacy and rephrase in session/token/dispatch units when you touch the surrounding text.
