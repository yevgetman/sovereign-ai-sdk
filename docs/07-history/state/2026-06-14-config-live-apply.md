# State snapshot — 2026-06-14 — Config live-apply UX (+ the day's post-audit bug hunt)

**This is the canonical current-state snapshot.** Two substantial things shipped 2026-06-14, in order:

1. **Post-audit deep-dive bug hunt → v0.6.42** (earlier in the day).
2. **Config live-apply UX → v0.6.43** (the headline; HEAD `27a443a`).

The learning-loop soak continues untouched (recall ON by default; the standing #1 ACTIVE-FOCUS track). No new ADRs, no bundle changes. Cross-repo `sovereign-ai-docs` sync still pending (now also for these two).

---

## Headline — Config live-apply UX (v0.6.43)

**Resolved the reported `/config` ambiguity: "is a saved setting applied now, or do I need to restart?"** The old model decided live-vs-restart from a single bit (does a `LIVE_APPLY_HOOK` exist?), and the picker badge + save toast derived it independently so they could disagree; many settings silently fell to "next session" with no clear messaging, and a few (notably `thinking.effort`) were silent no-ops.

**The fix — one apply-scope taxonomy** (`src/config/applyScope.ts`): every setting resolves (exact, then longest-prefix) to one of `live` / `live-reload` / `other-process` / `restart`. The picker badge AND the save toast both derive from it via `describeScope`, so they can never disagree, and **every toast names the setting + states the outcome**:
- green `✓ live` → "saved — <setting> applied to this session" (incl. the live conversation, from the next turn).
- amber `⤴ other` → "applies to the sov gateway/serve process, not this session".
- amber `⟳ restart` → "restart sov for <setting> to take effect".
- standalone `sov config` → plain "saved" (no session).

**Invariant (enforced + verified against the registry):** every green path has a matching `LIVE_APPLY_HOOK` that achieves it — so the badge can never over-claim.

**Now live to the running conversation** (the user-requested "apply mid-session"): models / `defaultProvider` / provider creds+baseUrl / router lanes (new `runtime.reresolveProvider` atomically re-resolves the whole provider stack — transport, contextLength, metadata, model, **compactor**, learning reasoner — between turns); `thinking.effort` (was the #1 silent no-op; now mirrors `/effort`, per-session so #57 isolation holds); task-routing; `permissionMode` (+ a loud `bypass` chrome indicator); web search; learning/recall (rebuilds the active SessionContext's recall+observer in place); microcompaction/compaction; the `ui.*` render flags. **Honest amber:** `gateway.*`/`openaiServer.*` (other-process); the boot-captured set `maxTurns`/`behavior.*`/`review.*`/`subscriptionExecutor.*`/`debugMode.*`/`router.maxConcurrent*`/learning-prune (restart).

**New mechanisms (`src/server/runtime.ts` + `commandContext.ts` + `sessionContext.ts`):** `reresolveProvider`, `reloadHooks`, `reloadMcpServers`, `rebuildRecall`, the M6 chrome-reflection recorders, and the `refreshRuntimeFromConfig` #55-class `harnessHome` fix. Coverage: surfaced orphan catalog fields (`learning.recall.*`, `providers.sov.*`, missing `gateway.*`); `listUnmanagedKeys` recurses into partially-catalogued blocks.

**Built** T1 (the `applyScope` contract + interface extensions) by hand; T2–T7 via a 5-owner disjoint-file workflow (TDD + per-owner review + a safety review of the provider re-resolution). The **safety review caught a HIGH**: `reresolveProvider` left the compactor's captured model stale after a cross-family swap (string snapshot, not by-reference) → would send a foreign model id to the new transport on the compaction path; fixed by reassigning `runtime.compact` + a regression guard. Central integration (the M6 recorder seam, badge-type widenings, cast removal, and aligning `SETTING_SCOPES` to the actual hook registry — removed `reasoning.effort`/`mcpServers`/`hooks` green over-claims) reconciled by the orchestrator.

**Gate:** lint clean (765 files) + typecheck clean + **TS 4096 pass / 0 fail / 16 skip** (+100) + Go `build`/`vet`/`test` green. Behavioral smoke via the real dispatcher confirmed every scope's toast. Spec `specs/2026-06-14-config-live-apply-design.md`; plan `plans/2026-06-14-config-live-apply.md`; usage in `docs/03-cli-reference/usage.md` (the "Apply-scope" table).

**Known v1 limitations:** `ui.footer`/`ui.diffRender`/`ui.contextMeter` update live session state + persist, but on-screen rendering awaits inline-TUI widget support; `runtime.reloadHooks`/`reloadMcpServers` exist but no `/config` field drives them (settings.json-only, so scoped `restart`); `runtime.model` remains process-global on a multi-user gateway (backlog #58).

---

## Predecessor (same day) — Post-audit deep-dive bug hunt (v0.6.42)

A second agent-driven deep-dive run **after** the 2026-06-10 full-codebase audit shipped, targeting the least-reviewed code (the 69 files changed since that audit) + a sweep of unchanged subsystems. **46 confirmed NEW findings (1 critical / 10 high / 12 medium / 23 low), all fixed.** Headline: a **channel-reachable Bash RCE from an incomplete C3 fix** (quote-naive `find` detector — `find . '-delete'` ran unprompted for an untrusted channel sender), closed by sharing the quote-stripping tokenizer. Other HIGHs were mostly incomplete prior fixes: SSRF range/rebinding gaps; **`sessionDb` H14 was filed-fixed but never actually changed** (+ a channel twin); reasoning models never booting when effort off; idle SSE reconnect flood; observations.jsonl 1 MiB synthesis-stop. Built by a 20-way disjoint-file fix fan-out + per-group review + adversarial bypass review on the security groups (which caught a residual SSRF bypass + a self-introduced regression). Report: `docs/07-history/audits/2026-06-14-post-audit-bug-hunt.md`. Two deferred low residuals: #59 (F36 sibling-hydrate), #60 (F15 same-credential race).

---

## Open backlog (unchanged: 9)
#17 (eval-gated auto-promote, P4) · #50–#54 (Phase-2 learning extraction, P2, deferred-by-design) · #58 (`runtime.model` process-global, P3) · #59 (F36 sibling-hydrate, P4) · #60 (F15 same-credential race, P4). Founder-reserved (NOT backlog): rented-engine choice, go/no-go, auto-promote default, recall-on default.

Predecessor snapshot: `docs/07-history/state/2026-06-09-plugin-system-v1.md` (Plugin System v1). Find the latest via `ls docs/07-history/state/*.md | sort -r | head -1`.
