# Subagent model policy

**HARD RULE — non-negotiable.**

When dispatching subagents in this repo (Agent tool / Task tool / subagent-driven-development / executing-plans / any task that runs in a sub-context), this rule overrides any default model selection in skills, plugins, or harness defaults.

## The rule

- **Opus 4.7 is the default and primary driver.** Use it for every subagent that requires reasoning, judgment, design sense, pattern matching across files, security-sensitive code, or anything that touches the runtime (`src/core/`, `src/providers/`, `src/permissions/`, `src/agent/sessionDb.ts`). This includes implementers, reviewers, planners, architects, debugging agents, and code-quality reviewers.

- **Sonnet 4.6 is acceptable only for trivially mechanical, fully specified tasks.**

  Examples that qualify:
  - A one-line version bump
  - A docs-only edit where the exact text is given verbatim
  - Tagging an existing artifact
  - Renaming a single identifier across files where the rename target is unambiguous
  - Running a documented build/test command and reporting pass/fail

  Examples that do NOT qualify:
  - Writing tests
  - Writing implementation
  - Reviewing code
  - Deciding between two patterns
  - Anything where the agent has discretion

  Pick Sonnet because the task is *genuinely mechanical*, never to save tokens or speed up output.

- **Never use Haiku.** No exceptions for "simple tasks," "cost," "speed," "small files," or any other rationalization. If you're tempted to pick Haiku, treat it as a signal you've misread the rule — pick Opus.

## How to interpret "use a fast cheap model"

If a skill or plan template says "use a fast cheap model," interpret that as:

> Sonnet 4.6 if and only if the task is trivially mechanical, otherwise Opus 4.7.

This rule mirrors the global rule in `~/.claude/rules/ecc/common/agents.md` and is restated here so it applies even when the global rules aren't loaded.

## Phase 16.1 specifically

Every implementer subagent in the active TUI rebuild runs on Opus. The only tasks that are candidates for Sonnet are the doc-text edits inside M0 (the ADR-text and umbrella-roadmap-text steps where the exact final text is in the plan body — and even then, Opus is acceptable since the work is short).
