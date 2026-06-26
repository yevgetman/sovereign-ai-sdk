# Plan — Session transcripts + subscription-executor visibility (2026-06-15)

Spec: `specs/2026-06-15-session-transcripts-design.md`. Autonomous build (no approval gates).

## T1 — Transcript module (`src/transcript/`)
- `paths.ts`: `transcriptsRoot(harnessHome, userId?)` (mirror `learning/paths.ts` + `validatePrincipalId`); `slugifyCwd(cwd)` (CC rule: `[^a-zA-Z0-9]→-`, realpath best-effort, 200-char + hash cap); `resolveTranscriptPath(root, cwd, sessionId)` (project-slug dir + sanitized `<sessionId>.jsonl` stem + containment assert — reuse the `safeTraceFilenameStem` pattern).
- `writer.ts`: `TranscriptWriter` mirroring `src/trace/writer.ts` — ctor `{ sessionId, cwd, harnessHome, ownerId?, redactSecrets?, version, meta }`; lazy `session_meta` first line; `appendMessage(role, content, seq)` builds the record, `redact(JSON.stringify(record))` (unless `redactSecrets:false`), queues on a sequential `writeChain`; `close()`; fail-open.
- Unit tests: path/slug/containment; record shape; redaction on/off; fail-open on bad dir.

## T2 — Config (`src/config/schema.ts`, `catalog.ts`, `applyScope.ts`)
- Add `TranscriptsSchema` `{ enabled?, dir?, redactSecrets? }` `.strict().optional()`; export `TranscriptsConfig`.
- Mark `debugMode.transcript`/`transcriptDir` descriptions deprecated (keep fields → no parse break).
- Catalog group `transcripts` (enabled/dir/redactSecrets); apply-scope `live`.
- Read-site default helper: `resolveTranscriptsConfig(settings)` → `{ enabled:true, redactSecrets:true, dir? }` with `debugMode.transcriptDir` as `dir` fallback.
- Tests: empty config → enabled+redact true; `enabled:false` honored; legacy `transcriptDir` fallback.

## T3 — Runtime wiring + `persistMessage`
- `src/agent/persistMessage.ts`: `persistMessage(runtime, sessionId, msg): number` → `saveMessage` + fire transcript append; returns row id.
- Runtime: a transcript store (`Map<sessionId, TranscriptWriter|null>`) + `recordTranscriptMessage(sessionId, role, content, seq)` (lazy-create resolving ownerId from row + cwd; null when `transcripts.enabled:false`); close in `disposeSession` + `dispose()`. Surface active dir for E.
- Migrate every `saveMessage` call site → `persistMessage`: `turns.ts:507/1085/1138`, `channels/pipeline.ts:195/298`, `openai/routes/chatCompletions.ts:285/434/519`, `compact/compactor.ts:188/194`.
- Tests: a turn writes a `<sessionId>.jsonl` under the (tmp) transcripts root with the user+assistant records; `enabled:false` writes nothing; owner scoping → `users/<id>/projects/...`; OpenAI route covered.

## T4 — Subscription-executor status chip (Go + tuiLauncher) — dispatch to subagent
- `tuiLauncher.ts`: forward `--subscription-executor` when enabled.
- `main.go` flag + `WithSubscriptionExecutor` builder; `statusline.go` field + `subscriptionExecutorChip()` (loud, `style.S.*` + theme tokens) in the right cluster.
- Optional live seam (`subscriptionExecutorChanged` on `CommandSideEffects`, all 5 seams) — only if clean; else boot-flag + note.
- Go tests for the chip render + the flag.

## T5 — Surface transcript location (E)
- Add `transcriptsDir` (or `off`) to `HarnessInfoTool` snapshot + splash footer.

## T6 — Docs + gate + ship
- `docs/03-cli-reference/usage.md` (transcripts: where, format, disable, redaction; subscription-executor indicator), `docs/04-extending/extending.md` if relevant, testing-log, state snapshot, backlog.
- Gate: `bun run lint && bun run typecheck && HARNESS_HOME=$(mktemp -d) bun test`; Go `go test ./...` (clean env). `sov upgrade`; cut v0.6.46; CHANGELOG; tag on harness repo.
