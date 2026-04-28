# Post Phase-10.5 REPL Retest Improvement Backlog

This document is the record of candidate improvements discovered during the
post-fix real-world REPL retest on 2026-04-27. These are not committed phase
requirements yet; they are the next set of issues worth considering after the
Phase-10.5 backlog was closed.

Source test:

- `docs/testing-log-2026-04-27.md` - Post-Fix Real-World Website REPL Retest

## What The Retest Verified

- Leading `~` paths worked for `FileWrite`, `FileEdit`, `FileRead`, and Bash
  validation commands in a live session.
- Read-only Bash and `FileRead` calls ran in `ask` mode without noisy prompts.
- Permission prompts for writes/edits were serialized and did not overlap or
  stall the REPL.
- The raised default `--max-tokens` budget avoided the earlier first-turn
  max-token failure mode.
- Provider failure after tool execution did not corrupt the transcript:
  both retest sessions had `missing_tool_results=0` in a direct SQLite check.
- `/cost` and clean `/quit` still worked after provider errors.

## Priority Order

1. Preflight provider/model health and tool-call capability before real work.
2. Warn clearly when provider failure leaves a turn with partial file changes.
3. Add a first-class static-site/artifact validator or validation recipe.
4. Handle unsupported Ollama tool models before a session is underway.
5. Update docs that still say `--max-tokens` defaults to `4096`.
6. Improve handling of pasted multi-line slash commands.
7. Consider optional terminal transcript capture for manual REPL tests.

## 1. Provider/Model Health Preflight

- Priority: P1
- Status: complete (2026-04-27)
- Fix: The CLI now runs a startup provider preflight by default before opening
  a real session. The preflight sends a tiny no-tool request with caching off,
  classifies low-credit/quota, credential, rate-limit, and provider HTTP
  failures, and aborts before the user can approve file mutations. `--no-preflight`
  remains available for isolated testing or known-offline provider work.
- Evidence: The Anthropic retest started successfully and completed the first
  website turn, but the second turn failed after several tool edits with:

  ```text
  Your credit balance is too low to access the Anthropic API.
  ```

  A local Ollama continuation session then started successfully, but the first
  model request failed with:

  ```text
  registry.ollama.ai/library/dolphin-llama3:latest does not support tools
  ```

- Impact: A user can spend time approving writes and end up with partial
  artifacts before learning that the selected provider/model cannot finish the
  workflow.
- Desired behavior: before a tool-enabled coding session begins real work, the
  harness should catch obvious provider/model blockers as early as practical.
- Implementation options:
  - Add an optional `--preflight` or default startup check that verifies
    credentials/quota where the provider exposes a cheap check.
  - For providers without a cheap quota endpoint, fail gracefully on the first
    provider error and surface a provider-health summary.
  - For model/tool capability, check provider metadata when available or keep a
    provider-specific compatibility probe/cache.
- Acceptance criteria:
  - Tool-incompatible local models fail before the user approves any file
    mutation, or the harness starts in an explicit no-tools mode.
  - Credential/quota failures are reported with clear next steps and do not
    look like harness crashes.

## 2. Partial Artifact Warning After Provider Failure

- Priority: P1
- Status: complete (2026-04-27)
- Fix: The REPL now tracks successful mutating tool results during each turn.
  If the provider later fails in that same turn, it prints a partial-changes
  warning with the touched paths so the user knows to validate the workspace
  before relying on generated artifacts.
- Evidence: The Anthropic session wrote an updated `index.html` and edited
  `style.css`, then the provider failed before the planned `chooser.js` write.
  External validation found:

  ```text
  index.html references chooser.js
  chooser.js returns HTTP 404
  ```

- Impact: The transcript stayed valid, but the workspace was left in an
  unfinished state. A user seeing only the provider error may not know which
  files changed or what still needs validation.
- Desired behavior: if a provider error happens after mutating tools ran in the
  current turn, the REPL should clearly say that the turn ended after partial
  file changes and list the touched paths when available.
- Implementation options:
  - Track per-turn mutating tool calls and touched paths in the REPL.
  - On provider error after tool results, print a warning such as
    `turn failed after file changes; validate before relying on the artifact`.
  - Optionally offer a `/resume-turn` or `/validate` hint.
- Acceptance criteria:
  - Provider errors after writes/edits distinguish "no changes happened" from
    "changes happened but the model did not finish".
  - The warning includes enough path information to guide manual validation.

## 3. Static-Site / Artifact Validation Helper

- Priority: P2
- Status: complete (2026-04-27)
- Fix: Added a read-only `StaticSiteValidate` tool. It validates a static site
  directory without shelling out from the model: entry HTML exists, local
  `href`/`src` references resolve, referenced local JavaScript passes
  `node --check` when enabled, and the entry page returns HTTP 200 from a
  temporary Bun static server. System guidance now tells the model to prefer
  this tool for simple static website artifacts.
- Evidence: The model used ad hoc `python3 -c` Bash checks that required human
  approval, while the decisive outside validation was a local-reference check
  plus HTTP checks. That validation caught the missing `chooser.js`.
- Impact: Site-building tasks still depend on the model inventing its own
  validation commands, and those commands are noisy under `ask` mode.
- Desired behavior: common artifact checks should be cheap, deterministic, and
  easy for the model to call.
- Implementation options:
  - Add a small first-class static-site validator tool for a directory:
    parse HTML, check local `href`/`src` references, optionally run
    `node --check` on local JS, start a local server, and report HTTP status.
  - Or add a command/eval recipe that the model can discover from system
    prompt guidance without broad Bash permissions.
- Acceptance criteria:
  - A missing local script or stylesheet is caught before final completion.
  - The validator is read-only and can run without a permission prompt.
  - The website eval and manual REPL flow can share the same validator logic.

## 4. Unsupported Ollama Tool Models Need Early Handling

- Priority: P2
- Status: complete (2026-04-27)
- Fix: Ollama sessions with visible tools now run a startup tool-call preflight
  after the tool pool is assembled and before opening a session. The probe sends
  a tiny no-op tool schema, drains the response, and classifies unsupported-tool
  provider errors as a harness-level model capability failure with guidance to
  choose a tool-capable model or start a no-tools conversational session.
- Evidence: `dolphin-llama3:latest` was listed locally, but Ollama rejected the
  request because the model does not support tools. The harness had already
  created a session and displayed the normal tool-enabled banner.
- Impact: Local fallback is unreliable unless the user already knows which
  Ollama models support tool calls.
- Desired behavior: when `--provider ollama` is used with visible tools, the
  harness should verify tool support or give a clear startup warning.
- Implementation options:
  - Detect unsupported-tool errors and rewrite them into a harness-level
    explanation with suggested tool-capable model families.
  - Cache known failing local model names for the session.
  - Add an explicit `--no-tools` mode for conversational local sessions.
- Acceptance criteria:
  - Unsupported local models fail before a confusing first-turn provider error,
    or the error clearly names the model capability problem and next action.

## 5. Stale `--max-tokens` Documentation

- Priority: P3
- Status: open
- Evidence: `src/main.ts` now sets `DEFAULT_MAX_TOKENS = 12000`, but
  `README.md` and `docs/usage.md` still say the default is `4096`.
- Impact: Users may apply unnecessary CLI overrides or misunderstand the
  current runtime behavior.
- Desired behavior: docs and CLI defaults stay aligned.
- Acceptance criteria:
  - README and usage docs both report `12000` as the current default.
  - Future default changes have a targeted docs assertion or checklist.

## 6. Pasted Multi-Line Slash Commands

- Priority: P3
- Status: open
- Evidence: Pasting `/cost\n/quit\n` into the REPL produced the `/cost` output
  but did not quit until `/quit` was entered again.
- Impact: Multi-line paste behavior is surprising and can make scripted manual
  REPL checks less reliable.
- Desired behavior: the REPL should either process pasted slash-command lines
  sequentially or clearly ignore unsupported trailing input.
- Acceptance criteria:
  - Pasted `/cost\n/quit\n` either runs both commands or produces a clear
    single-command-only behavior.

## 7. Optional Terminal Transcript Capture

- Priority: P3
- Status: open
- Evidence: The retest used the external `script` command to capture
  permission prompts, provider errors, and human inputs. The SQLite transcript
  records model messages but not the full terminal interaction.
- Impact: Manual REPL regressions are harder to audit without an external
  terminal recorder.
- Desired behavior: manual soak tests can opt into a harness-owned terminal
  transcript or structured event trace.
- Acceptance criteria:
  - A test run can write a redacted terminal/event log path without relying on
    shell-specific `script` behavior.
  - Logs include permission prompts, user answers, provider errors, session id,
    and local slash-command outputs.
