# Design — User-level session transcripts + subscription-executor visibility (2026-06-15)

## Motivation (three founder-reported gaps)

1. **The subscription-executor is invisible.** When `subscriptionExecutor.enabled: true`, nothing in the TUI (or splash, HarnessInfo, banner, SSE) tells the user the feature is active — even though it routes delegations to a headless `claude -p --dangerously-skip-permissions` subprocess (default `permissionMode: 'bypass'`). The user can't tell, while using the TUI, that this powerful mode is on.

2. **"Debug mode" does not save transcripts.** `debugMode.transcript` / `debugMode.transcriptDir` (and the `--transcript <path>` CLI flag) are **orphaned dead config** — vestiges of the pre-M13 readline REPL. Nothing in `src/` reads `transcriptDir` or writes a transcript; `debugMode` today only passes `--debug-mode` to the Go TUI to annotate delegator lines. The config *claims* to save transcripts and silently doesn't.

3. **No Claude-Code-style transcripts at the user level.** The full message history (text/thinking/tool_use/tool_result/image) **is** persisted — but as JSON rows inside one shared SQLite DB (`$HARNESS_HOME/sessions.db`), not as a human-readable, append-as-you-go, **one-file-per-session `.jsonl` under the user's home** the way Claude Code writes `~/.claude/projects/<slug>/<sessionId>.jsonl`. The per-session `.jsonl` files that *do* exist (`traces/<id>.jsonl`) are an operational event trace with no message bodies. The founder wants the Claude-Code ergonomic.

## What ships

A new **always-on per-session transcript writer** that mirrors Claude Code's on-disk ergonomic, plus a **status-line indicator** for the subscription-executor, plus **retirement of the dead transcript config**.

### A. Session transcripts (`src/transcript/`)

- **Layout (per-user scoped, Phase-E consistent):**
  - No owner (legacy / single principal): `$HARNESS_HOME/projects/<slug>/<sessionId>.jsonl`
  - With owner: `$HARNESS_HOME/users/<ownerId>/projects/<slug>/<sessionId>.jsonl`
  - `<slug>` = a **human-readable** slug of the session's cwd (Claude-Code rule: every non-alphanumeric → `-`; realpath-canonicalized best-effort; truncate at 200 chars + a stable hash suffix when longer). Browsable like CC's `-Users-julie-code-...`.
  - One file per session. The session-id stem is sanitized + containment-asserted under the project dir (reuse the `safeTraceFilenameStem` hardening from `src/trace/writer.ts` — the F-T8 path-traversal fix class).
- **Format — JSONL, one record per line** (Claude-Code-shaped, harness-appropriate):
  - A leading `{"type":"session_meta", sessionId, parentSessionId, cwd, model, provider, kind, version, startedAt}` line, written lazily before the first message (no empty files).
  - Per message: `{"type":"user"|"assistant", "seq":<saveMessage row id>, "sessionId", "parentSessionId", "cwd", "version", "timestamp":<ISO>, "message":{"role", "content": ContentBlock[]}}`. `content` is the harness `ContentBlock[]` verbatim — text, thinking (+signature), tool_use, tool_result, image. A tool result is a `user` record whose content carries a `tool_result` block (matches CC).
- **Redaction ON by default.** Unlike Claude Code (which does not redact), each line is passed through the existing `redact()` (`src/trajectory/redact.ts`) before write — the harness writes transcripts from gateway / channel / multi-user / cron contexts, not just a local single-user CLI, so secret-redaction is the safe default (consistent with the trace + trajectory writers). Gated by the existing `HARNESS_REDACT_SECRETS` snapshot.
- **Fail-open, non-blocking.** Mirror `TraceWriter`: a per-session sequential `writeChain` of `appendFile`s; `appendMessage()` returns immediately; any FS error is logged and swallowed — a transcript failure must NEVER break a turn.
- **Authoritative store unchanged.** `sessions.db` remains the source of truth and the resume source. The transcript file is an always-on human-readable **mirror** for inspection / portability / parity with Claude Code — we do **not** re-plumb resume onto JSONL (KISS / YAGNI).

### B. Hook point — universal coverage via one helper

`SessionDb.saveMessage` is the single universal chokepoint for every persisted user/assistant/tool message (turns route → TUI/`sov drive`/gateway/cron; channels; OpenAI API server; compaction). Sub-agent children never call `saveMessage` (their messages aren't persisted to the `messages` table) — so they're naturally excluded, matching Claude Code's sidechain separation.

- A **runtime-level transcript store**: `Map<sessionId, TranscriptWriter>` on the Runtime, lazily creating a writer per session (resolving `ownerId` from the session row + `cwd` from `runtime.cwd`), closed in `disposeSession(sessionId)` and `dispose()`.
- A **`persistMessage(runtime, sessionId, msg)` helper** that calls `runtime.sessionDb.saveMessage(...)` (returning its row id, drop-in) **and** fires the transcript append. Every current `saveMessage` call site is migrated to `persistMessage` so DB and transcript stay in lock-step and no surface is missed (incl. the OpenAI route, which has no `SessionContext`).

### C. Config — retire the dead, introduce the live

- New block `transcripts: { enabled?: boolean (default TRUE), dir?: string, redactSecrets?: boolean (default TRUE) }` (`.optional()`, read-site defaults per the project convention). Default-ON = "just like Claude Code". `dir` overrides the per-user root (advanced); `redactSecrets:false` opts out of redaction.
- **Deprecate the dead fields without breaking parse:** keep `debugMode.transcript` / `debugMode.transcriptDir` in the schema (so existing configs still parse) but mark them deprecated in their descriptions; honor `transcriptDir` only as a fallback `dir` when `transcripts.dir` is unset. Repurpose the existing `--transcript <path>` CLI flag to set `transcripts.dir` (it finally does something).
- Catalog + apply-scope: add `transcripts.*` to `src/config/catalog.ts`; `enabled`/`redactSecrets`/`dir` are **`live`** (the store reads config per-session at writer creation — a new session picks up the change; existing in-flight session keeps its writer). Document as `live` (next session) to be honest.

### D. Subscription-executor status-line indicator (Go TUI)

Reuse the **`TaskRouter` boot-flag pattern** (a config-level mode known at launch):

- `src/cli/tuiLauncher.ts`: when `userSettings.subscriptionExecutor?.enabled === true`, push `--subscription-executor` into `tuiArgs`.
- `packages/tui/cmd/sov-tui/main.go`: a `flag.Bool("subscription-executor", …)`, applied via a new `WithSubscriptionExecutor(true)` builder on `Model`.
- `packages/tui/internal/components/statusline.go`: a `SubscriptionExecutor bool` field + a `subscriptionExecutorChip()` helper, rendered in the right cluster. Styled **loud** (`s.Theme.Error` + `style.S.Glyph.Warning`) because the executor defaults to `permissionMode: 'bypass'` (no approval gate) — same posture as the bypass chip. All spacing/glyph/color via `style.S.*` + the injected theme (no hardcoded values).
- **Optional live seam:** a `subscriptionExecutorChanged` field on `CommandSideEffects` (threaded through all 5 wire seams per the project memory) so toggling `subscriptionExecutor.enabled` via `/config` updates the chip without a restart. If the 5-seam wiring proves heavy, ship the boot-flag indicator alone (restart-to-apply) and note the live seam as a follow-up — the boot indicator is the load-bearing fix.

### E. Surface the transcript location

Add the active transcript directory to the `HarnessInfo` snapshot (model-facing) and the splash footer line (`transcripts: <dir>` or `off`) so the user can see it's happening and where — closing the "I'm not sure transcripts are saved" gap directly.

## Out of scope (v1)

- Resume / session-picker reading the JSONL (SessionDb stays the resume source).
- Sub-agent sidechain transcript files (children don't persist messages; matches CC's main-file exclusion).
- Large-tool-output overflow sidecar + stub (CC's 50 KB cap) — v1 writes full redacted content; revisit if line sizes bite.
- Tombstone/edit of past lines; 100 ms batched flush (per-record `writeChain` is sufficient at harness volume).

## Risks / mitigations

- **Privacy / default-on writing to disk.** Founder explicitly asked for it ("save all conversation session transcripts at the user level just like claude code"); mitigated by per-user scoping (`users/<id>/`), default secret-redaction, and an `enabled:false` kill-switch.
- **Test fallout.** Always-on file writes during the suite land under each test's tmp `HARNESS_HOME` (harmless, like the trace writer). The store must no-op gracefully when cwd/harnessHome are absent (mock runtimes). Run the full clean-env gate; fix any directory-assertion fallout.
- **Hot-path safety.** Transcript append is fire-and-forget + error-swallowed; `persistMessage` returns the `saveMessage` row id unchanged so call sites are byte-compatible.
